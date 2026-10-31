// Tool-call repair for websocket turns served by HTTP upstreams. Port of
// sdk/api/handlers/openai/openai_responses_websocket_toolcall_repair.go:
// complete tool calls and tool outputs seen on a downstream session are cached
// (per downstream session key, committed only when a turn succeeds) so a later
// transcript that lost half of a call/output pair can be repaired instead of
// being rejected upstream ("No tool call found for function call output").
import { isObject, tryParse, type JSONObject } from "../util/json.ts";
import { dedupeResponsesWebsocketInputItems, isResponsesToolCallOutputType, isResponsesToolCallType, itemMeta, jsonString } from "./responses_websocket_requests.ts";

export const websocketToolOutputCacheMaxPerSession = 256;
export const websocketToolOutputCacheTTLMs = 30 * 60_000;

interface ToolCacheSession {
  lastSeen: number;
  outputs: Map<string, string>;
}

/** Per-session call_id -> raw item cache (Go: websocketToolOutputCache). */
export class WebsocketToolOutputCache {
  private readonly sessions = new Map<string, ToolCacheSession>();
  readonly ttlMs: number;
  readonly maxPerSession: number;

  /** ttlMs < 0 selects the 30 minute default; 0 disables expiry (Go: newWebsocketToolOutputCache). */
  constructor(
    ttlMs: number,
    maxPerSession: number,
    private readonly now: () => number = Date.now,
  ) {
    this.ttlMs = ttlMs < 0 ? websocketToolOutputCacheTTLMs : ttlMs;
    this.maxPerSession = maxPerSession <= 0 ? websocketToolOutputCacheMaxPerSession : maxPerSession;
  }

  record(sessionKey: string, callID: string, item: string): void {
    const key = sessionKey.trim();
    const id = callID.trim();
    if (key === "" || id === "") return;
    const now = this.now();
    this.cleanup(now);
    let session = this.sessions.get(key);
    if (!session) {
      session = { lastSeen: now, outputs: new Map() };
      this.sessions.set(key, session);
    }
    session.lastSeen = now;
    // Map keeps insertion order: a re-recorded id keeps its original position, like Go's order slice.
    session.outputs.set(id, item);
    while (session.outputs.size > this.maxPerSession) {
      const oldest = session.outputs.keys().next().value as string;
      session.outputs.delete(oldest);
    }
  }

  get(sessionKey: string, callID: string): string | undefined {
    const key = sessionKey.trim();
    const id = callID.trim();
    if (key === "" || id === "") return undefined;
    const now = this.now();
    this.cleanup(now);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    session.lastSeen = now;
    const item = session.outputs.get(id);
    return item !== undefined && item.length > 0 ? item : undefined;
  }

  private cleanup(now: number): void {
    if (this.ttlMs <= 0) return;
    for (const [key, session] of this.sessions) if (now - session.lastSeen > this.ttlMs) this.sessions.delete(key);
  }

  deleteSession(sessionKey: string): void {
    const key = sessionKey.trim();
    if (key !== "") this.sessions.delete(key);
  }

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey.trim());
  }
}

/** Reference counts of downstream sessions sharing a session key (Go: websocketToolSessionRefCounter). */
export class WebsocketToolSessionRefCounter {
  private readonly counts = new Map<string, number>();

  acquire(sessionKey: string): void {
    const key = sessionKey.trim();
    if (key === "") return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Whether the last reference was released. */
  release(sessionKey: string): boolean {
    const key = sessionKey.trim();
    if (key === "") return false;
    const count = this.counts.get(key) ?? 0;
    if (count <= 1) {
      this.counts.delete(key);
      return true;
    }
    this.counts.set(key, count - 1);
    return false;
  }
}

export const defaultWebsocketToolOutputCache = new WebsocketToolOutputCache(0, websocketToolOutputCacheMaxPerSession);
export const defaultWebsocketToolCallCache = new WebsocketToolOutputCache(0, websocketToolOutputCacheMaxPerSession);
export const defaultWebsocketToolSessionRefs = new WebsocketToolSessionRefCounter();

/** Go: retainResponsesWebsocketToolCaches. */
export function retainResponsesWebsocketToolCaches(sessionKey: string): void {
  defaultWebsocketToolSessionRefs.acquire(sessionKey);
}

/** Drops the session's cached tool items once its last connection closes (Go: releaseResponsesWebsocketToolCaches). */
export function releaseResponsesWebsocketToolCaches(sessionKey: string): void {
  if (!defaultWebsocketToolSessionRefs.release(sessionKey)) return;
  defaultWebsocketToolOutputCache.deleteSession(sessionKey);
  defaultWebsocketToolCallCache.deleteSession(sessionKey);
}

/**
 * The downstream session key: X-Client-Request-Id, X-Codex-Turn-Metadata
 * session_id, Session-Id, Session_id (Go: websocketDownstreamSessionKey).
 */
export function websocketDownstreamSessionKey(headers: Headers | undefined): string {
  if (!headers) return "";
  const requestID = (headers.get("X-Client-Request-Id") ?? "").trim();
  if (requestID !== "") return requestID;
  const metadata = (headers.get("X-Codex-Turn-Metadata") ?? "").trim();
  if (metadata !== "") {
    const parsed = tryParse(metadata);
    const sessionID = isObject(parsed) ? jsonString(parsed.session_id).trim() : "";
    if (sessionID !== "") return sessionID;
  }
  for (const name of ["Session-Id", "Session_id"]) {
    const value = (headers.get(name) ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}

/** A function_call / custom_tool_call with a call_id, a name and string arguments / input (Go: isCompleteResponsesWebsocketToolCall). */
export function isCompleteResponsesWebsocketToolCall(item: unknown): boolean {
  if (!isObject(item)) return false;
  if (typeof item.call_id !== "string" || item.call_id.trim() === "") return false;
  if (typeof item.name !== "string" || item.name.trim() === "") return false;
  switch (jsonString(item.type).trim()) {
    case "function_call":
      return typeof item.arguments === "string";
    case "custom_tool_call":
      return typeof item.input === "string";
    default:
      return false;
  }
}

/** Tool items seen in one turn, committed to the caches only on success (Go: responsesWebsocketToolCacheTurn). */
export class ResponsesWebsocketToolCacheTurn {
  readonly outputs = new Map<string, string>();
  readonly calls = new Map<string, string>();

  constructor(readonly sessionKey: string) {}

  /** Records complete tool calls of a response payload (Go: recordResponse). */
  recordResponse(payload: JSONObject): void {
    switch (jsonString(payload.type).trim()) {
      case "response.completed": {
        const output = isObject(payload.response) ? payload.response.output : undefined;
        if (!Array.isArray(output)) return;
        for (const item of output) if (isCompleteResponsesWebsocketToolCall(item)) this.recordItem(item);
        return;
      }
      case "response.output_item.added":
      case "response.output_item.done":
        if (isCompleteResponsesWebsocketToolCall(payload.item)) this.recordItem(payload.item);
    }
  }

  private recordItem(item: unknown): void {
    const meta = itemMeta(item);
    this.recordRawItem(meta.type, meta.callID, JSON.stringify(item));
  }

  recordRawItem(itemType: string, callID: string, raw: string): void {
    if (!isResponsesToolCallOutputType(itemType) && !isResponsesToolCallType(itemType)) return;
    const id = callID.trim();
    if (id === "" || raw.trim() === "") return;
    if (isResponsesToolCallOutputType(itemType)) this.outputs.set(id, raw);
    else this.calls.set(id, raw);
  }

  /** Go: commit. */
  commit(outputCache = defaultWebsocketToolOutputCache, callCache = defaultWebsocketToolCallCache): void {
    if (this.sessionKey === "") return;
    for (const [id, raw] of this.outputs) outputCache.record(this.sessionKey, id, raw);
    for (const [id, raw] of this.calls) callCache.record(this.sessionKey, id, raw);
  }
}

export function newResponsesWebsocketToolCacheTurn(sessionKey: string): ResponsesWebsocketToolCacheTurn | undefined {
  const key = sessionKey.trim();
  return key === "" ? undefined : new ResponsesWebsocketToolCacheTurn(key);
}

/** The request's input array (`input` matched case-insensitively, null rejected) and previous_response_id (Go: parseResponsesWebsocketRepairRequest). */
function parseRepairRequest(payload: string): { root: JSONObject; inputKey: string; input: unknown[]; previousResponseID: unknown } | undefined {
  const root = tryParse(payload);
  if (!isObject(root)) return undefined;
  let inputKey = "";
  let input: unknown;
  let found = false;
  let previousResponseID: unknown;
  for (const [key, value] of Object.entries(root)) {
    const lower = key.toLowerCase();
    if (lower === "input") {
      if (!Array.isArray(value) && value !== null) return undefined;
      input = value;
      inputKey = key;
      found = true;
    } else if (lower === "previous_response_id") {
      previousResponseID = value;
    }
  }
  if (!found || !Array.isArray(input)) return undefined;
  return { root, inputKey, input, previousResponseID };
}

/** The trimmed string form of a raw JSON value (Go: responsesWebsocketMetadataString). */
function metadataString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return jsonString(value).trim();
}

/**
 * Repairs the tool call / output pairs of a request (Go:
 * repairResponsesWebsocketToolCallsWithCachesMode): outputs without their call
 * get the cached call inserted (or are dropped), calls without their output get
 * the cached output appended (or are dropped), standalone named
 * function_call_output items are kept; an incremental request
 * (previous_response_id) keeps orphans as the upstream holds their partners.
 * `record` writes the request's items to the caches; `turn` collects them for a
 * later commit. Unchanged payloads are returned as is.
 */
export function repairResponsesWebsocketToolCallsWithCachesMode(
  outputCache: WebsocketToolOutputCache | undefined,
  callCache: WebsocketToolOutputCache | undefined,
  sessionKey: string,
  payload: string,
  record: boolean,
  turn: ResponsesWebsocketToolCacheTurn | undefined,
): string {
  if (payload.length === 0) return payload;
  const parsed = parseRepairRequest(payload);
  if (!parsed) return payload;
  const key = sessionKey.trim();
  const repairEnabled = key !== "" && outputCache !== undefined;
  const updated = repairResponsesToolCallItems(outputCache, callCache, key, parsed.input, repairEnabled && metadataString(parsed.previousResponseID) !== "", record && repairEnabled, turn, repairEnabled);
  if (updated.length === parsed.input.length && updated.every((item, index) => item === parsed.input[index])) return payload;
  parsed.root[parsed.inputKey] = updated;
  return JSON.stringify(parsed.root);
}

/** Go: repairResponsesWebsocketToolCalls (default caches, recording). */
export function repairResponsesWebsocketToolCalls(sessionKey: string, payload: string): string {
  return repairResponsesWebsocketToolCallsWithCachesMode(defaultWebsocketToolOutputCache, defaultWebsocketToolCallCache, sessionKey, payload, true, undefined);
}

/** Go: repairResponsesWebsocketToolCallsWithCache (output cache only). */
export function repairResponsesWebsocketToolCallsWithCache(cache: WebsocketToolOutputCache | undefined, sessionKey: string, payload: string): string {
  return repairResponsesWebsocketToolCallsWithCachesMode(cache, undefined, sessionKey, payload, true, undefined);
}

/** Go: repairResponsesWebsocketToolCallsWithoutRecording (default caches, read-only). */
export function repairResponsesWebsocketToolCallsWithoutRecording(sessionKey: string, payload: string): string {
  return repairResponsesWebsocketToolCallsWithCachesMode(defaultWebsocketToolOutputCache, defaultWebsocketToolCallCache, sessionKey, payload, false, undefined);
}

/** Go: repairResponsesWebsocketToolCallsWithCaches. */
export function repairResponsesWebsocketToolCallsWithCaches(outputCache: WebsocketToolOutputCache | undefined, callCache: WebsocketToolOutputCache | undefined, sessionKey: string, payload: string): string {
  return repairResponsesWebsocketToolCallsWithCachesMode(outputCache, callCache, sessionKey, payload, true, undefined);
}

/** Repairs a fallback (HTTP upstream) turn without recording; the items are committed with the turn (Go: prepareResponsesWebsocketFallbackTurn). */
export function prepareResponsesWebsocketFallbackTurn(sessionKey: string, payload: string): { payload: string; turn?: ResponsesWebsocketToolCacheTurn } {
  const turn = newResponsesWebsocketToolCacheTurn(sessionKey);
  return { payload: repairResponsesWebsocketToolCallsWithCachesMode(defaultWebsocketToolOutputCache, defaultWebsocketToolCallCache, sessionKey, payload, false, turn), turn };
}

function parseCached(raw: string): unknown {
  const parsed = tryParse(raw);
  if (parsed === undefined) throw new Error("invalid cached tool item");
  return parsed;
}

/** Go: repairResponsesToolCallItems. */
export function repairResponsesToolCallItems(
  outputCache: WebsocketToolOutputCache | undefined,
  callCache: WebsocketToolOutputCache | undefined,
  sessionKey: string,
  items: unknown[],
  allowOrphanOutputs: boolean,
  record: boolean,
  turn: ResponsesWebsocketToolCacheTurn | undefined,
  repairEnabled: boolean,
): unknown[] {
  if (!repairEnabled || !outputCache) return dedupeResponsesWebsocketInputItems(items);
  const metas = items.map(itemMeta);
  const outputPresent = new Set<string>();
  const callPresent = new Set<string>();
  items.forEach((item, index) => {
    const meta = metas[index]!;
    if (turn) turn.recordRawItem(meta.type, meta.callID, JSON.stringify(item));
    if (isResponsesToolCallOutputType(meta.type)) {
      if (meta.callID === "") return;
      outputPresent.add(meta.callID);
      if (record) outputCache.record(sessionKey, meta.callID, JSON.stringify(item));
    } else if (isResponsesToolCallType(meta.type)) {
      if (meta.callID === "") return;
      callPresent.add(meta.callID);
      if (record && callCache) callCache.record(sessionKey, meta.callID, JSON.stringify(item));
    }
  });

  const filtered: unknown[] = [];
  const insertedCalls = new Set<string>();
  items.forEach((item, index) => {
    const meta = metas[index]!;
    if (isResponsesToolCallOutputType(meta.type)) {
      if (meta.callID === "") {
        // Standalone named results (heartbeat / delegation input) have no call.
        if (meta.type === "function_call_output" && isObject(item) && typeof item.name === "string" && item.name.trim() !== "") filtered.push(item);
        return;
      }
      if (callPresent.has(meta.callID) || allowOrphanOutputs) {
        filtered.push(item);
        return;
      }
      const cached = callCache?.get(sessionKey, meta.callID);
      if (cached !== undefined) {
        if (!insertedCalls.has(meta.callID)) {
          filtered.push(parseCached(cached));
          insertedCalls.add(meta.callID);
          callPresent.add(meta.callID);
        }
        filtered.push(item);
      }
      // Orphaned outputs are dropped: upstream rejects transcripts with missing calls.
      return;
    }
    if (!isResponsesToolCallType(meta.type)) {
      filtered.push(item);
      return;
    }
    if (meta.callID === "") return;
    if (outputPresent.has(meta.callID) || allowOrphanOutputs) {
      filtered.push(item);
      return;
    }
    const cachedOutput = outputCache.get(sessionKey, meta.callID);
    if (cachedOutput !== undefined) {
      filtered.push(item, parseCached(cachedOutput));
      outputPresent.add(meta.callID);
    }
    // Orphaned calls are dropped: upstream rejects transcripts with missing outputs.
  });
  return dedupeResponsesWebsocketInputItems(filtered);
}

/** Records complete tool calls of a response payload in the call cache (Go: recordResponsesWebsocketToolCallsFromPayloadWithCache). */
export function recordResponsesWebsocketToolCallsFromPayloadWithCache(cache: WebsocketToolOutputCache | undefined, sessionKey: string, payload: JSONObject): void {
  const key = sessionKey.trim();
  if (key === "" || !cache) return;
  switch (jsonString(payload.type).trim()) {
    case "response.completed": {
      const output = isObject(payload.response) ? payload.response.output : undefined;
      if (!Array.isArray(output)) return;
      for (const item of output) {
        if (!isCompleteResponsesWebsocketToolCall(item)) continue;
        cache.record(key, jsonString((item as JSONObject).call_id).trim(), JSON.stringify(item));
      }
      return;
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = payload.item;
      if (!isCompleteResponsesWebsocketToolCall(item)) return;
      cache.record(key, jsonString((item as JSONObject).call_id).trim(), JSON.stringify(item));
    }
  }
}

export function recordResponsesWebsocketToolCallsFromPayload(sessionKey: string, payload: JSONObject): void {
  recordResponsesWebsocketToolCallsFromPayloadWithCache(defaultWebsocketToolCallCache, sessionKey, payload);
}

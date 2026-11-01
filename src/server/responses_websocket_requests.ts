// Request normalisation for the /v1/responses websocket transport. Port of
// sdk/api/handlers/openai/openai_responses_websocket_requests.go and the
// transcript helpers of openai_responses_websocket_prewarm.go: response.create /
// response.append frames become full Responses requests, either incremental
// (previous_response_id kept for a websocket upstream) or merged with the
// connection's previous request and response output (HTTP upstreams).
//
// Go worked on raw bytes with gjson/sjson; the port parses the frame once and
// works on plain objects (key order is kept: deleted keys vanish, added keys
// are appended like sjson does).
import type { ErrorMessage } from "../executor/types.ts";
import { isObject, tryParse, type JSONObject } from "../util/json.ts";

export const wsRequestTypeCreate = "response.create";
export const wsRequestTypeAppend = "response.append";

/** The Codex local compaction summary prefix (Go: codexLocalCompactionSummaryPrefix). */
export const codexLocalCompactionSummaryPrefix =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/** An ErrorMessage with a plain text error (Go: &interfaces.ErrorMessage{StatusCode, Error: fmt.Errorf(...)}). */
export function wsErrorMessage(status: number, message: string): ErrorMessage {
  return { statusCode: status, error: new Error(message) };
}

/** gjson Result.String() for the scalar fields read here. */
export function jsonString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/** gjson Result.Bool(). */
export function jsonBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim();
    return v === "1" || v === "t" || v === "T" || v === "true" || v === "TRUE" || v === "True";
  }
  return false;
}

/** Parses a frame as a JSON object ({} when it is not one). */
export function parseFrame(raw: string): JSONObject {
  const parsed = tryParse(raw);
  return isObject(parsed) ? parsed : {};
}

export function requestType(root: JSONObject): string {
  return jsonString(root.type).trim();
}

export interface NormalizedRequest {
  /** The normalised request (undefined on error). */
  request?: string;
  /** The connection's next lastRequest. */
  lastRequest: string;
  error?: ErrorMessage;
}

function fail(lastRequest: string, status: number, message: string): NormalizedRequest {
  return { lastRequest, error: wsErrorMessage(status, message) };
}

function done(root: JSONObject): NormalizedRequest {
  const json = JSON.stringify(root);
  return { request: json, lastRequest: json };
}

/** Go: normalizeResponsesWebsocketRequest (incremental and compaction bypass allowed). */
export function normalizeResponsesWebsocketRequest(raw: string, lastRequest: string, lastResponseOutput: string): NormalizedRequest {
  return normalizeResponsesWebsocketRequestWithIncrementalState(raw, lastRequest, lastResponseOutput, "", [], true, true);
}

/** Go: normalizeResponsesWebsocketRequestWithMode. */
export function normalizeResponsesWebsocketRequestWithMode(raw: string, lastRequest: string, lastResponseOutput: string, allowIncremental: boolean, allowCompactionReplayBypass: boolean): NormalizedRequest {
  return normalizeResponsesWebsocketRequestWithIncrementalState(raw, lastRequest, lastResponseOutput, "", [], allowIncremental, allowCompactionReplayBypass);
}

/** Go: normalizeResponsesWebsocketRequestWithIncrementalState. */
export function normalizeResponsesWebsocketRequestWithIncrementalState(
  raw: string,
  lastRequest: string,
  lastResponseOutput: string,
  lastResponseID: string,
  lastResponsePendingToolCallIDs: string[],
  allowIncremental: boolean,
  allowCompactionReplayBypass: boolean,
): NormalizedRequest {
  const root = parseFrame(raw);
  const type = requestType(root);
  switch (type) {
    case wsRequestTypeCreate:
      if (lastRequest.length === 0) return normalizeResponseCreateRequest(raw);
      return normalizeResponseSubsequentRequest(raw, lastRequest, lastResponseOutput, lastResponseID, lastResponsePendingToolCallIDs, allowIncremental, allowCompactionReplayBypass);
    case wsRequestTypeAppend:
      return normalizeResponseSubsequentRequest(raw, lastRequest, lastResponseOutput, lastResponseID, lastResponsePendingToolCallIDs, allowIncremental, allowCompactionReplayBypass);
    default:
      return fail(lastRequest, 400, `unsupported websocket request type: ${type}`);
  }
}

/** The first response.create of a connection (Go: normalizeResponseCreateRequest). */
export function normalizeResponseCreateRequest(raw: string): NormalizedRequest {
  const root = parseFrame(raw);
  if ("input" in root && !Array.isArray(root.input)) return fail("", 400, "websocket request requires array field: input");
  delete root.type;
  root.stream = true;
  if (!("input" in root)) root.input = [];
  if (jsonString(root.model).trim() === "") return fail("", 400, "missing model in response.create request");
  return done(root);
}

function inheritFromLastRequest(root: JSONObject, lastRequest: string): void {
  const last = parseFrame(lastRequest);
  if (!("model" in root)) {
    const model = jsonString(last.model).trim();
    if (model !== "") root.model = model;
  }
  if (!("instructions" in root) && "instructions" in last) root.instructions = last.instructions;
}

/** A follow-up create/append against the connection state (Go: normalizeResponseSubsequentRequest). */
export function normalizeResponseSubsequentRequest(
  raw: string,
  lastRequest: string,
  lastResponseOutput: string,
  lastResponseID: string,
  lastResponsePendingToolCallIDs: string[],
  allowIncremental: boolean,
  allowCompactionReplayBypass: boolean,
): NormalizedRequest {
  if (lastRequest.length === 0) return fail(lastRequest, 400, "websocket request received before response.create");
  const root = parseFrame(raw);
  const nextInput = root.input;
  if (!Array.isArray(nextInput)) return fail(lastRequest, 400, "websocket request requires array field: input");

  // A compacted transcript replaces the history instead of appending to it.
  if (shouldReplaceWebsocketTranscript(root, nextInput)) return done(normalizeResponseTranscriptReplacement(root, lastRequest));

  if (allowIncremental) {
    let prev = jsonString(root.previous_response_id).trim();
    if (prev === "") {
      if (!inputSatisfiesPendingToolCalls(nextInput, lastResponsePendingToolCallIDs)) return done(normalizeResponseTranscriptReplacement(root, lastRequest));
      prev = lastResponseID.trim();
    }
    if (prev !== "") {
      const normalized = { ...root };
      delete normalized.type;
      normalized.previous_response_id = prev;
      inheritFromLastRequest(normalized, lastRequest);
      normalized.stream = true;
      return done(normalized);
    }
  }

  let mergedInput: unknown[];
  if (allowCompactionReplayBypass && inputContainsFullTranscript(nextInput)) {
    mergedInput = nextInput;
  } else {
    const appendInput = inputContainsFullTranscript(nextInput) ? inputWithoutCompactionItems(nextInput) : nextInput;
    try {
      mergedInput = mergeResponsesWebsocketInput(lastRequest, lastResponseOutput, appendInput);
    } catch (err) {
      return fail(lastRequest, 400, err instanceof Error ? err.message : String(err));
    }
  }
  const normalized = { ...root };
  delete normalized.type;
  delete normalized.previous_response_id;
  inheritFromLastRequest(normalized, lastRequest);
  normalized.stream = true;
  normalized.input = mergedInput;
  return done(normalized);
}

/** Go: shouldReplaceWebsocketTranscript. */
export function shouldReplaceWebsocketTranscript(root: JSONObject, nextInput: unknown): boolean {
  const type = requestType(root);
  if (type !== wsRequestTypeCreate && type !== wsRequestTypeAppend) return false;
  if (jsonString(root.previous_response_id).trim() !== "") return false;
  if (!Array.isArray(nextInput)) return false;
  if (type === wsRequestTypeCreate && !("previous_response_id" in root) && inputHasCodexLocalCompactionSummary(nextInput)) return true;
  for (const item of nextInput) {
    const meta = itemMeta(item);
    if (meta.type === "function_call" || meta.type === "custom_tool_call") return true;
    if (meta.type === "message" && isObject(item) && jsonString(item.role).trim() === "assistant") return true;
  }
  return false;
}

/** Go: inputHasCodexLocalCompactionSummary. */
export function inputHasCodexLocalCompactionSummary(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  let hasSummary = false;
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    const obj = isObject(item) ? item : {};
    const itemType = jsonString(obj.type).trim();
    if (itemType === "additional_tools") {
      const tools = obj.tools;
      if (index !== 0 || jsonString(obj.role).trim() !== "developer" || !Array.isArray(tools)) return false;
      for (const tool of tools) {
        if (!isObject(tool) || jsonString(tool.type).trim() === "") return false;
      }
      continue;
    }
    if (itemType !== "" && itemType !== "message") return false;
    const role = jsonString(obj.role).trim();
    if (role !== "user" && role !== "developer") return false;
    if (role === "user" && codexLocalCompactionMessageText(obj).startsWith(codexLocalCompactionSummaryPrefix + "\n")) hasSummary = true;
  }
  return hasSummary;
}

/** Go: codexLocalCompactionMessageText. */
export function codexLocalCompactionMessageText(message: JSONObject): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (isObject(part) && jsonString(part.type).trim() === "input_text") text += jsonString(part.text);
  }
  return text;
}

/** Go: inputSatisfiesPendingToolCalls. */
export function inputSatisfiesPendingToolCalls(input: unknown, pendingCallIDs: string[]): boolean {
  if (pendingCallIDs.length === 0) return true;
  if (!Array.isArray(input)) return false;
  const outputs = new Set<string>();
  for (const item of input) {
    const meta = itemMeta(item);
    if ((meta.type === "function_call_output" || meta.type === "custom_tool_call_output") && meta.callID !== "") outputs.add(meta.callID);
  }
  for (const raw of pendingCallIDs) {
    const callID = raw.trim();
    if (callID !== "" && !outputs.has(callID)) return false;
  }
  return true;
}

/** A self-contained create replacing the transcript (Go: normalizeResponseTranscriptReplacement). */
export function normalizeResponseTranscriptReplacement(root: JSONObject, lastRequest: string): JSONObject {
  const normalized = { ...root };
  delete normalized.type;
  delete normalized.previous_response_id;
  inheritFromLastRequest(normalized, lastRequest);
  normalized.stream = true;
  return normalized;
}

// ---------------------------------------------------------------------------
// Input items
// ---------------------------------------------------------------------------

export interface ItemMeta {
  type: string;
  id: string;
  callID: string;
}

/** type / id / call_id of an input item, keys matched case-insensitively (Go: appendResponsesWebsocketMergeInputResult). */
export function itemMeta(item: unknown): ItemMeta {
  const meta: ItemMeta = { type: "", id: "", callID: "" };
  if (!isObject(item)) return meta;
  for (const [key, value] of Object.entries(item)) {
    const lower = key.toLowerCase();
    if (lower === "type") meta.type = jsonString(value).trim();
    else if (lower === "id") meta.id = jsonString(value).trim();
    else if (lower === "call_id") meta.callID = jsonString(value).trim();
  }
  return meta;
}

export function isResponsesToolCallType(itemType: string): boolean {
  const t = itemType.trim();
  return t === "function_call" || t === "custom_tool_call";
}

export function isResponsesToolCallOutputType(itemType: string): boolean {
  const t = itemType.trim();
  return t === "function_call_output" || t === "custom_tool_call_output";
}

/** Go: inputContainsFullTranscript (compaction markers, not assistant messages). */
export function inputContainsFullTranscript(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some((item) => {
    const type = isObject(item) ? jsonString(item.type) : "";
    return type === "compaction" || type === "compaction_summary";
  });
}

/** Go: inputWithoutCompactionItems. */
export function inputWithoutCompactionItems(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item) => {
    const type = isObject(item) ? jsonString(item.type) : "";
    return type !== "compaction" && type !== "compaction_summary";
  });
}

/** The previous request's input array; `input` matched case-insensitively, last one wins (Go: responsesWebsocketPreviousInputNoCopy). */
function previousInput(lastRequest: string): unknown[] {
  const parsed = tryParse(lastRequest);
  if (parsed === undefined) throw new Error("invalid previous request input: invalid JSON");
  if (parsed === null) return [];
  if (!isObject(parsed)) throw new Error("invalid previous request input: request is not an object");
  let input: unknown;
  let found = false;
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() !== "input") continue;
    found = true;
    if (value !== null && !Array.isArray(value)) throw new Error("invalid previous request input: input is not an array");
    input = value;
  }
  if (!found || input === null || input === undefined) return [];
  return input as unknown[];
}

/**
 * previous input + previous response output + new input, with duplicate tool
 * calls and duplicate ids removed (Go: mergeResponsesWebsocketInput). A
 * compaction in the previous output drops consumed compaction_trigger items.
 */
export function mergeResponsesWebsocketInput(lastRequest: string, lastResponseOutput: string, appendInput: unknown[]): unknown[] {
  let items = [...previousInput(lastRequest)];
  const trimmed = lastResponseOutput.trim();
  if (trimmed.startsWith("[")) {
    const output = tryParse(trimmed);
    if (Array.isArray(output)) {
      if (inputContainsFullTranscript(output)) items = items.filter((item) => itemMeta(item).type !== "compaction_trigger");
      items.push(...output);
    }
  }
  if (!Array.isArray(appendInput)) throw new Error("invalid request input: input is not an array");
  items.push(...appendInput);
  return dedupeResponsesWebsocketInputItems(dedupeResponsesWebsocketFunctionCalls(items));
}

/** Keeps the first tool call per call_id (Go: dedupeResponsesWebsocketFunctionCalls). */
export function dedupeResponsesWebsocketFunctionCalls(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const meta = itemMeta(item);
    if (isResponsesToolCallType(meta.type) && meta.callID !== "") {
      if (seen.has(meta.callID)) return false;
      seen.add(meta.callID);
    }
    return true;
  });
}

/**
 * One item per id: the last occurrence, but never replacing an item whose
 * call_id still has a matching output with one that does not
 * (Go: dedupeResponsesWebsocketInputItems).
 */
export function dedupeResponsesWebsocketInputItems(items: unknown[]): unknown[] {
  const metas = items.map(itemMeta);
  const referenced = new Set<string>();
  for (const meta of metas) if (isResponsesToolCallOutputType(meta.type) && meta.callID !== "") referenced.add(meta.callID);
  const keepIndex = new Map<string, number>();
  const keepReferenced = new Map<string, boolean>();
  metas.forEach((meta, index) => {
    if (meta.id === "") return;
    const isReferenced = meta.callID !== "" && referenced.has(meta.callID);
    if (!keepIndex.has(meta.id)) {
      keepIndex.set(meta.id, index);
      keepReferenced.set(meta.id, isReferenced);
      return;
    }
    if (isReferenced || !keepReferenced.get(meta.id)) {
      keepIndex.set(meta.id, index);
      keepReferenced.set(meta.id, isReferenced);
    }
  });
  return items.filter((_, index) => {
    const meta = metas[index]!;
    return meta.id === "" || keepIndex.get(meta.id) === index;
  });
}

/** Dedupes the input of a request by id (Go: dedupeResponsesWebsocketInputItemsByID). */
export function dedupeResponsesWebsocketInputItemsByID(payload: string): string {
  const root = tryParse(payload);
  if (!isObject(root) || !Array.isArray(root.input)) return payload;
  const deduped = dedupeResponsesWebsocketInputItems(root.input);
  if (deduped.length === root.input.length) return payload;
  root.input = deduped;
  return JSON.stringify(root);
}

/** A native websocket passthrough frame (Go: normalizeResponsesWebsocketPassthroughRequest). */
export function normalizeResponsesWebsocketPassthroughRequest(raw: string, modelName: string): { request?: string; error?: ErrorMessage } {
  const parsed = tryParse(raw);
  if (parsed === undefined) return { error: wsErrorMessage(400, "invalid websocket request JSON") };
  const root = isObject(parsed) ? { ...parsed } : {};
  const type = requestType(root);
  if (type !== wsRequestTypeCreate && type !== wsRequestTypeAppend) return { error: wsErrorMessage(400, `unsupported websocket request type: ${type}`) };
  if (jsonString(root.model).trim() === "") {
    const model = modelName.trim();
    if (model === "") return { error: wsErrorMessage(400, "missing model in response.create request") };
    root.model = model;
  }
  root.stream = true;
  return { request: JSON.stringify(root) };
}

// ---------------------------------------------------------------------------
// Prewarm (Go: openai_responses_websocket_prewarm.go)
// ---------------------------------------------------------------------------

/** A response.create with generate:false answered locally for HTTP upstreams (Go: shouldHandleResponsesWebsocketPrewarmLocally). */
export function shouldHandleResponsesWebsocketPrewarmLocally(root: JSONObject, allowIncremental: boolean): boolean {
  if (allowIncremental) return false;
  if (requestType(root) !== wsRequestTypeCreate) return false;
  return "generate" in root && !jsonBool(root.generate);
}

/**
 * A follow-up to a synthetic warm-up: the warm-up input never reached the
 * upstream, so it is materialised before the new input
 * (Go: normalizeResponsesWebsocketPrewarmFollowup).
 */
export function normalizeResponsesWebsocketPrewarmFollowup(raw: string, warmupRequest: string): NormalizedRequest {
  const root = parseFrame(raw);
  const type = requestType(root);
  if (type !== wsRequestTypeCreate && type !== wsRequestTypeAppend) return fail(warmupRequest, 400, `unsupported websocket request type: ${type}`);
  if (!Array.isArray(root.input)) return fail(warmupRequest, 400, "websocket request requires array field: input");
  let merged: unknown[];
  try {
    merged = mergeResponsesWebsocketInput(warmupRequest, "[]", root.input);
  } catch (err) {
    return fail(warmupRequest, 400, err instanceof Error ? err.message : String(err));
  }
  const normalized = normalizeResponseTranscriptReplacement(root, warmupRequest);
  normalized.input = merged;
  return done(normalized);
}

/** response.created + response.completed for a local warm-up (Go: syntheticResponsesWebsocketPrewarmPayloads). */
export function syntheticResponsesWebsocketPrewarmPayloads(requestJSON: string, nowMs: number, newId: () => string): string[] {
  const responseID = "resp_prewarm_" + newId();
  const createdAt = Math.floor(nowMs / 1000);
  const model = jsonString(parseFrame(requestJSON).model).trim();
  const created: JSONObject = {
    type: "response.created",
    sequence_number: 0,
    response: { id: responseID, object: "response", created_at: createdAt, status: "in_progress", background: false, error: null, output: [] },
  };
  const completed: JSONObject = {
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: responseID,
      object: "response",
      created_at: createdAt,
      status: "completed",
      background: false,
      error: null,
      output: [],
      usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
    },
  };
  if (model !== "") {
    (created.response as JSONObject).model = model;
    (completed.response as JSONObject).model = model;
  }
  return [JSON.stringify(created), JSON.stringify(completed)];
}

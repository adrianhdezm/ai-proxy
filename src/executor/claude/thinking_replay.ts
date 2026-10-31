// Thinking replay for Claude API-key credentials serving compat models. Port of
// internal/runtime/executor/claude_thinking_replay.go plus the shared helpers it
// reuses from kimi_thinking_replay.go (shouldClearKimiThinkingReplayAfterError,
// kimiThinkingReplayContentIsReplayable, restoreKimiThinkingReplayContent, the
// stream accumulator and wrapThinkingReplayStream) and the Claude-source branch
// of codexReasoningReplaySessionKey / xaiReasoningReplayIsolateSessionKey.
//
// Compat upstreams often require the signed thinking blocks of earlier
// tool-use turns, but many clients drop them from history. Each completed
// response whose content carries a signed thinking block and a tool_use is
// cached per (credential+model, session); a later request whose assistant turn
// matches that content minus thinking gets the cached content back.
import type { Auth } from "../../auth/types.ts";
import { AttributeAPIKey, AttributeAuthKind } from "../../auth/types.ts";
import { type ClaudeThinkingReplayCache, type ClaudeThinkingReplaySnapshot, claudeThinkingReplayJSONEqual, emptyClaudeThinkingReplaySnapshot, ClaudeThinkingReplayCacheMaxBlocksPerTurn, ClaudeThinkingReplayCacheMaxBytesPerSession } from "../../cache/claude_thinking_replay_cache.ts";
import { parseSuffix } from "../../thinking/suffix.ts";
import { FormatClaude } from "../../translator/types.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { sha256Hex } from "../../util/hash.ts";
import { tryParse } from "../../util/json.ts";
import { type ExecOptions, type ExecRequest, type StreamResult, statusCodeOf } from "../types.ts";
import { claudeCodeExecutionScope } from "./session.ts";
import { claudeCreds, headerValueCaseInsensitive, isClaudeOAuthToken } from "./upstream.ts";

/** Metadata key binding the resolved API-key model definition (Go: cliproxy.resolved_api_key_model_info). */
export const ClaudeResolvedModelInfoMetadataKey = "cliproxy.resolved_api_key_model_info";
/** Metadata key carrying the inbound client's API key (Go: helps.APIKeyFromContext). */
export const ClaudeCallerAPIKeyMetadataKey = "cliproxy.caller_api_key";
/** Execution session metadata key (Go: cliproxyexecutor.ExecutionSessionMetadataKey). */
export const ExecutionSessionMetadataKey = "execution_session_id";

export interface ClaudeThinkingReplayScope {
  modelFamily: string;
  sessionKey: string;
  snapshot: ClaudeThinkingReplaySnapshot;
  cacheReady: boolean;
  replayApplied: boolean;
}

export function emptyClaudeThinkingReplayScope(): ClaudeThinkingReplayScope {
  return { modelFamily: "", sessionKey: "", snapshot: emptyClaudeThinkingReplaySnapshot(), cacheReady: false, replayApplied: false };
}

export function claudeThinkingReplayScopeValid(scope: ClaudeThinkingReplayScope): boolean {
  return scope.modelFamily.trim() !== "" && scope.sessionKey.trim() !== "";
}

/** Whether the selected API-key model enables compat handling (Go: helps.APIKeyModelIsCompat). */
export function apiKeyModelIsCompat(req: ExecRequest): boolean {
  const info = req.metadata?.[ClaudeResolvedModelInfoMetadataKey];
  return isObj(info) && info.isCompat === true;
}

function authIsAPIKeyKind(auth: Auth): boolean {
  const kind = (auth.attributes?.[AttributeAuthKind] ?? "").trim().toLowerCase();
  if (kind !== "") return kind === "apikey" || kind === "api_key" || kind === "api-key";
  return (auth.attributes?.[AttributeAPIKey] ?? "").trim() !== "";
}

/** Replay applies to Claude-format callers on Claude API keys with compat models (Go: claudeThinkingReplayEnabled). */
export function claudeThinkingReplayEnabled(auth: Auth | undefined, req: ExecRequest, opts: ExecOptions): boolean {
  if (!auth || opts.sourceFormat.trim().toLowerCase() !== FormatClaude) return false;
  if (auth.provider.trim().toLowerCase() !== "claude" || !authIsAPIKeyKind(auth)) return false;
  if (!apiKeyModelIsCompat(req)) return false;
  const { apiKey } = claudeCreds(auth);
  return apiKey.trim() !== "" && !isClaudeOAuthToken(apiKey);
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const v = metadata?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function sessionKeyFromTurnMetadata(turnMetadata: string): string {
  const root = tryParse(turnMetadata);
  const promptCacheKey = gstr(getAt(root, "prompt_cache_key")).trim();
  if (promptCacheKey !== "") return "prompt-cache:" + promptCacheKey;
  const windowID = gstr(getAt(root, "window_id")).trim();
  if (windowID !== "") return "window:" + windowID;
  return "";
}

function sessionKeyFromPayload(payload: string): string {
  if (payload === "") return "";
  const root = tryParse(payload);
  const promptCacheKey = gstr(getAt(root, "prompt_cache_key")).trim();
  if (promptCacheKey !== "") return "prompt-cache:" + promptCacheKey;
  const clientMetadata = getAt(root, "client_metadata");
  const windowID = isObj(clientMetadata) ? gstr(clientMetadata["x-codex-window-id"]).trim() : "";
  if (windowID !== "") return "window:" + windowID;
  const turnMetadata = isObj(clientMetadata) ? gstr(clientMetadata["x-codex-turn-metadata"]).trim() : "";
  if (turnMetadata !== "") return sessionKeyFromTurnMetadata(turnMetadata);
  return "";
}

function sessionKeyFromHeaders(headers: Headers | undefined): string {
  if (!headers) return "";
  const turnMetadata = (headers.get("X-Codex-Turn-Metadata") ?? "").trim();
  if (turnMetadata !== "") {
    const key = sessionKeyFromTurnMetadata(turnMetadata);
    if (key !== "") return key;
  }
  const windowID = headerValueCaseInsensitive(headers, "X-Codex-Window-Id").trim();
  if (windowID !== "") return "window:" + windowID;
  for (const name of ["Session_id", "session_id", "Session-Id"]) {
    const value = headerValueCaseInsensitive(headers, name).trim();
    if (value !== "") return "session-id:" + value;
  }
  const conversationID = headerValueCaseInsensitive(headers, "Conversation_id").trim();
  if (conversationID !== "") return "conversation_id:" + conversationID;
  return "";
}

/**
 * The replay session key of a Claude-format request (Go: codexReasoningReplaySessionKey
 * for FormatClaude followed by xaiReasoningReplayIsolateSessionKey). Client-controlled
 * keys are namespaced by the caller API key; without one replay is disabled.
 */
export function claudeThinkingReplaySessionKey(req: ExecRequest, opts: ExecOptions): string {
  let key = claudeCodeExecutionScope(req.payload, opts.headers);
  if (key === "") {
    const execution = metadataString(opts.metadata, ExecutionSessionMetadataKey) || metadataString(req.metadata, ExecutionSessionMetadataKey);
    if (execution !== "") key = "execution:" + execution;
  }
  if (key === "") key = sessionKeyFromPayload(req.payload) || sessionKeyFromHeaders(opts.headers);
  key = key.trim();
  if (key === "" || key.startsWith("execution:")) return key;
  const callerKey = metadataString(opts.metadata, ClaudeCallerAPIKeyMetadataKey) || metadataString(req.metadata, ClaudeCallerAPIKeyMetadataKey);
  if (callerKey === "") return "";
  return "caller:" + sha256Hex(callerKey).slice(0, 16) + ":" + key;
}

/** "claude:<sha256(identity)[:8]>:<model>" (Go: claudeThinkingReplayModelFamily). */
export function claudeThinkingReplayModelFamily(auth: Auth | undefined, model: string): string {
  const baseModel = parseSuffix(model.trim()).modelName;
  if (baseModel === "") return "";
  let identity = (auth?.id ?? "").trim();
  if (identity === "" && auth) {
    const { apiKey, baseURL } = claudeCreds(auth);
    identity = baseURL.trim() || apiKey.trim();
  }
  if (identity === "") return "claude:" + baseModel;
  return "claude:" + sha256Hex(identity).slice(0, 16) + ":" + baseModel;
}

export function claudeThinkingReplayScopeFromRequest(auth: Auth | undefined, req: ExecRequest, opts: ExecOptions): ClaudeThinkingReplayScope {
  return { ...emptyClaudeThinkingReplayScope(), modelFamily: claudeThinkingReplayModelFamily(auth, req.model), sessionKey: claudeThinkingReplaySessionKey(req, opts) };
}

// --- content helpers (Go: kimi*) ---------------------------------------------

/** Cacheable when the content has a signed thinking block and a tool_use with an id. */
export function claudeThinkingReplayContentIsReplayable(content: string): boolean {
  const root = tryParse(content);
  if (!Array.isArray(root)) return false;
  let signedThinking = false;
  let toolUse = false;
  for (const part of root) {
    const type = gstr(getAt(part, "type")).trim();
    if (type === "thinking" && gstr(getAt(part, "signature")).trim() !== "") signedThinking = true;
    if (type === "tool_use" && gstr(getAt(part, "id")).trim() !== "") toolUse = true;
  }
  return signedThinking && toolUse;
}

function contentHasThinking(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const type = gstr(getAt(part, "type")).trim();
    return type === "thinking" || type === "redacted_thinking";
  });
}

/** Non-thinking parts in canonical form; undefined unless the content has a tool_use with an id. */
function nonThinkingContentParts(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  let hasToolUse = false;
  for (const part of content) {
    const type = gstr(getAt(part, "type")).trim();
    if (type === "thinking" || type === "redacted_thinking") continue;
    if (type === "tool_use") {
      if (gstr(getAt(part, "id")).trim() === "") return undefined;
      hasToolUse = true;
    }
    parts.push(canonical(part));
  }
  return hasToolUse ? parts : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Restores one cached assistant content into the latest matching assistant
 * turn that lacks thinking (Go: restoreKimiThinkingReplayContent).
 */
export function restoreThinkingReplayContent(body: string, cachedContent: string): { body: string; restored: boolean } {
  const cached = tryParse(cachedContent);
  const cachedParts = nonThinkingContentParts(cached);
  if (!cachedParts) return { body, restored: false };
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root) || !Array.isArray(root.messages)) return { body, restored: false };
  for (let index = root.messages.length - 1; index >= 0; index--) {
    const message = root.messages[index];
    if (gstr(getAt(message, "role")).trim().toLowerCase() !== "assistant") continue;
    const current = getAt(message, "content");
    if (current !== undefined && claudeThinkingReplayJSONEqual(JSON.stringify(current), cachedContent)) return { body, restored: false };
    if (contentHasThinking(current)) continue;
    const currentParts = nonThinkingContentParts(current);
    if (!currentParts || currentParts.length !== cachedParts.length || currentParts.some((p, i) => p !== cachedParts[i])) continue;
    (message as Record<string, unknown>).content = cached;
    return { body: JSON.stringify(root), restored: true };
  }
  return { body, restored: false };
}

/** Applies every cached turn in order (Go: restoreClaudeThinkingReplayContents). */
export function restoreClaudeThinkingReplayContents(body: string, cachedContents: string[]): { body: string; restored: boolean } {
  let restored = false;
  for (const content of cachedContents) {
    const r = restoreThinkingReplayContent(body, content);
    body = r.body;
    restored ||= r.restored;
  }
  return { body, restored };
}

/** Reads the cache and restores dropped thinking into the request (Go: prepareClaudeThinkingReplayRequest). */
export function prepareClaudeThinkingReplayRequest(cache: ClaudeThinkingReplayCache, auth: Auth | undefined, req: ExecRequest, opts: ExecOptions): { req: ExecRequest; scope: ClaudeThinkingReplayScope } {
  const scope = claudeThinkingReplayScopeFromRequest(auth, req, opts);
  if (!claudeThinkingReplayScopeValid(scope)) return { req, scope };
  const { contents, snapshot, found } = cache.getWithSnapshot(scope.modelFamily, scope.sessionKey);
  scope.snapshot = snapshot;
  scope.cacheReady = true;
  if (!found) return { req, scope };
  const r = restoreClaudeThinkingReplayContents(req.payload, contents);
  if (r.restored) {
    req = { ...req, payload: r.body };
    scope.replayApplied = true;
  }
  return { req, scope };
}

/** Caches a replayable content or clears stale state (Go: cacheClaudeThinkingReplayContent). */
export function cacheClaudeThinkingReplayContent(cache: ClaudeThinkingReplayCache, scope: ClaudeThinkingReplayScope, content: string): void {
  if (!claudeThinkingReplayScopeValid(scope) || !scope.cacheReady) return;
  if (claudeThinkingReplayContentIsReplayable(content)) {
    cache.replaceIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot, content);
    return;
  }
  clearClaudeThinkingReplayContent(cache, scope);
}

export function clearClaudeThinkingReplayContent(cache: ClaudeThinkingReplayCache, scope: ClaudeThinkingReplayScope): void {
  if (!claudeThinkingReplayScopeValid(scope) || !scope.cacheReady) return;
  cache.deleteIfUnchanged(scope.modelFamily, scope.sessionKey, scope.snapshot);
}

/** Caches the content of a JSON response or a buffered SSE response (Go: cacheClaudeThinkingReplayResponse). */
export function cacheClaudeThinkingReplayResponse(cache: ClaudeThinkingReplayCache, scope: ClaudeThinkingReplayScope, response: string): void {
  if (!claudeThinkingReplayScopeValid(scope)) return;
  const content = getAt(tryParse(response), "content");
  if (Array.isArray(content)) {
    cacheClaudeThinkingReplayContent(cache, scope, JSON.stringify(content));
    return;
  }
  const acc = new ThinkingReplayStreamAccumulator();
  acc.observe(response);
  const assembled = acc.content();
  if (assembled !== undefined) cacheClaudeThinkingReplayContent(cache, scope, assembled);
}

/** Replay is cleared after request-scoped 400/422 rejections (Go: shouldClearKimiThinkingReplayAfterError). */
export function shouldClearThinkingReplayAfterError(err: unknown): boolean {
  const status = statusCodeOf(err);
  return status === 400 || status === 422;
}

interface StreamBlock {
  raw: Record<string, unknown>;
  text?: string;
  thinking?: string;
  signature?: string;
  input: string;
  hasInputDelta: boolean;
  finished: boolean;
}

/** Rebuilds the assistant content from Claude SSE events (Go: kimiThinkingReplayStreamAccumulator). */
export class ThinkingReplayStreamAccumulator {
  private blocks: Map<number, StreamBlock> | undefined = new Map();
  private observed = false;
  private complete = false;
  upstreamError = false;
  private abandoned = false;
  private bytesUsed = 0;

  observe(chunk: string): void {
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      const root = tryParse<Record<string, unknown>>(payload);
      if (root === undefined) {
        this.abandon();
        continue;
      }
      switch (gstr(getAt(root, "type"))) {
        case "message_start":
          this.observed = true;
          break;
        case "content_block_start":
          if (!this.abandoned) this.blockStart(root);
          break;
        case "content_block_delta":
          if (!this.abandoned) this.blockDelta(root);
          break;
        case "content_block_stop":
          if (!this.abandoned) this.finishBlock(Number(getAt(root, "index") ?? 0));
          break;
        case "message_stop":
          this.complete = true;
          break;
        case "error":
          this.upstreamError = true;
          this.abandon();
          break;
      }
    }
  }

  private reserve(count: number): boolean {
    if (count < 0 || this.bytesUsed > ClaudeThinkingReplayCacheMaxBytesPerSession - count) {
      this.abandon();
      return false;
    }
    this.bytesUsed += count;
    return true;
  }

  private abandon(): void {
    this.abandoned = true;
    this.blocks = undefined;
    this.bytesUsed = 0;
  }

  private blockStart(root: Record<string, unknown>): void {
    const index = Number(getAt(root, "index") ?? 0);
    const block = getAt(root, "content_block");
    if (!this.blocks || !isObj(block) || this.blocks.size >= ClaudeThinkingReplayCacheMaxBlocksPerTurn || this.blocks.has(index)) {
      this.abandon();
      return;
    }
    if (!this.reserve(JSON.stringify(block).length)) return;
    this.blocks.set(index, { raw: block, input: "", hasInputDelta: false, finished: false });
  }

  private append(block: StreamBlock, field: "text" | "thinking" | "signature", suffix: string): void {
    if (block[field] === undefined) {
      const initial = gstr(block.raw[field]);
      if (!this.reserve(initial.length)) return;
      block[field] = initial;
    }
    if (this.reserve(suffix.length)) block[field] += suffix;
  }

  private blockDelta(root: Record<string, unknown>): void {
    const block = this.blocks?.get(Number(getAt(root, "index") ?? 0));
    if (!block) {
      this.abandon();
      return;
    }
    const delta = getAt(root, "delta");
    switch (gstr(getAt(delta, "type"))) {
      case "text_delta":
        this.append(block, "text", gstr(getAt(delta, "text")));
        break;
      case "thinking_delta":
        this.append(block, "thinking", gstr(getAt(delta, "thinking")));
        break;
      case "signature_delta":
        this.append(block, "signature", gstr(getAt(delta, "signature")));
        break;
      case "input_json_delta": {
        const suffix = gstr(getAt(delta, "partial_json"));
        if (this.reserve(suffix.length)) {
          block.input += suffix;
          block.hasInputDelta = true;
        }
        break;
      }
      default:
        this.abandon();
    }
  }

  private finishBlock(index: number): void {
    const block = this.blocks?.get(index);
    if (!block) {
      this.abandon();
      return;
    }
    if (block.hasInputDelta && tryParse(block.input) === undefined) {
      this.abandon();
      return;
    }
    block.finished = true;
  }

  /** The completed content array, or undefined when the stream did not finish cleanly. */
  content(): string | undefined {
    if (!this.observed || !this.complete || this.upstreamError || this.abandoned || !this.blocks) return undefined;
    const parts: unknown[] = [];
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      const block = this.blocks.get(index)!;
      if (!block.finished) {
        this.abandon();
        return undefined;
      }
      const raw: Record<string, unknown> = { ...block.raw };
      if (block.text !== undefined) raw.text = block.text;
      if (block.thinking !== undefined) raw.thinking = block.thinking;
      if (block.signature !== undefined) raw.signature = block.signature;
      if (block.hasInputDelta) raw.input = JSON.parse(block.input);
      parts.push(raw);
    }
    const content = JSON.stringify(parts);
    if (Buffer.byteLength(content, "utf8") > ClaudeThinkingReplayCacheMaxBytesPerSession) {
      this.abandon();
      return undefined;
    }
    return content;
  }
}

/**
 * Observes every forwarded chunk and caches the completed content when the
 * stream ends cleanly (Go: wrapClaudeThinkingReplayStream / wrapThinkingReplayStream).
 * A stream error leaves the cache alone; an upstream error event clears an
 * applied replay.
 */
export function wrapClaudeThinkingReplayStream(cache: ClaudeThinkingReplayCache, result: StreamResult, scope: ClaudeThinkingReplayScope): StreamResult {
  if (!claudeThinkingReplayScopeValid(scope)) return result;
  async function* wrapped(): AsyncGenerator<string> {
    const acc = new ThinkingReplayStreamAccumulator();
    for await (const chunk of result.chunks) {
      acc.observe(chunk);
      yield chunk;
    }
    const content = acc.content();
    if (content !== undefined) {
      cacheClaudeThinkingReplayContent(cache, scope, content);
      return;
    }
    if (acc.upstreamError && scope.replayApplied) clearClaudeThinkingReplayContent(cache, scope);
  }
  return { headers: result.headers, chunks: wrapped() };
}


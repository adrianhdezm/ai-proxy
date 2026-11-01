// Codex reasoning replay: the executor half of
// internal/runtime/executor/codex_executor_reasoning.go.
//
// A Claude Messages client keeps only the visible text of earlier assistant
// turns; the encrypted reasoning items (and the tool calls they led to) that
// Codex returned are lost unless the client echoes a thinking signature. The
// executor caches those items from response.completed per (model, session) and,
// when a later turn of the same session arrives without them, re-inserts each
// cached turn in front of the input item it belongs to (anchored by tool call
// ids, the assistant message text fingerprint and the request prefix
// fingerprint). An invalid-signature rejection clears the session.
//
// Only Claude inbound requests take part (Go: codexReasoningReplayEnabledForSource).
// Dropped from upstream: the gin-context header fallback (the inbound headers
// arrive as ExecOptions.headers here) and the OpenAI-inbound API-key session
// key, which never applies to Claude inbound.
import { CodexReasoningReplayTurnType, type CodexReasoningReplayCache } from "../../cache/codex_reasoning_replay_cache.ts";
import { FormatClaude, type Format } from "../../translator/types.ts";
import { parseSuffix } from "../../thinking/index.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { sha256Hex } from "../../util/hash.ts";
import { sanitizeClaudeToolID } from "../../util/claude_tool_id.ts";
import { signaturePayloadWithoutProviderPrefix } from "../../signature/provider_compatibility.ts";
import { inspectGPTReasoningSignature, isValidGPTReasoningSignature } from "../../signature/gpt_validation.ts";
import { inspectMetaReasoningSignature, isValidMetaReasoningSignature } from "../../signature/meta_validation.ts";
import { inspectGrokEncryptedContent, isValidGrokEncryptedContent } from "../../signature/grok_validation.ts";
import type { ExecOptions, ExecRequest } from "../types.ts";
import { codexStatusErrorClassification } from "./errors.ts";

/** Go: cliproxyexecutor.ExecutionSessionMetadataKey. */
export const ExecutionSessionMetadataKey = "execution_session_id";
/** Go: helps.ClaudeCodeSessionHeader / ClaudeCodeAgentHeader / ClaudeCodeMainAgentID. */
export const ClaudeCodeSessionHeader = "X-Claude-Code-Session-Id";
export const ClaudeCodeAgentHeader = "X-Claude-Code-Agent-Id";
export const ClaudeCodeMainAgentID = "main";

export interface CodexReasoningReplayScope {
  modelName: string;
  sessionKey: string;
  requestFingerprint: string;
}

export function emptyCodexReasoningReplayScope(): CodexReasoningReplayScope {
  return { modelName: "", sessionKey: "", requestFingerprint: "" };
}

export function codexReasoningReplayScopeValid(scope: CodexReasoningReplayScope | undefined): scope is CodexReasoningReplayScope {
  return !!scope && scope.modelName.trim() !== "" && scope.sessionKey.trim() !== "";
}

/** Raw JSON of one parsed input item (Go: gjson Result.Raw of the compact body). */
function rawOf(item: unknown): string {
  return JSON.stringify(item) ?? "null";
}

function typeOf(item: unknown): string {
  return gstr(getAt(item, "type")).trim();
}

function sourceFormatEqual(from: Format, want: Format): boolean {
  return String(from ?? "").trim().toLowerCase() === want.toLowerCase();
}

export function codexReasoningReplayEnabledForSource(from: Format): boolean {
  return sourceFormatEqual(from, FormatClaude);
}

/** Go: codexReasoningReplayScopeFromRequest. `body` is the translated upstream body before replay insertion. */
export function codexReasoningReplayScopeFromRequest(from: Format, req: ExecRequest, opts: ExecOptions, body: string): CodexReasoningReplayScope {
  if (!codexReasoningReplayEnabledForSource(from)) return emptyCodexReasoningReplayScope();
  const root = tryParse(body);
  let modelName = gstr(getAt(root, "model")).trim();
  if (modelName === "") modelName = parseSuffix(req.model).modelName;
  const input = getAt(root, "input");
  const inputItems = isArr(input) ? input : [];
  return {
    modelName,
    sessionKey: codexReasoningReplaySessionKey(from, req, opts, body),
    requestFingerprint: codexReplayInputPrefixFingerprint(inputItems, inputItems.length),
  };
}

// ---------------------------------------------------------------------------
// Session key derivation
// ---------------------------------------------------------------------------

/** First non-empty value of a header, case-insensitively (Go: headerValueCaseInsensitive). */
function headerValue(headers: Headers | undefined, name: string): string {
  if (!headers) return "";
  return (headers.get(name) ?? "").trim();
}

const claudeCodeSessionSuffixPattern = /_session_([a-f0-9-]+)$/;

/** Go: extractClaudeCodeSessionIDFromPayload. A bare metadata.user_id is not a session. */
export function extractClaudeCodeSessionIDFromPayload(payload: string): string {
  if (payload.length === 0) return "";
  const userID = gstr(getAt(tryParse(payload), "metadata.user_id"));
  if (userID === "") return "";
  const match = claudeCodeSessionSuffixPattern.exec(userID);
  if (match) return match[1]!;
  if (userID.startsWith("{")) return gstr(getAt(tryParse(userID), "session_id")).trim();
  return "";
}

/** Go: helps.ExtractClaudeCodeSessionID: the session header wins over payload metadata. */
export function extractClaudeCodeSessionID(payload: string, headers: Headers | undefined): string {
  const header = headerValue(headers, ClaudeCodeSessionHeader);
  if (header !== "") return header;
  return extractClaudeCodeSessionIDFromPayload(payload);
}

/** Go: helps.ExtractClaudeCodeAgentID. */
export function extractClaudeCodeAgentID(headers: Headers | undefined): string {
  const header = headerValue(headers, ClaudeCodeAgentHeader);
  return header !== "" ? header : ClaudeCodeMainAgentID;
}

/** Go: helps.ClaudeCodeExecutionScope: "claude:<session>:agent:<agent>", or "" without a session. */
export function claudeCodeExecutionScope(payload: string, headers: Headers | undefined): string {
  const sessionID = extractClaudeCodeSessionID(payload, headers);
  if (sessionID === "") return "";
  return "claude:" + sessionID + ":agent:" + extractClaudeCodeAgentID(headers);
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const raw = metadata?.[key];
  if (typeof raw === "string") return raw.trim();
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw).trim();
  return "";
}

/** Go: codexReasoningReplaySessionKey (Claude inbound branches). */
export function codexReasoningReplaySessionKey(from: Format, req: ExecRequest, opts: ExecOptions, body: string): string {
  if (sourceFormatEqual(from, FormatClaude)) {
    const scope = claudeCodeExecutionScope(req.payload, opts.headers);
    if (scope !== "") return scope;
  }
  let value = metadataString(opts.metadata, ExecutionSessionMetadataKey);
  if (value !== "") return "execution:" + value;
  value = metadataString(req.metadata, ExecutionSessionMetadataKey);
  if (value !== "") return "execution:" + value;
  value = codexReasoningReplaySessionKeyFromPayload(body);
  if (value !== "") return value;
  value = codexReasoningReplaySessionKeyFromPayload(req.payload);
  if (value !== "") return value;
  return codexReasoningReplaySessionKeyFromHeaders(opts.headers);
}

/** Go: codexReasoningReplaySessionKeyFromPayload. */
export function codexReasoningReplaySessionKeyFromPayload(payload: string): string {
  if (payload.length === 0) return "";
  const root = tryParse(payload);
  const promptCacheKey = gstr(getAt(root, "prompt_cache_key")).trim();
  if (promptCacheKey !== "") return "prompt-cache:" + promptCacheKey;
  const clientMetadata = getAt(root, "client_metadata");
  const windowID = gstr(isObj(clientMetadata) ? clientMetadata["x-codex-window-id"] : undefined).trim();
  if (windowID !== "") return "window:" + windowID;
  const turnMetadata = gstr(isObj(clientMetadata) ? clientMetadata["x-codex-turn-metadata"] : undefined).trim();
  if (turnMetadata !== "") return codexReasoningReplaySessionKeyFromTurnMetadata(turnMetadata);
  return "";
}

/** Go: codexReasoningReplaySessionKeyFromHeaders. Fetch headers are case-insensitive already. */
export function codexReasoningReplaySessionKeyFromHeaders(headers: Headers | undefined): string {
  if (!headers) return "";
  const turnMetadata = headerValue(headers, "X-Codex-Turn-Metadata");
  if (turnMetadata !== "") {
    const key = codexReasoningReplaySessionKeyFromTurnMetadata(turnMetadata);
    if (key !== "") return key;
  }
  const windowID = headerValue(headers, "X-Codex-Window-Id");
  if (windowID !== "") return "window:" + windowID;
  for (const name of ["Session_id", "Session-Id"]) {
    const value = headerValue(headers, name);
    if (value !== "") return "session-id:" + value;
  }
  const conversationID = headerValue(headers, "Conversation_id");
  if (conversationID !== "") return "conversation_id:" + conversationID;
  return "";
}

function codexReasoningReplaySessionKeyFromTurnMetadata(turnMetadata: string): string {
  const root = tryParse(turnMetadata);
  const promptCacheKey = gstr(getAt(root, "prompt_cache_key")).trim();
  if (promptCacheKey !== "") return "prompt-cache:" + promptCacheKey;
  const windowID = gstr(getAt(root, "window_id")).trim();
  if (windowID !== "") return "window:" + windowID;
  return "";
}

// ---------------------------------------------------------------------------
// Request side: insertion
// ---------------------------------------------------------------------------

/**
 * Re-inserts the cached turns of the request's session (Go:
 * applyCodexReasoningReplayCacheRequired). Returns the scope even when nothing
 * was inserted, so the response can be cached under it.
 */
export function applyCodexReasoningReplayCache(
  cache: CodexReasoningReplayCache,
  from: Format,
  req: ExecRequest,
  opts: ExecOptions,
  body: string,
): { body: string; scope: CodexReasoningReplayScope } {
  const scope = codexReasoningReplayScopeFromRequest(from, req, opts, body);
  if (!codexReasoningReplayScopeValid(scope)) return { body, scope };
  const items = cache.getItems(scope.modelName, scope.sessionKey);
  if (!items) return { body, scope };
  const inserted = insertCodexReasoningReplayTurns(body, items);
  return { body: inserted.ok ? inserted.body : body, scope };
}

function codexInputHasValidReasoningEncryptedContent(inputItems: unknown[]): boolean {
  for (const item of inputItems) {
    if (typeOf(item) !== "reasoning") continue;
    const encrypted = getAt(item, "encrypted_content");
    if (typeof encrypted !== "string") continue;
    const rawSig = signaturePayloadWithoutProviderPrefix(encrypted);
    if (isValidGPTReasoningSignature(rawSig) || isValidMetaReasoningSignature(rawSig) || isValidGrokEncryptedContent(rawSig)) return true;
  }
  return false;
}

interface ReplayTurn {
  marked: boolean;
  assistantFingerprint: string;
  requestFingerprint: string;
  callIDs: string[];
  items: string[];
}

/** Go: insertCodexReasoningReplayTurns. Newest turns are anchored first. */
export function insertCodexReasoningReplayTurns(body: string, replayItems: string[]): { body: string; ok: boolean } {
  const root = tryParse(body);
  const input = getAt(root, "input");
  if (!isObj(root) || !isArr(input) || replayItems.length === 0) return { body, ok: false };
  const inputItems = input;
  const turns = splitCodexReasoningReplayTurns(replayItems);
  const insertions = new Map<number, string[]>();
  const usedAnchorIndexes = new Set<number>();
  const prefixFingerprints = new CodexReplayPrefixFingerprints(inputItems);
  let fallbackAnchorEnd = inputItems.length - 1;
  let inserted = false;
  const prepend = (index: number, items: string[]) => insertions.set(index, [...items, ...(insertions.get(index) ?? [])]);
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex]!;
    if (turn.items.length === 0) continue;
    if (!turn.marked) {
      let items = filterCodexReasoningReplayItemsForInput(inputItems, turn.items);
      if (items.length === 0) continue;
      const index = codexReasoningReplayInsertIndex(inputItems, items);
      items = codexAlignReasoningReplayToolCallIDs(inputItems, items);
      prepend(index, items);
      inserted = true;
      continue;
    }
    const anchor = codexReasoningReplayTurnAnchorIndex(inputItems, turn, fallbackAnchorEnd, usedAnchorIndexes, prefixFingerprints);
    if (anchor === undefined) continue;
    usedAnchorIndexes.add(anchor);
    if (turn.requestFingerprint === "") fallbackAnchorEnd = anchor - 1;
    let items = filterCodexReasoningReplayTurnItems(inputItems, turn.items);
    if (items.length === 0) continue;
    items = codexAlignReasoningReplayToolCallIDs(inputItems, items);
    prepend(anchor, items);
    inserted = true;
  }
  if (!inserted) return { body, ok: false };

  const rebuilt: unknown[] = [];
  inputItems.forEach((item, index) => {
    for (const replay of insertions.get(index) ?? []) rebuilt.push(JSON.parse(replay));
    rebuilt.push(item);
  });
  for (const replay of insertions.get(inputItems.length) ?? []) rebuilt.push(JSON.parse(replay));
  root.input = rebuilt;
  return { body: JSON.stringify(root), ok: true };
}

function splitCodexReasoningReplayTurns(items: string[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let current: ReplayTurn = { marked: false, assistantFingerprint: "", requestFingerprint: "", callIDs: [], items: [] };
  for (const item of items) {
    const parsed = tryParse(item);
    if (typeOf(parsed) === CodexReasoningReplayTurnType) {
      if (current.items.length > 0) turns.push(current);
      const callIDs = getAt(parsed, "call_ids");
      current = {
        marked: true,
        assistantFingerprint: gstr(getAt(parsed, "assistant_fingerprint")).trim(),
        requestFingerprint: gstr(getAt(parsed, "request_fingerprint")).trim(),
        callIDs: isArr(callIDs) ? callIDs.map((v) => gstr(v).trim()).filter((v) => v !== "") : [],
        items: [],
      };
      continue;
    }
    current.items.push(item);
  }
  if (current.items.length > 0) turns.push(current);
  return turns;
}

const toolItemTypes = new Set(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);

function codexReasoningReplayTurnAnchorIndex(
  inputItems: unknown[],
  turn: ReplayTurn,
  fallbackEnd: number,
  used: Set<number>,
  prefixFingerprints: CodexReplayPrefixFingerprints,
): number | undefined {
  let searchEnd = fallbackEnd;
  if (turn.requestFingerprint !== "") searchEnd = inputItems.length - 1;
  if (searchEnd >= inputItems.length) searchEnd = inputItems.length - 1;
  const matchesRequestPrefix = (index: number) => turn.requestFingerprint === "" || prefixFingerprints.at(index) === turn.requestFingerprint;
  if (turn.callIDs.length > 0) {
    const callIDs = new Set<string>();
    for (const callID of turn.callIDs) for (const candidate of codexReplayComparableCallIDs(callID)) callIDs.add(candidate);
    for (let index = searchEnd; index >= 0; index--) {
      if (used.has(index) || !matchesRequestPrefix(index)) continue;
      if (!toolItemTypes.has(typeOf(inputItems[index]))) continue;
      for (const candidate of codexReplayComparableCallIDs(gstr(getAt(inputItems[index], "call_id")))) {
        if (callIDs.has(candidate)) return index;
      }
    }
  }
  if (turn.assistantFingerprint !== "") {
    for (let index = searchEnd; index >= 0; index--) {
      if (used.has(index) || !matchesRequestPrefix(index)) continue;
      if (codexReplayAssistantMessageFingerprint(inputItems[index]) === turn.assistantFingerprint) return index;
    }
  }
  if (turn.callIDs.length === 0 && turn.assistantFingerprint === "") return codexReasoningReplayInsertIndex(inputItems, turn.items);
  return undefined;
}

function stripRouterSuffix(rawSignature: string, suffix: string): string {
  if (suffix === "" || rawSignature.length <= suffix.length + 1) return rawSignature;
  return rawSignature.slice(0, rawSignature.length - suffix.length - 1);
}

/** The signature without provider prefix and router suffix (Go: canonicalCodexReasoningReplaySignatureKey). */
export function canonicalCodexReasoningReplaySignatureKey(rawSignature: string): string {
  const sig = signaturePayloadWithoutProviderPrefix(rawSignature.trim());
  for (const inspect of [inspectGPTReasoningSignature, inspectMetaReasoningSignature, inspectGrokEncryptedContent]) {
    try {
      const info = inspect(sig);
      if (info.routerSuffix !== "") return stripRouterSuffix(sig, info.routerSuffix);
    } catch {
      // not this envelope
    }
  }
  return sig;
}

function filterCodexReasoningReplayTurnItems(inputItems: unknown[], items: string[]): string[] {
  const existingReasoning = new Set<string>();
  const existingCalls = new Set<string>();
  const existingOutputs = new Set<string>();
  for (const inputItem of inputItems) {
    switch (typeOf(inputItem)) {
      case "reasoning": {
        const key = canonicalCodexReasoningReplaySignatureKey(gstr(getAt(inputItem, "encrypted_content")));
        if (key !== "") existingReasoning.add(key);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        for (const candidate of codexReplayComparableCallIDs(gstr(getAt(inputItem, "call_id")))) existingOutputs.add(candidate);
        break;
    }
    for (const key of codexReplayToolCallKeys(inputItem)) existingCalls.add(key);
  }

  const filtered: string[] = [];
  for (const item of items) {
    const parsed = tryParse(item);
    switch (typeOf(parsed)) {
      case "reasoning":
        if (existingReasoning.has(canonicalCodexReasoningReplaySignatureKey(gstr(getAt(parsed, "encrypted_content"))))) continue;
        break;
      case "function_call":
      case "custom_tool_call": {
        const keys = codexReplayToolCallKeys(parsed);
        if (keys.length === 0 || keys.some((key) => existingCalls.has(key))) continue;
        const hasMatchingOutput = codexReplayComparableCallIDs(gstr(getAt(parsed, "call_id"))).some((candidate) => existingOutputs.has(candidate));
        if (!hasMatchingOutput) continue;
        for (const key of keys) existingCalls.add(key);
        break;
      }
      default:
        continue;
    }
    filtered.push(item);
  }
  return filtered;
}

/** sha256 of an assistant message's text (Go: codexReplayAssistantMessageFingerprint); "" when not one. */
export function codexReplayAssistantMessageFingerprint(item: unknown): string {
  const itemType = typeOf(item);
  if (itemType !== "" && itemType !== "message") return "";
  if (gstr(getAt(item, "role")).trim().toLowerCase() !== "assistant") return "";
  const content = getAt(item, "content");
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (isArr(content)) {
    for (const part of content) {
      switch (typeOf(part)) {
        case "input_text":
        case "output_text":
          text += gstr(getAt(part, "text"));
          break;
        case "refusal":
          text += "\x00refusal\x00" + gstr(getAt(part, "refusal"));
          break;
        default:
          return "";
      }
    }
  } else {
    return "";
  }
  if (text.length === 0) return "";
  return sha256Hex(text);
}

/** sha256 over the raw JSON of input[0:end] (Go: codexReplayInputPrefixFingerprint); "" when out of range. */
export function codexReplayInputPrefixFingerprint(inputItems: unknown[], end: number): string {
  if (end < 0 || end > inputItems.length) return "";
  const hasher = new Bun.CryptoHasher("sha256");
  for (let index = 0; index < end; index++) {
    hasher.update("\x00item\x00");
    hasher.update(rawOf(inputItems[index]));
  }
  return hasher.digest("hex");
}

/**
 * Prefix fingerprints from one incremental hashing pass (Go:
 * codexReplayPrefixFingerprints); the anchor search probes many prefixes.
 */
export class CodexReplayPrefixFingerprints {
  private readonly items: unknown[];
  private readonly hasher = new Bun.CryptoHasher("sha256");
  /** sums[end] is the fingerprint of items[0:end]; extended lazily. */
  private readonly sums: string[];

  constructor(items: unknown[]) {
    this.items = items;
    this.sums = [this.hasher.copy().digest("hex")];
  }

  at(end: number): string {
    if (end < 0 || end > this.items.length) return "";
    while (this.sums.length <= end) {
      const next = this.sums.length - 1;
      this.hasher.update("\x00item\x00");
      this.hasher.update(rawOf(this.items[next]));
      this.sums.push(this.hasher.copy().digest("hex"));
    }
    return this.sums[end]!;
  }
}

function filterCodexReasoningReplayItemsForInput(inputItems: unknown[], items: string[]): string[] {
  const hasInputReasoning = codexInputHasValidReasoningEncryptedContent(inputItems);
  const existingCalls = new Set<string>();
  const existingOutputs = new Set<string>();
  for (const inputItem of inputItems) {
    const itemType = typeOf(inputItem);
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      for (const candidate of codexReplayComparableCallIDs(gstr(getAt(inputItem, "call_id")))) existingOutputs.add(candidate);
    }
    for (const key of codexReplayToolCallKeys(inputItem)) existingCalls.add(key);
  }
  const filtered: string[] = [];
  for (const item of items) {
    const parsed = tryParse(item);
    switch (typeOf(parsed)) {
      case "reasoning":
        if (hasInputReasoning) continue;
        break;
      case "function_call":
      case "custom_tool_call": {
        const keys = codexReplayToolCallKeys(parsed);
        if (keys.length === 0 || keys.some((key) => existingCalls.has(key))) continue;
        const hasMatchingOutput = codexReplayComparableCallIDs(gstr(getAt(parsed, "call_id"))).some((candidate) => existingOutputs.has(candidate));
        if (!hasMatchingOutput) continue;
        for (const key of keys) existingCalls.add(key);
        break;
      }
      default:
        continue;
    }
    filtered.push(item);
  }
  return filtered;
}

/** Where an unanchored turn goes (Go: codexReasoningReplayInsertIndex). */
export function codexReasoningReplayInsertIndex(inputItems: unknown[], replayItems: string[]): number {
  const replayCallIDs = new Set<string>();
  for (const replay of replayItems) {
    const parsed = tryParse(replay);
    const itemType = typeOf(parsed);
    if (itemType !== "function_call" && itemType !== "custom_tool_call") continue;
    for (const callID of codexReplayComparableCallIDs(gstr(getAt(parsed, "call_id")))) replayCallIDs.add(callID);
  }
  if (replayCallIDs.size > 0) {
    for (let index = 0; index < inputItems.length; index++) {
      const itemType = typeOf(inputItems[index]);
      if (itemType !== "function_call_output" && itemType !== "custom_tool_call_output") continue;
      const callID = gstr(getAt(inputItems[index], "call_id")).trim();
      if (callID === "" || replayCallIDs.has(callID)) return index;
    }
  }
  for (let index = inputItems.length - 1; index >= 0; index--) {
    if (codexReplayMessageRole(inputItems[index]) === "assistant") return index;
  }
  for (let index = 0; index < inputItems.length; index++) {
    if (shouldInsertCodexReasoningReplayBefore(inputItems[index])) return index;
  }
  return inputItems.length;
}

/** Rewrites replayed call ids to the spelling the request's outputs use (Go: codexAlignReasoningReplayToolCallIDs). */
function codexAlignReasoningReplayToolCallIDs(inputItems: unknown[], replayItems: string[]): string[] {
  const outputCallIDs = new Map<string, string>();
  for (const inputItem of inputItems) {
    const itemType = typeOf(inputItem);
    if (itemType !== "function_call_output" && itemType !== "custom_tool_call_output") continue;
    const callID = gstr(getAt(inputItem, "call_id")).trim();
    if (callID === "") continue;
    for (const candidate of codexReplayComparableCallIDs(callID)) outputCallIDs.set(candidate, callID);
  }
  if (outputCallIDs.size === 0) return replayItems;
  return replayItems.map((replay) => {
    const parsed = tryParse(replay);
    const itemType = typeOf(parsed);
    if ((itemType !== "function_call" && itemType !== "custom_tool_call") || !isObj(parsed)) return replay;
    const callID = gstr(parsed.call_id).trim();
    let outputCallID = "";
    for (const candidate of codexReplayComparableCallIDs(callID)) {
      const value = outputCallIDs.get(candidate);
      if (value) {
        outputCallID = value;
        break;
      }
    }
    if (outputCallID === "" || outputCallID === callID) return replay;
    parsed.call_id = outputCallID;
    return JSON.stringify(parsed);
  });
}

function shouldInsertCodexReasoningReplayBefore(item: unknown): boolean {
  const role = codexReplayMessageRole(item);
  if (role === undefined) return true;
  return role !== "developer" && role !== "system";
}

function codexReplayMessageRole(item: unknown): string | undefined {
  const itemType = typeOf(item);
  const role = gstr(getAt(item, "role")).trim().toLowerCase();
  if (role === "" || (itemType !== "" && itemType !== "message")) return undefined;
  return role;
}

function codexReplayToolCallKeys(item: unknown): string[] {
  const itemType = typeOf(item);
  if (itemType !== "function_call" && itemType !== "custom_tool_call") return [];
  return codexReplayComparableCallIDs(gstr(getAt(item, "call_id"))).map((callID) => itemType + ":" + callID);
}

/** The call id and the Claude-visible spelling a Claude client echoes back (Go: codexReplayComparableCallIDs). */
export function codexReplayComparableCallIDs(callID: string): string[] {
  const id = callID.trim();
  if (id === "") return [];
  const visible = shortenCodexReplayCallIDIfNeeded(sanitizeClaudeToolID(id));
  if (visible === "" || visible === id) return [id];
  return [id, visible];
}

/** Go: shortenCodexReplayCallIDIfNeeded (64-byte limit, sha256 suffix). */
export function shortenCodexReplayCallIDIfNeeded(id: string): string {
  const limit = 64;
  if (id.length <= limit) return id;
  const suffix = "_" + sha256Hex(id).slice(0, 16);
  const prefixLen = limit - suffix.length;
  if (prefixLen <= 0) return suffix.slice(suffix.length - limit);
  return id.slice(0, prefixLen) + suffix;
}

// ---------------------------------------------------------------------------
// Response side: caching and invalidation
// ---------------------------------------------------------------------------

/**
 * Caches the replayable items of a completed response as one marked turn
 * (Go: cacheCodexReasoningReplayFromCompleted). `completed` is the event
 * (string or parsed) after its output was rebuilt from output_item.done items.
 */
export function cacheCodexReasoningReplayFromCompleted(cache: CodexReasoningReplayCache, scope: CodexReasoningReplayScope | undefined, completed: string | unknown): void {
  if (!codexReasoningReplayScopeValid(scope)) return;
  const root = typeof completed === "string" ? tryParse(completed) : completed;
  const output = getAt(root, "response.output");
  if (!isArr(output)) return;
  const replayItems: string[] = [];
  const callIDs: string[] = [];
  let assistantFingerprint = "";
  for (const item of output) {
    switch (typeOf(item)) {
      case "reasoning":
        replayItems.push(rawOf(item));
        break;
      case "function_call":
      case "custom_tool_call": {
        replayItems.push(rawOf(item));
        const callID = gstr(getAt(item, "call_id")).trim();
        if (callID !== "") callIDs.push(callID);
        break;
      }
      case "message": {
        const fingerprint = codexReplayAssistantMessageFingerprint(item);
        if (fingerprint !== "") assistantFingerprint = fingerprint;
        break;
      }
    }
  }
  if (replayItems.length === 0) return;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(scope.requestFingerprint);
  hasher.update("\x00assistant\x00" + assistantFingerprint);
  for (const callID of callIDs) hasher.update("\x00call\x00" + callID);
  for (const item of replayItems) {
    hasher.update("\x00item\x00");
    hasher.update(item);
  }
  const marker: Record<string, unknown> = { type: CodexReasoningReplayTurnType, id: hasher.digest("hex") };
  if (assistantFingerprint !== "") marker.assistant_fingerprint = assistantFingerprint;
  if (scope.requestFingerprint !== "") marker.request_fingerprint = scope.requestFingerprint;
  if (callIDs.length > 0) marker.call_ids = callIDs;
  cache.appendItems(scope.modelName, scope.sessionKey, [JSON.stringify(marker), ...replayItems]);
}

/** Drops the session's cached turns after a thinking_signature_invalid rejection (Go: clearCodexReasoningReplayOnInvalidSignature). */
export function clearCodexReasoningReplayOnInvalidSignature(cache: CodexReasoningReplayCache, scope: CodexReasoningReplayScope | undefined, statusCode: number, body: string): void {
  if (!codexReasoningReplayScopeValid(scope)) return;
  if (codexStatusErrorClassification(statusCode, body)?.code === "thinking_signature_invalid") cache.delete(scope.modelName, scope.sessionKey);
}

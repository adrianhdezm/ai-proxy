// Port of internal/runtime/executor/helps/claude_web_search_results.go and the
// claudeWebSearchResultCacheScope / claudeWebSearchResultCacheCredentialScope
// parts of claude_executor.go.
//
// A Responses client (Codex) replays a web search as a web_search_call with the
// query only; Claude then receives a web_search_tool_result block without its
// content. With client.codex.web-search-result-cache enabled the Claude
// executor records the result blocks of every Responses-inbound response and
// fills the empty blocks of later requests of the same session and credential.
import type { Auth } from "../../auth/types.ts";
import { type ClaudeWebSearchResultCache, defaultClaudeWebSearchResultLimit, defaultClaudeWebSearchResultTTLMs } from "../../cache/claude_web_search_result_cache.ts";
import { log } from "../../log.ts";
import { FormatOpenAIResponse, type Format } from "../../translator/types.ts";
import { sha256Hex } from "../../util/hash.ts";
import { isObject, tryParse, type JSONObject } from "../../util/json.ts";
import { codexReasoningReplaySessionKey } from "../codex/reasoning_replay.ts";
import type { ExecOptions, ExecRequest } from "../types.ts";
import { ClaudeCallerAPIKeyMetadataKey } from "./thinking_replay.ts";
import { claudeCreds } from "./upstream.ts";

const webSearchToolResultMarker = `"web_search_tool_result"`;

/** client.codex.web-search-result-cache (default disabled, as upstream). */
export interface ClaudeWebSearchResultCacheConfig {
  enabled: boolean;
  /** Sliding entry lifetime in ms; <= 0 means 24h (Go: EffectiveTTL). */
  ttlMs?: number;
  /** Maximum entries; <= 0 means 1024 (Go: EffectiveLimit). */
  limit?: number;
}

export interface ClaudeWebSearchResultScope {
  sessionKey: string;
  ttlMs: number;
  limit: number;
}

const noScope: ClaudeWebSearchResultScope = { sessionKey: "", ttlMs: 0, limit: 0 };

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Isolates a replay session key per inbound caller: "execution:" keys are
 * already private; anything else needs the authenticated caller key, else
 * there is no scope (Go: xaiReasoningReplayIsolateSessionKey).
 */
export function isolateCallerSessionKey(sessionKey: string, req: ExecRequest, opts: ExecOptions): string {
  const key = sessionKey.trim();
  if (key === "") return "";
  if (key.startsWith("execution:")) return key;
  const apiKey = metadataString(opts.metadata, ClaudeCallerAPIKeyMetadataKey) || metadataString(req.metadata, ClaudeCallerAPIKeyMetadataKey);
  if (apiKey === "") return "";
  return "caller:" + sha256Hex(apiKey).slice(0, 16) + ":" + key;
}

/** A hashed identity of the credential so two credentials never share results (Go: claudeWebSearchResultCacheCredentialScope). */
export function claudeWebSearchResultCacheCredentialScope(auth: Auth | undefined): string {
  if (!auth) return "";
  let identity = (auth.id ?? "").trim();
  if (identity === "") {
    const { apiKey, baseURL } = claudeCreds(auth);
    identity = apiKey.trim();
    if (identity === "") identity = baseURL.trim();
  }
  if (identity === "") return "";
  return "claude:" + sha256Hex(identity).slice(0, 16);
}

/** The cache scope of one request; empty unless enabled and Responses-inbound with a session (Go: claudeWebSearchResultCacheScope). */
export function claudeWebSearchResultCacheScope(
  config: ClaudeWebSearchResultCacheConfig | undefined,
  auth: Auth,
  from: Format,
  req: ExecRequest,
  opts: ExecOptions,
  originalPayload: string,
): ClaudeWebSearchResultScope {
  if (!config?.enabled) return noScope;
  if ((from ?? "").trim().toLowerCase() !== FormatOpenAIResponse) return noScope;
  let sessionKey = isolateCallerSessionKey(codexReasoningReplaySessionKey(from, req, opts, originalPayload), req, opts);
  if (sessionKey === "") return noScope;
  const credential = claudeWebSearchResultCacheCredentialScope(auth);
  if (credential !== "") sessionKey = credential + ":" + sessionKey;
  const ttlMs = config.ttlMs !== undefined && config.ttlMs > 0 ? config.ttlMs : defaultClaudeWebSearchResultTTLMs;
  const limit = config.limit !== undefined && config.limit > 0 ? Math.trunc(config.limit) : defaultClaudeWebSearchResultLimit;
  return { sessionKey, ttlMs, limit };
}

function contentEmpty(content: unknown): boolean {
  return content === undefined || content === null || (Array.isArray(content) && content.length === 0);
}

function recordBlock(cache: ClaudeWebSearchResultCache, scope: ClaudeWebSearchResultScope, block: unknown): void {
  if (!isObject(block) || block.type !== "web_search_tool_result") return;
  if (contentEmpty(block.content)) return;
  const toolUseID = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
  cache.set(scope.sessionKey, toolUseID, JSON.stringify(block.content), scope.ttlMs, scope.limit);
}

/**
 * Stores the web_search_tool_result blocks of a Claude response: a complete
 * Messages body, or SSE text whose content_block_start events carry the whole
 * result block (Go: RecordClaudeWebSearchResultsContext).
 */
export function recordClaudeWebSearchResults(cache: ClaudeWebSearchResultCache, scope: ClaudeWebSearchResultScope, data: string): void {
  if (scope.sessionKey.trim() === "" || !data.includes(webSearchToolResultMarker)) return;
  const root = tryParse(data);
  if (isObject(root) && Array.isArray(root.content)) {
    for (const block of root.content) recordBlock(cache, scope, block);
    return;
  }
  for (const rawLine of data.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const event = tryParse(line.slice(5).trim());
    if (isObject(event) && event.type === "content_block_start") recordBlock(cache, scope, event.content_block);
  }
}

/**
 * Fills assistant web_search_tool_result blocks whose content is missing or
 * empty with the stored content of the session; other blocks are left alone
 * (Go: RestoreClaudeWebSearchResultsContext).
 */
export function restoreClaudeWebSearchResults(cache: ClaudeWebSearchResultCache, scope: ClaudeWebSearchResultScope, body: string): string {
  if (scope.sessionKey.trim() === "" || !body.includes(webSearchToolResultMarker)) return body;
  const root = tryParse(body);
  if (!isObject(root) || !Array.isArray(root.messages)) return body;
  let restored = 0;
  for (const message of root.messages) {
    if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "web_search_tool_result" || !contentEmpty(block.content)) continue;
      const toolUseID = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const cached = cache.get(scope.sessionKey, toolUseID, scope.ttlMs > 0 ? scope.ttlMs : undefined);
      if (cached === undefined) continue;
      const content = tryParse(cached);
      if (content === undefined) continue;
      (block as JSONObject).content = content;
      restored++;
    }
  }
  if (restored === 0) return body;
  log.debug(`claude web search results: restored ${restored} result block(s) from cache`);
  return JSON.stringify(root);
}

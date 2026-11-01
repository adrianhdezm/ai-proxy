// Request shaping for the Codex Responses websocket transport. Port of
// internal/runtime/executor/codex_websockets_request.go (applyCodexPromptCacheHeaders,
// applyCodexWebsocketHeaders, ensureCodexWebsocketSessionHeader) and the
// request helpers of codex_websockets_connection.go (frameCodexWebsocketRequestBody,
// normalizeCodexWebsocketParallelToolCalls, buildCodexResponsesWebsocketURL).
//
// Header casing: Go preserved "session_id" / "Conversation_id" spellings on the
// wire; Headers (and Bun's websocket client) lower-case names, so only the
// values are kept.
//
// Not ported: the SIWC header branch. The prompt cache id itself comes from
// ../prompt_cache.ts (shared with the HTTP transport).
import type { Auth } from "../../../auth/types.ts";
import type { Format } from "../../../translator/types.ts";
import { applyCustomHeadersFromAttrs } from "../../../util/header_helpers.ts";
import { gstr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import type { ExecRequest } from "../../types.ts";
import { codexAuthUsesAPIKey, codexResponsesLiteHeader, headerValueCaseInsensitive, isCodexResponsesLiteRequest } from "../creds.ts";
import { type CodexHeaderPolicy, applyCodexCloakingHeaders, codexHeaderDefaults, codexOriginator, codexSessionHeaderValue, codexUserAgent, ensureHeader, ensureHeaderWithConfigPrecedence, isCodexCloakingDisabled } from "../headers.ts";
import { setBoolIfDifferent, setStringIfDifferent } from "../request.ts";
import { codexPromptCacheID } from "../prompt_cache.ts";

/** OpenAI-Beta value selecting the Responses websocket protocol (Go: codexResponsesWebsocketBetaHeaderValue). */
export const codexResponsesWebsocketBetaHeaderValue = "responses_websockets=2026-02-06";

/**
 * Sets prompt_cache_key and the session headers (Go: applyCodexPromptCacheHeadersWithContext):
 * the Claude Code session cache id for Claude inbound, the client's
 * prompt_cache_key for Responses inbound, else the execution / derived session
 * UUID. Returns the body and the initial websocket headers.
 */
export function applyCodexPromptCacheHeaders(from: Format, req: ExecRequest, body: string, clientHeaders?: Headers, optsMetadata?: Record<string, unknown>): { body: string; headers: Headers } {
  const headers = new Headers();
  if (body.length === 0) return { body, headers };
  const cacheID = codexPromptCacheID(from, req, body, clientHeaders, optsMetadata);
  if (cacheID !== "") {
    body = setStringIfDifferent(body, "prompt_cache_key", cacheID);
    headers.set("session_id", cacheID);
    headers.set("Conversation_id", cacheID);
  }
  return { body, headers };
}

/** session_id from the target, the client, or the fallback; Session-Id is dropped (Go: ensureCodexWebsocketSessionHeader). */
export function ensureCodexWebsocketSessionHeader(target: Headers, source: Headers | undefined, fallbackValue: string): void {
  let sessionID = codexSessionHeaderValue(target);
  if (sessionID === "") sessionID = codexSessionHeaderValue(source);
  if (sessionID === "") sessionID = fallbackValue.trim();
  target.delete("Session-Id");
  if (sessionID !== "") target.set("session_id", sessionID);
}

/** Existing target > client > config > fallback (Go: ensureHeaderWithPriority). */
function ensureHeaderWithPriority(target: Headers, source: Headers | undefined, key: string, configValue: string, fallbackValue: string): void {
  if ((target.get(key) ?? "").trim() !== "") return;
  const incoming = (source?.get(key) ?? "").trim();
  if (incoming !== "") {
    target.set(key, incoming);
    return;
  }
  if (configValue.trim() !== "") {
    target.set(key, configValue.trim());
    return;
  }
  if (fallbackValue.trim() !== "") target.set(key, fallbackValue.trim());
}

/** Go: misc.EnsureHeader with an empty default, but keeping an existing target value first. */
function ensureClientHeader(target: Headers, source: Headers | undefined, key: string): void {
  ensureHeader(target, source, key, "");
}

/**
 * The websocket handshake headers (Go: applyCodexWebsocketHeaders, non-SIWC
 * branch): Authorization, forwarded client identity / turn headers, the
 * responses_websockets beta, session_id, Originator / ChatGPT-Account-ID for
 * OAuth credentials, operator "header:" rules and cloaking.
 */
export function applyCodexWebsocketHeaders(
  headers: Headers,
  auth: Auth | undefined,
  token: string,
  policy: CodexHeaderPolicy | undefined,
  nativeRequest: boolean,
  clientHeaders: Headers | undefined,
): Headers {
  if (token.trim() !== "") headers.set("Authorization", "Bearer " + token);
  else headers.delete("Authorization");

  const isAPIKey = codexAuthUsesAPIKey(auth);
  const defaults = codexHeaderDefaults(policy, auth);
  ensureHeaderWithPriority(headers, clientHeaders, "x-codex-beta-features", defaults.betaFeatures, "");
  ensureClientHeader(headers, clientHeaders, "x-codex-turn-state");
  ensureClientHeader(headers, clientHeaders, "x-codex-turn-metadata");
  ensureClientHeader(headers, clientHeaders, "x-client-request-id");
  ensureClientHeader(headers, clientHeaders, "x-responsesapi-include-timing-metrics");
  ensureClientHeader(headers, clientHeaders, "Version");
  if (nativeRequest) ensureClientHeader(headers, clientHeaders, codexResponsesLiteHeader);
  if (isAPIKey) ensureHeaderWithPriority(headers, clientHeaders, "User-Agent", "", "");
  else ensureHeaderWithConfigPrecedence(headers, clientHeaders, "User-Agent", defaults.userAgent, codexUserAgent);

  let beta = (headers.get("OpenAI-Beta") ?? "").trim();
  if (beta === "") beta = (clientHeaders?.get("OpenAI-Beta") ?? "").trim();
  if (beta === "" || !beta.includes("responses_websockets=")) beta = codexResponsesWebsocketBetaHeaderValue;
  headers.set("OpenAI-Beta", beta);

  const sessionFallback = (headers.get("User-Agent") ?? "").includes("Mac OS") ? crypto.randomUUID() : "";
  ensureCodexWebsocketSessionHeader(headers, clientHeaders, sessionFallback);
  if (nativeRequest && isCodexCloakingDisabled(policy, auth)) {
    headers.delete("session_id");
    headers.delete("conversation_id");
    clientHeaders?.forEach((value, key) => {
      switch (key.toLowerCase()) {
        case "session-id":
        case "session_id":
        case "conversation_id":
        case "thread-id":
        case "x-codex-routing-hint":
        case "x-codex-window-id":
          headers.set(key, value);
      }
    });
  }
  const originator = headerValueCaseInsensitive(clientHeaders, "Originator");
  if (originator !== "") headers.set("Originator", originator);
  else if (!isAPIKey) headers.set("Originator", codexOriginator);
  if (!isAPIKey) {
    const accountID = auth?.metadata?.account_id;
    if (typeof accountID === "string" && accountID.trim() !== "") headers.set("ChatGPT-Account-ID", accountID.trim());
  }
  applyCustomHeadersFromAttrs(headers, auth?.attributes, { clientHeaders });
  applyCodexCloakingHeaders(headers, policy, auth);
  return headers;
}

/** Responses Lite websocket requests never run tools in parallel (Go: normalizeCodexWebsocketParallelToolCalls). */
export function normalizeCodexWebsocketParallelToolCalls(body: string, headers: Headers | undefined): string {
  if (!isCodexResponsesLiteRequest(body, headers)) return body;
  return setBoolIfDifferent(body, "parallel_tool_calls", false);
}

/** Adds the response.create frame type without touching the rest of the payload (Go: frameCodexWebsocketRequestBody). */
export function frameCodexWebsocketRequestBody(body: string): string {
  if (body.length === 0) return body;
  const root = tryParse(body);
  if (!isObj(root)) return body;
  if (gstr(root.type) === "response.create") return body;
  root.type = "response.create";
  return JSON.stringify(root);
}

/** http(s)://host/path -> ws(s)://host/path (Go: buildCodexResponsesWebsocketURL). */
export function buildCodexResponsesWebsocketURL(httpURL: string): string {
  const raw = httpURL.trim();
  // WHATWG URL takes the first path segment of "https:///x" as the host; Go reports it empty.
  if (/^[a-z][a-z0-9+.-]*:\/\/(?:[/?#]|$)/i.test(raw)) throw new Error("codex websockets executor: responses websocket URL host is empty");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(`codex websockets executor: invalid responses websocket URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "http") parsed.protocol = "ws:";
  else if (scheme === "https") parsed.protocol = "wss:";
  else throw new Error(`codex websockets executor: unsupported responses websocket URL scheme "${scheme}"`);
  if (parsed.host.trim() === "") throw new Error("codex websockets executor: responses websocket URL host is empty");
  return parsed.toString();
}

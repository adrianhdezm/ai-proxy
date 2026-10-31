// Codex websocket error events. Port of
// internal/runtime/executor/codex_websockets_errors.go (parseCodexWebsocketErrorWithCooling,
// buildCodexWebsocketErrorPayload, isCodexWebsocketConnectionLimitError,
// parseCodexWebsocketErrorHeaders, normalizeCodexWebsocketCompletion,
// encodeCodexWebsocketAsSSE, clearCodexReasoningReplayOnWebsocketError).
import type { CodexReasoningReplayCache } from "../../../cache/codex_reasoning_replay_cache.ts";
import { getAt, gstr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import { StatusError } from "../../types.ts";
import { isCodexTransientCapacityError, isCodexUsageLimitError, parseCodexRetryAfter, parseRetryAfterHeader } from "../errors.ts";
import { type CodexReasoningReplayScope, clearCodexReasoningReplayOnInvalidSignature } from "../reasoning_replay.ts";

const statusTexts: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Request Entity Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function intOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Math.trunc(Number(value.trim()));
  return 0;
}

/** The status of a websocket error event: status, else status_code (Go: gjson .Int()). */
export function codexWebsocketErrorStatus(root: unknown): number {
  let status = intOf(getAt(root, "status"));
  if (status === 0) status = intOf(getAt(root, "status_code"));
  return status;
}

/** `{"status":N,"error":{...}}` from a websocket error event (Go: buildCodexWebsocketErrorPayload). */
export function buildCodexWebsocketErrorPayload(payload: string, status: number): string {
  const root = tryParse(payload);
  const out: Record<string, unknown> = { status };
  const body = getAt(root, "body");
  if (body !== undefined) {
    out.body = body;
    const bodyError = getAt(body, "error");
    if (bodyError !== undefined) {
      out.error = bodyError;
      return JSON.stringify(out);
    }
  }
  const error = getAt(root, "error");
  if (error !== undefined) {
    out.error = error;
    return JSON.stringify(out);
  }
  out.error = { type: "server_error", message: statusTexts[status] ?? "" };
  return JSON.stringify(out);
}

/** Go: isCodexWebsocketConnectionLimitError. */
export function isCodexWebsocketConnectionLimitError(payload: string): boolean {
  if (payload.length === 0) return false;
  const root = tryParse(payload);
  for (const path of ["error.code", "error.type", "body.error.code", "body.error.type", "code", "error"]) {
    if (gstr(getAt(root, path)).trim() === "websocket_connection_limit_reached") return true;
  }
  return false;
}

/** The `headers` object of an error event as Headers (Go: parseCodexWebsocketErrorHeaders). */
export function parseCodexWebsocketErrorHeaders(payload: string): Headers | undefined {
  const node = getAt(tryParse(payload), "headers");
  if (!isObj(node)) return undefined;
  const mapped = new Headers();
  let any = false;
  for (const [rawKey, value] of Object.entries(node)) {
    const name = rawKey.trim();
    if (name === "") continue;
    let text = "";
    if (typeof value === "string") text = value.trim();
    else if (typeof value === "number" || typeof value === "boolean") text = String(value);
    if (text === "") continue;
    try {
      mapped.set(name, text);
      any = true;
    } catch {
      // invalid header name
    }
  }
  return any ? mapped : undefined;
}

/**
 * Classifies a `{"type":"error","status":N,...}` event (Go:
 * parseCodexWebsocketErrorWithCooling). Retry hint precedence: the quota body
 * reset, then the connection-limit immediate retry, then Retry-After on a 429.
 */
export function parseCodexWebsocketErrorWithCooling(payload: string, modelLevelCooling: boolean, nowMs: number = Date.now()): StatusError | undefined {
  if (payload.length === 0) return undefined;
  const root = tryParse(payload);
  if (gstr(getAt(root, "type")).trim() !== "error") return undefined;
  const status = codexWebsocketErrorStatus(root);
  if (status <= 0) return undefined;
  const out = buildCodexWebsocketErrorPayload(payload, status);
  const headers = parseCodexWebsocketErrorHeaders(payload);
  const isUsageLimit = isCodexUsageLimitError(out);
  const transientCapacity = !isUsageLimit && isCodexTransientCapacityError(out);
  let retryAfterMs = parseCodexRetryAfter(status, out, nowMs);
  if (retryAfterMs === undefined && isCodexWebsocketConnectionLimitError(payload)) retryAfterMs = 0;
  else if (retryAfterMs === undefined && status === 429) retryAfterMs = parseRetryAfterHeader(headers, nowMs);
  return new StatusError(status, out, {
    headers,
    body: out,
    credentialScoped: isUsageLimit && !modelLevelCooling,
    transientRateLimit: transientCapacity && status === 429,
    retryAfterMs,
  });
}

export function parseCodexWebsocketError(payload: string): StatusError | undefined {
  return parseCodexWebsocketErrorWithCooling(payload, false);
}

/** Clears the reasoning replay of an invalid-signature websocket error (Go: clearCodexReasoningReplayOnWebsocketError). */
export function clearCodexReasoningReplayOnWebsocketError(cache: CodexReasoningReplayCache, scope: CodexReasoningReplayScope, payload: string): void {
  const status = codexWebsocketErrorStatus(tryParse(payload));
  if (status <= 0) return;
  clearCodexReasoningReplayOnInvalidSignature(cache, scope, status, buildCodexWebsocketErrorPayload(payload, status));
}

/** response.done (websocket spelling) becomes response.completed (Go: normalizeCodexWebsocketCompletion). */
export function normalizeCodexWebsocketCompletion(payload: string): string {
  const root = tryParse(payload);
  if (!isObj(root) || gstr(root.type).trim() !== "response.done") return payload;
  root.type = "response.completed";
  return JSON.stringify(root);
}

/** One SSE data line for the translators (Go: encodeCodexWebsocketAsSSE). */
export function encodeCodexWebsocketAsSSE(payload: string): string {
  return payload.length === 0 ? "" : "data: " + payload;
}

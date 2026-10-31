// Upstream failure classification for the Codex executor. Port of
// internal/runtime/executor/codex_executor_terminal.go (the terminal event and
// HTTP status classification), parseRetryAfterHeader from
// openai_compat_executor.go and helps/codex_terminal_incomplete.go.
//
// Every classification is expressed through the StatusError fields the auth
// manager reads:
//
//   case                                   | status | flags
//   usage_limit_reached (body/terminal)    | 429    | credentialScoped unless modelLevelCooling; retryAfterMs from resets_at/resets_in_seconds
//   transient capacity / turn rate limit   | 429    | transientRateLimit; retryAfterMs from Retry-After header
//   other 4xx/5xx                          | as is  | retryAfterMs from Retry-After on 429 only
//   stream ended without a terminal event  | 408    | requestScoped + streamTruncated (no failover, no cooldown)
//   response.incomplete with 0 output      | 502    | requestScoped
//   terminal event with context length     | 400    | requestScoped (body code context_too_large)
//   terminal event, invalid signature      | 400    | plain (see classifyCodexStatusError body)
//   other terminal events                  | per codexTerminalFailureStatus (error.status_code/status, type/code; else 502)
import { StatusError } from "../types.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

export const codexIncompleteStreamMessage = "stream error: stream disconnected before completion: stream closed before response.completed";
/** Go: helps.CodexEmptyIncompleteStreamMessage. */
export const codexEmptyIncompleteStreamMessage = "stream error: upstream terminated with incomplete empty response (0 tokens)";

const httpStatusText: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  413: "Request Entity Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function statusText(status: number): string {
  return httpStatusText[status] ?? `status ${status}`;
}

function parseBody(body: string): unknown {
  return tryParse(body);
}

function lowerAt(root: unknown, path: string): string {
  return gstr(getAt(root, path)).trim().toLowerCase();
}

/**
 * An accepted upstream stream ended without response.completed/incomplete
 * (Go: newCodexIncompleteStreamError: 408, IsRequestScoped). It is also marked
 * streamTruncated so the manager neither fails over nor cools the credential,
 * and the body types the failure as a retryable server-side request_timeout.
 */
export function newCodexIncompleteStreamError(): StatusError {
  const body = JSON.stringify({ error: { code: "request_timeout", type: "server_error", message: codexIncompleteStreamMessage } });
  return new StatusError(408, codexIncompleteStreamMessage, { body, requestScoped: true, streamTruncated: true });
}

/** Whether an error is the incomplete-stream error above. */
export function isCodexIncompleteStreamError(err: unknown): boolean {
  return err instanceof StatusError && err.statusCode === 408 && err.message === codexIncompleteStreamMessage;
}

/** response.incomplete with zero output (Go: newCodexEmptyIncompleteStreamError: 502, IsRequestScoped). */
export function newCodexEmptyIncompleteStreamError(): StatusError {
  const body = JSON.stringify({ error: { code: "upstream_empty_incomplete", type: "server_error", message: codexEmptyIncompleteStreamMessage } });
  return new StatusError(502, codexEmptyIncompleteStreamMessage, { body, requestScoped: true });
}

// ---------------------------------------------------------------------------
// Terminal SSE events (type "error" / "response.failed")
// ---------------------------------------------------------------------------

export interface TerminalFailure {
  error: StatusError;
  /** The normalised `{"error":{...}}` body the classification was made from. */
  body: string;
}

/** Go: codexTerminalFailureErrWithCooling. */
export function codexTerminalFailureErrWithCooling(eventData: string, modelLevelCooling: boolean, nowMs: number = Date.now()): TerminalFailure | undefined {
  const streamErr = codexTerminalStreamErrWithCooling(eventData, modelLevelCooling, nowMs);
  if (streamErr) return streamErr;
  const body = codexTerminalFailureBody(eventData);
  if (body === undefined) return undefined;
  return { error: newCodexStatusErrWithHeadersAndCooling(codexTerminalFailureStatus(body), undefined, body, modelLevelCooling, nowMs), body };
}

export function codexTerminalFailureErr(eventData: string): TerminalFailure | undefined {
  return codexTerminalFailureErrWithCooling(eventData, false);
}

/** Go: codexTerminalStreamErrWithCooling (the subset of terminal failures classified as 400-class request problems). */
export function codexTerminalStreamErrWithCooling(eventData: string, modelLevelCooling: boolean, nowMs: number = Date.now()): TerminalFailure | undefined {
  const body = codexTerminalFailureBody(eventData);
  if (body === undefined || !codexTerminalStreamErrShouldHandle(body)) return undefined;
  const error = newCodexStatusErrWithHeadersAndCooling(400, undefined, body, modelLevelCooling, nowMs);
  // Deviation: a context-length rejection is the request's fault on every
  // credential, so it is marked request-scoped (no failover, no cooldown).
  if (error.statusCode === 400 && codexTerminalErrorIsContextLength(body)) error.requestScoped = true;
  return { error, body };
}

export function codexTerminalStreamErr(eventData: string): TerminalFailure | undefined {
  return codexTerminalStreamErrWithCooling(eventData, false);
}

/** Go: codexTerminalStreamContextLengthErr. */
export function codexTerminalStreamContextLengthErr(eventData: string): StatusError | undefined {
  const streamErr = codexTerminalStreamErr(eventData);
  if (!streamErr || !codexTerminalErrorIsContextLength(streamErr.body)) return undefined;
  return streamErr.error;
}

function codexTerminalStreamErrShouldHandle(body: string): boolean {
  if (codexTerminalErrorIsContextLength(body)) return true;
  if (isCodexUsageLimitError(body) || isCodexTransientCapacityError(body)) return true;
  const classification = codexStatusErrorClassification(400, body);
  return classification !== undefined && classification.code === "thinking_signature_invalid";
}

/** Go: codexTerminalFailureStatus. */
export function codexTerminalFailureStatus(body: string): number {
  const root = parseBody(body);
  for (const path of ["error.status_code", "error.status"]) {
    const value = getAt(root, path);
    const status = typeof value === "number" ? Math.trunc(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0;
    if (status >= 400 && status <= 599) return status;
  }
  const errorType = lowerAt(root, "error.type");
  const errorCode = lowerAt(root, "error.code");
  if (errorCode === "cyber_policy") return 400;
  if (errorType === "not_found_error" || errorCode === "not_found" || errorCode === "model_not_found") return 404;
  if (errorType === "authentication_error" || errorCode === "invalid_api_key" || errorCode === "unauthorized") return 401;
  if (errorType === "permission_error" || errorCode === "forbidden" || errorCode === "permission_denied") return 403;
  if (errorType === "rate_limit_error" || errorCode === "rate_limit_exceeded") return 429;
  if (errorType === "invalid_request_error" || errorType === "bad_request_error") return 400;
  return 502;
}

/** Extracts the `{"error":{...}}` body of a terminal failure event (Go: codexTerminalFailureBody). */
export function codexTerminalFailureBody(eventData: string): string | undefined {
  const root = parseBody(eventData);
  const eventType = gstr(getAt(root, "type"));
  let body: Record<string, unknown> | undefined;
  switch (eventType) {
    case "error":
      body = codexTerminalErrorBody(root, "error");
      if (!body) body = codexTerminalTopLevelErrorBody(root);
      break;
    case "response.failed":
      body = codexTerminalErrorBody(root, "response.error");
      if (!body) body = codexTerminalErrorBody(root, "error");
      break;
    default:
      return undefined;
  }
  if (!body) body = { error: { message: "upstream stream failed without error details" } };
  const seq = getAt(root, "sequence_number");
  if (seq !== undefined) body.sequence_number = typeof seq === "number" ? Math.trunc(seq) : Number(seq) || 0;
  return JSON.stringify(body);
}

function codexTerminalErrorBody(root: unknown, path: string): Record<string, unknown> | undefined {
  const errorResult = getAt(root, path);
  if (errorResult === undefined) return undefined;
  const body: Record<string, unknown> = { error: {} };
  if (isObj(errorResult) || isArr(errorResult)) {
    body.error = structuredClone(errorResult);
  } else {
    const message = gstr(errorResult).trim();
    if (message !== "") body.error = { message };
  }
  const errObj = isObj(body.error) ? body.error : (body.error = {});
  const messageOf = () => gstr(errObj.message).trim();
  if (messageOf() === "") {
    const message = gstr(getAt(root, "response.error.message")).trim();
    if (message !== "") errObj.message = message;
  }
  if (messageOf() === "") {
    const code = gstr(errObj.code).trim();
    if (code !== "") errObj.message = code;
  }
  if (messageOf() === "") {
    const errorType = gstr(errObj.type).trim();
    if (errorType !== "") errObj.message = errorType;
  }
  return body;
}

function codexTerminalTopLevelErrorBody(root: unknown): Record<string, unknown> | undefined {
  const message = gstr(getAt(root, "message")).trim();
  const code = gstr(getAt(root, "code")).trim();
  const errorType = gstr(getAt(root, "error_type")).trim();
  const param = gstr(getAt(root, "param")).trim();
  if (message === "" && code === "" && errorType === "" && param === "") return undefined;
  const error: Record<string, unknown> = {};
  if (message !== "") error.message = message;
  if (code !== "") error.code = code;
  if (errorType !== "") error.type = errorType;
  if (param !== "") error.param = param;
  if (gstr(error.message).trim() === "") {
    if (code !== "") error.message = code;
    else if (errorType !== "") error.message = errorType;
  }
  return { error };
}

/** Go: codexTerminalErrorIsContextLength. */
export function codexTerminalErrorIsContextLength(body: string): boolean {
  const root = parseBody(body);
  const errorCode = lowerAt(root, "error.code");
  const message = lowerAt(root, "error.message");
  return (
    errorCode === "context_length_exceeded" ||
    errorCode === "context_too_large" ||
    message.includes("context window") ||
    message.includes("context length") ||
    message.includes("too many tokens")
  );
}

// ---------------------------------------------------------------------------
// HTTP status errors
// ---------------------------------------------------------------------------

export function newCodexStatusErr(statusCode: number, body: string): StatusError {
  return newCodexStatusErrWithHeadersAndCooling(statusCode, undefined, body, false);
}

export function newCodexStatusErrWithHeaders(statusCode: number, headers: Headers | undefined, body: string): StatusError {
  return newCodexStatusErrWithHeadersAndCooling(statusCode, headers, body, false);
}

export function newCodexStatusErrWithCooling(statusCode: number, body: string, modelLevelCooling: boolean): StatusError {
  return newCodexStatusErrWithHeadersAndCooling(statusCode, undefined, body, modelLevelCooling);
}

/**
 * Builds the StatusError for an upstream rejection (Go: newCodexStatusErrWithHeadersAndCooling).
 * A usage_limit_reached body reset describes quota recovery and wins over the
 * generic Retry-After header; every other 429 honours the header.
 */
export function newCodexStatusErrWithHeadersAndCooling(
  statusCode: number,
  headers: Headers | undefined,
  body: string,
  modelLevelCooling: boolean,
  nowMs: number = Date.now(),
): StatusError {
  let errCode = statusCode;
  const isUsageLimit = isCodexUsageLimitError(body);
  const credentialScoped = isUsageLimit && !modelLevelCooling;
  const transientCapacity = !isUsageLimit && isCodexTransientCapacityError(body);
  if (transientCapacity || isUsageLimit) errCode = 429;
  const classified = classifyCodexStatusError(errCode, body);
  let retryAfterMs = parseCodexRetryAfter(errCode, classified, nowMs);
  if (retryAfterMs === undefined && errCode === 429) retryAfterMs = parseRetryAfterHeader(headers, nowMs);
  return new StatusError(errCode, classified, {
    headers,
    body: classified,
    credentialScoped,
    transientRateLimit: transientCapacity && errCode === 429,
    retryAfterMs,
  });
}

/** Rewrites known Codex failures into a stable `{"error":{message,type,code}}` body (Go: classifyCodexStatusError). */
export function classifyCodexStatusError(statusCode: number, body: string): string {
  const classification = codexStatusErrorClassification(statusCode, body);
  if (!classification) return body;
  const root = parseBody(body);
  let message = gstr(getAt(root, "error.message"));
  if (message === "") message = gstr(getAt(root, "message"));
  if (message === "") message = body.trim();
  if (message === "") message = statusText(statusCode);
  return JSON.stringify({ error: { message, type: classification.errType, code: classification.code } });
}

export interface CodexStatusErrorClassification {
  code: string;
  errType: string;
}

/** Go: codexStatusErrorClassification. */
export function codexStatusErrorClassification(statusCode: number, body: string): CodexStatusErrorClassification | undefined {
  const root = parseBody(body);
  let errorMessage = lowerAt(root, "error.message");
  if (errorMessage === "") errorMessage = lowerAt(root, "message");
  const lower = body.trim().toLowerCase();
  const upstreamCode = lowerAt(root, "error.code");
  const upstreamType = lowerAt(root, "error.type");
  const isInvalidRequest = upstreamType === "" || upstreamType === "invalid_request_error";
  if (
    statusCode === 413 ||
    upstreamCode === "context_length_exceeded" ||
    upstreamCode === "context_too_large" ||
    (isInvalidRequest &&
      (errorMessage.includes("context length") || errorMessage.includes("context_length") || errorMessage.includes("maximum context") || errorMessage.includes("too many tokens")))
  ) {
    return { code: "context_too_large", errType: "invalid_request_error" };
  }
  if (lower.includes("invalid signature in thinking block") || lower.includes("invalid_encrypted_content")) {
    return { code: "thinking_signature_invalid", errType: "invalid_request_error" };
  }
  if (upstreamCode === "previous_response_not_found" || lower.includes("previous_response_not_found") || (lower.includes("previous_response_id") && lower.includes("not found"))) {
    return { code: "previous_response_not_found", errType: "invalid_request_error" };
  }
  if (
    statusCode === 401 ||
    upstreamType === "authentication_error" ||
    upstreamCode === "invalid_api_key" ||
    lower.includes("invalid or expired token") ||
    lower.includes("refresh_token_reused")
  ) {
    return { code: "auth_unavailable", errType: "authentication_error" };
  }
  return undefined;
}

/** Whether the body is the thinking_signature_invalid rejection (used to clear the replay cache). */
export function isCodexInvalidSignatureError(statusCode: number, body: string): boolean {
  return codexStatusErrorClassification(statusCode, body)?.code === "thinking_signature_invalid";
}

/**
 * Codex's per-turn admission rejection (issue 7017): the dedicated code, or a
 * rate_limit_error whose message says the service is at capacity when no other
 * code is present (Go: isCodexTurnRateLimitError).
 */
export function isCodexTurnRateLimitError(errorBody: string): boolean {
  if (errorBody.length === 0) return false;
  const root = parseBody(errorBody);
  let hasOtherCode = false;
  for (const path of ["error.code", "code", "body.error.code"]) {
    const candidate = gstr(getAt(root, path)).trim();
    if (candidate === "") continue;
    if (candidate.toLowerCase() === "turn_rate_limit_exceeded") return true;
    hasOtherCode = true;
  }
  if (hasOtherCode) return false;
  const rateLimitTyped = ["error.type", "type", "body.error.type"].some((path) => gstr(getAt(root, path)).trim().toLowerCase() === "rate_limit_error");
  if (!rateLimitTyped) return false;
  return ["error.message", "message", "body.error.message"].some((path) => gstr(getAt(root, path)).trim().toLowerCase().includes("at capacity"));
}

function codexErrorCodeOf(errorBody: string): string {
  const root = parseBody(errorBody);
  for (const path of ["error.code", "code", "body.error.code"]) {
    const code = gstr(getAt(root, path)).trim();
    if (code !== "") return code;
  }
  return "";
}

/** Every transient, model-scoped capacity rejection (Go: isCodexTransientCapacityError). */
export function isCodexTransientCapacityError(errorBody: string): boolean {
  const code = codexErrorCodeOf(errorBody).toLowerCase();
  if (code !== "" && code !== "turn_rate_limit_exceeded" && code !== "model_at_capacity" && code !== "model_is_at_capacity") return false;
  return isCodexModelCapacityError(errorBody) || isCodexTurnRateLimitError(errorBody);
}

/** Go: isCodexModelCapacityError. */
export function isCodexModelCapacityError(errorBody: string): boolean {
  if (errorBody.length === 0) return false;
  const root = parseBody(errorBody);
  for (const candidate of [gstr(getAt(root, "error.message")), gstr(getAt(root, "message")), errorBody]) {
    const lower = candidate.trim().toLowerCase();
    if (lower === "") continue;
    if (lower.includes("model is at capacity") || lower.includes("model_at_capacity") || lower.includes("model_is_at_capacity") || (lower.includes("model") && lower.includes("at capacity"))) {
      return true;
    }
  }
  return false;
}

/** Quota/plan exhaustion: error.type == usage_limit_reached in any layout (Go: isCodexUsageLimitError). */
export function isCodexUsageLimitError(errorBody: string): boolean {
  if (errorBody.length === 0) return false;
  const root = parseBody(errorBody);
  return ["error.type", "type", "body.error.type"].some((path) => gstr(getAt(root, path)).trim().toLowerCase() === "usage_limit_reached");
}

function intOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

/** Retry hint (ms) from a usage_limit_reached body: resets_at first, then resets_in_seconds (Go: parseCodexRetryAfter). */
export function parseCodexRetryAfter(statusCode: number, errorBody: string, nowMs: number = Date.now()): number | undefined {
  if (statusCode !== 429 || errorBody.length === 0) return undefined;
  const root = parseBody(errorBody);
  for (const quota of [getAt(root, "error"), root, getAt(root, "body.error")]) {
    if (gstr(getAt(quota, "type")).trim().toLowerCase() !== "usage_limit_reached") continue;
    const resetsAt = intOf(getAt(quota, "resets_at"));
    if (resetsAt > 0) {
      const resetAtMs = resetsAt * 1000;
      if (resetAtMs > nowMs) return resetAtMs - nowMs;
    }
    const resetsIn = intOf(getAt(quota, "resets_in_seconds"));
    if (resetsIn > 0) return resetsIn * 1000;
  }
  return undefined;
}

/** Retry-After header in ms: delta-seconds or an HTTP date (Go: parseRetryAfterHeader). */
export function parseRetryAfterHeader(headers: Headers | undefined, nowMs: number = Date.now()): number | undefined {
  if (!headers) return undefined;
  const raw = (headers.get("Retry-After") ?? "").trim();
  if (raw === "") return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    // Far-future deadlines only ever over-report recovery.
    if (!Number.isSafeInteger(seconds * 1000)) return Number.MAX_SAFE_INTEGER;
    return seconds * 1000;
  }
  const deadline = Date.parse(raw);
  if (!Number.isNaN(deadline)) return Math.max(0, deadline - nowMs);
  return undefined;
}

/**
 * Whether a terminal failure inside an HTTP 200 stream is a transient capacity
 * rejection another credential may serve (Go: isCodexOverloadBootstrapFailure).
 * Only informational here: the bootstrap-buffering path that acts on it is not ported.
 */
export function isCodexOverloadBootstrapFailure(body: string): boolean {
  if (isCodexTransientCapacityError(body)) return true;
  const root = parseBody(body);
  const errorType = lowerAt(root, "error.type");
  const errorCode = lowerAt(root, "error.code");
  let errorMessage = lowerAt(root, "error.message");
  if (errorMessage === "") errorMessage = lowerAt(root, "message");
  if (errorType === "service_unavailable_error" || errorCode === "server_is_overloaded") return true;
  if (errorType === "rate_limit_error" || errorCode === "rate_limit_exceeded") return true;
  if ((errorType === "server_error" || errorCode === "server_error") && errorMessage.includes("you can retry your request")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Terminal incomplete detection (Go: helps/codex_terminal_incomplete.go)
// ---------------------------------------------------------------------------

/** Whether an event carries non-empty generated content (Go: HasMeaningfulCodexOutputDelta). */
export function hasMeaningfulCodexOutputDelta(eventData: string | unknown): boolean {
  const root = typeof eventData === "string" ? parseBody(eventData) : eventData;
  switch (gstr(getAt(root, "type"))) {
    case "response.output_text.delta":
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
    case "response.function_call_arguments.delta": {
      const delta = getAt(root, "delta");
      return delta !== undefined && gstr(delta).trim().length > 0;
    }
    default:
      return false;
  }
}

/**
 * Whether a response.incomplete event is a silent upstream abort: explicitly
 * zero output tokens and no output at all (Go: IsCodexTerminalEmptyIncomplete).
 */
export function isCodexTerminalEmptyIncomplete(eventData: string | unknown, outputItemsCount: number, sawOutputDelta: boolean): boolean {
  const root = typeof eventData === "string" ? parseBody(eventData) : eventData;
  if (gstr(getAt(root, "type")) !== "response.incomplete") return false;
  if (sawOutputDelta) return false;
  if (outputItemsCount > 0) return false;
  const output = getAt(root, "response.output");
  if (isArr(output) && output.length > 0) return false;
  const outputTokens = getAt(root, "response.usage.output_tokens");
  if (typeof outputTokens !== "number") return false;
  // Require an exact integer zero (0.5 is not zero).
  return outputTokens === 0 && Object.is(outputTokens, 0);
}

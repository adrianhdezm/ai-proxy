// Error mapping for the HTTP layer. Port of internal/clienterror (HTTPStatusFromError),
// sdk/api/handlers/handlers_errors.go (enrichAuthSelectionError, WriteErrorResponse header
// policy), handlers_execution.go (executionErrorMessage) and the Claude error envelope of
// sdk/api/handlers/claude/code_handlers.go (toClaudeError, claudeErrorDetailFromText,
// claudeErrorTypeFromStatus).
import {
  AuthManagerError,
  ModelCooldownError,
  TerminalAuthError,
  extractUpstreamErrorSummary,
  isClaudeThreadNotFound,
  isStreamTruncatedError,
  safeResponseHeaders,
} from "../auth/manager/index.ts";
import { StatusError, statusCodeOf, type ErrorMessage } from "../executor/types.ts";
import { isObject, tryParse } from "../util/json.ts";
import { isCPAReservedResponseHeader } from "./headers.ts";

/** nginx-style status for a client that went away before the proxy finished (Go: StatusClientClosedRequest). */
export const StatusClientClosedRequest = 499;

const statusTexts: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Request Entity Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  499: "Client Closed Request",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
};

/** Go's http.StatusText for the statuses this layer produces. */
export function httpStatusText(status: number): string {
  return statusTexts[status] ?? "";
}

/**
 * HTTP status carried by an error: explicit statusCode values win (StatusError,
 * AuthManagerError, RequestRejectedError), then AbortError maps to 499 and
 * TimeoutError to 504, walking the cause chain. 0 when unknown (Go: HTTPStatusFromError).
 */
export function httpStatusFromError(err: unknown): number {
  const seen = new Set<unknown>();
  let current = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = statusCodeOf(current);
    if (code !== undefined && code > 0) return code;
    if (current instanceof Error) {
      if (current.name === "AbortError") return StatusClientClosedRequest;
      if (current.name === "TimeoutError") return 504;
      current = current.cause;
      continue;
    }
    break;
  }
  return 0;
}

export function httpStatusFromErrorOr(err: unknown, fallback: number): number {
  const code = httpStatusFromError(err);
  return code > 0 ? code : fallback;
}

function isAuthSelectionCode(err: unknown): err is AuthManagerError {
  if (err instanceof ModelCooldownError) return false;
  if (!(err instanceof AuthManagerError)) return false;
  const code = err.code.trim();
  return code === "auth_not_found" || code === "auth_unavailable";
}

/**
 * Adds provider/model context (and the last upstream error) to a "no auth
 * available" selection error and defaults its status to 503
 * (Go: enrichAuthSelectionError). Other errors pass through unchanged.
 */
export function enrichAuthSelectionError(err: unknown, providers: string[], model: string): unknown {
  if (!isAuthSelectionCode(err)) return err;
  const providerText = providers.join(",") || "unknown";
  const modelText = model.trim() || "unknown";
  const baseMessage = err.message.trim() || "no auth available";
  const cause = err.cause;
  const upstreamSummary = cause !== undefined && cause !== null ? extractUpstreamErrorSummary(cause instanceof Error ? cause.message : String(cause)) : "";
  let detail =
    upstreamSummary !== "" && !baseMessage.includes(upstreamSummary)
      ? `${baseMessage} (providers=${providerText}, model=${modelText}; last upstream error: ${upstreamSummary})`
      : `${baseMessage} (providers=${providerText}, model=${modelText})`;
  if (`,${providerText},`.includes(",claude,")) detail += "; check the Claude auth/key session and cooldown state";
  const status = err.httpStatus > 0 ? err.httpStatus : 503;
  if (err instanceof TerminalAuthError) return new TerminalAuthError(err.code, detail, { httpStatus: status, cause });
  return new AuthManagerError(err.code, detail, { retryable: err.retryable, httpStatus: status, retryAfterMs: err.retryAfterMs, cause });
}

function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

/** Converts an execution failure into the handler-level ErrorMessage (Go: executionErrorMessage). */
export function executionErrorMessage(err: unknown): ErrorMessage {
  const status = httpStatusFromErrorOr(err, 500);
  const addon = err instanceof StatusError && err.headers ? new Headers(err.headers) : undefined;
  return { statusCode: status, error: asError(err), addon };
}

// ---------------------------------------------------------------------------
// Claude error envelope
// ---------------------------------------------------------------------------

export interface ClaudeErrorDetail {
  type: string;
  message: string;
  details?: { error_code: string };
}

export interface ClaudeErrorResponse {
  type: "error";
  error: ClaudeErrorDetail;
}

/** Anthropic error type for an HTTP status (Go: claudeErrorTypeFromStatus). */
export function claudeErrorTypeFromStatus(status: number): string {
  switch (status) {
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 409:
      return "conflict_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 408:
    case 504:
      return "timeout_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

/**
 * The text used for the error message: the upstream body when the error carries
 * one, otherwise the error message (Go: claudeErrorText).
 */
export function claudeErrorText(err: Error | undefined | null): string {
  if (!err) return "";
  const provider = err as { responseBody?: unknown; body?: unknown };
  if (typeof provider.responseBody === "function") {
    const body = (provider.responseBody as () => unknown).call(err);
    if (typeof body === "string" && body.length > 0) return body;
  }
  if (typeof provider.body === "string" && provider.body.length > 0) return provider.body;
  return err.message;
}

/**
 * Derives (type, message) for the Claude envelope. A JSON error body is mined
 * for its own type/message (Anthropic `{"error":{type,message}}`, OpenAI
 * `{"error":{type,message,code}}` or a flat `{type,message}` object), otherwise
 * the type follows the status (Go: claudeErrorDetailFromText).
 */
export function claudeErrorDetailFromText(status: number, errText: string): { type: string; message: string } {
  let message = errText.trim();
  if (message === "") message = httpStatusText(status);
  let errType = claudeErrorTypeFromStatus(status);

  const payload = tryParse(message);
  if (isObject(payload)) {
    const inner = payload.error;
    if (isObject(inner)) {
      if (typeof inner.type === "string" && inner.type.trim() !== "") errType = inner.type.trim();
      if (typeof inner.message === "string" && inner.message.trim() !== "") message = inner.message.trim();
      else if (typeof inner.code === "string" && inner.code.trim() !== "") message = inner.code.trim();
    } else {
      if (typeof payload.type === "string" && payload.type.trim() !== "" && payload.type.trim() !== "error") errType = payload.type.trim();
      if (typeof payload.message === "string" && payload.message.trim() !== "") message = payload.message.trim();
    }
  }
  return { type: errType, message };
}

/**
 * Builds the Claude error envelope for an ErrorMessage (Go: toClaudeError).
 *
 * Deviation from upstream: a truncated stream or transport failure
 * (StatusError.streamTruncated / the manager's stream_truncated code) is never
 * reported as invalid_request_error. Its status is lifted to 502 unless it is
 * already a 5xx or a timeout (408), so the client sees a retryable api_error.
 */
export function toClaudeError(msg: ErrorMessage | undefined | null): ClaudeErrorResponse {
  let status = 500;
  let errText = httpStatusText(status);
  let truncated = false;
  if (msg) {
    if (msg.statusCode > 0) {
      status = msg.statusCode;
      errText = httpStatusText(status);
    }
    if (msg.error) {
      truncated = isStreamTruncatedError(msg.error);
      const text = claudeErrorText(msg.error).trim();
      if (text !== "") errText = text;
    }
  }
  if (truncated && status < 500 && status !== 408) status = 502;
  const detail = claudeErrorDetailFromText(status, errText);
  if (truncated && detail.type === "invalid_request_error") detail.type = "api_error";
  const response: ClaudeErrorResponse = { type: "error", error: { type: detail.type, message: detail.message } };
  if (isClaudeThreadNotFound(status, errText)) response.error.details = { error_code: "thread_not_found" };
  return response;
}

const fallbackClaudeErrorBody = `{"type":"error","error":{"type":"api_error","message":"Internal Server Error"}}`;

/** The serialised Claude error envelope. */
export function claudeErrorBody(msg: ErrorMessage | undefined | null): string {
  try {
    return JSON.stringify(toClaudeError(msg));
  } catch {
    return fallbackClaudeErrorBody;
  }
}

/** A Claude-shaped error for errors the handler raises itself (model not found, bad body, ...). */
export function claudeErrorMessage(status: number, type: string, message: string): ErrorMessage {
  return { statusCode: status, error: new Error(JSON.stringify({ type: "error", error: { type, message } })) };
}

export interface ErrorResponseOptions {
  /** config requests.passthroughHeaders: forward the filtered upstream error headers (`addon`). */
  passthroughHeaders?: boolean;
}

/**
 * Builds the HTTP error response for a failed request (Go: ClaudeCodeAPIHandler.WriteErrorResponse).
 *
 * - A locally computed Retry-After (cooldown deadline, auth_unavailable hint,
 *   429 StatusError.retryAfterMs) is always written (Go: SafeResponseHeaders).
 * - Upstream headers (`addon`) are copied only with passthroughHeaders, never
 *   the proxy-reserved ones, and never Retry-After when a trusted local
 *   deadline was written above.
 * - `directBody` (a pre-formatted downstream body) is written verbatim.
 */
export function claudeErrorResponse(msg: ErrorMessage | undefined | null, options: ErrorResponseOptions = {}): Response {
  const status = msg && msg.statusCode > 0 ? msg.statusCode : 500;
  const headers = new Headers();
  if (msg && msg.directBody !== undefined) {
    msg.directHeaders?.forEach((value, key) => {
      if (isCPAReservedResponseHeader(key)) return;
      headers.append(key, value);
    });
    let body = msg.directBody;
    if (isClaudeThreadNotFound(status, body)) body = claudeErrorBody({ statusCode: status, error: new Error(body) });
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Response(body, { status, headers });
  }
  let trustedRetryAfter = false;
  if (msg?.error) {
    const safe = safeResponseHeaders(msg.error);
    const retryAfter = safe?.get("Retry-After");
    if (retryAfter) {
      headers.set("Retry-After", retryAfter);
      trustedRetryAfter = true;
    }
  }
  if (msg?.addon && options.passthroughHeaders) {
    const addon = msg.addon;
    const names = new Set<string>();
    addon.forEach((_value, key) => names.add(key));
    for (const key of names) {
      if (isCPAReservedResponseHeader(key)) continue;
      if (trustedRetryAfter && key.toLowerCase() === "retry-after") continue;
      headers.delete(key);
      headers.append(key, addon.get(key) ?? "");
    }
  }
  headers.set("Content-Type", "application/json");
  return new Response(claudeErrorBody(msg), { status, headers });
}

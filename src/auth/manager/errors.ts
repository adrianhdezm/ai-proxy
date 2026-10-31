// Manager error types and upstream failure classification. Port of
// sdk/cliproxy/auth/errors.go (Error, auth_unavailable, terminal auth errors),
// the modelCooldownError of selector.go, the classification helpers of
// conductor_cooldown.go (resultErrorFromError, isRequestInvalidError,
// isTransientTransportError, retryAfterFromError, ...) and
// internal/clienterror.IsRequestFault.
//
// Dropped from upstream: the trustedRetryAfterError / upstreamExecutionAttempt
// wrappers (the manager hands the original StatusError back and the HTTP layer
// derives Retry-After from `retryAfterMs`), Home round errors, websocket turn
// errors and the typed configured-TLS-handshake timeout (Bun fetch has no
// configurable handshake bound).
import { StatusError, statusCodeOf } from "../../executor/types.ts";
import type { AuthError } from "../types.ts";

export const ErrorCodeRequestScoped = "request_scoped";
export const ErrorCodeTransientTransport = "transient_transport";
export const ErrorCodeStreamTruncated = "stream_truncated";
export const ErrorCodeTransientRateLimit = "transient_rate_limit";
export const ErrorCodeForceCooldown = "force_cooldown";
export const ErrorCodeModelNotFound = "model_not_found";
/** Transport/session lifecycle failures (client abort, EOF, websocket close) that never cool credentials. */
export const ErrorCodeConnectionLifecycle = "connection_lifecycle";

/**
 * Provider agnostic failure raised by the manager itself (selection, refresh,
 * configuration). Mirrors the four-field Go Error; `statusCode` is exposed so
 * `statusCodeOf()` from the executor contract works unchanged.
 */
export class AuthManagerError extends Error {
  code: string;
  retryable: boolean;
  httpStatus: number;
  /** Locally computed recovery hint in milliseconds (auth_unavailable / model_cooldown). */
  retryAfterMs?: number;

  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; httpStatus?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AuthManagerError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.httpStatus = opts.httpStatus ?? 0;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /** HTTP-like status (0 when unknown). */
  get statusCode(): number {
    return this.httpStatus;
  }

  /** The AuthError shape stored on auth / model states. */
  toAuthError(): AuthError {
    const out: AuthError = { message: this.message, retryable: this.retryable };
    if (this.code !== "") out.code = this.code;
    if (this.httpStatus !== 0) out.httpStatus = this.httpStatus;
    return out;
  }
}

/** Marks a permanent upstream auth failure (Go: terminalAuthError). */
export class TerminalAuthError extends AuthManagerError {
  constructor(code: string, message: string, opts: { httpStatus?: number; cause?: unknown } = {}) {
    super(code, message, { retryable: false, httpStatus: opts.httpStatus, cause: opts.cause });
    this.name = "TerminalAuthError";
  }

  isTerminalAuth(): boolean {
    return true;
  }
}

export function isTerminalAuthError(err: unknown): boolean {
  return err instanceof TerminalAuthError;
}

/** Every candidate for the model is cooling down (Go: modelCooldownError). Surfaces as HTTP 429. */
export class ModelCooldownError extends AuthManagerError {
  model: string;
  provider: string;
  /** Time until the earliest candidate recovers, in milliseconds (never negative). */
  resetInMs: number;

  constructor(model: string, provider: string, resetInMs: number, cause?: unknown) {
    const reset = resetInMs < 0 ? 0 : resetInMs;
    super("model_cooldown", "", { retryable: true, httpStatus: 429, retryAfterMs: reset, cause });
    this.name = "ModelCooldownError";
    this.model = model;
    this.provider = provider;
    this.resetInMs = reset;
    this.message = this.body();
  }

  isModelCooldown(): boolean {
    return true;
  }

  /** Retry-After in whole seconds (ceil). */
  resetSeconds(): number {
    return Math.max(0, Math.ceil(this.resetInMs / 1000));
  }

  /** JSON error body mirroring the Go Error() output. */
  body(): string {
    const modelName = this.model !== "" ? this.model : "requested model";
    let message = `All credentials for model ${modelName} are cooling down`;
    if (this.provider !== "") message = `${message} via provider ${this.provider}`;
    const errorBody: Record<string, unknown> = {
      code: "model_cooldown",
      message,
      model: this.model,
      reset_time: formatResetDuration(this.resetInMs),
      reset_seconds: this.resetSeconds(),
    };
    if (this.provider !== "") errorBody.provider = this.provider;
    if (this.cause !== undefined && this.cause !== null) {
      const causeText = extractUpstreamErrorSummary(errorText(this.cause));
      if (causeText !== "") {
        errorBody.last_upstream_error = causeText;
        errorBody.message = `${message} (last error: ${causeText})`;
      }
    }
    return JSON.stringify({ error: errorBody });
  }

  headers(): Headers {
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set("Retry-After", String(this.resetSeconds()));
    return headers;
  }
}

function formatResetDuration(ms: number): string {
  let value = ms;
  if (value > 0 && value < 1000) value = 1000;
  const seconds = Math.round(value / 1000);
  if (seconds === 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  let out = "";
  if (h > 0) out += `${h}h`;
  if (m > 0 || (h > 0 && s > 0)) out += `${m}m`;
  if (s > 0 || out === "") out += `${s}s`;
  return out;
}

/** "no auth available" with a Retry-After hint when a recovery time is known (Go: newAuthUnavailableErrorWithCause). */
export function newAuthUnavailableError(nextMs: number, nowMs: number, cause?: unknown): AuthManagerError {
  if (nextMs > nowMs) {
    return new AuthManagerError("auth_unavailable", "no auth available", {
      retryable: true,
      httpStatus: 503,
      retryAfterMs: nextMs - nowMs,
      cause,
    });
  }
  return new AuthManagerError("auth_unavailable", "no auth available", { cause });
}

export function newAuthNotFoundError(message = "no auth available"): AuthManagerError {
  return new AuthManagerError("auth_not_found", message);
}

// ---------------------------------------------------------------------------
// Error inspection
// ---------------------------------------------------------------------------

/** The text used for body inspections: the upstream body when present, else the message. */
export function errorText(err: unknown): string {
  if (err === undefined || err === null) return "";
  if (err instanceof StatusError) return err.responseBody();
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function errorStatus(err: unknown): number {
  return statusCodeOf(err) ?? 0;
}

/** A request-scoped refusal that must not trigger failover (Go: isRequestScopedError). */
export function isRequestScopedError(err: unknown): boolean {
  if (err instanceof StatusError) return err.requestScoped;
  if (err instanceof AuthManagerError) return err.code === ErrorCodeRequestScoped;
  return false;
}

export function isStreamTruncatedError(err: unknown): boolean {
  if (err instanceof StatusError) return err.streamTruncated;
  if (err instanceof AuthManagerError) return err.code === ErrorCodeStreamTruncated;
  return false;
}

/** The failure applies to the whole credential (Go: isCredentialScopedError). */
export function isCredentialScopedError(err: unknown): boolean {
  return err instanceof StatusError && err.credentialScoped;
}

/** A transient capacity 429 that must not exhaust the quota (Go: isTransientRateLimitError). */
export function isTransientRateLimitError(err: unknown): boolean {
  if (isCredentialScopedError(err)) return false;
  if (err instanceof StatusError) return err.transientRateLimit;
  if (err instanceof AuthManagerError) return err.code === ErrorCodeTransientRateLimit;
  return false;
}

/** Provider supplied retry hint in milliseconds, undefined when none (Go: retryAfterFromError). */
export function retryAfterFromError(err: unknown): number | undefined {
  if (err instanceof StatusError) return err.retryAfterMs;
  if (err instanceof AuthManagerError) return err.retryAfterMs;
  if (err && typeof err === "object" && typeof (err as { retryAfterMs?: unknown }).retryAfterMs === "number") {
    return (err as { retryAfterMs: number }).retryAfterMs;
  }
  return undefined;
}

export function isUnauthorizedError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (errorStatus(err) === 401) return true;
  const raw = errorText(err).toLowerCase();
  return raw.includes("status 401") || raw.includes("401 unauthorized");
}

export function isInvalidGrantErrorMessage(message: string | undefined): boolean {
  return (message ?? "").toLowerCase().includes("invalid_grant");
}

export function isInvalidGrantError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (!isInvalidGrantErrorMessage(errorText(err))) return false;
  const status = errorStatus(err);
  return status === 400 || status === 401 || status === 0;
}

export function isInvalidGrantResultError(err: AuthError | undefined): boolean {
  if (!err) return false;
  if (!isInvalidGrantErrorMessage(err.code) && !isInvalidGrantErrorMessage(err.message)) return false;
  const status = err.httpStatus ?? 0;
  return status === 400 || status === 401 || status === 0;
}

const modelSupportPatterns = [
  "model_not_supported",
  "requested model is not supported",
  "requested model is unsupported",
  "requested model is unavailable",
  "model is not supported",
  "model not supported",
  "unsupported model",
  "model unavailable",
  "not available for your plan",
  "not available for your account",
];

/** Message patterns of a credential/model capability mismatch (Go: isModelSupportErrorMessage). */
export function isModelSupportErrorMessage(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (lower === "") return false;
  return modelSupportPatterns.some((pattern) => lower.includes(pattern));
}

function parseJSONObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function pathString(obj: Record<string, unknown> | undefined, path: string): string {
  let cursor: unknown = obj;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return "";
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor.trim().toLowerCase() : "";
}

const errorCodePaths = ["error.code", "code", "response.error.code", "body.error.code"];
const errorTypePaths = ["error.type", "type", "response.error.type", "body.error.type"];

function hasModelNotFoundErrorBody(text: string): boolean {
  const body = parseJSONObject(text);
  if (!body) return false;
  return errorCodePaths.some((path) => {
    const code = pathString(body, path);
    return code === "model_not_found" || code === "model_not_found_error";
  });
}

/** A structured upstream model_not_found rejection (Go: isExplicitModelNotFoundError, structured part). */
export function isExplicitModelNotFoundError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  return hasModelNotFoundErrorBody(errorText(err));
}

/** The failure is a credential/model capability mismatch, not a caller fault (Go: isModelSupportError). */
export function isModelSupportError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (isExplicitModelNotFoundError(err)) return true;
  const status = errorStatus(err);
  if (status !== 400 && status !== 422 && status !== 404) return false;
  return isModelSupportErrorMessage(errorText(err));
}

export function isModelSupportResultError(err: AuthError | undefined): boolean {
  if (!err) return false;
  if (hasModelNotFoundErrorBody(err.message) || err.code === ErrorCodeModelNotFound) return true;
  const status = err.httpStatus ?? 0;
  if (status !== 400 && status !== 422 && status !== 404) return false;
  return isModelSupportErrorMessage(err.message);
}

const requestFaultCodes = new Set([
  "cyber_policy",
  "context_length_exceeded",
  "message_too_big",
  "string_above_max_length",
  "invalid_prompt",
  "invalid_value",
  "unsupported_value",
  "invalid_request_error",
  "previous_response_not_found",
]);
const requestFaultTypes = new Set(["invalid_request", "invalid_request_error", "bad_request_error", "invalid_prompt"]);

function hasRequestFaultBody(text: string): boolean {
  const body = parseJSONObject(text);
  if (!body) return false;
  if (errorCodePaths.some((path) => requestFaultCodes.has(pathString(body, path)))) return true;
  return errorTypePaths.some((path) => requestFaultTypes.has(pathString(body, path)));
}

function hasAuthenticationErrorBody(text: string): boolean {
  const body = parseJSONObject(text);
  if (!body) return false;
  return errorTypePaths.some((path) => pathString(body, path) === "authentication_error");
}

/** Codex "item not found ... not persisted when store is false" plain-text 404 (Go: clienterror.IsItemNotPersisted). */
export function isItemNotPersisted(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("item with id") && lower.includes("not found") && lower.includes("items are not persisted when `store` is set to false");
}

/** Claude's stale previous_message_id continuation 404 (Go: clienterror.IsClaudeThreadNotFound). */
export function isClaudeThreadNotFound(status: number, text: string): boolean {
  if (status !== 404) return false;
  const body = text.trim();
  if (body === "") return false;
  const parsed = parseJSONObject(body);
  if (parsed) {
    const message = pathString(parsed, "error.message");
    return pathString(parsed, "error.type") === "not_found_error" && message.includes("thread state") && message.includes("previous_message_id");
  }
  const lower = body.toLowerCase();
  return lower.includes("thread state") && lower.includes("previous_message_id");
}

/**
 * Whether an upstream failure is caused by the request and must not rotate or
 * penalise credentials (Go: clienterror.IsRequestFault).
 */
export function isRequestFault(status: number, err: unknown): boolean {
  if (status <= 0) status = errorStatus(err);
  const text = errorText(err);
  if (status === 402 || status === 429) return false;
  if (status === 401 && hasAuthenticationErrorBody(text)) return false;
  if (isClaudeThreadNotFound(status, text)) return true;
  if (hasModelNotFoundErrorBody(text)) return false;
  if (hasRequestFaultBody(text)) return true;
  if (text !== "" && isItemNotPersisted(text)) return true;
  switch (status) {
    case 400:
    case 409:
    case 413:
    case 422:
      return true;
    default:
      return false;
  }
}

/**
 * Whether the error ends credential rotation for this request
 * (Go: isRequestInvalidError): request-scoped faults and truncated accepted streams.
 */
export function isRequestInvalidError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (isStreamTruncatedError(err)) return true;
  if (isRequestScopedError(err)) return true;
  if (isInvalidGrantError(err)) return false;
  if (isModelSupportError(err)) return false;
  return isRequestFault(errorStatus(err), err);
}

const transientTransportPatterns = [
  // Go: isTransientTransportMessage
  "tls: tls handshake",
  "tls handshake timeout",
  "wsarecv",
  "wsasend",
  "a connection attempt failed",
  "connection refused",
  "connection reset",
  "i/o timeout",
  "no such host",
  "server misbehaving",
  "network is unreachable",
  "no route to host",
  "broken pipe",
  "connection aborted",
  "use of closed network connection",
  "unexpected eof",
  // Bun/Node fetch spellings of the same failures
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
  "unexpected end of",
  "socket hang up",
  "fetch failed",
  "connection closed",
  "the socket connection was closed",
  "was aborted",
  "timed out",
];

/** x/net/http2 closed-connection errors (Go: isHTTP2ClosedConnectionMessage). */
function isHTTP2ClosedConnectionMessage(lower: string): boolean {
  return lower.includes("http2: client connection force closed via clientconn.close") || lower.includes("http2: client conn is closed");
}

function isTransientTransportMessage(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (lower === "") return false;
  return transientTransportPatterns.some((pattern) => lower.includes(pattern)) || isHTTP2ClosedConnectionMessage(lower);
}

/** Pre-HTTP dial/TLS/DNS/reset failures that skip cooldown but allow retry rounds (Go: isTransientTransportError). */
export function isTransientTransportError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (errorStatus(err) !== 0) return false;
  if (err instanceof AuthManagerError) return err.code === ErrorCodeTransientTransport;
  // Caller-owned cancellation and deadlines are never transport failures.
  if (isAbortError(err)) return false;
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH)$/.test(code)) return true;
  return isTransientTransportMessage(errorText(err));
}

/**
 * Transport/session lifecycle failures that must not cool credentials: client
 * cancellation, caller deadlines, EOF and websocket/HTTP2 close disconnects
 * (Go: isConnectionLifecycleError). Status-bearing errors always stay coolable.
 */
export function isConnectionLifecycleError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (err instanceof Error && err.name === "CodexWebsocketCloseError") {
    const code = (err as { code?: unknown }).code;
    if (code === 1000 || code === 1001 || code === 1006) return true;
  }
  if (errorStatus(err) !== 0) return false;
  if (isAbortError(err)) return true;
  return isConnectionLifecycleMessage(errorText(err));
}

/** Go: isConnectionLifecycleMessage. */
export function isConnectionLifecycleMessage(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (lower === "") return false;
  if (lower === "context canceled" || lower === "context deadline exceeded" || lower === "eof" || lower === "unexpected eof") return true;
  if (lower.includes("websocket: close 1000") || lower.includes("websocket: close 1001") || lower.includes("websocket: close 1006")) return true;
  return lower.includes("unexpected eof") || isHTTP2ClosedConnectionMessage(lower);
}

export function isConnectionLifecycleResultError(err: AuthError | undefined): boolean {
  if (!err) return false;
  if (err.code === ErrorCodeConnectionLifecycle) return true;
  if (err.code === ErrorCodeTransientTransport) return false;
  // Message fallback only without an HTTP status, so 401/429/5xx bodies cannot suppress cooldown.
  if (statusCodeFromResult(err) !== 0) return false;
  return isConnectionLifecycleMessage(err.message);
}

/** Cloudflare bot/WAF challenge markers (Go: isCloudflareChallengeErrorMessage). */
export function isCloudflareChallengeErrorMessage(message: string): boolean {
  const lower = message.trim().toLowerCase();
  return lower.includes("challenge-platform") || lower.includes("cf-mitigated") || lower.includes("cloudflare challenge") || (lower.includes("just a moment") && lower.includes("cloudflare"));
}

/** A Cloudflare challenge (served with 403); HTTP >= 500 origin failures (520-526) take precedence (Go: isCloudflareChallengeError). */
export function isCloudflareChallengeError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  if (errorStatus(err) >= 500) return false;
  return isCloudflareChallengeErrorMessage(errorText(err));
}

export function isCloudflareChallengeResultError(err: AuthError | undefined): boolean {
  if (!err) return false;
  if (statusCodeFromResult(err) >= 500) return false;
  return isCloudflareChallengeErrorMessage(err.message);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Converts any thrown value into the AuthError recorded on auth state (Go: resultErrorFromError). */
export function resultErrorFromError(err: unknown): AuthError | undefined {
  if (err === undefined || err === null) return undefined;
  let result: AuthError;
  if (err instanceof AuthManagerError) {
    result = err.toAuthError();
  } else if (err instanceof StatusError) {
    result = { message: err.responseBody(), retryable: false, httpStatus: err.statusCode };
  } else {
    result = { message: errorText(err), retryable: false };
  }
  if (!result.httpStatus) {
    const status = errorStatus(err);
    if (status !== 0) result.httpStatus = status;
  }
  if (isStreamTruncatedError(err)) {
    result.code = ErrorCodeStreamTruncated;
  } else if (isTransientRateLimitError(err)) {
    result.code = ErrorCodeTransientRateLimit;
  } else if (isExplicitModelNotFoundError(err)) {
    if (!result.code || result.code === ErrorCodeRequestScoped) result.code = ErrorCodeModelNotFound;
  } else if (isRequestScopedError(err) || isRequestInvalidError(err)) {
    result.code = ErrorCodeRequestScoped;
  } else if (isConnectionLifecycleError(err)) {
    // Lifecycle classification for markResult without making the error request-scoped.
    if (!result.code || result.code === ErrorCodeConnectionLifecycle) result.code = ErrorCodeConnectionLifecycle;
  } else if (isTransientTransportError(err)) {
    if (!result.code || result.code === ErrorCodeTransientTransport) result.code = ErrorCodeTransientTransport;
  }
  return result;
}

export function isRequestScopedResultError(err: AuthError | undefined): boolean {
  return !!err && err.code === ErrorCodeRequestScoped;
}

export function isTransientTransportResultError(err: AuthError | undefined): boolean {
  if (!err) return false;
  if (err.code === ErrorCodeTransientTransport) return true;
  if (statusCodeFromResult(err) !== 0) return false;
  // Matching text alone must not promote a handshake-timeout phrase (Go: isTransientTransportResultError).
  if (err.message.toLowerCase().includes("tls handshake timeout")) return false;
  return isTransientTransportMessage(err.message);
}

export function isStreamTruncatedResultError(err: AuthError | undefined): boolean {
  return !!err && err.code === ErrorCodeStreamTruncated;
}

export function isTransientRateLimitResultError(err: AuthError | undefined): boolean {
  return !!err && err.code === ErrorCodeTransientRateLimit;
}

/** Failures that must not mark auth/model cooling (Go: shouldSkipCredentialCooldown). */
export function shouldSkipCredentialCooldown(err: AuthError | undefined): boolean {
  if (err && err.code === ErrorCodeForceCooldown) return false;
  return isRequestScopedResultError(err) || isConnectionLifecycleResultError(err) || isTransientTransportResultError(err) || isStreamTruncatedResultError(err);
}

export function statusCodeFromResult(err: AuthError | undefined): number {
  return err?.httpStatus ?? 0;
}

/** Statuses that permit another credential retry round (Go: isCredentialRetryRoundStatus). */
export function isCredentialRetryRoundStatus(status: number): boolean {
  switch (status) {
    case 403:
    case 408:
    case 429:
    case 500:
    case 502:
    case 503:
    case 504:
      return true;
    default:
      return false;
  }
}

export function isRequestRetryRoundError(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  return isCredentialRetryRoundStatus(errorStatus(err)) || isTransientTransportError(err);
}

// ---------------------------------------------------------------------------
// Upstream error summaries (Go: ExtractUpstreamErrorSummary / SanitizeUpstreamErrorSummary)
// ---------------------------------------------------------------------------

const sanitizers: Array<[RegExp, string]> = [
  [/((?:[A-Za-z0-9.+_-]+:)?\/\/)(?:[^:\s/@]+:[^@\s]+|[^@\s/]+)@/gi, "$1[REDACTED_AUTH]@"],
  [/([?&][A-Za-z0-9_.-]*(?:key|token|secret|password|auth|sig|signature)=)[^&\s,\r\n;]+/gi, "$1[REDACTED]"],
  [/\b(?:set-)?cookie\s*:[^\r\n]+/gi, "Cookie: [REDACTED]"],
  [/\bauthorization\s*[:=]\s*[^\r\n]+/gi, "Authorization: [REDACTED]"],
  [/\b(?:sk-[A-Za-z0-9._~+/=-]{6,}|ghp_[A-Za-z0-9._~+/=-]{6,})\b/g, "sk-[REDACTED]"],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/((?:'|")?(?:[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credentials?|sessionid))(?:'|")?\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;|\r\n]+)/gi, "$1[REDACTED]"],
  [/(^|[\s("'`=\[])(\/(?:[^/\s"'`,;:()\[\]<>]+\/)*[^/\s"'`,;:()\[\]<>]+\.(?:json|yaml|yml|key|pem|txt|log|toml|conf|env|crt|cer))/g, "$1[REDACTED_PATH]"],
  [/\b[A-Za-z]:\\[^\r\n:,;'"<>]+/g, "[REDACTED_PATH]"],
];

/** Removes credentials, tokens and file paths and bounds the length (Go: SanitizeUpstreamErrorSummary). */
export function sanitizeUpstreamErrorSummary(s: string): string {
  let out = s.trim();
  if (out === "") return "";
  for (const [pattern, replacement] of sanitizers) out = out.replace(pattern, replacement);
  const chars = Array.from(out);
  if (chars.length > 256) return chars.slice(0, 253).join("") + "...";
  return out;
}

/** Concise, sanitised summary of an upstream error string (Go: ExtractUpstreamErrorSummary). */
export function extractUpstreamErrorSummary(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";
  let jsonPart = trimmed;
  const idx = trimmed.indexOf(": {");
  if (idx !== -1 && idx < 50) jsonPart = trimmed.slice(idx + 2).trim();
  const parsed = parseJSONObject(jsonPart);
  if (parsed) {
    let code = "";
    let message = "";
    const errNode = parsed.error;
    if (errNode && typeof errNode === "object" && !Array.isArray(errNode)) {
      const node = errNode as Record<string, unknown>;
      code = typeof node.code === "string" ? node.code.trim() : "";
      if (code === "") code = typeof node.type === "string" ? node.type.trim() : "";
      message = typeof node.message === "string" ? node.message.trim() : "";
    } else if (typeof errNode === "string") {
      message = errNode.trim();
    }
    if (code === "" && message === "") {
      code = typeof parsed.code === "string" ? parsed.code.trim() : "";
      if (code === "") code = typeof parsed.type === "string" ? parsed.type.trim() : "";
      message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    }
    let summary = "";
    if (code !== "" && message !== "") {
      summary = code.toLowerCase() === message.toLowerCase() || message.toLowerCase().includes(code.toLowerCase()) ? message : `${code}: ${message}`;
    } else if (message !== "") {
      summary = message;
    } else if (code !== "") {
      summary = code;
    }
    if (summary !== "") return sanitizeUpstreamErrorSummary(summary);
  }
  return sanitizeUpstreamErrorSummary(trimmed);
}

// ---------------------------------------------------------------------------
// Response hints for the HTTP layer
// ---------------------------------------------------------------------------

/** Retry-After seconds (ceil, minimum 1) for a positive delay, undefined otherwise (Go: safeRetryAfterHeader). */
export function retryAfterSeconds(retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return undefined;
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * Headers the HTTP layer may always expose for a manager error: only the
 * locally computed recovery hint, never raw upstream headers (Go: SafeResponseHeaders).
 */
export function safeResponseHeaders(err: unknown): Headers | undefined {
  if (err instanceof ModelCooldownError) return err.headers();
  if (err instanceof AuthManagerError) {
    const seconds = retryAfterSeconds(err.retryAfterMs);
    if (seconds === undefined) return undefined;
    return new Headers({ "Retry-After": String(seconds) });
  }
  if (err instanceof StatusError && err.statusCode === 429) {
    const seconds = retryAfterSeconds(err.retryAfterMs);
    if (seconds === undefined) return undefined;
    return new Headers({ "Retry-After": String(seconds) });
  }
  return undefined;
}

// Error classification for the OpenAI API-key executor. Port of
// newOpenAICompatStatusError, openAICompatRetryAfter, parseRetryAfterHeader,
// openAICompatErrorEvent, openAICompatChunkHasFinishReason and
// openAICompatStreamDataError from internal/runtime/executor/openai_compat_executor.go.
import { StatusError } from "../types.ts";
import { getAt, gint, gstr, isArr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

/** Fallback retry delay for explicit per-minute token limits without a Retry-After header. */
export const openAICompatTPMFallbackRetryAfterMs = 60_000;

/**
 * Builds the StatusError for a non-2xx upstream response. The body is the
 * error payload passed through to the client; a 429 carries the provider's
 * retry hint (Go: newOpenAICompatStatusError).
 */
export function newOpenAICompatStatusError(status: number, headers: Headers | undefined, body: string, nowMs: number = Date.now()): StatusError {
  return new StatusError(status, body, {
    headers,
    body,
    retryAfterMs: openAICompatRetryAfter(status, headers, body, nowMs),
  });
}

/**
 * Parses an HTTP Retry-After header in either the delay-seconds or HTTP-date
 * form (Go: parseRetryAfterHeader). A present, valid value always yields a
 * number so an explicit immediate retry (0 seconds or a past date) stays
 * distinguishable from an absent hint; missing or malformed values yield undefined.
 */
export function parseRetryAfterHeader(headers: Headers | undefined, nowMs: number): number | undefined {
  if (!headers) return undefined;
  const raw = (headers.get("Retry-After") ?? "").trim();
  if (raw === "") return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return Number.MAX_SAFE_INTEGER;
    return Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER);
  }
  const deadline = Date.parse(raw);
  if (!Number.isNaN(deadline)) {
    const delay = deadline - nowMs;
    return delay < 0 ? 0 : delay;
  }
  return undefined;
}

/**
 * Preserves the provider's standard Retry-After signal on 429s. Some
 * OpenAI-compatible providers omit that header for explicit per-minute token
 * limits; in that narrow case a one-minute fallback prevents immediate replay
 * of the same large request (Go: openAICompatRetryAfter).
 */
export function openAICompatRetryAfter(status: number, headers: Headers | undefined, body: string, nowMs: number): number | undefined {
  if (status !== 429) return undefined;
  const fromHeader = parseRetryAfterHeader(headers, nowMs);
  if (fromHeader !== undefined) return fromHeader;
  const root = tryParse<unknown>(body);
  const code = gstr(getAt(root, "error.code")).trim().toLowerCase();
  const message = gstr(getAt(root, "error.message")).trim().toLowerCase();
  if (code.includes("tpmratelimitexceeded") || (message.includes("tokens per minute") && message.includes("limit") && message.includes("exceeded"))) {
    return openAICompatTPMFallbackRetryAfterMs;
  }
  return undefined;
}

/** SSE event names that mark an upstream failure (Go: openAICompatErrorEvent). */
export function openAICompatErrorEvent(eventName: string): boolean {
  const name = eventName.toLowerCase();
  return name === "error" || name === "response.error" || name === "response.failed";
}

/** Whether a chat completion chunk carries a non-empty choices[].finish_reason (Go: openAICompatChunkHasFinishReason). */
export function openAICompatChunkHasFinishReason(payload: string): boolean {
  const choices = getAt(tryParse<unknown>(payload), "choices");
  if (!isArr(choices)) return false;
  for (const choice of choices) {
    const reason = getAt(choice, "finish_reason");
    if (reason !== undefined && reason !== null && gstr(reason).trim() !== "") return true;
  }
  return false;
}

/**
 * Detects an error payload inside a 2xx SSE stream and converts it to a
 * StatusError carrying the payload's status (502 when it has none)
 * (Go: openAICompatStreamDataError).
 */
export function openAICompatStreamDataError(payload: string, eventName: string): StatusError | undefined {
  if (payload.length === 0) return undefined;
  const root = tryParse<unknown>(payload);
  if (root === undefined) return undefined;
  const payloadType = gstr(getAt(root, "type")).toLowerCase();
  let hasError = false;
  for (const path of ["error", "response.error"]) {
    const node = getAt(root, path);
    if (node !== undefined && node !== null) {
      hasError = true;
      break;
    }
  }
  const hasTopLevelErrorFields = getAt(root, "code") !== undefined && getAt(root, "message") !== undefined;
  if (!hasError && payloadType !== "error" && payloadType !== "response.error" && payloadType !== "response.failed" && !openAICompatErrorEvent(eventName) && !hasTopLevelErrorFields) {
    return undefined;
  }
  let status = 0;
  for (const path of ["status", "status_code", "error.status", "error.status_code", "response.error.status", "response.error.status_code"]) {
    status = gint(getAt(root, path));
    if (status >= 400 && status <= 599) break;
  }
  if (status < 400 || status > 599) status = 502;
  return new StatusError(status, payload, { body: payload });
}

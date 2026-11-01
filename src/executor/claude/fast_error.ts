// Fast-mode (speed=fast / fast-mode-2026-02-01) failures stop at the caller:
// they do not justify retrying another credential or cooling the selected one,
// unless the failure is a genuine credential-level rate limit. Port of
// internal/runtime/executor/claude_executor_fast_error.go, expressed through the
// StatusError flags the auth manager reads:
//
//   - an upstream HTTP error is passed through as-is (status, decoded body,
//     headers without the stale Content-Encoding / Content-Length), request-scoped
//     (Go: claudeFastDirectResponseError);
//   - transport, decode and stream failures keep their cause and become
//     request-scoped; a failure after a 2xx reports status 0 rather than the
//     upstream success (Go: claudeFastRequestError).
import { StatusError } from "../types.ts";
import { claudeRequestUsesFastMode, claudeRequestedBetas } from "./betas.ts";
import { claudeHeadersIndicateUnifiedRateLimitRejection, parseClaudeRateLimitResetForError } from "./ratelimit.ts";
import { headerValuesCaseInsensitive } from "./upstream.ts";

/** Whether the outgoing request selects the fast tier, by body or by the emitted beta (Go: claudeRequestIsFast). */
export function claudeRequestIsFast(headers: Headers | undefined, body: string): boolean {
  if (!headers) return false;
  const betas = headerValuesCaseInsensitive(headers, "Anthropic-Beta").join(",");
  return claudeRequestUsesFastMode(body, claudeRequestedBetas(betas, undefined));
}

/** The upstream HTTP error of a fast request, passed through without retry (Go: newClaudeFastDirectResponseError). */
export function newClaudeFastDirectResponseError(statusCode: number, upstreamHeaders: Headers | undefined, body: string, nowMs: number = Date.now()): StatusError {
  // The body has already been decoded; drop headers that describe the compressed bytes.
  const headers = new Headers(upstreamHeaders);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  let retryAfterMs: number | undefined;
  let credentialScoped = false;
  if (statusCode === 429) {
    retryAfterMs = parseClaudeRateLimitResetForError(upstreamHeaders, body, nowMs);
    credentialScoped = claudeHeadersIndicateUnifiedRateLimitRejection(upstreamHeaders);
  }
  return new StatusError(statusCode, `claude Fast upstream request failed with status ${statusCode}`, {
    headers,
    body,
    retryAfterMs,
    credentialScoped,
    requestScoped: !credentialScoped,
  });
}

/** Marks a fast request's failure request-scoped, keeping its cause (Go: wrapClaudeFastRequestError). */
export function wrapClaudeFastRequestError(fastRequest: boolean, statusCode: number, err: unknown): unknown {
  if (!fastRequest || err === undefined || err === null) return err;
  if (err instanceof Error && err.name === "AbortError") return err;
  const status = statusCode >= 200 && statusCode < 300 ? 0 : statusCode;
  if (err instanceof StatusError) {
    const credentialScoped = err.credentialScoped;
    return new StatusError(status, err.message, {
      headers: err.headers,
      body: err.body,
      retryAfterMs: err.retryAfterMs,
      streamTruncated: err.streamTruncated,
      credentialScoped,
      requestScoped: !credentialScoped,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StatusError(status, message, { requestScoped: true, cause: err });
}

/** Re-throws a stream's terminal failure through wrapClaudeFastRequestError. */
export async function* wrapClaudeFastStreamErrors(chunks: AsyncIterable<string>, fastRequest: boolean, statusCode: number): AsyncGenerator<string> {
  try {
    yield* chunks;
  } catch (err) {
    throw wrapClaudeFastRequestError(fastRequest, statusCode, err);
  }
}

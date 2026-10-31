// Streaming failover plumbing. Port of sdk/cliproxy/auth/conductor_stream.go:
// readStreamBootstrap (hold the response until the first non-empty chunk),
// streamBootstrapError (an error before any payload fails over), wrapStreamResult
// (a committed stream is forwarded as-is and its outcome recorded at the end)
// and streamErrorResult (a stream whose only item is the error).
import type { StreamResult } from "../../executor/types.ts";
import { AuthManagerError } from "./errors.ts";

/**
 * Tags a failure that happened after the executor returned a stream but before
 * any payload reached the client. The cause is the real upstream error.
 */
export class StreamBootstrapError extends Error {
  readonly bootstrapCause: unknown;
  readonly headers?: Headers;

  constructor(cause: unknown, headers?: Headers) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "StreamBootstrapError";
    this.bootstrapCause = cause;
    this.headers = headers ? new Headers(headers) : undefined;
  }
}

/** The real upstream error behind a bootstrap tag (identity otherwise). */
export function unwrapStreamBootstrapError(err: unknown): unknown {
  return err instanceof StreamBootstrapError ? err.bootstrapCause : err;
}

export function newEmptyStreamError(): AuthManagerError {
  return new AuthManagerError("empty_stream", "upstream stream closed before first payload", { retryable: true, httpStatus: 502 });
}

export interface StartedStream {
  first: string;
  iterator: AsyncIterator<string>;
  headers?: Headers;
}

/**
 * Reads the upstream stream until its first non-empty chunk. Throws a
 * StreamBootstrapError when the stream fails or closes before producing one
 * (Go: readStreamBootstrap + the empty_stream branch).
 */
export async function readStreamBootstrap(result: StreamResult): Promise<StartedStream> {
  if (!result || !result.chunks) {
    throw new StreamBootstrapError(new AuthManagerError("empty_stream", "upstream stream has no source", { retryable: true, httpStatus: 502 }), result?.headers);
  }
  const iterator = result.chunks[Symbol.asyncIterator]();
  for (;;) {
    let next: IteratorResult<string>;
    try {
      next = await iterator.next();
    } catch (err) {
      throw new StreamBootstrapError(err, result.headers);
    }
    if (next.done) throw new StreamBootstrapError(newEmptyStreamError(), result.headers);
    if (typeof next.value === "string" && next.value.length > 0) return { first: next.value, iterator, headers: result.headers };
  }
}

/** A committed stream that only carries the terminal error (Go: streamErrorResult). */
export function streamErrorResult(headers: Headers | undefined, err: unknown): StreamResult {
  async function* chunks(): AsyncGenerator<string> {
    throw err;
  }
  return { headers: headers ? new Headers(headers) : undefined, chunks: chunks() };
}

/**
 * Forwards a committed stream to the caller. `onDone` runs exactly once when the
 * stream ends: with the error when the upstream iterator threw, without one
 * when it completed or the consumer stopped early (Go: wrapStreamResult).
 */
export function wrapStreamResult(started: StartedStream, onDone: (err: unknown | undefined) => void): StreamResult {
  const { first, iterator, headers } = started;
  async function* chunks(): AsyncGenerator<string> {
    let outcome: { err?: unknown } | undefined;
    try {
      yield first;
      for (;;) {
        let next: IteratorResult<string>;
        try {
          next = await iterator.next();
        } catch (err) {
          outcome = { err };
          throw err;
        }
        if (next.done) break;
        if (typeof next.value !== "string" || next.value.length === 0) continue;
        yield next.value;
      }
      outcome = {};
    } finally {
      if (!outcome) {
        // The consumer stopped early: release the upstream iterator.
        outcome = {};
        try {
          await iterator.return?.();
        } catch {
          // ignore
        }
      }
      onDone(outcome.err);
    }
  }
  return { headers, chunks: chunks() };
}

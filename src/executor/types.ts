// Executor contracts. Port of the relevant parts of sdk/cliproxy/executor/types.go,
// sdk/cliproxy/auth/conductor.go (ProviderExecutor) and internal/interfaces/error_message.go.
import type { Format } from "../translator/types.ts";
import type { Auth } from "../auth/types.ts";

/** Metadata keys stored in ExecOptions.metadata / ExecRequest.metadata. */
export const RequestedModelMetadataKey = "requested_model";
export const RequestPathMetadataKey = "request_path";
export const ReasoningEffortMetadataKey = "reasoning_effort";
export const SelectedAuthMetadataKey = "selected_auth_id";
export const PinnedAuthMetadataKey = "pinned_auth_id";

export interface ExecRequest {
  /** Upstream model identifier after alias/suffix resolution. */
  model: string;
  /** Provider specific JSON payload (inbound format; the executor translates it). */
  payload: string;
  /** Payload schema of `payload`. */
  format: Format;
  /** Optional provider specific execution hints. */
  metadata?: Record<string, unknown>;
}

export interface ExecOptions {
  /** Streaming mode. */
  stream: boolean;
  /** Optional alternate format hint (e.g. "sse"). */
  alt?: string;
  /** Inbound request headers forwarded to the provider request builder. */
  headers?: Headers;
  /** Optional query string parameters. */
  query?: URLSearchParams;
  /** Inbound request bytes prior to translation. */
  originalRequest?: string;
  /** Inbound schema. */
  sourceFormat: Format;
  /** Downstream response schema; defaults to sourceFormat. */
  responseFormat?: Format;
  /** Extra execution hints shared across selection and executors. */
  metadata?: Record<string, unknown>;
  /** Cancels the upstream call when the client goes away. */
  signal?: AbortSignal;
  /** Overrides the credential and global proxy for this execution only. */
  proxyUrl?: string;
}

export function responseFormatOrSource(opts: ExecOptions): Format {
  return opts.responseFormat && opts.responseFormat !== "" ? opts.responseFormat : opts.sourceFormat;
}

export interface ExecResponse {
  /** Provider response already translated to the response format. */
  payload: string;
  /** Optional structured data for translators. */
  metadata?: Record<string, unknown>;
  /** Upstream HTTP response headers for passthrough to clients. */
  headers?: Headers;
}

/**
 * Result of a streaming execution. `chunks` yields fully translated SSE
 * fragments (each already in the response format, e.g. `event: ...\ndata: ...\n\n`).
 * A terminal failure is surfaced by the iterator throwing, usually a StatusError.
 */
export interface StreamResult {
  headers?: Headers;
  chunks: AsyncIterable<string>;
}

/** Error carrying an upstream HTTP status, headers and body. */
export class StatusError extends Error {
  statusCode: number;
  headers?: Headers;
  body?: string;
  /** Marks a request-scoped refusal (bad request) that must not trigger failover. */
  requestScoped: boolean;
  /** Set when the upstream stream ended before a terminal event. */
  streamTruncated: boolean;
  /**
   * Upstream-provided retry delay in milliseconds (Retry-After header,
   * resets_in_seconds, retryDelay, ...). Undefined when the upstream gave none.
   */
  retryAfterMs?: number;
  /**
   * The failure applies to the whole credential (e.g. account usage limit),
   * so every model it serves must be cooled down, not just the requested one.
   */
  credentialScoped: boolean;
  /** A transient capacity/rate-limit rejection that should not escalate the backoff level. */
  transientRateLimit: boolean;

  constructor(
    statusCode: number,
    message: string,
    opts: {
      headers?: Headers;
      body?: string;
      requestScoped?: boolean;
      streamTruncated?: boolean;
      retryAfterMs?: number;
      credentialScoped?: boolean;
      transientRateLimit?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "StatusError";
    this.statusCode = statusCode;
    this.headers = opts.headers;
    this.body = opts.body;
    this.requestScoped = opts.requestScoped ?? false;
    this.streamTruncated = opts.streamTruncated ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.credentialScoped = opts.credentialScoped ?? false;
    this.transientRateLimit = opts.transientRateLimit ?? false;
  }

  /** Mirrors ResponseBody() of the Go StatusError; the body wins over the message. */
  responseBody(): string {
    return this.body && this.body.length > 0 ? this.body : this.message;
  }
}

export function statusCodeOf(err: unknown): number | undefined {
  if (err instanceof StatusError) return err.statusCode;
  if (err && typeof err === "object" && typeof (err as { statusCode?: unknown }).statusCode === "number") {
    return (err as { statusCode: number }).statusCode;
  }
  return undefined;
}

/** Error payload handed to HTTP handlers. */
export interface ErrorMessage {
  statusCode: number;
  error: Error;
  /** Upstream headers that may be passed through when enabled. */
  addon?: Headers;
  /** Pre-formatted downstream body supplied by a trusted component. */
  directBody?: string;
  directHeaders?: Headers;
}

/**
 * ProviderExecutor is implemented once per upstream transport
 * (claude, codex, gemini-cli, aistudio, openai-compat).
 */
export interface ProviderExecutor {
  /** Provider key handled by this executor. */
  readonly identifier: string;
  /** Non-streaming execution; returns the response translated to the response format. */
  execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse>;
  /** Streaming execution; chunks are translated to the response format. */
  executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult>;
  /** Refreshes provider credentials and returns the updated auth. */
  refresh(auth: Auth): Promise<Auth>;
  /** Token counting for the given request. */
  countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse>;
}

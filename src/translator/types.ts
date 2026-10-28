// Translator contracts. Port of sdk/translator/{format,formats,types}.go.
//
// Conventions for this port:
// - Payloads are JSON strings (the Go code used []byte with gjson/sjson).
// - A stream translator receives one upstream SSE fragment at a time and
//   returns zero or more fully formed downstream SSE fragments.
// - Per-stream translator state lives in TranslatorState.value (Go: param *any).

/** Identifies a request/response schema used inside the proxy. */
export type Format = string;

export const FormatOpenAI: Format = "openai";
export const FormatOpenAIResponse: Format = "openai-response";
export const FormatClaude: Format = "claude";
export const FormatGemini: Format = "gemini";
export const FormatCodex: Format = "codex";

/** Request-scoped context handed to response translators. */
export interface TranslateContext {
  signal?: AbortSignal;
  /** Free-form request-scoped values (e.g. the inbound request id). */
  values?: Record<string, unknown>;
}

export const emptyContext: TranslateContext = {};

/** Mutable per-stream state slot; translators store their own state in `value`. */
export interface TranslatorState {
  value?: unknown;
}

/**
 * Optional contract a translator state may implement: a retained tool-input
 * failure that must never be recovered by raw fallback (Go: ToolInputError()).
 */
export interface ToolInputErrorState {
  toolInputError(): Error | undefined;
}

export function toolInputFailed(state: TranslatorState | undefined): boolean {
  const v = state?.value as Partial<ToolInputErrorState> | undefined;
  return !!v && typeof v.toolInputError === "function" && v.toolInputError() !== undefined;
}

/**
 * Converts a request payload from a source schema to a target schema.
 * Throwing a RequestRejectedError is a request-scoped refusal (HTTP 400).
 */
export type RequestTransform = (model: string, rawJSON: string, stream: boolean) => string;

/** Converts one streaming response fragment from the upstream schema to the client schema. */
export type ResponseStreamTransform = (
  ctx: TranslateContext,
  model: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
) => string[];

/** Converts a complete non-streaming response from the upstream schema to the client schema. */
export type ResponseNonStreamTransform = (
  ctx: TranslateContext,
  model: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
) => string;

/** Converts a token count into the client schema's count_tokens response. */
export type ResponseTokenCountTransform = (ctx: TranslateContext, count: number) => string;

export interface ResponseTransform {
  stream?: ResponseStreamTransform;
  nonStream?: ResponseNonStreamTransform;
  tokenCount?: ResponseTokenCountTransform;
}

/** A request-scoped refusal raised by a request translator. */
export class RequestRejectedError extends Error {
  readonly statusCode: number;
  readonly requestScoped = true;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RequestRejectedError";
    this.statusCode = statusCode;
  }
}

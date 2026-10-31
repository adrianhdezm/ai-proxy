// OpenAI-compatible image endpoints: POST /v1/images/generations and
// POST /v1/images/edits. Port of the non-xAI parts of
// sdk/api/handlers/openai/openai_images_handlers.go (ImagesGenerations,
// ImagesEdits, imagesEditsFromJSON / imagesEditsFromMultipart,
// buildOpenAICompatImagesJSONRequest / buildOpenAICompatImagesMultipartRequest,
// collectRoutedImages / streamRoutedImages / forwardRawImageStream) plus the
// OpenAI error envelope of sdk/api/handlers/handlers.go (BuildErrorResponseBodyWithError).
//
// Routing: the request is validated here and handed to the AuthManager in the
// "openai-image" source format with the inbound path in the request_path
// metadata. GPT Image models (gpt-image-1.5, gpt-image-2, gpt-image-2.5,
// gpt-image-2.5-flare, gpt-image-2.5-sunburst, any routing prefix) go to the
// Codex and/or OpenAI API-key credentials the registry lists for them; any
// other model is accepted only when an OpenAI API-key credential serves it
// (the stand-in for upstream's openai-compatibility image models) and goes to
// that provider only. The executors answer in the OpenAI Images shape
// (`{"created","data":[{"b64_json"|"url"}],"usage"}`) or with an Images SSE
// stream, which is forwarded as-is.
//
// Dropped from upstream: xAI (grok-imagine) models, the dead handler-side
// Responses fallback (collectImagesFromResponses / streamImagesFromResponses:
// every accepted model is routed before it), pre-first-token keep-alive ticks,
// payload interceptors and the API_RESPONSE log hooks.
import { TerminalAuthError } from "../auth/manager/index.ts";
import { safeResponseHeaders } from "../auth/manager/errors.ts";
import { RequestPathMetadataKey, RequestedModelMetadataKey, type ErrorMessage, type ExecOptions, type ExecRequest, type ExecResponse, type StreamResult } from "../executor/types.ts";
import { FormatOpenAIImage, ImagesEditsPath, ImagesGenerationsPath, bytesToBinaryString, isUploadedFile, parseMultipartForm, rewriteOpenAICompatImagesMultipartForm, type MultipartForm } from "../executor/openai/images.ts";
import { DisallowFreeAuthMetadataKey } from "../executor/codex/images.ts";
import { getGlobalRegistry, type ModelRegistry } from "../registry/index.ts";
import { parseSuffix } from "../thinking/suffix.ts";
import { isObject, tryParse, type JSONObject } from "../util/json.ts";
import { RequestUsageRecorder } from "../usage/recorder.ts";
import type { UsageStatistics } from "../usage/statistics.ts";
import type { ExecutionManager } from "./claude_handlers.ts";
import { claudeErrorText, enrichAuthSelectionError, executionErrorMessage, httpStatusText } from "./errors.ts";
import { filterUpstreamHeaders, forwardableInboundHeaders, isCPAReservedResponseHeader, writeUpstreamHeaders } from "./headers.ts";

export const gptImage15Model = "gpt-image-1.5";
export const defaultImagesToolModel = "gpt-image-2";
export const gptImage25FlareModel = "gpt-image-2.5-flare";
export const gptImage25SunburstModel = "gpt-image-2.5-sunburst";
export const gptImage25Model = "gpt-image-2.5";

/** Providers that can serve image requests. */
const imageProviders = new Set(["codex", "openai"]);

export interface ImagesHandlerOptions {
  manager: ExecutionManager;
  /** Model registry used to resolve model -> providers (default: the global one). */
  registry?: ModelRegistry;
  /** config requests.passthroughHeaders. */
  passthroughHeaders?: boolean;
  /** config multimedia.disableImageGeneration: both endpoints answer 404. */
  disableImageGeneration?: boolean;
  /** Maximum inbound body size in bytes; 0 disables the limit. */
  maxRequestBodyBytes?: number;
  /** Usage statistics store; one record per request when enabled. */
  usage?: UsageStatistics;
  /** Clock (epoch ms). */
  now?: () => number;
}

export interface ImagesRequestContext {
  /** The inbound API key the request authenticated with ("" when access is open). */
  clientKey?: string;
}

// ---------------------------------------------------------------------------
// OpenAI error envelope
// ---------------------------------------------------------------------------

export interface OpenAIErrorDetail {
  message: string;
  type: string;
  code?: string;
  param?: string;
  retryable?: boolean;
}

/** `{"error":{...}}` for errors the handler raises itself. */
export function openAIErrorJSON(detail: OpenAIErrorDetail): string {
  return JSON.stringify({ error: detail });
}

function errorTypeAndCode(status: number): { type: string; code?: string } {
  switch (status) {
    case 401:
      return { type: "authentication_error", code: "invalid_api_key" };
    case 403:
      return { type: "permission_error", code: "insufficient_quota" };
    case 429:
      return { type: "rate_limit_error", code: "rate_limit_exceeded" };
    case 404:
      return { type: "invalid_request_error", code: "model_not_found" };
    case 408:
      return { type: "server_error", code: "request_timeout" };
    default:
      return status >= 500 ? { type: "server_error", code: "internal_server_error" } : { type: "invalid_request_error" };
  }
}

/**
 * Builds the OpenAI error body for a status and error text (Go:
 * BuildErrorResponseBodyWithError). Terminal credential failures become
 * authentication_error / upstream_authentication_required; an upstream body
 * already in the `{"error":{...}}` shape is passed through compacted; any other
 * text is wrapped with a type and code derived from the status.
 *
 * Deviation: upstream passes every valid JSON body through verbatim; here a
 * JSON body without an `error` object is wrapped (its message / detail string
 * becomes the message) so clients always get the OpenAI envelope.
 */
export function openAIErrorBody(status: number, errText: string, err?: unknown): string {
  if (status <= 0) status = 500;
  if (errText.trim() === "") errText = httpStatusText(status) || "Internal Server Error";
  const trimmed = errText.trim();
  const parsed = tryParse(trimmed);
  if (err instanceof TerminalAuthError) {
    let message = errText;
    if (isObject(parsed)) {
      if (typeof parsed.message === "string" && parsed.message !== "") message = parsed.message;
      else if (isObject(parsed.error) && typeof parsed.error.message === "string" && parsed.error.message !== "") message = parsed.error.message;
    }
    return openAIErrorJSON({ message, type: "authentication_error", code: "upstream_authentication_required", retryable: false });
  }
  let message = errText;
  if (parsed !== undefined) {
    if (isObject(parsed) && isObject(parsed.error)) return JSON.stringify(parsed);
    if (isObject(parsed)) {
      for (const key of ["message", "detail", "error"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim() !== "") {
          message = value.trim();
          break;
        }
      }
    }
  }
  const { type, code } = errorTypeAndCode(status);
  return openAIErrorJSON(code ? { message, type, code } : { message, type });
}

/** The OpenAI error body for an ErrorMessage (Go: WriteErrorResponse body). */
export function openAIErrorBodyFor(msg: ErrorMessage | undefined | null): string {
  const status = msg && msg.statusCode > 0 ? msg.statusCode : 500;
  const text = msg?.error ? claudeErrorText(msg.error).trim() : "";
  return openAIErrorBody(status, text !== "" ? text : httpStatusText(status), msg?.error);
}

/** A handler-raised OpenAI error (the message is already the envelope). */
export function openAIErrorMessage(status: number, detail: OpenAIErrorDetail): ErrorMessage {
  return { statusCode: status, error: new Error(openAIErrorJSON(detail)) };
}

/**
 * The HTTP error response in the OpenAI envelope with the header policy of
 * WriteErrorResponse: the locally computed Retry-After always, upstream
 * headers only with passthroughHeaders (never the proxy-reserved ones).
 */
export function openAIErrorResponse(msg: ErrorMessage | undefined | null, options: { passthroughHeaders?: boolean } = {}): Response {
  const status = msg && msg.statusCode > 0 ? msg.statusCode : 500;
  const headers = new Headers();
  if (msg && msg.directBody !== undefined) {
    msg.directHeaders?.forEach((value, key) => {
      if (!isCPAReservedResponseHeader(key)) headers.append(key, value);
    });
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return new Response(msg.directBody, { status, headers });
  }
  let trustedRetryAfter = false;
  if (msg?.error) {
    const retryAfter = safeResponseHeaders(msg.error)?.get("Retry-After");
    if (retryAfter) {
      headers.set("Retry-After", retryAfter);
      trustedRetryAfter = true;
    }
  }
  if (msg?.addon && options.passthroughHeaders) {
    const names = new Set<string>();
    msg.addon.forEach((_value, key) => names.add(key));
    for (const key of names) {
      if (isCPAReservedResponseHeader(key)) continue;
      if (trustedRetryAfter && key.toLowerCase() === "retry-after") continue;
      headers.set(key, msg.addon.get(key) ?? "");
    }
  }
  headers.set("Content-Type", "application/json");
  return new Response(openAIErrorBodyFor(msg), { status, headers });
}

function invalidRequest(message: string, status = 400): ErrorMessage {
  return openAIErrorMessage(status, { message, type: "invalid_request_error" });
}

// ---------------------------------------------------------------------------
// Model rules
// ---------------------------------------------------------------------------

/** The last path segment, lower-cased (Go: imagesModelBase). */
export function imagesModelBase(model: string): string {
  model = model.trim();
  const idx = model.lastIndexOf("/");
  if (idx >= 0 && idx < model.length - 1) model = model.slice(idx + 1);
  return model.trim().toLowerCase();
}

/** GPT Image models served through Codex (Go: isCodexImagesToolModel). */
export function isCodexImagesToolModel(model: string): boolean {
  switch (imagesModelBase(model)) {
    case gptImage15Model:
    case defaultImagesToolModel:
    case gptImage25FlareModel:
    case gptImage25SunburstModel:
    case gptImage25Model:
      return true;
    default:
      return false;
  }
}

/** Unsupported model message (Go: rejectUnsupportedImagesModel, xAI names dropped). */
export function unsupportedImagesModelMessage(model: string): string {
  return `Model ${model} is not supported on ${ImagesGenerationsPath} or ${ImagesEditsPath}. Use ${gptImage15Model}, ${defaultImagesToolModel}, ${gptImage25FlareModel}, ${gptImage25SunburstModel}, ${gptImage25Model}, or a model configured on an OpenAI API key.`;
}

/** Sets model and the stream flag (dropped when not streaming) on a JSON image request (Go: buildOpenAICompatImagesJSONRequest). */
export function buildOpenAICompatImagesJSONRequest(body: JSONObject, imageModel: string, stream: boolean): string {
  const out: JSONObject = { ...body };
  if (imageModel.trim() !== "") out.model = imageModel.trim();
  if (stream) out.stream = true;
  else delete out.stream;
  return JSON.stringify(out);
}

/** Go: parseBoolField. */
export function parseBoolField(raw: string, fallback: boolean): boolean {
  switch (raw.trim().toLowerCase()) {
    case "":
      return fallback;
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface ImageCall {
  /** Model as requested (routing prefix and suffix kept). */
  model: string;
  /** Payload: JSON text, or multipart bytes as a binary string. */
  payload: string;
  contentType: string;
  stream: boolean;
  path: string;
}

export class OpenAIImagesHandler {
  private readonly manager: ExecutionManager;
  private readonly registry: ModelRegistry;
  private readonly passthroughHeaders: boolean;
  private readonly disabled: boolean;
  private readonly maxBodyBytes: number;
  private readonly usage: UsageStatistics | undefined;
  private readonly now: () => number;

  constructor(options: ImagesHandlerOptions) {
    this.manager = options.manager;
    this.registry = options.registry ?? getGlobalRegistry();
    this.passthroughHeaders = options.passthroughHeaders ?? false;
    this.disabled = options.disableImageGeneration === true;
    this.maxBodyBytes = Math.max(0, Math.trunc(options.maxRequestBodyBytes ?? 0));
    this.usage = options.usage;
    this.now = options.now ?? Date.now;
  }

  private errorResponse(msg: ErrorMessage): Response {
    return openAIErrorResponse(msg, { passthroughHeaders: this.passthroughHeaders });
  }

  private disabledResponse(): Response {
    return this.errorResponse(openAIErrorMessage(404, { message: "image generation is disabled", type: "invalid_request_error", code: "not_found" }));
  }

  /** Whether the model is accepted on the image endpoints (Go: isSupportedImagesModel, xAI dropped). */
  isSupportedImagesModel(model: string): boolean {
    if (isCodexImagesToolModel(model)) return true;
    return this.registryProviders(model).includes("openai");
  }

  private registryProviders(model: string): string[] {
    const base = parseSuffix(model).modelName.trim();
    let providers = base === "" ? [] : this.registry.getModelProviders(base);
    if (providers.length === 0 && base !== model) providers = this.registry.getModelProviders(model);
    return providers;
  }

  /** Providers for an accepted image model (Go: getRequestDetails + image routing). */
  imageProvidersFor(model: string): string[] {
    const allowed = isCodexImagesToolModel(model) ? imageProviders : new Set(["openai"]);
    return this.registryProviders(model).filter((provider) => allowed.has(provider));
  }

  private async readBody(request: Request): Promise<{ bytes: Uint8Array } | { error: ErrorMessage }> {
    const tooLarge = () => ({ error: openAIErrorMessage(413, { message: "request body too large", type: "invalid_request_error", code: "request_too_large" }) });
    if (this.maxBodyBytes > 0) {
      const declared = Number(request.headers.get("Content-Length") ?? "");
      if (Number.isFinite(declared) && declared > this.maxBodyBytes) return tooLarge();
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await request.arrayBuffer();
    } catch (err) {
      return { error: invalidRequest(`Invalid request: ${err instanceof Error ? err.message : String(err)}`) };
    }
    if (this.maxBodyBytes > 0 && buffer.byteLength > this.maxBodyBytes) return tooLarge();
    return { bytes: new Uint8Array(buffer) };
  }

  /** Reads and validates a JSON image request (model default, support check, prompt). */
  private async readJSONCall(request: Request, path: string): Promise<ImageCall | { error: ErrorMessage }> {
    const body = await this.readBody(request);
    if ("error" in body) return body;
    const parsed = tryParse(new TextDecoder().decode(body.bytes));
    if (!isObject(parsed)) return { error: invalidRequest("Invalid request: body must be valid JSON") };
    let model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    if (model === "") model = defaultImagesToolModel;
    if (!this.isSupportedImagesModel(model)) return { error: invalidRequest(unsupportedImagesModelMessage(model)) };
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    if (prompt === "") return { error: invalidRequest("Invalid request: prompt is required") };
    const stream = parsed.stream === true;
    return { model, payload: buildOpenAICompatImagesJSONRequest(parsed, model, stream), contentType: "application/json", stream, path };
  }

  /** POST /v1/images/generations (Go: ImagesGenerations). */
  async imagesGenerations(request: Request, context: ImagesRequestContext = {}): Promise<Response> {
    if (this.disabled) return this.disabledResponse();
    const start = this.now();
    const call = await this.readJSONCall(request, ImagesGenerationsPath);
    if ("error" in call) return this.errorResponse(call.error);
    return this.handleRoutedImages(request, call, context, start);
  }

  /** POST /v1/images/edits, JSON or multipart (Go: ImagesEdits). */
  async imagesEdits(request: Request, context: ImagesRequestContext = {}): Promise<Response> {
    if (this.disabled) return this.disabledResponse();
    const start = this.now();
    const contentType = (request.headers.get("Content-Type") ?? "").trim().toLowerCase();
    if (contentType.startsWith("application/json")) {
      const call = await this.readJSONCall(request, ImagesEditsPath);
      if ("error" in call) return this.errorResponse(call.error);
      return this.handleRoutedImages(request, call, context, start);
    }
    if (contentType.startsWith("multipart/form-data") || contentType === "") {
      const call = await this.readMultipartCall(request);
      if ("error" in call) return this.errorResponse(call.error);
      return this.handleRoutedImages(request, call, context, start);
    }
    return this.errorResponse(invalidRequest(`Invalid request: unsupported Content-Type ${JSON.stringify(contentType)}`));
  }

  /** Go: imagesEditsFromMultipart (routed branch). */
  private async readMultipartCall(request: Request): Promise<ImageCall | { error: ErrorMessage }> {
    const body = await this.readBody(request);
    if ("error" in body) return body;
    let form: MultipartForm;
    try {
      form = await parseMultipartForm(body.bytes, request.headers.get("Content-Type") ?? "");
    } catch (err) {
      return { error: invalidRequest(`Invalid request: ${err instanceof Error ? err.message : String(err)}`) };
    }
    const field = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value.trim() : "";
    };
    let model = field("model");
    if (model === "") model = defaultImagesToolModel;
    if (!this.isSupportedImagesModel(model)) return { error: invalidRequest(unsupportedImagesModelMessage(model)) };
    if (field("prompt") === "") return { error: invalidRequest("Invalid request: prompt is required") };
    const hasFiles = (key: string) => form.getAll(key).some(isUploadedFile);
    if (!hasFiles("image[]") && !hasFiles("image")) return { error: invalidRequest("Invalid request: image is required") };
    const stream = parseBoolField(field("stream"), false);
    let rebuilt: { bytes: Uint8Array; contentType: string };
    try {
      rebuilt = await rewriteOpenAICompatImagesMultipartForm(form, model, stream);
    } catch (err) {
      return { error: invalidRequest(`Invalid request: ${err instanceof Error ? err.message : String(err)}`) };
    }
    return { model, payload: bytesToBinaryString(rebuilt.bytes), contentType: rebuilt.contentType, stream, path: ImagesEditsPath };
  }

  private prepare(request: Request, call: ImageCall): { providers: string[]; req: ExecRequest; opts: ExecOptions } | { error: ErrorMessage } {
    const providers = this.imageProvidersFor(call.model);
    if (providers.length === 0) {
      return { error: openAIErrorMessage(400, { message: `unknown provider for model ${call.model}`, type: "invalid_request_error", code: "model_not_found", param: "model" }) };
    }
    const metadata: Record<string, unknown> = {
      [RequestedModelMetadataKey]: call.model,
      [RequestPathMetadataKey]: call.path,
      // Free ChatGPT plans cannot generate images (Go: WithDisallowFreeAuth).
      [DisallowFreeAuthMetadataKey]: true,
    };
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
    if (idempotencyKey) metadata.idempotency_key = idempotencyKey;
    const headers = forwardableInboundHeaders(request.headers);
    headers.set("Content-Type", call.contentType);
    const req: ExecRequest = { model: call.model, payload: call.payload, format: FormatOpenAIImage };
    const opts: ExecOptions = {
      stream: call.stream,
      headers,
      query: new URL(request.url).searchParams,
      originalRequest: call.payload,
      sourceFormat: FormatOpenAIImage,
      metadata,
      signal: request.signal,
    };
    return { providers, req, opts };
  }

  private usageRecorder(request: Request, call: ImageCall, prepared: { providers: string[]; opts: ExecOptions }, start: number, clientKey: string): RequestUsageRecorder | undefined {
    if (!this.usage?.enabled) return undefined;
    const manager = this.manager;
    return new RequestUsageRecorder({
      statistics: this.usage,
      now: this.now,
      start,
      endpoint: `${request.method.toUpperCase()} ${call.path}`,
      model: call.model,
      alias: call.model,
      clientKey,
      sessionId: "",
      stream: call.stream,
      metadata: prepared.opts.metadata,
      providers: prepared.providers,
      lookupAuth: manager.getById ? (id) => manager.getById!(id) : undefined,
    });
  }

  /** Go: handleRoutedImages -> collectRoutedImages / streamRoutedImages. */
  private async handleRoutedImages(request: Request, call: ImageCall, context: ImagesRequestContext, start: number): Promise<Response> {
    const prepared = this.prepare(request, call);
    if ("error" in prepared) return this.errorResponse(prepared.error);
    const recorder = this.usageRecorder(request, call, prepared, start, context.clientKey ?? "");
    if (!call.stream) {
      let resp: ExecResponse;
      try {
        resp = await this.manager.execute(prepared.providers, prepared.req, prepared.opts);
      } catch (err) {
        const msg = executionErrorMessage(enrichAuthSelectionError(err, prepared.providers, call.model));
        recorder?.recordFailure(msg.statusCode);
        return this.errorResponse(msg);
      }
      recorder?.recordResponse(resp.payload);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (this.passthroughHeaders) writeUpstreamHeaders(headers, filterUpstreamHeaders(resp.headers));
      return new Response(resp.payload, { status: 200, headers });
    }

    let result: StreamResult;
    try {
      result = await this.manager.executeStream(prepared.providers, prepared.req, prepared.opts);
    } catch (err) {
      const msg = executionErrorMessage(enrichAuthSelectionError(err, prepared.providers, call.model));
      recorder?.recordFailure(msg.statusCode);
      return this.errorResponse(msg);
    }
    const iterator = result.chunks[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await nextNonEmpty(iterator);
    } catch (err) {
      // Failed before any payload: plain JSON error, nothing committed yet.
      const msg = executionErrorMessage(enrichAuthSelectionError(err, prepared.providers, call.model));
      recorder?.recordFailure(msg.statusCode);
      return this.errorResponse(msg);
    }
    const headers = new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (this.passthroughHeaders) writeUpstreamHeaders(headers, filterUpstreamHeaders(result.headers));
    const body = forwardImagesStream({
      first,
      iterator,
      signal: request.signal,
      onDone: (terminal, lastUsagePayload) => {
        if (!recorder) return;
        if (terminal) recorder.recordFailure(terminal.statusCode);
        else if (request.signal?.aborted) recorder.recordFailure(499);
        else recorder.recordResponse(lastUsagePayload ?? "{}");
      },
    });
    return new Response(body, { status: 200, headers });
  }
}

async function nextNonEmpty(iterator: AsyncIterator<string>): Promise<IteratorResult<string>> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) return next;
    if (typeof next.value === "string" && next.value.length > 0) return next;
  }
}

export interface ForwardImagesStreamOptions {
  first: IteratorResult<string>;
  iterator: AsyncIterator<string>;
  signal?: AbortSignal;
  /** Terminal outcome plus the last `data:` JSON that carried `usage` (for the usage record). */
  onDone?: (terminal: ErrorMessage | undefined, lastUsagePayload: string | undefined) => void;
}

/**
 * Forwards a committed image stream verbatim. A failure after the first byte
 * becomes a terminal `event: error` frame with the OpenAI envelope, started on
 * an SSE event boundary (Go: forwardRawImageStream + writeImagesStreamErrorEvent).
 */
export function forwardImagesStream(options: ForwardImagesStreamOptions): ReadableStream<Uint8Array> {
  const { first, iterator, signal } = options;
  const encoder = new TextEncoder();
  let cancelled = false;
  let tail = "";
  let pendingLine = "";
  let lastUsagePayload: string | undefined;
  const observe = (chunk: string) => {
    tail = (tail + chunk).slice(-2);
    pendingLine += chunk;
    for (;;) {
      const idx = pendingLine.indexOf("\n");
      if (idx < 0) break;
      const line = pendingLine.slice(0, idx).replace(/\r$/, "");
      pendingLine = pendingLine.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data.includes('"usage"')) continue;
      const parsed = tryParse(data);
      if (isObject(parsed) && isObject(parsed.usage)) lastUsagePayload = JSON.stringify({ usage: parsed.usage, model: parsed.model });
    }
  };
  const release = () => {
    cancelled = true;
    iterator.return?.().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (cancelled || text.length === 0) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cancelled = true;
        }
      };
      const onAbort = () => release();
      signal?.addEventListener("abort", onAbort, { once: true });
      let terminal: ErrorMessage | undefined;
      try {
        if (!first.done) {
          observe(first.value);
          write(first.value);
          while (!cancelled) {
            let next: IteratorResult<string>;
            try {
              next = await iterator.next();
            } catch (err) {
              terminal = executionErrorMessage(err);
              break;
            }
            if (next.done) break;
            if (typeof next.value !== "string" || next.value.length === 0) continue;
            observe(next.value);
            write(next.value);
          }
        } else {
          write("\n");
        }
        if (cancelled) return;
        if (terminal) {
          const boundary = tail === "" || tail === "\n\n" ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
          write(`${boundary}event: error\ndata: ${openAIErrorBodyFor(terminal)}\n\n`);
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        options.onDone?.(terminal, lastUsagePayload);
        try {
          controller.close();
        } catch {
          // already closed/cancelled
        }
      }
    },
    cancel() {
      release();
    },
  });
}

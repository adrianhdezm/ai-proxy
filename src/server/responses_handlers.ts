// OpenAI Responses-compatible handlers: POST /v1/responses (stream and
// non-stream), POST /v1/responses/compact and the OpenAI shape of GET /v1/models.
// Port of sdk/api/handlers/openai/openai_responses_handlers.go (Responses,
// Compact, handleNonStreamingResponse, handleStreamingResponse,
// forwardResponsesStream), the models half of sdk/api/handlers/openai/openai_handlers.go
// (OpenAIModels) and isAnthropicModelsRequest / unifiedModelsHandler from
// internal/api/server_routes.go, on the routing of handlers_routing.go
// (getRequestDetails) and the stream plumbing of stream_forwarder.go (ForwardStream).
//
// Requests are routed by model through the registry exactly like the Claude
// handler and reach the executors with sourceFormat "openai-response"; the
// executors translate to their upstream and back to Responses.
//
// The websocket transport (GET /v1/responses) lives in responses_websocket.ts.
// Dropped from upstream: the /backend-api/codex aliases, Codex multi-agent v2 tool preparation and orphan
// delegation rewriting, pre-first-token keep-alives, plugin routes, Home mode,
// the Codex client model catalogue for ?client_version= (the plain OpenAI list
// is returned) and the API_RESPONSE request-log hooks (diagnostics go to the
// debug log, sanitised).
import { safeResponseHeaders } from "../auth/manager/errors.ts";
import { isStreamTruncatedError } from "../auth/manager/index.ts";
import { RequestPathMetadataKey, RequestedModelMetadataKey, type ErrorMessage, type ExecOptions, type ExecRequest, type ExecResponse, type StreamResult } from "../executor/types.ts";
import { log } from "../log.ts";
import { getGlobalRegistry, type ModelRegistry } from "../registry/index.ts";
import { parseSuffix } from "../thinking/suffix.ts";
import { FormatOpenAIResponse } from "../translator/types.ts";
import { isObject, tryParse, type JSONObject } from "../util/json.ts";
import { newDetail, newSubsetTokenBreakdown, type Detail } from "../usage/accounting.ts";
import type { ClaudeStreamUsageObserver } from "../usage/claude.ts";
import { RequestUsageRecorder } from "../usage/recorder.ts";
import type { UsageStatistics } from "../usage/statistics.ts";
import type { StreamDelivery } from "../usage/stream_delivery.ts";
import { CallerAPIKeyMetadataKey, type ExecutionManager } from "./claude_handlers.ts";
import { enrichAuthSelectionError, executionErrorMessage } from "./errors.ts";
import { getRequestDetails, type RequestDetails } from "./routing.ts";
import { filterUpstreamHeaders, forwardableInboundHeaders, writeUpstreamHeaders } from "./headers.ts";
import { openAIErrorMessage, openAIErrorResponse } from "./images_handlers.ts";
import {
  ResponsesSSEFramer,
  buildOpenAIResponsesStreamErrorChunk,
  buildOpenAIResponsesStreamFailedChunk,
  isCodexResponsesClientRequest,
  responsesStreamErrorText,
  sanitizeResponsesInitialErrorMessage,
  sanitizeResponsesStreamErrorMessage,
} from "./responses_sse.ts";

/** Alt value that selects the Codex compaction endpoint (Go: opts.Alt == "responses/compact"). */
export const ResponsesCompactAlt = "responses/compact";

/** Providers that serve /v1/responses/compact. */
const compactProviders = new Set(["codex"]);

export interface ResponsesHandlerOptions {
  manager: ExecutionManager;
  /** Model registry used to resolve model -> providers (default: the global one). */
  registry?: ModelRegistry;
  /** config requests.passthroughHeaders. */
  passthroughHeaders?: boolean;
  /** Usage statistics store; one record per request when enabled. */
  usage?: UsageStatistics;
  /** Clock (epoch ms). */
  now?: () => number;
}

export interface ResponsesRequestContext {
  /** The inbound API key the request authenticated with ("" when access is open). */
  clientKey?: string;
}

/** Inbound header names a Responses client (Codex CLI / desktop, OpenAI SDKs) sends that the executors read. */
const responsesInboundHeaders = new Set(["originator", "version", "session_id", "session-id", "conversation_id", "thread-id", "openai-beta"]);
const responsesInboundHeaderPrefixes = ["x-codex-", "x-openai-"];

/**
 * The inbound headers handed to executors for a Responses request: the Claude
 * allow-list plus the Codex client identity / session headers. Credentials
 * (Authorization, x-api-key, ...) never pass.
 */
export function responsesForwardableHeaders(src: Headers): Headers {
  const dst = forwardableInboundHeaders(src);
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (responsesInboundHeaders.has(lower) || responsesInboundHeaderPrefixes.some((prefix) => lower.startsWith(prefix))) {
      if (!dst.has(key)) dst.append(key, value);
    }
  });
  return dst;
}

// ---------------------------------------------------------------------------
// /v1/models client detection
// ---------------------------------------------------------------------------

/**
 * Whether GET /v1/models should answer in the OpenAI list shape. Upstream
 * answers Anthropic only for an Anthropic-Version header or a claude-cli
 * User-Agent and OpenAI otherwise (Go: isAnthropicModelsRequest).
 *
 * Deviation: this port keeps the Claude shape by default (it started as a
 * Claude-only server) and switches to the OpenAI shape only for a recognisable
 * OpenAI client: ?client_version= (Codex), an official Codex User-Agent or
 * Originator, an OpenAI SDK / Codex User-Agent, or OpenAI-* request headers.
 */
export function isOpenAIModelsRequest(request: Request, url: URL): boolean {
  const headers = request.headers;
  if (url.searchParams.has("client_version")) return true;
  if ((headers.get("Anthropic-Version") ?? "") !== "") return false;
  const ua = (headers.get("User-Agent") ?? "").trim();
  if (ua.startsWith("claude-cli")) return false;
  if (isCodexResponsesClientRequest(headers)) return true;
  if (/^(openai|codex)/i.test(ua)) return true;
  for (const name of ["Originator", "OpenAI-Organization", "OpenAI-Project", "OpenAI-Beta"]) {
    if ((headers.get(name) ?? "").trim() !== "") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function intOf(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/**
 * Usage of a Responses usage object (Go: ParseCodexUsage / ParseOpenAIResponsesUsage):
 * cached tokens are part of input_tokens, reasoning tokens part of output_tokens.
 */
export function parseResponsesUsageNode(node: unknown): Detail {
  if (!isObject(node)) return newDetail();
  const input = intOf(node.input_tokens);
  const output = intOf(node.output_tokens);
  const cached = isObject(node.input_tokens_details) ? intOf(node.input_tokens_details.cached_tokens) : 0;
  const reasoning = isObject(node.output_tokens_details) ? intOf(node.output_tokens_details.reasoning_tokens) : 0;
  let total = intOf(node.total_tokens);
  if (total === 0) total = input + output;
  return newDetail({
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cached,
    cacheReadTokens: cached,
    totalTokens: total,
    tokenBreakdown: newSubsetTokenBreakdown(input, cached, 0, output, reasoning, total),
  });
}

/**
 * Feeds the downstream Responses SSE text to the recorder's stream observer:
 * the usage and model of response.completed / response.incomplete become the
 * record's detail, and a completed / incomplete response marks success.
 */
class ResponsesStreamUsageTracker {
  private lineBuf = "";

  constructor(private readonly observer: ClaudeStreamUsageObserver) {}

  observe(text: string): void {
    if (text.length === 0) return;
    let start = 0;
    for (;;) {
      const idx = text.indexOf("\n", start);
      if (idx === -1) {
        this.lineBuf += text.slice(start);
        return;
      }
      this.observeLine(this.lineBuf + text.slice(start, idx));
      this.lineBuf = "";
      start = idx + 1;
    }
  }

  private observeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const parsed = tryParse(trimmed.slice(5).trim());
    if (!isObject(parsed)) return;
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const response = isObject(parsed.response) ? parsed.response : undefined;
    if (response && typeof response.model === "string" && response.model.trim() !== "") this.observer.responseModel = response.model.trim();
    if (type === "response.completed" || type === "response.incomplete" || type === "response.done") {
      if (response && isObject(response.usage)) this.observer.observeUsage(parseResponsesUsageNode(response.usage));
      this.observer.sawMessageStop = true;
    }
  }
}

/** Publishes a non-stream success with the usage of a Responses JSON body (the recorder's public stream path). */
function recordResponsesPayload(recorder: RequestUsageRecorder, payload: string): void {
  const { observer, delivery } = recorder.startStream();
  const root = tryParse(payload);
  if (isObject(root)) {
    if (isObject(root.usage)) observer.observeUsage(parseResponsesUsageNode(root.usage));
    if (typeof root.model === "string") observer.responseModel = root.model.trim();
  }
  observer.sawMessageStop = true;
  delivery.finish();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface ParsedBody {
  raw: string;
  object: JSONObject;
}

interface Prepared {
  providers: string[];
  req: ExecRequest;
  opts: ExecOptions;
}

interface UsageContext {
  start: number;
  clientKey: string;
  alias: string;
}

export class OpenAIResponsesAPIHandler {
  private readonly manager: ExecutionManager;
  private readonly registry: ModelRegistry;
  private readonly passthroughHeaders: boolean;
  private readonly usage: UsageStatistics | undefined;
  private readonly now: () => number;

  constructor(options: ResponsesHandlerOptions) {
    this.manager = options.manager;
    this.registry = options.registry ?? getGlobalRegistry();
    this.passthroughHeaders = options.passthroughHeaders ?? false;
    this.usage = options.usage;
    this.now = options.now ?? Date.now;
  }

  /** Handler type (Go: HandlerType). */
  handlerType(): string {
    return FormatOpenAIResponse;
  }

  /** Available models in the OpenAI shape (Go: Models). */
  models(): JSONObject[] {
    return this.registry.getAvailableModels("openai");
  }

  /** GET /v1/models for OpenAI clients: id, object, created and owned_by only (Go: OpenAIModels). */
  openAIModels(): Response {
    const data = this.models().map(filterOpenAIModel);
    return jsonResponse({ object: "list", data });
  }

  /** GET /v1/models/:id for OpenAI clients. */
  openAIModelDetail(id: string): Response {
    const wanted = id.trim();
    for (const model of this.models()) {
      if (model.id === wanted) return jsonResponse(filterOpenAIModel(model));
    }
    return this.errorResponse(openAIErrorMessage(404, { message: `The model '${wanted}' does not exist`, type: "invalid_request_error", code: "model_not_found" }));
  }

  /** POST /v1/responses (Go: Responses). */
  async responses(request: Request, rawJSON: string, context: ResponsesRequestContext = {}): Promise<Response> {
    const usage: UsageContext = { start: this.now(), clientKey: context.clientKey ?? "", alias: "" };
    const parsed = parseRequestBody(rawJSON);
    if ("error" in parsed) return this.errorResponse(parsed.error);
    usage.alias = typeof parsed.object.model === "string" ? parsed.object.model : "";
    if (parsed.object.stream === true) return this.handleStreamingResponse(request, parsed, usage);
    return this.handleNonStreamingResponse(request, parsed, usage, "");
  }

  /** POST /v1/responses/compact: Codex compaction, never streamed (Go: Compact). */
  async compact(request: Request, rawJSON: string, context: ResponsesRequestContext = {}): Promise<Response> {
    const usage: UsageContext = { start: this.now(), clientKey: context.clientKey ?? "", alias: "" };
    const parsed = parseRequestBody(rawJSON);
    if ("error" in parsed) return this.errorResponse(parsed.error);
    usage.alias = typeof parsed.object.model === "string" ? parsed.object.model : "";
    if (parsed.object.stream === true) {
      return this.errorResponse(openAIErrorMessage(400, { message: "Streaming not supported for compact responses", type: "invalid_request_error" }));
    }
    let body = parsed;
    if ("stream" in parsed.object) {
      const object = { ...parsed.object };
      delete object.stream;
      body = { raw: JSON.stringify(object), object };
    }
    return this.handleNonStreamingResponse(request, body, usage, ResponsesCompactAlt);
  }

  private errorResponse(msg: ErrorMessage): Response {
    const response = openAIErrorResponse(msg, { passthroughHeaders: this.passthroughHeaders });
    // A sanitised error keeps the original as its cause: its trusted Retry-After still applies.
    if (!response.headers.has("Retry-After") && msg.error?.cause !== undefined) {
      const retryAfter = safeResponseHeaders(msg.error.cause)?.get("Retry-After");
      if (retryAfter) response.headers.set("Retry-After", retryAfter);
    }
    return response;
  }

  /**
   * Resolves the providers for the requested model; the thinking suffix is
   * stripped for the lookup (Go: getRequestDetails). An unroutable model is a
   * 400 model_not_found request error.
   */
  getRequestDetails(modelName: string): RequestDetails {
    return getRequestDetails(this.registry, modelName);
  }


  private prepare(request: Request, body: ParsedBody, stream: boolean, alt: string, clientKey: string): Prepared | { error: ErrorMessage } {
    const modelName = typeof body.object.model === "string" ? body.object.model : "";
    const details = this.getRequestDetails(modelName);
    if ("error" in details) return details;
    let providers = details.providers;
    if (alt === ResponsesCompactAlt) {
      providers = providers.filter((provider) => compactProviders.has(provider));
      if (providers.length === 0) {
        return { error: openAIErrorMessage(501, { message: `/responses/compact is not supported for model ${modelName}`, type: "invalid_request_error", code: "unsupported_model" }) };
      }
    }
    const url = new URL(request.url);
    const metadata: Record<string, unknown> = { [RequestedModelMetadataKey]: modelName, [RequestPathMetadataKey]: url.pathname };
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
    if (idempotencyKey) metadata.idempotency_key = idempotencyKey;
    // The authenticated inbound key scopes per-caller caches (Go: APIKeyFromContext); never logged.
    if (clientKey) metadata[CallerAPIKeyMetadataKey] = clientKey;
    const req: ExecRequest = { model: details.model, payload: body.raw, format: FormatOpenAIResponse };
    const opts: ExecOptions = {
      stream,
      headers: responsesForwardableHeaders(request.headers),
      query: url.searchParams,
      originalRequest: body.raw,
      sourceFormat: FormatOpenAIResponse,
      metadata,
      signal: request.signal,
    };
    if (alt !== "") opts.alt = alt;
    return { providers, req, opts };
  }

  private usageRecorder(request: Request, prepared: Prepared, usage: UsageContext): RequestUsageRecorder | undefined {
    if (!this.usage?.enabled) return undefined;
    const manager = this.manager;
    return new RequestUsageRecorder({
      statistics: this.usage,
      now: this.now,
      start: usage.start,
      endpoint: `${request.method.toUpperCase()} ${new URL(request.url).pathname}`,
      model: prepared.req.model,
      alias: usage.alias,
      clientKey: usage.clientKey,
      sessionId: responsesSessionID(request.headers),
      stream: prepared.opts.stream,
      metadata: prepared.opts.metadata,
      providers: prepared.providers,
      lookupAuth: manager.getById ? (id) => manager.getById!(id) : undefined,
    });
  }

  private async handleNonStreamingResponse(request: Request, body: ParsedBody, usage: UsageContext, alt: string): Promise<Response> {
    const prepared = this.prepare(request, body, false, alt, usage.clientKey);
    if ("error" in prepared) return this.errorResponse(prepared.error);
    const recorder = this.usageRecorder(request, prepared, usage);
    let resp: ExecResponse;
    try {
      resp = await this.manager.execute(prepared.providers, prepared.req, prepared.opts);
    } catch (err) {
      const msg = executionErrorMessage(enrichAuthSelectionError(err, prepared.providers, prepared.req.model));
      recorder?.recordFailure(msg.statusCode);
      return this.errorResponse(msg);
    }
    if (recorder) recordResponsesPayload(recorder, resp.payload);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.passthroughHeaders) writeUpstreamHeaders(headers, filterUpstreamHeaders(resp.headers));
    return new Response(resp.payload, { status: 200, headers });
  }

  /**
   * Streams the Responses events. The stream is committed only once the
   * framer released a complete data frame, so a failure before that is a plain
   * JSON error with its status; afterwards failures become one terminal
   * `error` (or `response.failed` for official Codex clients) event, and a
   * stream that closes without a terminal event is reported as a 502 server
   * error (Go: handleStreamingResponse + forwardResponsesStream).
   */
  private async handleStreamingResponse(request: Request, body: ParsedBody, usage: UsageContext): Promise<Response> {
    const prepared = this.prepare(request, body, true, "", usage.clientKey);
    if ("error" in prepared) return this.errorResponse(prepared.error);
    const { providers, req, opts } = prepared;
    const recorder = this.usageRecorder(request, prepared, usage);
    const initialError = (msg: ErrorMessage | undefined): Response => {
      const safe = sanitizeResponsesInitialErrorMessage(msg) ?? { statusCode: 502, error: new Error("upstream stream closed before first payload") };
      recorder?.recordFailure(safe.statusCode);
      return this.errorResponse(safe);
    };
    const executionError = (err: unknown): ErrorMessage => normalizeTruncatedStatus(executionErrorMessage(enrichAuthSelectionError(err, providers, req.model)));

    let result: StreamResult;
    try {
      result = await this.manager.executeStream(providers, req, opts);
    } catch (err) {
      return initialError(executionError(err));
    }
    const codexClient = isCodexResponsesClientRequest(request.headers);
    const framer = new ResponsesSSEFramer({ failureEvent: codexClient ? "response.failed" : "error", isCodexClient: codexClient });
    const iterator = result.chunks[Symbol.asyncIterator]();
    let initial = "";

    const commit = (plan: ForwardPlan): Response => {
      const headers = new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (this.passthroughHeaders) writeUpstreamHeaders(headers, filterUpstreamHeaders(result.headers));
      let observe: ((text: string) => void) | undefined;
      let delivery: StreamDelivery | undefined;
      if (recorder) {
        const started = recorder.startStream(request.signal);
        const tracker = new ResponsesStreamUsageTracker(started.observer);
        delivery = started.delivery;
        observe = (text) => {
          try {
            tracker.observe(text);
          } catch {
            // usage observation never breaks forwarding
          }
        };
      }
      const stream = forwardResponsesStream({
        initial,
        framer,
        plan,
        iterator,
        codexClient,
        signal: request.signal,
        normalize: (err) => sanitizeResponsesStreamErrorMessage(executionError(err))!,
        onWrite: observe,
        onDone: (terminal) => delivery?.finish(terminal ? { statusCode: terminal.statusCode } : undefined),
      });
      return new Response(stream, { status: 200, headers });
    };

    // Peek until the first complete data frame (Go: the select loop before commitSSE).
    for (;;) {
      let next: IteratorResult<string>;
      try {
        next = await iterator.next();
      } catch (err) {
        initial += framer.flush();
        const msg = executionError(err);
        if (framer.dataFrames > 0) return commit({ kind: "error", error: sanitizeResponsesStreamErrorMessage(msg)! });
        return initialError(msg);
      }
      if (next.done) {
        initial += framer.flush();
        let msg: ErrorMessage | undefined;
        if (framer.terminalEvent === "") {
          const message = framer.dataFrames > 0 ? "upstream stream closed before a terminal event" : "upstream stream closed before first payload";
          msg = { statusCode: 502, error: new Error(message) };
        }
        if (framer.dataFrames > 0) {
          if (framer.terminalError) return commit({ kind: "finished", terminal: framer.terminalError });
          if (!msg) return commit({ kind: "finished" });
          return commit({ kind: "error", error: sanitizeResponsesStreamErrorMessage(msg)! });
        }
        return initialError(msg);
      }
      if (typeof next.value !== "string" || next.value.length === 0) continue;
      initial += framer.writeChunk(next.value);
      if (framer.dataFrames === 0) continue;
      if (framer.terminalError) {
        logResponsesStreamError(framer, framer.terminalError);
        return commit({ kind: "finished", terminal: framer.terminalError });
      }
      return commit({ kind: "forward" });
    }
  }
}

function filterOpenAIModel(model: JSONObject): JSONObject {
  const out: JSONObject = { id: model.id, object: model.object };
  if ("created" in model) out.created = model.created;
  if ("owned_by" in model) out.owned_by = model.owned_by;
  return out;
}

/** The client session of a Responses request (Codex session headers), for usage records. */
function responsesSessionID(headers: Headers): string {
  for (const name of ["X-Claude-Code-Session-Id", "Session_id", "Session-Id", "X-Session-Id"]) {
    const value = (headers.get(name) ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}

/**
 * Deviation (as in the Claude error envelope): a truncated stream is never
 * reported with a client-error status. A truncation below 500 other than
 * Codex's retryable 408 is lifted to 502, so the Responses error is typed
 * server_error, never invalid_request_error.
 */
function normalizeTruncatedStatus(msg: ErrorMessage): ErrorMessage {
  if (msg.statusCode < 500 && msg.statusCode !== 408 && isStreamTruncatedError(msg.error)) return { ...msg, statusCode: 502 };
  return msg;
}

function parseRequestBody(rawJSON: string): ParsedBody | { error: ErrorMessage } {
  const parsed = tryParse(rawJSON);
  if (!isObject(parsed)) return { error: openAIErrorMessage(400, { message: "Invalid request: body must be a JSON object", type: "invalid_request_error" }) };
  return { raw: rawJSON, object: parsed };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Logs a terminal stream failure with the last event, sanitised and bounded (Go: logResponsesStreamError). */
function logResponsesStreamError(framer: ResponsesSSEFramer, msg: ErrorMessage): void {
  let status = msg.statusCode;
  if (status < 400 || status > 599) status = 500;
  const lastEvent = framer.lastEvent !== "" ? framer.lastEvent : "none";
  log.debug(`responses stream terminated after ${lastEvent}: ${responsesStreamErrorText(msg, status)}`);
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

/** What happens after the initial output: keep forwarding, write a terminal error, or stop. */
export type ForwardPlan = { kind: "forward" } | { kind: "error"; error: ErrorMessage } | { kind: "finished"; terminal?: ErrorMessage };

export interface ForwardResponsesStreamOptions {
  /** Output already released by the framer before the commit. */
  initial: string;
  framer: ResponsesSSEFramer;
  plan: ForwardPlan;
  iterator: AsyncIterator<string>;
  /** Official Codex client: terminal failures are `response.failed` events. */
  codexClient: boolean;
  signal?: AbortSignal;
  /** Turns an iterator failure into the sanitised terminal ErrorMessage. */
  normalize: (err: unknown) => ErrorMessage;
  /** Observes every piece of text written downstream. */
  onWrite?: (text: string) => void;
  /** Receives the terminal failure (undefined on a clean end or client abort). */
  onDone?: (terminal: ErrorMessage | undefined) => void;
}

/**
 * The committed Responses SSE body (Go: forwardResponsesStream on
 * BaseAPIHandler.ForwardStream). Chunks go through the framer; an iterator
 * failure is written as one terminal error event unless the stream already
 * ended with a terminal event; a clean close without a terminal event becomes
 * a 502 "upstream stream closed before a terminal event (last event: X)" error.
 */
export function forwardResponsesStream(options: ForwardResponsesStreamOptions): ReadableStream<Uint8Array> {
  const { framer, iterator, signal } = options;
  framer.failureEvent = options.codexClient ? "response.failed" : "error";
  framer.isCodexClient = options.codexClient;
  const encoder = new TextEncoder();
  let cancelled = false;
  let iteratorDone = false;
  const release = () => {
    cancelled = true;
    if (!iteratorDone) iterator.return?.().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (cancelled || text.length === 0) return;
        options.onWrite?.(text);
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cancelled = true;
        }
      };
      const writeTerminalError = (msg: ErrorMessage): void => {
        write(framer.flush());
        const status = msg.statusCode > 0 ? msg.statusCode : 500;
        const errText = responsesStreamErrorText(msg, status);
        logResponsesStreamError(framer, msg);
        if (framer.terminalEvent !== "") return;
        let seq = framer.dataFrames;
        const parsed = tryParse(errText);
        if (isObject(parsed) && typeof parsed.sequence_number === "number") seq = Math.trunc(parsed.sequence_number);
        if (options.codexClient) write(`\nevent: response.failed\ndata: ${buildOpenAIResponsesStreamFailedChunk(status, errText, seq)}\n\n`);
        else write(`\nevent: error\ndata: ${buildOpenAIResponsesStreamErrorChunk(status, errText, seq)}\n\n`);
      };
      const onAbort = () => release();
      signal?.addEventListener("abort", onAbort, { once: true });
      let terminal: ErrorMessage | undefined;
      try {
        write(options.initial);
        const plan = options.plan;
        if (plan.kind === "error") {
          terminal = plan.error;
          writeTerminalError(plan.error);
          return;
        }
        if (plan.kind === "finished") {
          terminal = plan.terminal;
          return;
        }
        while (!cancelled) {
          let next: IteratorResult<string>;
          try {
            next = await iterator.next();
          } catch (err) {
            iteratorDone = true;
            if (cancelled || signal?.aborted) return;
            terminal = options.normalize(err);
            writeTerminalError(terminal);
            return;
          }
          if (next.done) {
            iteratorDone = true;
            // CloseError: a clean close must have produced a terminal event.
            write(framer.flush());
            if (framer.terminalError) {
              terminal = framer.terminalError;
            } else if (framer.terminalEvent === "") {
              const lastEvent = framer.lastEvent !== "" ? framer.lastEvent : "none";
              terminal = { statusCode: 502, error: new Error(`upstream stream closed before a terminal event (last event: ${lastEvent})`) };
            }
            if (terminal) writeTerminalError(terminal);
            else write("\n");
            return;
          }
          if (typeof next.value !== "string" || next.value.length === 0) continue;
          write(framer.writeChunk(next.value));
          if (framer.terminalError) {
            // ChunkError: the framer already wrote the terminal failure event.
            terminal = framer.terminalError;
            logResponsesStreamError(framer, terminal);
            return;
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!iteratorDone) iterator.return?.().catch(() => {});
        options.onDone?.(cancelled && !terminal ? undefined : terminal);
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

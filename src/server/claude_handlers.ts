// Claude Messages-compatible handlers. Port of sdk/api/handlers/claude/code_handlers.go
// (ClaudeMessages, ClaudeCountTokens, ClaudeModels, the streaming forwarder with
// claudeSSEStreamState and the Claude error envelope) on top of the routing of
// handlers_routing.go (getRequestDetails) and the execution plumbing of
// handlers_execution.go. The transport is fetch Request/Response instead of gin.
//
// Dropped from upstream: model routers / plugin executors, request interceptors,
// pre-first-token keep-alive ticks, gzip sniffing of non-stream bodies (Bun's
// fetch already decompresses), the "auto" model alias and the API_RESPONSE log hooks.
import { RequestPathMetadataKey, RequestedModelMetadataKey, type ErrorMessage, type ExecOptions, type ExecRequest, type ExecResponse, type StreamResult } from "../executor/types.ts";
import { getGlobalRegistry, type ModelRegistry } from "../registry/index.ts";
import { parseSuffix } from "../thinking/suffix.ts";
import { FormatClaude } from "../translator/types.ts";
import { tryParse, isObject, type JSONObject } from "../util/json.ts";
import { claudeErrorBody, claudeErrorMessage, claudeErrorResponse, enrichAuthSelectionError, executionErrorMessage } from "./errors.ts";
import { filterUpstreamHeaders, forwardableInboundHeaders, writeUpstreamHeaders } from "./headers.ts";
import { buildClaudeModelsResponse, resolveClaudeModelIDPrefix } from "./models.ts";
import { ClaudeSSEStreamState } from "./sse_state.ts";

/** The slice of AuthManager the handlers need (structurally satisfied by AuthManager). */
export interface ExecutionManager {
  execute(providers: string[], req: ExecRequest, opts: ExecOptions): Promise<ExecResponse>;
  executeStream(providers: string[], req: ExecRequest, opts: ExecOptions): Promise<StreamResult>;
  executeCount(providers: string[], req: ExecRequest, opts: ExecOptions): Promise<ExecResponse>;
}

export interface ClaudeHandlerOptions {
  manager: ExecutionManager;
  /** Model registry used to resolve model -> providers (default: the global one). */
  registry?: ModelRegistry;
  /** config requests.passthroughHeaders. */
  passthroughHeaders?: boolean;
  /**
   * Rewrite non-"claude-" ids in /v1/models to the claude-fable-5-dd-<reversed>
   * form upstream uses for Claude Code. Off by default in this port; requests
   * carrying such ids are always decoded.
   */
  cloakModelList?: boolean;
}

const sseErrorPrefix = "event: error\ndata: ";

export class ClaudeCodeAPIHandler {
  private readonly manager: ExecutionManager;
  private readonly registry: ModelRegistry;
  private readonly passthroughHeaders: boolean;
  private readonly cloakModelList: boolean;

  constructor(options: ClaudeHandlerOptions) {
    this.manager = options.manager;
    this.registry = options.registry ?? getGlobalRegistry();
    this.passthroughHeaders = options.passthroughHeaders ?? false;
    this.cloakModelList = options.cloakModelList ?? false;
  }

  /** Handler type (Go: HandlerType). */
  handlerType(): string {
    return FormatClaude;
  }

  /** Available models in the Anthropic list shape (Go: Models). */
  models(): JSONObject[] {
    return this.registry.getAvailableModels("claude");
  }

  /** GET /v1/models (Go: ClaudeModels). */
  claudeModels(): Response {
    return jsonResponse(buildClaudeModelsResponse(this.models(), !this.cloakModelList));
  }

  /** GET /v1/models/:id. The id may carry the cloaked prefix. */
  claudeModelDetail(id: string): Response {
    const wanted = resolveClaudeModelIDPrefix(id.trim());
    const listing = buildClaudeModelsResponse(this.models(), !this.cloakModelList);
    const data = Array.isArray(listing.data) ? (listing.data as JSONObject[]) : [];
    for (const entry of data) {
      if (entry.id === id || (typeof entry.id === "string" && resolveClaudeModelIDPrefix(entry.id) === wanted)) return jsonResponse(entry);
    }
    return claudeErrorResponse(claudeErrorMessage(404, "not_found_error", `model not found: ${id}`), { passthroughHeaders: this.passthroughHeaders });
  }

  /** POST /v1/messages (Go: ClaudeMessages). */
  async claudeMessages(request: Request, rawJSON: string): Promise<Response> {
    const parsed = parseRequestBody(rawJSON);
    if ("error" in parsed) return this.errorResponse(parsed.error);
    const body = rewriteClaudeDDModelInBody(parsed.body, parsed.raw);
    const stream = body.object.stream === true;
    if (!stream) return this.handleNonStreamingResponse(request, body);
    return this.handleStreamingResponse(request, body);
  }

  /** POST /v1/messages/count_tokens (Go: ClaudeCountTokens). */
  async claudeCountTokens(request: Request, rawJSON: string): Promise<Response> {
    const parsed = parseRequestBody(rawJSON);
    if ("error" in parsed) return this.errorResponse(parsed.error);
    const body = rewriteClaudeDDModelInBody(parsed.body, parsed.raw);
    const prepared = this.prepareExecution(request, body, false);
    if ("error" in prepared) return this.errorResponse(prepared.error);
    let resp: ExecResponse;
    try {
      resp = await this.manager.executeCount(prepared.providers, prepared.req, prepared.opts);
    } catch (err) {
      return this.errorResponse(executionErrorMessage(enrichAuthSelectionError(err, prepared.providers, prepared.req.model)));
    }
    return this.jsonSuccess(resp);
  }

  private errorResponse(msg: ErrorMessage): Response {
    return claudeErrorResponse(msg, { passthroughHeaders: this.passthroughHeaders });
  }

  private jsonSuccess(resp: ExecResponse): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.passthroughHeaders) writeUpstreamHeaders(headers, filterUpstreamHeaders(resp.headers));
    return new Response(resp.payload, { status: 200, headers });
  }

  /**
   * Resolves the providers for the requested model via the registry: the
   * thinking suffix is stripped for the lookup, the full model name travels
   * to the executor (Go: getRequestDetails).
   */
  getRequestDetails(modelName: string): { providers: string[]; model: string } | { error: ErrorMessage } {
    const parsedSuffix = parseSuffix(modelName);
    const baseModel = parsedSuffix.modelName.trim();
    let providers = baseModel === "" ? [] : this.registry.getModelProviders(baseModel);
    if (providers.length === 0 && baseModel !== modelName) providers = this.registry.getModelProviders(modelName);
    if (providers.length === 0) {
      const name = modelName.trim();
      return { error: claudeErrorMessage(404, "not_found_error", name === "" ? "model not found" : `model not found: ${name}`) };
    }
    return { providers, model: modelName };
  }

  private prepareExecution(request: Request, body: ParsedBody, stream: boolean): { providers: string[]; req: ExecRequest; opts: ExecOptions } | { error: ErrorMessage } {
    const modelName = typeof body.object.model === "string" ? body.object.model : "";
    const details = this.getRequestDetails(modelName);
    if ("error" in details) return details;
    const url = new URL(request.url);
    const metadata: Record<string, unknown> = { [RequestedModelMetadataKey]: modelName, [RequestPathMetadataKey]: url.pathname };
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
    if (idempotencyKey) metadata.idempotency_key = idempotencyKey;
    const req: ExecRequest = { model: details.model, payload: body.raw, format: FormatClaude };
    const opts: ExecOptions = {
      stream,
      headers: forwardableInboundHeaders(request.headers),
      query: url.searchParams,
      originalRequest: body.raw,
      sourceFormat: FormatClaude,
      metadata,
      signal: request.signal,
    };
    return { providers: details.providers, req, opts };
  }

  private async handleNonStreamingResponse(request: Request, body: ParsedBody): Promise<Response> {
    const prepared = this.prepareExecution(request, body, false);
    if ("error" in prepared) return this.errorResponse(prepared.error);
    let resp: ExecResponse;
    try {
      resp = await this.manager.execute(prepared.providers, prepared.req, prepared.opts);
    } catch (err) {
      return this.errorResponse(executionErrorMessage(enrichAuthSelectionError(err, prepared.providers, prepared.req.model)));
    }
    return this.jsonSuccess(resp);
  }

  /**
   * Streams the upstream chunks as text/event-stream. The first chunk is read
   * before the response commits so an early failure still produces a plain
   * JSON error with the right status; later failures become a terminal
   * `event: error` frame and a close without message_stop becomes a 502 frame
   * (Go: handleStreamingResponse + forwardClaudeStreamWithState).
   */
  private async handleStreamingResponse(request: Request, body: ParsedBody): Promise<Response> {
    const prepared = this.prepareExecution(request, body, true);
    if ("error" in prepared) return this.errorResponse(prepared.error);
    const { providers, req, opts } = prepared;
    let result: StreamResult;
    try {
      result = await this.manager.executeStream(providers, req, opts);
    } catch (err) {
      return this.errorResponse(executionErrorMessage(enrichAuthSelectionError(err, providers, req.model)));
    }
    const iterator = result.chunks[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await nextNonEmpty(iterator);
    } catch (err) {
      // Upstream failed before any payload: plain JSON error, no SSE commit.
      return this.errorResponse(executionErrorMessage(enrichAuthSelectionError(err, providers, req.model)));
    }

    const headers = new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (this.passthroughHeaders) writeUpstreamHeaders(headers, filterUpstreamHeaders(result.headers));
    const stream = forwardClaudeStream({ first, iterator, signal: request.signal, errorBody: (msg) => claudeErrorBody(msg) });
    return new Response(stream, { status: 200, headers });
  }
}

interface ParsedBody {
  raw: string;
  object: JSONObject;
}

function parseRequestBody(rawJSON: string): ParsedBody | { error: ErrorMessage } {
  const parsed = tryParse(rawJSON);
  if (!isObject(parsed)) {
    return { error: claudeErrorMessage(400, "invalid_request_error", "Invalid request: body must be a JSON object") };
  }
  return { raw: rawJSON, object: parsed };
}

/** Decodes claude-fable-5-dd-<reversed> model ids back to the real model name (Go: rewriteClaudeDDModelInBody). */
export function rewriteClaudeDDModelInBody(object: JSONObject, raw: string): ParsedBody {
  const modelName = typeof object.model === "string" ? object.model : "";
  const resolved = resolveClaudeModelIDPrefix(modelName);
  if (resolved === modelName) return { raw, object };
  const updated: JSONObject = { ...object, model: resolved };
  return { raw: JSON.stringify(updated), object: updated };
}

async function nextNonEmpty(iterator: AsyncIterator<string>): Promise<IteratorResult<string>> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) return next;
    if (typeof next.value === "string" && next.value.length > 0) return next;
  }
}

export interface ForwardClaudeStreamOptions {
  /** The already-read first chunk (or a done result when the upstream closed without data). */
  first: IteratorResult<string>;
  iterator: AsyncIterator<string>;
  /** Client disconnect. */
  signal?: AbortSignal;
  /** Serialises the terminal error frame payload. */
  errorBody: (msg: ErrorMessage) => string;
  /** Receives the terminal outcome (undefined on a clean close). */
  onDone?: (err: ErrorMessage | undefined) => void;
}

/**
 * Builds the downstream SSE body for a committed Claude stream. Each chunk is
 * written as-is and observed; when the upstream iterator throws, a terminal
 * `event: error` frame with the Claude error envelope is written (unless the
 * stream already carried an error event), always starting on an SSE event
 * boundary; when the iterator ends without message_stop a 502
 * "upstream stream closed before message_stop" frame is written (Go: CloseError).
 */
export function forwardClaudeStream(options: ForwardClaudeStreamOptions): ReadableStream<Uint8Array> {
  const { first, iterator, signal, errorBody } = options;
  const encoder = new TextEncoder();
  const state = new ClaudeSSEStreamState();
  let cancelled = false;
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
          state.observeChunk(first.value);
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
            state.observeChunk(next.value);
            write(next.value);
          }
        }
        if (cancelled) return;
        state.flushPendingLine();
        if (!terminal && !state.sawMessageStop && !state.sawErrorEvent) {
          terminal = { statusCode: 502, error: new Error("upstream stream closed before message_stop") };
        }
        if (terminal) {
          // WriteTerminalError: never duplicate an error event the upstream already emitted.
          write(state.ensureSSEEventBoundary());
          if (!state.sawErrorEvent) write(`${sseErrorPrefix}${errorBody(terminal)}\n\n`);
        } else {
          // WriteDone: make sure the final event is terminated by a blank line.
          write(state.ensureSSEEventBoundary());
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        options.onDone?.(terminal);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

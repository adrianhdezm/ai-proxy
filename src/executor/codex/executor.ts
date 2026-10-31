// Codex executor (provider key "codex"). Port of the HTTP/SSE path of
// internal/runtime/executor/codex_executor{,_execute,_stream,_request,_terminal,_auth,_tokens}.go.
//
// Inbound requests (Claude Messages, or any format with a registered translator
// to "codex") are translated to the OpenAI Responses API and POSTed to
// `<base>/responses`, where base is attributes.base_url (API-key credentials,
// attributes.api_key) or the ChatGPT backend https://chatgpt.com/backend-api/codex
// (OAuth credentials, metadata.access_token + metadata.account_id). Codex always
// answers with an SSE stream, also for non-streaming requests.
//
// Failure classification (see errors.ts for the table): upstream non-2xx and
// terminal `error` / `response.failed` events become StatusErrors whose
// credentialScoped / transientRateLimit / requestScoped / streamTruncated flags
// drive the AuthManager's cooldown and failover.
//
// Stream bootstrap buffering (options.streamBootstrapBuffering, Go:
// codex.stream-bootstrap-buffering): executeStream reads the stream before
// returning it and holds back the handshake frames (response.created, ...) until
// the first generated event, so an overload / rate-limit rejection the backend
// smuggles into an HTTP 200 stream throws before any chunk and the manager fails
// over. See bootstrapStream below.
//
// Reasoning replay (reasoning_replay.ts): Claude inbound turns get the encrypted
// reasoning of earlier turns of the same session re-inserted from the cache,
// which is filled from response.completed and cleared on an invalid signature.
//
// Image generation: requests from /v1/images/* (source format "openai-image")
// are served by images.ts. Other requests get the hosted image_generation tool
// declared (ensureImageGenerationTool) unless options.disableImageGeneration is
// set, in which case any image_generation tool / tool_choice is stripped.
//
// Responses inbound (sourceFormat "openai-response"): the request goes through
// the normalising Responses -> Codex translator and the stream comes back as raw
// SSE lines; a native Codex request (Responses Lite) keeps its completed output
// untouched (preserveNativeOutput). /v1/responses/compact (opts.alt
// "responses/compact") is executeCompact: the Responses body is posted to
// <base>/responses/compact without translation and the JSON answer returned.
// As upstream, the Codex executor never installs the apply_patch bridge: Codex
// understands custom tools natively (only the dropped xAI / Kimi / Meta
// executors normalised apply_patch).
//
// The Responses websocket transport lives in websockets/ (CodexWebsocketsExecutor);
// the registered "codex" executor is websockets/auto.ts CodexAutoExecutor, which
// picks it only for downstream websocket turns on websocket-enabled credentials.
//
// Reasoning items are sanitised before sending (reasoning_sanitize.ts: invalid
// encrypted_content dropped, cleartext reasoning content cleared unless the model
// is is-compat) and the prompt cache identity is set (prompt_cache.ts: body
// prompt_cache_key + Session-Id header).
//
// Not ported (outside this slice): SIWC credentials and body rules, zstd request
// compression, multi-agent v2 optimisation, the payload config finalizer, usage
// reporting and request logging, the Claude input-token estimate on
// message_start, and the Home refresh/file-lock path.
import type { Auth } from "../../auth/types.ts";
import { CodexAuthenticator } from "../../auth/codex/index.ts";
import { FormatCodex, FormatOpenAIResponse, type Format, type TranslateContext, type TranslatorState } from "../../translator/types.ts";
import { applyPatchTranslationError, applyPatchUpstreamError, applyPatchUpstreamErrorMessage, ensureResponsesUsageDetails } from "../responses.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import "../../translator/codex/claude/index.ts";
import "../../translator/codex/openai/responses/index.ts";
import { parseSuffix } from "../../thinking/index.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, type StreamResult, StatusError, responseFormatOrSource } from "../types.ts";
import { applyFetchProxy } from "../proxy.ts";
import { codexAuthUsesAPIKey, codexBaseURL, codexCreds, isNativeCodexRequest } from "./creds.ts";
import {
  type TerminalFailure,
  codexTerminalFailureErrWithCooling,
  hasMeaningfulCodexOutputDelta,
  isCodexOverloadBootstrapFailure,
  isCodexTerminalEmptyIncomplete,
  newCodexEmptyIncompleteStreamError,
  newCodexIncompleteStreamError,
  newCodexStatusErrWithHeadersAndCooling,
} from "./errors.ts";
import { type CodexHeaderDefaults, applyCodexHeaders, applyCodexRoutingHint, applyModelHeaderOverrides } from "./headers.ts";
import { sanitizeCodexInputItemIDs } from "./input_ids.ts";
import {
  type CollectedOutputItems,
  collectCodexOutputItemDone,
  collectedOutputItemCount,
  deleteFields,
  ensureImageGenerationTool,
  ensureWebSearchToolForHistory,
  newCollectedOutputItems,
  normalizeCodexInstructions,
  normalizeCodexParallelToolCalls,
  parseCodexUsage,
  patchCodexCompletedOutput,
  setBoolIfDifferent,
  setStringIfDifferent,
  translateCodexRequestPair,
} from "./request.ts";
import { type CodexSSEItem, CodexSSEScanner, scanCodexSSEText, utf8Len } from "./sse_scanner.ts";
import { codexBootstrapMaxBufferedBytes, codexBootstrapMaxBufferedFrames, isCodexBootstrapBufferableEvent, newCodexBootstrapOverloadErr } from "./bootstrap.ts";
import {
  type CodexReasoningReplayScope,
  emptyCodexReasoningReplayScope,
  applyCodexReasoningReplayCache,
  cacheCodexReasoningReplayFromCompleted,
  clearCodexReasoningReplayOnInvalidSignature,
} from "./reasoning_replay.ts";
import { type CodexReasoningReplayCache, defaultCodexReasoningReplayCache } from "../../cache/codex_reasoning_replay_cache.ts";
import { asRequestError, applyRequestThinking, resolvedModelInfo } from "./thinking.ts";
import { countCodexInputTokens } from "./tokens.ts";
import { normalizeCodexToolSchemas } from "./tool_schema.ts";
import { type CodexModelOptionsResolver, resolveCodexModelIsCompat, resolveResponsesSignatureTargetModel, sanitizeResponsesReasoningEncryptedContent } from "./reasoning_sanitize.ts";
import { applyCodexHTTPPromptCache } from "./prompt_cache.ts";
import { type CodexImagesContext, executeCodexOpenAIImage, executeCodexOpenAIImageStream, isCodexOpenAIImageRequest, stripImageGenerationTools } from "./images.ts";

/** Injectable fetch for tests; defaults to the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** ExecOptions.alt selecting the compaction endpoint (Go: opts.Alt == "responses/compact"). */
export const CodexCompactAlt = "responses/compact";

/** Message of the 502 raised when an accepted stream ends before any translated payload (failover-eligible). */
export const codexEmptyStreamMessage = "upstream stream closed before first payload";

export interface CodexExecutorOptions {
  /**
   * codex.model-level-cooling: a usage_limit_reached rejection cools only the
   * requested model instead of the whole credential (no credentialScoped flag).
   */
  modelLevelCooling?: boolean;
  /** codex.disable-codex-cloaking: keep the client's User-Agent/Originator. */
  disableCloaking?: boolean;
  /** codex-header-defaults: User-Agent / beta features for OAuth credentials. */
  headerDefaults?: CodexHeaderDefaults;
  fetch?: FetchLike;
  /**
   * Clock (epoch ms) for resets_at / Retry-After dates, refresh timestamps and
   * the stream bootstrap time ceiling.
   */
  now?: () => number;
  /**
   * codex.stream-bootstrap-buffering (default false): hold back the frames that
   * arrive before generation starts so an overload or rate-limit rejection inside
   * an HTTP 200 stream fails over to the next credential.
   */
  streamBootstrapBuffering?: boolean;
  /**
   * codex.stream-bootstrap-timeout in ms (default 0 = no time ceiling, only the
   * frame and byte budgets). Measured with `now` from the response headers.
   */
  streamBootstrapTimeoutMs?: number;
  /** Reasoning replay store; defaults to the process-wide defaultCodexReasoningReplayCache. */
  reasoningReplayCache?: CodexReasoningReplayCache;
  /**
   * multimedia.disable-image-generation: never declare the image_generation
   * tool and strip it (and a tool_choice forcing it) from outgoing requests.
   */
  disableImageGeneration?: boolean;
  /**
   * The configured models (name / alias / is-compat) of the credential serving a
   * request (Go: resolveCodexConfig(auth).Models). Decides compat handling when
   * no model definition is bound to the request.
   */
  modelOptionsFor?: CodexModelOptionsResolver;
}

interface PreparedRequest {
  url: string;
  headers: Headers;
  /** Final upstream body. */
  body: string;
  originalPayload: string;
  from: Format;
  responseFormat: Format;
  /** Native Codex Responses Lite requests keep the completed output untouched. */
  preserveNativeOutput: boolean;
  /** Reasoning replay scope (invalid unless a Claude inbound request with a session). */
  replayScope: CodexReasoningReplayScope;
}

/** Stateless executor for the Codex Responses API (Go: CodexExecutor). */
export class CodexExecutor implements ProviderExecutor {
  readonly identifier = "codex";
  private readonly options: CodexExecutorOptions;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly replayCache: CodexReasoningReplayCache;

  constructor(options: CodexExecutorOptions = {}) {
    this.options = options;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.replayCache = options.reasoningReplayCache ?? defaultCodexReasoningReplayCache;
  }

  private get modelLevelCooling(): boolean {
    return this.options.modelLevelCooling === true;
  }

  /** Go: resolveCodexModelIsCompat. */
  isCompat(auth: Auth, req: ExecRequest, baseModel: string): boolean {
    return resolveCodexModelIsCompat(auth, req, baseModel, this.options.modelOptionsFor);
  }

  /** Builds the translated upstream request (Go: the shared head of Execute / ExecuteStream). */
  prepare(auth: Auth, req: ExecRequest, opts: ExecOptions, stream: boolean): PreparedRequest {
    const baseModel = parseSuffix(req.model).modelName;
    const { apiKey } = codexCreds(auth);
    const baseURL = codexBaseURL(auth);

    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const to = FormatCodex;
    const originalPayload = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
    const isCompat = this.isCompat(auth, req, baseModel);
    const targetModel = resolveResponsesSignatureTargetModel(baseModel, req, opts);
    const preserveNativeOutput = isNativeCodexRequest(req.payload, from, responseFormat, opts.headers);

    let body: string;
    try {
      const pair = translateCodexRequestPair(from, to, baseModel, originalPayload, req.payload, stream, isCompat);
      body = setStringIfDifferent(pair.body, "model", baseModel);
      body = applyRequestThinking(body, req, opts, from, to, this.identifier);
    } catch (err) {
      throw asRequestError(err);
    }

    body = setStringIfDifferent(body, "model", baseModel);
    body = setBoolIfDifferent(body, "stream", true);
    const reasoningSummaryDelivery = stream ? getAt(tryParse(body), "stream_options.reasoning_summary_delivery") : undefined;
    body = deleteFields(body, "previous_response_id", "generate", "prompt_cache_retention", "safety_identifier", "stream_options");
    if (reasoningSummaryDelivery !== undefined) {
      const root = tryParse(body);
      if (isObj(root)) {
        root.stream_options = { reasoning_summary_delivery: reasoningSummaryDelivery };
        body = JSON.stringify(root);
      }
    }
    body = ensureWebSearchToolForHistory(body, opts.headers);
    body = normalizeCodexInstructions(body, preserveNativeOutput);
    if (this.options.disableImageGeneration !== true) body = ensureImageGenerationTool(body, baseModel, auth, opts.headers);
    body = normalizeCodexParallelToolCalls(body, opts.headers);
    body = normalizeCodexToolSchemas(body);
    const replay = applyCodexReasoningReplayCache(this.replayCache, from, req, opts, body);
    body = replay.body;
    body = sanitizeResponsesReasoningEncryptedContent("codex executor", body, isCompat, targetModel, baseURL);
    // Go: cacheHelper (prompt_cache_key + Session-Id, input id sanitising, payload finalizer).
    const cache = applyCodexHTTPPromptCache(from, req, body, opts.headers, opts.metadata);
    body = sanitizeCodexInputItemIDs(cache.body);
    // Go: the payload finalizer's disable-image-generation strip.
    if (this.options.disableImageGeneration === true) body = stripImageGenerationTools(body);

    const url = baseURL.replace(/\/+$/, "") + "/responses";
    const headers = new Headers();
    if (cache.sessionID !== "") headers.set("Session-Id", cache.sessionID);
    applyCodexHeaders(headers, auth, apiKey, true, { disableCloaking: this.options.disableCloaking, headerDefaults: this.options.headerDefaults }, opts.headers);
    applyCodexRoutingHint(headers, auth, baseModel, body, opts.headers);
    applyModelHeaderOverrides(headers, baseModel);
    return { url, headers, body, originalPayload, from, responseFormat, preserveNativeOutput, replayScope: replay.scope };
  }

  private async send(auth: Auth, prepared: PreparedRequest, opts: ExecOptions): Promise<Response> {
    const init: RequestInit & { proxy?: string } = { method: "POST", headers: prepared.headers, body: prepared.body, signal: opts.signal };
    applyFetchProxy(init, opts.proxyUrl, auth.proxyUrl, undefined);
    return this.fetchFn(prepared.url, init);
  }

  /** Reads a rejected response and classifies it (Go: newCodexStatusErrWithHeadersAndCooling). */
  private async statusError(resp: Response, replayScope: CodexReasoningReplayScope): Promise<StatusError> {
    let body = "";
    try {
      body = await resp.text();
    } catch {
      // An unreadable error body is classified by its status alone.
    }
    clearCodexReasoningReplayOnInvalidSignature(this.replayCache, replayScope, resp.status, body);
    log.debug("codex executor: request error", { status: resp.status });
    return newCodexStatusErrWithHeadersAndCooling(resp.status, resp.headers, body, this.modelLevelCooling, this.now());
  }

  /** What the image endpoints borrow from this executor (images.ts). */
  private imagesContext(): CodexImagesContext {
    return { fetch: this.fetchFn, now: this.now, modelLevelCooling: this.modelLevelCooling, headerPolicy: { disableCloaking: this.options.disableCloaking, headerDefaults: this.options.headerDefaults } };
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    if (opts.alt === CodexCompactAlt) return this.executeCompact(auth, req, opts);
    if (isCodexOpenAIImageRequest(opts)) return executeCodexOpenAIImage(this.imagesContext(), auth, req, opts);
    const prepared = this.prepare(auth, req, opts, false);
    const resp = await this.send(auth, prepared, opts);
    if (resp.status < 200 || resp.status >= 300) throw await this.statusError(resp, prepared.replayScope);

    const { text, readError } = await readBodyText(resp);
    const items = newCollectedOutputItems();
    let sawOutputDelta = false;
    for (const line of scanCodexSSEText(text, { onDiagnostic: logSSEDiagnostic })) {
      if (!line.startsWith("data:")) continue;
      const eventData = line.slice(5).trim();
      const root = tryParse<unknown>(eventData);
      const eventType = codexEventType(root, eventData);
      if (hasMeaningfulCodexOutputDelta(root)) sawOutputDelta = true;

      const failure = codexTerminalFailureErrWithCooling(eventData, this.modelLevelCooling, this.now());
      if (failure) {
        clearCodexReasoningReplayOnInvalidSignature(this.replayCache, prepared.replayScope, failure.error.statusCode, failure.body);
        throw failure.error;
      }

      if (eventType === "response.output_item.done") {
        collectCodexOutputItemDone(root, items);
        continue;
      }
      if (eventType !== "response.completed" && eventType !== "response.incomplete") continue;
      if (isCodexTerminalEmptyIncomplete(root, collectedOutputItemCount(items), sawOutputDelta)) throw newCodexEmptyIncompleteStreamError();

      const completedData = patchedEventData(eventData, root, items, false);
      if (eventType === "response.completed") cacheCodexReasoningReplayFromCompleted(this.replayCache, prepared.replayScope, completedData);
      const state: TranslatorState = {};
      const ctx: TranslateContext = { signal: opts.signal };
      let out = defaultRegistry.translateNonStream(ctx, FormatCodex, prepared.responseFormat, req.model, prepared.originalPayload, prepared.body, completedData, state);
      if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
      if (out.length === 0) throw new StatusError(502, "upstream returned an unusable response");
      if (prepared.responseFormat === FormatOpenAIResponse) out = ensureResponsesUsageDetails(out);
      const usage = parseCodexUsage(root);
      return { payload: out, headers: resp.headers, metadata: usage ? { usage } : undefined };
    }
    if (readError !== undefined && opts.signal?.aborted) throw readError;
    throw newCodexIncompleteStreamError();
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    if (opts.alt === CodexCompactAlt) throw new StatusError(400, "streaming not supported for /responses/compact", { requestScoped: true });
    if (isCodexOpenAIImageRequest(opts)) return executeCodexOpenAIImageStream(this.imagesContext(), auth, req, opts);
    const prepared = this.prepare(auth, req, opts, true);
    const resp = await this.send(auth, prepared, opts);
    if (resp.status < 200 || resp.status >= 300) throw await this.statusError(resp, prepared.replayScope);
    // The bootstrap clock starts at the response headers (Go: responseReady).
    const bootstrapStart = this.now();
    const source = new CodexLineSource(resp.body, opts.signal);
    const processor = new CodexStreamProcessor(this, req, opts, prepared);
    if (this.options.streamBootstrapBuffering !== true) {
      return { headers: resp.headers, chunks: this.streamChunks(source, processor, opts, { chunks: [], terminal: false }) };
    }
    let bootstrap: CodexBootstrap;
    try {
      bootstrap = await this.bootstrapStream(source, processor, opts, bootstrapStart);
    } catch (err) {
      source.close();
      throw err;
    }
    return { headers: resp.headers, chunks: this.streamChunks(source, processor, opts, bootstrap) };
  }

  /**
   * The buffered head of ExecuteStream (Go: the `if buffering` scan loop). Reads
   * until the first frame that is not a bufferable handshake frame, holding the
   * translated handshake chunks back. An overload rejection inside that window
   * throws its 503/429 classification before any chunk exists, so the manager
   * fails over; any other terminal failure is delivered in-stream after the held
   * chunks. The hold ends when a frame would push it past
   * codexBootstrapMaxBufferedFrames upstream lines or codexBootstrapMaxBufferedBytes
   * (upstream bytes plus translated chunk bytes), or once streamBootstrapTimeoutMs
   * has passed since the response headers; the stream is then released as is.
   */
  private async bootstrapStream(source: CodexLineSource, processor: CodexStreamProcessor, opts: ExecOptions, start: number): Promise<CodexBootstrap> {
    const timeout = Math.max(0, this.options.streamBootstrapTimeoutMs ?? 0);
    const timeoutReached = () => timeout > 0 && this.now() - start >= timeout;
    const scanner = source.scanner;
    let bufferedFrames = 0;
    let bufferedBytes = 0;
    let exhaustedReason = "";
    const buffered: string[] = [];
    // Consulted while a split event is being assembled, so one event cannot hold more than the budgets.
    scanner.setBudgetChecker((_line, heldLines, heldBytes) => {
      if (timeoutReached()) exhaustedReason = "time budget";
      else if (bufferedFrames + heldLines >= codexBootstrapMaxBufferedFrames) exhaustedReason = "frame budget";
      else if (bufferedBytes + heldBytes >= codexBootstrapMaxBufferedBytes) exhaustedReason = "byte budget";
      else return false;
      return true;
    });
    try {
      for (;;) {
        if (opts.signal?.aborted) throw abortReason(opts.signal);
        const item = await source.next();
        if (!item) break;
        if (item.budget) {
          log.debug("codex executor: bootstrap budget exhausted, releasing stream", { reason: exhaustedReason, lines: bufferedFrames, bytes: bufferedBytes });
          return { chunks: buffered, terminal: false };
        }
        const out = processor.processLine(item.line);
        if (out.failure) {
          if (out.failure.overload && !timeoutReached()) {
            log.debug("codex executor: bootstrap overload rejection, failing over", { lines: bufferedFrames });
            throw newCodexBootstrapOverloadErr(out.failure.body);
          }
          return { chunks: buffered, terminal: false, error: out.failure.error };
        }
        if (out.handshake && !out.terminal) {
          const rawLines = item.rawLines > 0 ? item.rawLines : 1;
          let frameBytes = item.rawBytes;
          for (const chunk of out.chunks) frameBytes += utf8Len(chunk);
          const reached = timeoutReached();
          const totalFrames = bufferedFrames + scanner.heldLines() + rawLines;
          const totalBytes = bufferedBytes + scanner.heldBytes() + frameBytes;
          if (!reached && totalFrames <= codexBootstrapMaxBufferedFrames && totalBytes <= codexBootstrapMaxBufferedBytes) {
            bufferedFrames += rawLines;
            bufferedBytes += frameBytes;
            buffered.push(...out.chunks);
            continue;
          }
          const reason = reached ? "time budget" : totalFrames > codexBootstrapMaxBufferedFrames ? "frame budget" : "byte budget";
          log.debug("codex executor: bootstrap budget exhausted, releasing stream", { reason, lines: bufferedFrames, bytes: bufferedBytes });
        }
        return { chunks: [...buffered, ...out.chunks], terminal: out.terminal };
      }
    } finally {
      scanner.setBudgetChecker(undefined);
    }
    // The stream ended (or failed) before generation started.
    if (source.readError !== undefined) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      throw source.readError;
    }
    if (opts.signal?.aborted) throw abortReason(opts.signal);
    if (buffered.length === 0) throw new StatusError(502, codexEmptyStreamMessage);
    throw newCodexIncompleteStreamError();
  }

  /**
   * Translates the upstream SSE body line by line (Go: the ExecuteStream reader
   * goroutine), after replaying what a buffered bootstrap held. A terminal
   * failure event throws its classified StatusError after everything already
   * emitted; a body that ends without a terminal event throws the 502
   * empty-stream error when nothing was emitted (the manager fails over) and
   * otherwise the truncated-stream error.
   */
  private async *streamChunks(source: CodexLineSource, processor: CodexStreamProcessor, opts: ExecOptions, bootstrap: CodexBootstrap): AsyncGenerator<string> {
    let emitted = 0;
    try {
      for (const chunk of bootstrap.chunks) {
        if (chunk.length === 0) continue;
        emitted++;
        yield chunk;
      }
      if (bootstrap.error !== undefined) throw bootstrap.error;
      if (bootstrap.terminal) return;
      for (;;) {
        const item = await source.next();
        if (!item) break;
        if (item.budget) continue;
        const out = processor.processLine(item.line);
        if (out.failure) throw out.failure.error;
        for (const chunk of out.chunks) {
          if (chunk.length === 0) continue;
          emitted++;
          yield chunk;
        }
        if (out.terminal) return;
      }
      if (opts.signal?.aborted) return;
      if (source.readError !== undefined) {
        const error = source.readError;
        log.debug("codex executor: upstream stream read error", { error: error instanceof Error ? error.message : String(error) });
      }
      if (emitted === 0) throw new StatusError(502, codexEmptyStreamMessage);
      throw newCodexIncompleteStreamError();
    } finally {
      // Stops the upstream body unless it was read to the end (terminal event, error, early consumer stop).
      source.close();
    }
  }

  /**
   * POST <base>/responses/compact (Go: executeCompact). The Responses body is
   * not translated (source and target are both "openai-response"); the
   * stream flag is removed, instructions normalised, web_search declared for
   * replayed web_search_call history and tool schemas normalised. The JSON
   * answer (object "response.compaction") is returned as is.
   */
  private async executeCompact(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const baseModel = parseSuffix(req.model).modelName;
    const { apiKey } = codexCreds(auth);
    const baseURL = codexBaseURL(auth);
    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const to = FormatOpenAIResponse;
    const originalPayload = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
    const isCompat = this.isCompat(auth, req, baseModel);
    let body: string;
    try {
      body = translateCodexRequestPair(from, to, baseModel, originalPayload, req.payload, false, isCompat).body;
      body = applyRequestThinking(body, req, opts, from, to, this.identifier);
    } catch (err) {
      throw asRequestError(err);
    }
    body = setStringIfDifferent(body, "model", baseModel);
    body = deleteFields(body, "stream");
    body = normalizeCodexInstructions(body, isNativeCodexRequest(req.payload, from, responseFormat, opts.headers));
    body = ensureWebSearchToolForHistory(body, opts.headers);
    body = sanitizeResponsesReasoningEncryptedContent("codex executor", body, isCompat, resolveResponsesSignatureTargetModel(baseModel, req, opts), baseURL);
    body = normalizeCodexParallelToolCalls(body, opts.headers);
    body = normalizeCodexToolSchemas(body);
    const cache = applyCodexHTTPPromptCache(from, req, body, opts.headers, opts.metadata);
    body = sanitizeCodexInputItemIDs(cache.body);

    const url = baseURL.replace(/\/+$/, "") + "/responses/compact";
    const headers = new Headers();
    if (cache.sessionID !== "") headers.set("Session-Id", cache.sessionID);
    applyCodexHeaders(headers, auth, apiKey, false, { disableCloaking: this.options.disableCloaking, headerDefaults: this.options.headerDefaults }, opts.headers);
    applyCodexRoutingHint(headers, auth, baseModel, body, opts.headers);
    applyModelHeaderOverrides(headers, baseModel);
    const prepared: PreparedRequest = { url, headers, body, originalPayload, from, responseFormat, preserveNativeOutput: false, replayScope: emptyCodexReasoningReplayScope() };
    const resp = await this.send(auth, prepared, opts);
    if (resp.status < 200 || resp.status >= 300) throw await this.statusError(resp, prepared.replayScope);
    const data = await resp.text();
    const state: TranslatorState = {};
    let out = defaultRegistry.translateNonStream({ signal: opts.signal }, to, responseFormat, req.model, originalPayload, body, data, state);
    if (applyPatchTranslationError(state) || out.length === 0) throw new StatusError(502, applyPatchUpstreamErrorMessage);
    if (responseFormat === FormatOpenAIResponse) out = ensureResponsesUsageDetails(out);
    return { payload: out, headers: resp.headers };
  }

  /** @internal Used by CodexStreamProcessor. */
  terminalFailure(data: string): TerminalFailure | undefined {
    return codexTerminalFailureErrWithCooling(data, this.modelLevelCooling, this.now());
  }

  /** @internal Used by CodexStreamProcessor. */
  get reasoningReplayCache(): CodexReasoningReplayCache {
    return this.replayCache;
  }

  /**
   * Token counting (Go: CountTokens). Translates the request like Execute and
   * estimates the prompt locally (ceil(chars / 4), see tokens.ts); Claude
   * responses are `{"input_tokens":N}`.
   */
  async countTokens(_auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const body = this.countTokensBody(req, opts);
    const count = countCodexInputTokens(body);
    const usageJSON = JSON.stringify({ response: { usage: { input_tokens: count, output_tokens: 0, total_tokens: count } } });
    return { payload: defaultRegistry.translateTokenCount({ signal: opts.signal }, FormatCodex, responseFormatOrSource(opts), count, usageJSON) };
  }

  /** The translated Codex body countTokens estimates (Go: the head of CountTokens). */
  countTokensBody(req: ExecRequest, opts: ExecOptions): string {
    const baseModel = parseSuffix(req.model).modelName;
    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const isCompat = resolvedModelInfo(req)?.isCompat === true;
    let body: string;
    try {
      body = translateCodexRequestPair(from, FormatCodex, baseModel, req.payload, req.payload, false, isCompat).body;
      body = applyRequestThinking(body, req, opts, from, FormatCodex, this.identifier);
    } catch (err) {
      throw asRequestError(err);
    }
    body = setStringIfDifferent(body, "model", baseModel);
    body = deleteFields(body, "previous_response_id", "generate", "prompt_cache_retention", "safety_identifier", "stream_options");
    body = setBoolIfDifferent(body, "stream", false);
    return normalizeCodexInstructions(body, isNativeCodexRequest(req.payload, from, responseFormat, opts.headers));
  }

  /**
   * Refreshes ChatGPT OAuth credentials through the Codex token endpoint; API-key
   * credentials (and OAuth records without a refresh token) are returned unchanged
   * (Go: Refresh, non-SIWC branch without the Home / file-lock plumbing).
   */
  async refresh(auth: Auth): Promise<Auth> {
    log.debug("codex executor: refresh called");
    if (codexAuthUsesAPIKey(auth)) return auth;
    return new CodexAuthenticator().refresh(auth, { fetch: this.options.fetch, now: this.options.now });
  }
}

/** Builds the "codex" provider executor. */
export function createCodexExecutor(options: CodexExecutorOptions = {}): CodexExecutor {
  return new CodexExecutor(options);
}

/** What a bootstrap hands to the stream: chunks to replay first, then an in-stream error or the end. */
interface CodexBootstrap {
  chunks: string[];
  /** The first released frame was a terminal success event: nothing more to read. */
  terminal: boolean;
  /** A non-overload terminal failure seen while buffering, delivered after the chunks. */
  error?: StatusError;
}

interface CodexLineOutcome {
  chunks: string[];
  /** response.completed / incomplete / done: the stream is finished. */
  terminal: boolean;
  /** The frame may be held back during a bootstrap (Go: isHandshake). */
  handshake: boolean;
  /** A terminal failure; `overload` marks the ones a bootstrap fails over on. */
  failure?: { error: StatusError; body: string; overload: boolean };
}

/** Per-stream translation state shared by the bootstrap and the streaming phase. */
class CodexStreamProcessor {
  private readonly state: TranslatorState = {};
  private readonly ctx: TranslateContext;
  private readonly items = newCollectedOutputItems();
  private sawOutputDelta = false;

  constructor(
    private readonly executor: CodexExecutor,
    private readonly req: ExecRequest,
    opts: ExecOptions,
    private readonly prepared: PreparedRequest,
  ) {
    this.ctx = { signal: opts.signal };
  }

  /** Classifies and translates one delivered line (Go: one iteration of the scan loop). */
  processLine(line: string): CodexLineOutcome {
    let translatedLine = line;
    let terminal = false;
    let handshake = false;
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      const root = tryParse<unknown>(data);
      translatedLine = "data: " + data;
      const eventType = codexEventType(root, data);
      const failure = this.executor.terminalFailure(data);
      if (failure) {
        clearCodexReasoningReplayOnInvalidSignature(this.executor.reasoningReplayCache, this.prepared.replayScope, failure.error.statusCode, failure.body);
        return { chunks: [], terminal: false, handshake: false, failure: { error: failure.error, body: failure.body, overload: isCodexOverloadBootstrapFailure(failure.body) } };
      }
      if (hasMeaningfulCodexOutputDelta(root)) this.sawOutputDelta = true;
      if (isCodexTerminalEmptyIncomplete(root, collectedOutputItemCount(this.items), this.sawOutputDelta)) {
        // Not an overload rejection: in-stream delivery even while buffering.
        return { chunks: [], terminal: false, handshake: false, failure: { error: newCodexEmptyIncompleteStreamError(), body: "", overload: false } };
      }
      handshake = isCodexBootstrapBufferableEvent(eventType, data);
      switch (eventType) {
        case "response.output_item.done":
          collectCodexOutputItemDone(root, this.items);
          break;
        case "response.completed":
        case "response.incomplete":
        case "response.done": {
          terminal = true;
          const completed = this.prepared.preserveNativeOutput ? normalizedCompletion(data, root) : patchedEventData(data, root, this.items, true);
          if (eventType !== "response.incomplete") cacheCodexReasoningReplayFromCompleted(this.executor.reasoningReplayCache, this.prepared.replayScope, completed);
          translatedLine = "data: " + completed;
          break;
        }
      }
    } else {
      // Comments, event:, id:, retry: and blank lines carry no event; they are held with their frame.
      handshake = true;
    }
    let chunks = defaultRegistry.translateStream(this.ctx, FormatCodex, this.prepared.responseFormat, this.req.model, this.prepared.originalPayload, this.prepared.body, translatedLine, this.state);
    // Go: TranslateStreamWithClaudeInputTokens completes Responses usage details on every chunk.
    if (this.prepared.responseFormat === FormatOpenAIResponse && !applyPatchTranslationError(this.state)) chunks = chunks.map(ensureResponsesUsageDetails);
    return { chunks, terminal, handshake };
  }
}

/**
 * Pulls scanner items from the upstream body one physical line at a time, so
 * the bootstrap budget checker sees the caller's state for every earlier line
 * (Go: CodexSSEScanner.Scan over the response body).
 */
class CodexLineSource {
  readonly scanner = new CodexSSEScanner({ onDiagnostic: logSSEDiagnostic });
  /** A transport error that ended the body (Go: scanner.Err()). */
  readError: unknown;
  private reader?: ReturnType<typeof defaultReader>;
  private lines: string[] = [];
  private lineIndex = 0;
  private items: CodexSSEItem[] = [];
  private itemIndex = 0;
  private finishPending = false;
  private ended = false;
  private drained = false;
  private closed = false;
  private readonly onAbort = () => {
    this.reader?.cancel().catch(() => {});
  };

  constructor(
    private readonly body: ReadableStream<Uint8Array> | null,
    private readonly signal?: AbortSignal,
  ) {}

  async next(): Promise<CodexSSEItem | undefined> {
    for (;;) {
      if (this.itemIndex < this.items.length) return this.items[this.itemIndex++];
      if (this.lineIndex < this.lines.length) {
        this.items = this.scanner.scanLineItems(this.lines[this.lineIndex++]!);
        this.itemIndex = 0;
        continue;
      }
      if (this.finishPending) {
        this.finishPending = false;
        this.ended = true;
        this.items = this.scanner.finishItems();
        this.itemIndex = 0;
        continue;
      }
      if (this.ended || this.closed) return undefined;
      await this.fill();
    }
  }

  private async fill(): Promise<void> {
    if (!this.body) {
      this.ended = true;
      this.drained = true;
      return;
    }
    let reader = this.reader;
    if (!reader) {
      reader = this.reader = defaultReader(this.body);
      this.signal?.addEventListener("abort", this.onAbort, { once: true });
      if (this.signal?.aborted) this.onAbort();
    }
    let result: Awaited<ReturnType<typeof reader.read>>;
    try {
      result = await reader.read();
    } catch (err) {
      this.readError = err;
      this.ended = true;
      return;
    }
    if (result.done) {
      this.drained = true;
      this.lines = this.scanner.endLines();
      this.finishPending = true;
    } else {
      this.lines = this.scanner.splitLines(result.value);
    }
    this.lineIndex = 0;
  }

  /** Releases the body: cancelled unless it was read to the end. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    if (!this.reader) {
      if (this.body && !this.body.locked) this.body.cancel().catch(() => {});
      return;
    }
    if (!this.drained) this.reader.cancel().catch(() => {});
    try {
      this.reader.releaseLock();
    } catch {
      // already released
    }
  }
}

function defaultReader(body: ReadableStream<Uint8Array>) {
  return body.getReader();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Reads a body to the end, keeping what arrived before a transport error (Go: io.ReadAll's partial data). */
async function readBodyText(resp: Response): Promise<{ text: string; readError?: unknown }> {
  const body = resp.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text };
  } catch (err) {
    return { text, readError: err };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

/**
 * The event type. Go read it with gjson, which also finds the leading "type" of
 * an event whose JSON is invalid further on; the regex fallback keeps that.
 */
function codexEventType(root: unknown, data: string): string {
  if (root !== undefined) return gstr(getAt(root, "type"));
  const match = /^\s*\{\s*"type"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(data);
  return match ? match[1]! : "";
}

/** response.done (websocket spelling) becomes response.completed (Go: normalizeCodexWebsocketCompletion). */
function normalizedCompletion(data: string, root: unknown): string {
  if (gstr(getAt(root, "type")).trim() !== "response.done" || !isObj(root)) return data;
  root.type = "response.completed";
  return JSON.stringify(root);
}

/**
 * The completion event with its output rebuilt from response.output_item.done
 * items (Go: patchCodexCompletedOutput); the original bytes when nothing changed.
 */
function patchedEventData(data: string, root: unknown, items: CollectedOutputItems, normalizeDone: boolean): string {
  if (!isObj(root)) return data;
  const before = JSON.stringify(root);
  if (normalizeDone && gstr(root.type).trim() === "response.done") root.type = "response.completed";
  patchCodexCompletedOutput(root, items);
  const after = JSON.stringify(root);
  return after === before ? data : after;
}

function logSSEDiagnostic(diag: unknown): void {
  log.warn("codex executor: SSE event data is not valid JSON", diag);
}

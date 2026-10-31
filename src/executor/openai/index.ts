// OpenAI API-key executor (provider key "openai"). Port of the chat completions
// path of internal/runtime/executor/openai_compat_executor.go plus the helpers
// it uses from internal/runtime/executor/helps (ApplyRequestThinking /
// translatedRequestSummaryConfig, TranslateRequestPairWithAPIKeyModelCompatibility
// for the Claude -> OpenAI pair, APIKeyModelIsCompat).
//
// Claude Messages requests are translated to OpenAI chat completions and sent
// to `<base_url>/chat/completions` with a Bearer API key; responses and SSE
// streams are translated back to the response format (Claude).
//
// OpenAI Responses requests (source format "openai-response" from /v1/responses)
// go through the Responses -> chat completions translator; at the end of the
// stream the translator state may synthesize the missing [DONE]
// (CanFinalizeResponseStream) or reject an unfinished apply_patch call, and
// every Responses chunk gets complete usage details (EnsureResponsesUsageDetails).
//
// Image requests (source format "openai-image" from /v1/images/*) are passed
// through to `<base_url>/images/generations` or `/images/edits` (images.ts).
//
// Not ported (upstream features outside this slice): video endpoints,
// /responses/compact, prompt_cache_key, payload-config rules, apply_patch
// stream repair, usage reporting/TTFT metrics, Home credential options and
// the plugin request normalizers.
import type { Config, ModelOverride } from "../../config/types.ts";
import { modelOverridesFor } from "../../config/auths.ts";
import { type Auth, AttributeAPIKey, AttributeBaseURL } from "../../auth/types.ts";
import { FormatClaude, FormatOpenAI, FormatOpenAIResponse, type Format, type TranslateContext, type TranslatorState } from "../../translator/types.ts";
import { hasRequestTransformer, translateNonStream, translateRequest, translateTokenCount } from "../../translator/registry.ts";
import "../../translator/openai/openai/responses/index.ts";
import { applyPatchTranslationError, applyPatchUpstreamError, canFinalizeResponseStream, ensureResponsesUsageDetails, finalizeApplyPatchStream, initializeApplyPatchStream } from "../responses.ts";
import {
  SummaryUnspecified,
  type SummaryConfig,
  applySummaryConfigForModel,
  applyThinkingWithFallbackModelInfoAndSummary,
  applyThinkingWithModelInfoAndSummary,
  extractExplicitSummaryConfig,
  extractSummaryConfig,
  extractTranslatedSummaryConfig,
  parseSuffix,
} from "../../thinking/index.ts";
import { lookupModelInfo, type ModelInfo } from "../../registry/index.ts";
import { applyCustomHeadersFromAttrs } from "../../util/header_helpers.ts";
import { SSEParser, type SSEEvent } from "../../util/sse.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";
import { applyFetchProxy } from "../proxy.ts";
import { translateRequestPairWithAPIKeyModelCompatibility, translateRequestWithAPIKeyModelCompatibility } from "../request_pair.ts";
import { type ResponseModelReporter, newResponseModelReporter, publishResponseModelAfter } from "../response_model.ts";
import {
  type ExecOptions,
  type ExecRequest,
  type ExecResponse,
  type ProviderExecutor,
  type StreamResult,
  StatusError,
  responseFormatOrSource,
} from "../types.ts";
import {
  type OpenAICompatModelOption,
  modelOptionsFromOverrides,
  normalizeOpenAIMaxTokens,
  normalizeOpenAIToolResultsTextOnly,
  parseOpenAIUsage,
  payloadRequestedModel,
  setBoolIfDifferent,
  setStringIfDifferent,
  shouldNormalizeOpenAIToolResultsForModel,
  shouldUseMaxCompletionTokensForModel,
} from "./helpers.ts";
import { newOpenAICompatStatusError, openAICompatChunkHasFinishReason, openAICompatErrorEvent, openAICompatStreamDataError } from "./errors.ts";
import { ClaudeInputTokenState, estimateTokensByChars, newClaudeInputTokenState, translateStreamWithClaudeInputTokens } from "./claude_input_tokens.ts";
import { type OpenAIImagesContext, executeOpenAICompatImages, executeOpenAICompatImagesStream, openAICompatImageEndpointPath } from "./images.ts";

export * from "./helpers.ts";
export * from "./errors.ts";
export * from "./claude_input_tokens.ts";

export const openAICompatDefaultUserAgent = "cli-proxy-openai-compat";
/** Metadata key under which a caller may bind the resolved API-key model definition (Go: cliproxy.resolved_api_key_model_info). */
export const ResolvedAPIKeyModelInfoMetadataKey = "cliproxy.resolved_api_key_model_info";

/** Injectable fetch for tests; defaults to the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatExecutorOptions {
  /** Provider key the executor answers for (default "openai"). */
  provider?: string;
  /**
   * Resolves the per-model compat options of a credential. Defaults to the
   * credential's config model overrides (modelOverridesFor) when a config is given.
   */
  modelOptionsFor?: (auth: Auth, req: ExecRequest) => OpenAICompatModelOption[] | undefined;
  fetch?: FetchLike;
  /** Clock used for Retry-After HTTP dates (epoch ms). */
  now?: () => number;
}

/** Credential material of an API-key auth (Go: resolveCredentials). */
export function resolveCredentials(auth: Auth | undefined): { baseURL: string; apiKey: string } {
  if (!auth || !auth.attributes) return { baseURL: "", apiKey: "" };
  return {
    baseURL: (auth.attributes[AttributeBaseURL] ?? "").trim(),
    apiKey: (auth.attributes[AttributeAPIKey] ?? "").trim(),
  };
}

/**
 * Sets `key` on target from the client's headers when non-empty, otherwise keeps
 * an existing value, otherwise the default (Go: misc.EnsureHeader).
 */
function ensureHeader(target: Headers, source: Headers | undefined, key: string, defaultValue: string): void {
  const incoming = (source?.get(key) ?? "").trim();
  if (incoming !== "") {
    target.set(key, incoming);
    return;
  }
  if ((target.get(key) ?? "").trim() !== "") return;
  target.set(key, defaultValue);
}

/** Go: ensureOpenAICompatUserAgent. */
export function ensureOpenAICompatUserAgent(target: Headers, clientHeaders?: Headers): void {
  ensureHeader(target, clientHeaders, "User-Agent", openAICompatDefaultUserAgent);
}

/**
 * Reports whether the selected API-key model enables compatibility handling
 * for Claude thinking blocks (Go: APIKeyModelIsCompat). Without a bound model
 * definition it falls back to the credential's model options and the registry.
 */
export function apiKeyModelIsCompat(req: ExecRequest, options: ReadonlyArray<OpenAICompatModelOption> | undefined, baseModel: string, requestedModel: string, provider: string): boolean {
  const bound = resolvedModelInfo(req);
  if (bound !== undefined) return bound.isCompat === true;
  const match = matchModelOption(options, baseModel, requestedModel);
  if (match) return match.isCompat === true;
  return lookupModelInfo(baseModel, provider)?.isCompat === true;
}

function resolvedModelInfo(req: ExecRequest): ModelInfo | undefined {
  const raw = req.metadata?.[ResolvedAPIKeyModelInfoMetadataKey];
  return isObj(raw) ? (raw as unknown as ModelInfo) : undefined;
}

function matchModelOption(options: ReadonlyArray<OpenAICompatModelOption> | undefined, baseModel: string, requestedModel: string): OpenAICompatModelOption | undefined {
  if (!options) return undefined;
  const upstream = parseSuffix(baseModel.trim()).modelName.trim().toLowerCase();
  const requested = parseSuffix(requestedModel.trim()).modelName.trim().toLowerCase();
  for (const option of options) {
    if (upstream !== "" && option.name.trim().toLowerCase() === upstream) return option;
  }
  for (const option of options) {
    const alias = (option.alias ?? "").trim().toLowerCase();
    if (alias !== "" && (alias === upstream || alias === requested)) return option;
  }
  return undefined;
}

/**
 * Gives the translated target payload precedence for the summary intent, then
 * the current and original source payloads (Go: translatedRequestSummaryConfig).
 */
export function translatedRequestSummaryConfig(body: string, currentSourcePayload: string, originalSourcePayload: string, model: string, fromFormat: string, toFormat: string): SummaryConfig {
  fromFormat = fromFormat.trim().toLowerCase();
  toFormat = toFormat.trim().toLowerCase();
  const targetSummary = fromFormat === toFormat ? extractSummaryConfig(body, toFormat) : extractExplicitSummaryConfig(body, toFormat);
  if (targetSummary.mode !== SummaryUnspecified) return targetSummary;

  const currentSummary = extractTranslatedSummaryConfig(currentSourcePayload, fromFormat, toFormat);
  const originalSummary = extractTranslatedSummaryConfig(originalSourcePayload, fromFormat, toFormat);
  if (currentSummary.mode === SummaryUnspecified) return originalSummary;

  if (!hasRequestTransformer(fromFormat, toFormat)) return { mode: SummaryUnspecified };

  const candidate = applySummaryConfigForModel(body, toFormat, model, currentSummary);
  if (extractExplicitSummaryConfig(candidate, toFormat).mode !== SummaryUnspecified) return { mode: SummaryUnspecified };
  return currentSummary;
}

/** Go: helps.ApplyRequestThinking (registry lookup unless a model definition is bound to the request). */
export function applyRequestThinking(body: string, req: ExecRequest, opts: ExecOptions, fromFormat: string, toFormat: string, provider: string): string {
  const originalSource = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
  const source = req.payload.length > 0 ? req.payload : (opts.originalRequest ?? "");
  const summaryConfig = translatedRequestSummaryConfig(body, req.payload, originalSource, req.model, fromFormat, toFormat);
  const bound = resolvedModelInfo(req);
  if (bound !== undefined) return applyThinkingWithModelInfoAndSummary(body, source, req.model, fromFormat, toFormat, provider, bound, summaryConfig);
  return applyThinkingWithFallbackModelInfoAndSummary(body, source, req.model, fromFormat, toFormat, provider, undefined, summaryConfig);
}

/** Converts a request-scoped translator/thinking refusal into a StatusError the manager will not fail over. */
function asRequestError(err: unknown): unknown {
  if (err instanceof StatusError) return err;
  if (err && typeof err === "object" && (err as { requestScoped?: unknown }).requestScoped === true) {
    const status = typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 400;
    return new StatusError(status, err instanceof Error ? err.message : String(err), { requestScoped: true, cause: err });
  }
  return err;
}

interface PreparedRequest {
  url: string;
  headers: Headers;
  body: string;
  originalPayload: string;
  from: Format;
  responseFormat: Format;
}

/** Stateless executor for OpenAI-compatible chat completions providers (Go: OpenAICompatExecutor). */
export class OpenAICompatExecutor implements ProviderExecutor {
  readonly identifier: string;
  private readonly cfg: Config | undefined;
  private readonly options: OpenAICompatExecutorOptions;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(cfg?: Config, options: OpenAICompatExecutorOptions = {}) {
    this.cfg = cfg;
    this.options = options;
    this.identifier = options.provider ?? "openai";
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** Per-model compat options for the credential (Go: resolveCompatConfig, reduced to the config-index path). */
  resolveCompatConfig(auth: Auth, req: ExecRequest): OpenAICompatModelOption[] | undefined {
    if (this.options.modelOptionsFor) return this.options.modelOptionsFor(auth, req);
    if (!this.cfg) return undefined;
    const overrides: ModelOverride[] = modelOverridesFor(this.cfg, auth);
    return overrides.length > 0 ? modelOptionsFromOverrides(overrides) : undefined;
  }

  private prepare(auth: Auth, req: ExecRequest, opts: ExecOptions, stream: boolean): PreparedRequest {
    const { baseURL, apiKey } = resolveCredentials(auth);
    const compat = this.resolveCompatConfig(auth, req);
    const baseModel = parseSuffix(req.model).modelName;
    if (baseURL === "") throw new StatusError(401, "missing provider baseURL");

    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const to = FormatOpenAI;
    const originalPayload = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
    const requestedModel = payloadRequestedModel(opts, req.model);
    const isCompat = apiKeyModelIsCompat(req, compat, baseModel, requestedModel, this.identifier);

    let translated: string;
    try {
      const pair = translateRequestPairWithAPIKeyModelCompatibility(from, to, baseModel, originalPayload, req.payload, stream, isCompat);
      translated = setStringIfDifferent(pair.working, "model", baseModel);
      translated = applyRequestThinking(translated, req, opts, from, to, this.identifier);
    } catch (err) {
      throw asRequestError(err);
    }

    if (shouldNormalizeOpenAIToolResultsForModel(compat, baseModel, requestedModel)) translated = normalizeOpenAIToolResultsTextOnly(translated);
    const useMCT = shouldUseMaxCompletionTokensForModel(compat, baseModel, requestedModel);
    translated = normalizeOpenAIMaxTokens(translated, useMCT);
    if (stream) {
      // Request usage data in the final streaming chunk so token statistics are
      // captured even when the upstream is an OpenAI-compatible provider.
      translated = setBoolIfDifferent(translated, "stream_options.include_usage", true);
    }

    const url = baseURL.replace(/\/+$/, "") + "/chat/completions";
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    if (apiKey !== "") headers.set("Authorization", "Bearer " + apiKey);
    ensureOpenAICompatUserAgent(headers, opts.headers);
    applyCustomHeadersFromAttrs(headers, auth.attributes, { clientHeaders: opts.headers });
    if (stream) {
      headers.set("Accept", "text/event-stream");
      headers.set("Cache-Control", "no-cache");
    }
    return { url, headers, body: translated, originalPayload, from, responseFormat };
  }

  private async send(auth: Auth, prepared: PreparedRequest, opts: ExecOptions): Promise<Response> {
    const init: RequestInit & { proxy?: string } = { method: "POST", headers: prepared.headers, body: prepared.body, signal: opts.signal };
    applyFetchProxy(init, opts.proxyUrl, auth.proxyUrl, this.cfg?.requests.proxyUrl);
    return this.fetchFn(prepared.url, init);
  }

  /** What the image endpoints borrow from this executor (images.ts). */
  private imagesContext(): OpenAIImagesContext {
    return { identifier: this.identifier, fetch: this.fetchFn, now: this.now, proxyUrl: this.cfg?.requests.proxyUrl, credentials: resolveCredentials, ensureUserAgent: ensureOpenAICompatUserAgent };
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const imagesPath = openAICompatImageEndpointPath(opts);
    if (imagesPath !== "") return executeOpenAICompatImages(this.imagesContext(), auth, req, opts, imagesPath);
    const prepared = this.prepare(auth, req, opts, false);
    const resp = await this.send(auth, prepared, opts);
    const body = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
      log.debug("openai compat executor: request error", { status: resp.status });
      throw newOpenAICompatStatusError(resp.status, resp.headers, body, this.now());
    }
    const reporter = newResponseModelReporter(this.identifier, req.model, auth);
    reporter.observeResponseModel(body);
    reporter.publish();
    const state: TranslatorState = {};
    const ctx: TranslateContext = { signal: opts.signal };
    let out = translateNonStream(ctx, FormatOpenAI, prepared.responseFormat, req.model, prepared.originalPayload, prepared.body, body, state);
    if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
    if (out.length === 0) throw new StatusError(502, "upstream returned an unusable response", { body: "" });
    if (prepared.responseFormat === FormatOpenAIResponse) out = ensureResponsesUsageDetails(out);
    const usage = parseOpenAIUsage(body);
    return { payload: out, headers: resp.headers, metadata: usage.present ? { usage } : undefined };
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    const imagesPath = openAICompatImageEndpointPath(opts);
    if (imagesPath !== "") return executeOpenAICompatImagesStream(this.imagesContext(), auth, req, opts, imagesPath);
    const prepared = this.prepare(auth, req, opts, true);
    const resp = await this.send(auth, prepared, opts);
    if (resp.status < 200 || resp.status >= 300) {
      const body = await resp.text();
      log.debug("openai compat executor: request error", { status: resp.status });
      throw newOpenAICompatStatusError(resp.status, resp.headers, body, this.now());
    }
    const inputTokens = newClaudeInputTokenState(prepared.from, FormatOpenAI, prepared.responseFormat, prepared.originalPayload);
    const reporter = newResponseModelReporter(this.identifier, req.model, auth);
    return { headers: resp.headers, chunks: publishResponseModelAfter(this.streamChunks(resp, req, opts, prepared, inputTokens, reporter), reporter) };
  }

  /** Reads the upstream SSE body frame by frame and yields translated downstream frames. */
  private async *streamChunks(resp: Response, req: ExecRequest, opts: ExecOptions, prepared: PreparedRequest, inputTokens: ClaudeInputTokenState, reporter?: ResponseModelReporter): AsyncGenerator<string> {
    const state: TranslatorState = {};
    const ctx: TranslateContext = { signal: opts.signal };
    const responseFormat = prepared.responseFormat;
    const translate = (line: string): string[] => {
      const chunks = translateStreamWithClaudeInputTokens(ctx, FormatOpenAI, responseFormat, req.model, prepared.originalPayload, prepared.body, line, state, inputTokens);
      // Go: TranslateStreamWithClaudeInputTokens completes Responses usage details on every chunk.
      if (responseFormat !== FormatOpenAIResponse || applyPatchTranslationError(state)) return chunks;
      return chunks.map(ensureResponsesUsageDetails);
    };
    // Responses output: prepare the apply_patch state even for an empty EOF (Go: InitializeApplyPatchStream).
    initializeApplyPatchStream(ctx, FormatOpenAI, responseFormat, req.model, prepared.originalPayload, prepared.body, state);

    let seenDone = false;
    let sawFinishReason = false;
    // Non-empty downstream chunks yielded so far. A stream that reaches its
    // terminal marker without any is a failed attempt (502) so the auth manager
    // can fail over instead of handing the client a stream with no message_start.
    let emitted = 0;
    const noOutputError = (): StatusError => new StatusError(502, "upstream stream ended without output");

    // Returns the translated frames of one upstream event, or throws the stream error.
    const processFrame = (ev: SSEEvent): { chunks: string[]; done: boolean } => {
      const eventName = ev.event;
      const dataLines = ev.data === "" && !/^\s*data:/m.test(ev.raw) ? [] : ev.data.split("\n");
      if (dataLines.length === 0) {
        if (openAICompatErrorEvent(eventName)) throw new StatusError(502, "upstream error event ended without data");
        return { chunks: [], done: false };
      }
      if (dataLines.length > 1 && dataLines.some((l) => l.trim() === "[DONE]")) {
        throw new StatusError(502, "upstream stream ended with incomplete data before [DONE]");
      }
      const dataPayload = dataLines.map((l) => l.trim()).join("\n").trim();
      const isDone = dataPayload === "[DONE]";
      if (isDone && openAICompatErrorEvent(eventName)) throw new StatusError(502, "upstream error event ended before [DONE]");
      if (isDone && emitted === 0) throw noOutputError();
      if (!isDone && tryParse(dataPayload) === undefined) throw new StatusError(502, "upstream stream ended with incomplete SSE data frame");
      if (!isDone) {
        const streamErr = openAICompatStreamDataError(dataPayload, eventName);
        if (streamErr) throw streamErr;
        reporter?.observeResponseModel(dataPayload);
        if (!sawFinishReason && openAICompatChunkHasFinishReason(dataPayload)) sawFinishReason = true;
      }
      const chunks = translate("data: " + dataPayload);
      if (isDone) seenDone = true;
      return { chunks, done: isDone };
    };

    const body = resp.body;
    if (!body) throw new StatusError(502, "upstream stream closed before [DONE]");
    const reader = body.getReader();
    const parser = new SSEParser();
    const decoder = new TextDecoder();
    let lineBuffer = "";
    // Feeds complete lines to the SSE parser. A bare JSON line outside the SSE
    // framing is an error body on a 2xx stream (Go: the "{" / "[" line check).
    const feedLines = (text: string, final: boolean): SSEEvent[] => {
      lineBuffer += text;
      const events: SSEEvent[] = [];
      const consume = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) throw new StatusError(502, trimmed, { body: trimmed });
        events.push(...parser.push(line));
      };
      for (;;) {
        const idx = lineBuffer.indexOf("\n");
        if (idx < 0) break;
        const line = lineBuffer.slice(0, idx + 1);
        lineBuffer = lineBuffer.slice(idx + 1);
        consume(line);
      }
      if (final && lineBuffer !== "") {
        const rest = lineBuffer;
        lineBuffer = "";
        consume(rest);
      }
      return events;
    };
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let readError: unknown;
    try {
      let finished = false;
      while (!finished) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (err) {
          readError = err;
          break;
        }
        if (result.done) break;
        for (const ev of feedLines(decoder.decode(result.value, { stream: true }), false)) {
          const out = processFrame(ev);
          for (const chunk of out.chunks) {
            if (chunk === "") continue;
            emitted++;
            yield chunk;
          }
          if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
          if (out.done) {
            finished = true;
            break;
          }
        }
      }
      if (!finished && readError === undefined && !seenDone) {
        for (const ev of [...feedLines(decoder.decode(), true), ...parser.flush()]) {
          const out = processFrame(ev);
          for (const chunk of out.chunks) {
            if (chunk === "") continue;
            emitted++;
            yield chunk;
          }
          if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
          if (out.done) break;
        }
      }
      // EndApplyPatchStream: an apply_patch-enabled Responses stream must not end without its terminator.
      if (!opts.signal?.aborted) {
        for (const chunk of finalizeApplyPatchStream(state)) {
          if (chunk !== "") yield chunk;
        }
        if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
      }
      if (seenDone) return;
      if (opts.signal?.aborted) return;
      // A Responses stream whose output is complete may synthesize the missing [DONE] (Go: CanFinalizeResponseStream).
      if (readError === undefined && responseFormat === FormatOpenAIResponse && canFinalizeResponseStream(state)) {
        const finalChunks = translate("data: [DONE]");
        for (const chunk of finalChunks) {
          if (chunk !== "") yield chunk;
        }
        if (finalChunks.length > 0) return;
      }
      if (readError !== undefined) {
        const message = readError instanceof Error ? readError.message : String(readError);
        throw new StatusError(502, "upstream stream read error: " + message, { cause: readError });
      }
      // Without a translator-confirmed terminal state, a clean Responses or Claude
      // EOF without [DONE] remains a failed stream instead of completing it.
      if (responseFormat === FormatOpenAIResponse || (responseFormat === FormatClaude && !sawFinishReason)) throw new StatusError(502, "upstream stream closed before [DONE]");
      if (emitted === 0) throw noOutputError();
      // Providers that omit [DONE] after the finish_reason: flush the terminal frames.
      for (const chunk of translate("data: [DONE]")) {
        if (chunk !== "") yield chunk;
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  /**
   * Token counting (Go: CountTokens). Upstream has no OpenAI count endpoint and
   * counted the translated chat payload locally with tiktoken; this port uses the
   * same ceil(chars / 4) estimate as the Claude input token state.
   */
  async countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const baseModel = parseSuffix(req.model).modelName;
    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const compat = this.resolveCompatConfig(auth, req);
    const requestedModel = payloadRequestedModel(opts, req.model);
    const isCompat = apiKeyModelIsCompat(req, compat, baseModel, requestedModel, this.identifier);
    let translated: string;
    try {
      translated = translateRequestWithAPIKeyModelCompatibility(from, FormatOpenAI, baseModel, req.payload, false, isCompat);
      translated = applyRequestThinking(translated, req, opts, from, FormatOpenAI, this.identifier);
    } catch (err) {
      throw asRequestError(err);
    }
    const count = countOpenAIChatTokens(translated);
    const usageJSON = buildOpenAIUsageJSON(count);
    return { payload: translateTokenCount({ signal: opts.signal }, FormatOpenAI, responseFormat, count, usageJSON) };
  }

  /** Refresh is a no-op for API-key credentials; OAuth-style credentials cannot be rotated here (Go: Refresh). */
  async refresh(auth: Auth): Promise<Auth> {
    log.debug("openai compat executor: refresh called");
    if (openAICompatAuthHasRefreshToken(auth)) {
      throw new Error(`openai compat executor cannot refresh oauth credentials for provider ${this.identifier}`);
    }
    return auth;
  }
}

function openAICompatAuthHasRefreshToken(auth: Auth | undefined): boolean {
  const metadata = auth?.metadata;
  if (!metadata) return false;
  for (const key of ["refresh_token", "refreshToken"]) {
    const token = metadata[key];
    if (typeof token === "string" && token.trim() !== "") return true;
  }
  return false;
}

/** Go: helps.BuildOpenAIUsageJSON. */
export function buildOpenAIUsageJSON(count: number): string {
  return JSON.stringify({ prompt_tokens: count, completion_tokens: 0, total_tokens: count });
}

/**
 * Estimates the prompt tokens of an OpenAI chat payload: message roles and
 * text content, tool call names/arguments and tool declarations
 * (Go: helps.CountOpenAIChatTokens, with ceil(chars / 4) instead of tiktoken).
 */
export function countOpenAIChatTokens(payload: string): number {
  const root = tryParse<unknown>(payload);
  const segments: string[] = [];
  const push = (v: unknown): void => {
    const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v) ?? "";
    if (s.trim() !== "") segments.push(s.trim());
  };
  const messages = getAt(root, "messages");
  if (isArr(messages)) {
    for (const message of messages) {
      push(gstr(getAt(message, "role")));
      push(gstr(getAt(message, "name")));
      const content = getAt(message, "content");
      if (typeof content === "string") push(content);
      else if (isArr(content)) {
        for (const part of content) {
          if (typeof part === "string") push(part);
          else if (isObj(part) && typeof part.text === "string") push(part.text);
        }
      }
      push(gstr(getAt(message, "reasoning_content")));
      const toolCalls = getAt(message, "tool_calls");
      if (isArr(toolCalls)) {
        for (const call of toolCalls) {
          push(gstr(getAt(call, "id")));
          push(gstr(getAt(call, "function.name")));
          push(getAt(call, "function.arguments"));
        }
      }
      push(gstr(getAt(message, "tool_call_id")));
    }
  }
  const tools = getAt(root, "tools");
  if (isArr(tools)) {
    for (const tool of tools) {
      push(gstr(getAt(tool, "function.name")));
      push(gstr(getAt(tool, "function.description")));
      push(getAt(tool, "function.parameters"));
    }
  }
  if (segments.length === 0) return 0;
  return estimateTokensByChars(segments.join("\n"));
}

/** Builds the "openai" provider executor from the loaded config. */
export function createOpenAIExecutor(cfg?: Config, options: OpenAICompatExecutorOptions = {}): OpenAICompatExecutor {
  return new OpenAICompatExecutor(cfg, options);
}

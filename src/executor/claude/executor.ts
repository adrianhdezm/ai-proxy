// The Claude upstream executor (provider key "claude"). Port of
// internal/runtime/executor/claude_executor.go, claude_executor_execute.go,
// claude_executor_stream.go, claude_executor_tokens.go and the refresh part of
// claude_executor_auth.go, reduced to the kept request pipeline:
//
//   parseSuffix -> translate (identity for Claude inbound) -> model -> tool_choice
//   [thinking replay restore] -> parseSuffix -> translate (identity for Claude
//   inbound) -> model -> tool_choice -> thinking -> [rebuild mid-system] ->
//   cloaking (billing header, currentDate, continuity) -> context_management /
//   diagnostics (cloaked + api.anthropic.com) -> max_tokens -> forced tool
//   choice -> context_management reconcile -> sampling -> cache_control
//   (ensure/limit/ttl) -> stream flag -> signature sanitising -> CLI identity ->
//   CCH placeholder -> betas lifted from body -> CCH signing (last mutation) ->
//   mid-system validation -> headers -> POST -> continuity commit / replay cache
//
// Responses inbound (sourceFormat "openai-response"): the native tool search
// fallback (applyNativeToolSearchFallback, upstream.claude.tool-search pinned
// per request), the web search result cache (client.codex.web-search-result-cache),
// apply_patch stream finalisation and EnsureResponsesUsageDetails.
//
// Cloaked OAuth / claude-code-cli requests present client tools as Claude Code
// MCP aliases (tool_alias.ts) and restore the names in responses. Fast-mode
// requests to api.anthropic.com fail request-scoped (fast_error.ts).
//
// Skipped from upstream (see the slice report): compaction,
// usage reporting plugins, payload config rules, preserved-thinking block
// binding, local token estimation and the OAuth profile prefetch.
import { ClaudeAuthenticator } from "../../auth/claude/authenticator.ts";
import { type Auth, isAPIKeyAuth } from "../../auth/types.ts";
import { log } from "../../log.ts";
import { parseSuffix } from "../../thinking/suffix.ts";
import { translateNonStream, translateRequest, translateStream, translateTokenCount } from "../../translator/registry.ts";
import { FormatClaude, FormatOpenAIResponse, type TranslateContext, type TranslatorState } from "../../translator/types.ts";
import { clientToolSearchEnabled, convertOpenAIResponsesRequestToClaudeWithToolSearch, withClientToolSearch } from "../../translator/claude/openai/responses/index.ts";
import { responsesHasToolSearch, stripResponsesToolSearch } from "../../util/responses_tool_search.ts";
import { ClaudeWebSearchResultCache, defaultClaudeWebSearchResultCache } from "../../cache/claude_web_search_result_cache.ts";
import {
  applyPatchOriginalRequest,
  applyPatchTranslationError,
  applyPatchUpstreamError,
  ensureResponsesUsageDetails,
  finalizeApplyPatchStream,
  initializeApplyPatchStream,
} from "../responses.ts";
import {
  type ClaudeWebSearchResultCacheConfig,
  type ClaudeWebSearchResultScope,
  claudeWebSearchResultCacheScope,
  recordClaudeWebSearchResults,
  restoreClaudeWebSearchResults,
} from "./web_search_results.ts";
import { claudeModelLacksToolSearch } from "./tool_search.ts";
import { claudeRequestIsFast, newClaudeFastDirectResponseError, wrapClaudeFastRequestError, wrapClaudeFastStreamErrors } from "./fast_error.ts";
import {
  ClaudeOAuthToolAliasStore,
  type ClaudeToolAliasMap,
  prepareClaudeOAuthToolNamesForRequest,
  rememberClaudeOAuthToolAliases,
  remapOAuthToolNames,
  resolveClaudeMCPAliasSecret,
  reverseRemapOAuthToolNames,
  reverseRemapOAuthToolNamesInSSE,
} from "./tool_alias.ts";
import { stripClaudeCodeAttributionSystem } from "../../util/claude_attribution.ts";
import { getAt, gint, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { iterateSSE } from "../../util/sse.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, StatusError, type StreamResult, responseFormatOrSource } from "../types.ts";
import { applyFetchProxy } from "../proxy.ts";
import { extractAndRemoveBetas, claudeTokenCountingBeta } from "./betas.ts";
import {
  claudeCacheControlTTL1h,
  enforceCacheControlLimit,
  ensureCacheControl,
  isExplicitPromptCacheMode,
  normalizeCacheControlTTL,
  shouldEnsureCacheControl,
  stripClaudeCacheControlTTL,
  stripPromptCacheOptions,
  upgradeClaudeCacheControlTTL,
} from "./cache_control.ts";
import { detectClaudeCodeRequest } from "./client_detection.ts";
import {
  type ClaudeCloakMode,
  applyCloaking,
  isEffectiveConfirmedClaudeCode,
  rebuildMidSystemMessagesToTopLevel,
  resolveClaudeFingerprintPolicy,
  resolveClaudeWirePolicy,
  validateClaudeMidSystemMessageModel,
} from "./cloaking.ts";
import type { ClaudeHeaderDefaults } from "./device_profile.ts";
import { ClaudeContinuityStore, type ClaudeDiagnosticsRequestState, commitClaudeContinuity, defaultClaudeContinuityStore, emptyClaudeDiagnosticsState, injectClaudeDiagnostics, injectClaudeDiagnosticsWithState, newClaudeContinuityContext } from "./diagnostics.ts";
import { type ClaudeRequestContext, claudeCCHFallbackBillingHeader, defaultClaudeSessionDatePinDays } from "./billing.ts";
import { type ClaudeCodeContextManagementState, injectClaudeCodeContextManagement, reconcileClaudeCodeContextManagement } from "./context_management.ts";
import { ClaudeCCHUpstreamKind, claudeBodyNeedsBillingFallback, claudeCCHSigningEnabled, ensureClaudeBillingHeaderCCHPlaceholder, signAnthropicMessagesBody } from "./signing.ts";
import {
  type ClaudeThinkingReplayScope,
  ExecutionSessionMetadataKey,
  apiKeyModelIsCompat,
  cacheClaudeThinkingReplayResponse,
  claudeThinkingReplayEnabled,
  claudeThinkingReplayScopeValid,
  clearClaudeThinkingReplayContent,
  emptyClaudeThinkingReplayScope,
  prepareClaudeThinkingReplayRequest,
  shouldClearThinkingReplayAfterError,
  wrapClaudeThinkingReplayStream,
} from "./thinking_replay.ts";
import { ClaudeThinkingReplayCache, defaultClaudeThinkingReplayCache } from "../../cache/claude_thinking_replay_cache.ts";
import { classifyClaudeUpstreamErrorWithCooling } from "./errors.ts";
import { applyClaudeHeaders } from "./headers.ts";
import { applyClaudeCLIIdentity, claudeAgentSessionUUIDForRequest, validateClaudeMetadataUnique } from "./identity.ts";
import {
  applyRequestThinking,
  disableThinkingIfToolChoiceForced,
  ensureModelMaxTokens,
  normalizeClaudeSamplingForUpstream,
  normalizeClaudeToolChoice,
  sanitizeClaudeMessagesForClaudeUpstreamWithDebug,
  setBoolIfDifferent,
  setStringIfDifferent,
} from "./request.ts";
import { claudeSubagentRequests1h, isClaudeProbeOrHelperRequest, isClaudeSubagentRequest } from "./request_shape.ts";
import {
  type ClaudeStreamState,
  claudeMessageIDFromResponse,
  claudeMessageIDFromSSE,
  claudeResponseContentEncoding,
  decodeResponseBody,
  newClaudeStreamState,
  observeClaudeSSEEvent,
  parseClaudeUsage,
  readAllText,
  restoreClaudeResponseModel,
  validateClaudeStreamingResponse,
} from "./response.ts";
import { DefaultClaudeBaseURL, claudeCreds, headerValueCaseInsensitive, isAnthropicUpstreamBase, isAnthropicUpstreamURL } from "./upstream.ts";
import { defaultClaudeVersion } from "./device_profile.ts";

export type FetchLike = (input: string, init?: RequestInit & { proxy?: string; decompress?: boolean }) => Promise<Response>;

/**
 * Executor configuration. The YAML Config has no claude section yet, so the
 * server wires this subset explicitly; every field is optional.
 */
export interface ClaudeExecutorConfig {
  /** Default cloak mode when the credential sets none: "auto" (OAuth and opted-in credentials), "always", "never". */
  cloakMode?: ClaudeCloakMode;
  /** Keep a unified 5h/7d 429 on the requested model instead of cooling the whole credential (upstream claude.model-level-cooling). */
  modelLevelCooling?: boolean;
  /** Operator overrides for the emitted Claude Code headers (upstream claude-header-defaults). */
  headerDefaults?: ClaudeHeaderDefaults;
  /** Fold caller {"role":"system"} turns into the top-level system field (upstream rebuild_mid_system_message). */
  rebuildMidSystemMessage?: boolean;
  /** Global outbound proxy; overridden by auth.proxyUrl and opts.proxyUrl. */
  proxyUrl?: string;
  /** fetch used for upstream calls (tests). */
  fetch?: FetchLike;
  /** Clock for rate-limit deadlines, the currentDate reminder, continuity and replay TTLs (tests). */
  now?: () => number;
  /**
   * Days a cloaked session keeps its currentDate pin; 0 = continuity-scoped
   * (1h) pin. Default 7 (upstream claude.session-date-pin-days).
   */
  sessionDatePinDays?: number;
  /** Per-session continuity state; defaults to the process-wide store (or a private one when `now` is set). */
  continuityStore?: ClaudeContinuityStore;
  /** Thinking replay cache; defaults to the process-wide cache (or a private one when `now` is set). */
  thinkingReplayCache?: ClaudeThinkingReplayCache;
  /** Optional upstream model rewrite; when set the requested model is written back into responses. */
  upstreamModelNormalizer?: (baseModel: string) => string;
  /**
   * client.codex.web-search-result-cache: store the web_search_tool_result
   * blocks of Responses-inbound responses and restore them into later requests
   * of the same session and credential. Disabled by default, as upstream.
   */
  webSearchResultCache?: ClaudeWebSearchResultCacheConfig;
  /** Web search result store; defaults to the process-wide cache (or a private one when `now` is set). */
  webSearchResultStore?: ClaudeWebSearchResultCache;
  /** Thread-continuation MCP alias store; defaults to one per executor. */
  toolAliasStore?: ClaudeOAuthToolAliasStore;
}

/** What applyNativeToolSearchFallback decided for one request. */
interface ToolSearchDecision {
  req: ExecRequest;
  opts: ExecOptions;
  /** upstream.claude.tool-search pinned for the request and response translations. */
  toolSearch: boolean;
}

const to = FormatClaude;

export class ClaudeExecutor implements ProviderExecutor {
  readonly identifier = "claude";
  private readonly cfg: ClaudeExecutorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  readonly continuity: ClaudeContinuityStore;
  readonly replayCache: ClaudeThinkingReplayCache;
  readonly webSearchResults: ClaudeWebSearchResultCache;
  readonly toolAliases: ClaudeOAuthToolAliasStore;

  constructor(cfg: ClaudeExecutorConfig = {}) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.now = cfg.now ?? (() => Date.now());
    this.continuity = cfg.continuityStore ?? (cfg.now ? new ClaudeContinuityStore(cfg.now) : defaultClaudeContinuityStore);
    this.replayCache = cfg.thinkingReplayCache ?? (cfg.now ? new ClaudeThinkingReplayCache({ now: cfg.now }) : defaultClaudeThinkingReplayCache);
    this.webSearchResults = cfg.webSearchResultStore ?? (cfg.now ? new ClaudeWebSearchResultCache({ now: cfg.now }) : defaultClaudeWebSearchResultCache);
    this.toolAliases = cfg.toolAliasStore ?? new ClaudeOAuthToolAliasStore();
  }

  /**
   * Whether a credential can receive Codex tool_search as Anthropic native
   * tool search for the upstream model: Anthropic's own origin, or a custom
   * base URL with attributes.native_tool_search "true"; never for models that
   * predate tool search, nor while upstream.claude.tool-search is off
   * (Go: SupportsNativeToolSearch).
   */
  supportsNativeToolSearch(auth: Auth | undefined, upstreamModel: string, toolSearch = clientToolSearchEnabled()): boolean {
    if (!toolSearch || claudeModelLacksToolSearch(upstreamModel)) return false;
    const baseURL = claudeCreds(auth).baseURL.trim();
    if (baseURL === "" || isAnthropicUpstreamBase(baseURL)) return true;
    return (auth?.attributes?.native_tool_search ?? "").trim().toLowerCase() === "true";
  }

  /**
   * Pins upstream.claude.tool-search for a Responses request and removes
   * client tool_search from it when the credential cannot use native tool
   * search, so the translation matches the pre-tool-search one
   * (Go: applyNativeToolSearchFallback).
   */
  applyNativeToolSearchFallback(auth: Auth, upstreamModel: string, req: ExecRequest, opts: ExecOptions): ToolSearchDecision {
    const toolSearch = clientToolSearchEnabled();
    if (opts.sourceFormat !== FormatOpenAIResponse || !toolSearch) return { req, opts, toolSearch };
    if (!responsesHasToolSearch(req.payload) && !(opts.originalRequest && responsesHasToolSearch(opts.originalRequest))) return { req, opts, toolSearch };
    if (this.supportsNativeToolSearch(auth, upstreamModel, toolSearch)) return { req, opts, toolSearch };
    const stripped: ExecRequest = { ...req, payload: stripResponsesToolSearch(req.payload) };
    const strippedOpts: ExecOptions = opts.originalRequest && opts.originalRequest.length > 0 ? { ...opts, originalRequest: stripResponsesToolSearch(opts.originalRequest) } : opts;
    log.debug(`claude executor: native tool search unavailable, removed tool_search from request (model=${upstreamModel})`);
    return { req: stripped, opts: strippedOpts, toolSearch };
  }

  private toolSearchDecision(auth: Auth, req: ExecRequest, opts: ExecOptions): ToolSearchDecision {
    return this.applyNativeToolSearchFallback(auth, this.upstreamModel(parseSuffix(req.model).modelName), req, opts);
  }

  /** Translates the inbound payload to Claude; Responses requests use the pinned tool-search switch. */
  private translateToClaude(from: string, baseModel: string, req: ExecRequest, stream: boolean, toolSearch: boolean): string {
    if (from === FormatOpenAIResponse) return convertOpenAIResponsesRequestToClaudeWithToolSearch(baseModel, req.payload, stream, toolSearch, apiKeyModelIsCompat(req));
    return translateRequest(from, to, baseModel, req.payload, stream);
  }

  private webSearchScope(auth: Auth, req: ExecRequest, opts: ExecOptions, originalPayload: string): ClaudeWebSearchResultScope {
    return claudeWebSearchResultCacheScope(this.cfg.webSearchResultCache, auth, opts.sourceFormat, req, opts, originalPayload);
  }

  private sessionDatePinRetentionMs(): number {
    const days = this.cfg.sessionDatePinDays ?? defaultClaudeSessionDatePinDays;
    return days > 0 ? days * 24 * 60 * 60_000 : 0;
  }

  /** Restores dropped thinking for compat API-key models (Go: prepareClaudeThinkingReplayRequest). */
  private prepareReplay(auth: Auth, req: ExecRequest, opts: ExecOptions): { req: ExecRequest; scope: ClaudeThinkingReplayScope } {
    if (!claudeThinkingReplayEnabled(auth, req, opts)) return { req, scope: emptyClaudeThinkingReplayScope() };
    return prepareClaudeThinkingReplayRequest(this.replayCache, auth, req, opts);
  }

  private clearReplayAfterError(scope: ClaudeThinkingReplayScope, err: unknown): void {
    if (scope.replayApplied && shouldClearThinkingReplayAfterError(err)) clearClaudeThinkingReplayContent(this.replayCache, scope);
  }

  /** The credential attribute rebuild_mid_system_message or the executor-wide switch (Go: rebuildMidSystemMessageEnabled). */
  private rebuildMidSystemMessageEnabled(auth: Auth): boolean {
    if ((auth.attributes?.rebuild_mid_system_message ?? "").trim().toLowerCase() === "true") return true;
    return this.cfg.rebuildMidSystemMessage === true;
  }

  private modelLevelCooling(): boolean {
    return this.cfg.modelLevelCooling === true;
  }

  private upstreamModel(baseModel: string): string {
    return this.cfg.upstreamModelNormalizer ? this.cfg.upstreamModelNormalizer(baseModel) : baseModel;
  }

  private restoreResponseModel(payload: string, model: string): string {
    if (!this.cfg.upstreamModelNormalizer || model.trim() === "") return payload;
    return restoreClaudeResponseModel(payload, model);
  }

  private async send(url: string, headers: Headers, body: string, auth: Auth, opts: ExecOptions): Promise<Response> {
    const init: RequestInit & { proxy?: string; decompress?: boolean } = { method: "POST", headers, body, signal: opts.signal, decompress: false };
    applyFetchProxy(init, opts.proxyUrl, auth.proxyUrl, this.cfg.proxyUrl);
    return this.fetchImpl(url, init);
  }

  /**
   * Reads and classifies a non-2xx upstream response. A fast request's error is
   * passed through request-scoped instead (Go: newClaudeFastDirectResponseError).
   */
  private async upstreamError(res: Response, fastRequest = false): Promise<unknown> {
    let text: string;
    try {
      text = await readAllText(decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers)));
    } catch (err) {
      const msg = `failed to decode error response body: ${(err as Error).message}`;
      log.warn(msg);
      const classified = classifyClaudeUpstreamErrorWithCooling(res.status, res.headers, msg, this.modelLevelCooling(), this.now());
      return wrapClaudeFastRequestError(fastRequest, res.status, classified);
    }
    log.debug("claude executor: request error", { status: res.status });
    if (fastRequest) return newClaudeFastDirectResponseError(res.status, res.headers, text, this.now());
    return classifyClaudeUpstreamErrorWithCooling(res.status, res.headers, text, this.modelLevelCooling(), this.now());
  }

  /** Sends a prepared request; a fast request's transport failure is request-scoped (Go: wrapClaudeFastRequestError). */
  private async sendPrepared(prepared: { url: string; headers: Headers; body: string }, auth: Auth, opts: ExecOptions, fastRequest: boolean): Promise<Response> {
    try {
      return await this.send(prepared.url, prepared.headers, prepared.body, auth, opts);
    } catch (err) {
      throw wrapClaudeFastRequestError(fastRequest, 0, err);
    }
  }

  /**
   * Runs the shared request pipeline and returns everything the transport needs.
   * `upstreamStream` selects the SSE transport (always true for executeStream).
   */
  private prepare(
    auth: Auth,
    req: ExecRequest,
    opts: ExecOptions,
    upstreamStream: boolean,
    toolSearch: boolean,
  ): {
    url: string;
    headers: Headers;
    body: string;
    bodyForTranslation: string;
    originalPayload: string;
    diagnostics: ClaudeDiagnosticsRequestState;
    webSearch: ClaudeWebSearchResultScope;
    toolAliases?: ClaudeToolAliasMap;
  } {
    const baseModel = parseSuffix(req.model).modelName;
    const upstreamModel = this.upstreamModel(baseModel);
    const { apiKey, baseURL: configuredBase } = claudeCreds(auth);
    const baseURL = configuredBase !== "" ? configuredBase : DefaultClaudeBaseURL;
    const url = `${baseURL}/v1/messages?beta=true`;
    const fp = resolveClaudeFingerprintPolicy(auth, apiKey);
    const from = opts.sourceFormat;
    const originalPayload = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
    const incomingHeaders = opts.headers;
    const detection = detectClaudeCodeRequest(incomingHeaders, originalPayload, false, this.cfg.headerDefaults);
    const [wirePolicy] = resolveClaudeWirePolicy(this.cfg, auth, apiKey, detection.confirmed);
    const confirmedClaudeCode = isEffectiveConfirmedClaudeCode(detection, wirePolicy);
    const sessionID = fp.profileClaudeCodeCLI || wirePolicy.cloak ? claudeAgentSessionUUIDForRequest(incomingHeaders, originalPayload, req.payload, confirmedClaudeCode, opts.metadata, req.metadata) : "";
    // The credential identity rewrite must see the only metadata object the caller sent.
    if (fp.applyCLIIdentity) validateClaudeMetadataUnique(req.payload);
    // Real Claude OAuth always signs CCH; an opted-in API key signs only on api.anthropic.com.
    const cchSigning = claudeCCHSigningEnabled(apiKey, ClaudeCCHUpstreamKind.Anthropic, fp.profileClaudeCodeCLI, url);
    const directAnthropic = isAnthropicUpstreamBase(baseURL);
    const injectDiagnostics = fp.profileClaudeCodeCLI && this.cfg.headerDefaults?.injectDiagnostics !== false;
    const rc: ClaudeRequestContext = {
      store: this.continuity,
      incomingHeaders,
      sessionID: fp.profileClaudeCodeCLI ? sessionID : "",
      hasExecutionMetadata: claudeRequestHasExecutionMetadata(opts.metadata, req.metadata),
      continuity: newClaudeContinuityContext(),
      workload: headerValueCaseInsensitive(incomingHeaders, "X-CPA-Claude-Workload").trim(),
      now: this.now,
      sessionDatePinRetentionMs: this.sessionDatePinRetentionMs(),
      timezone: this.cfg.headerDefaults?.timezone ?? "",
    };

    let body = this.translateToClaude(from, baseModel, req, upstreamStream, toolSearch);
    body = setStringIfDifferent(body, "model", upstreamModel);
    body = normalizeClaudeToolChoice(this.identifier, upstreamModel, body);
    body = applyRequestThinking(body, req, opts, from, to, this.identifier);
    const webSearch = this.webSearchScope(auth, req, opts, originalPayload);
    body = restoreClaudeWebSearchResults(this.webSearchResults, webSearch, body);
    if (this.rebuildMidSystemMessageEnabled(auth)) body = rebuildMidSystemMessagesToTopLevel(body);

    let isProbeOrHelper = isClaudeProbeOrHelperRequest(body);
    const explicitCacheMode = isExplicitPromptCacheMode(originalPayload, req.payload, body);
    const cloak = applyCloaking(this.cfg, auth, body, apiKey, confirmedClaudeCode, {
      explicitCacheMode,
      sessionID,
      cchSigning,
      billingVersion: defaultClaudeVersion(this.cfg.headerDefaults),
      rc,
    });
    body = cloak.payload;
    const cloaked = cloak.cloaked;

    // Only Messages on Anthropic itself carries context_management / diagnostics.
    let diagnostics = emptyClaudeDiagnosticsState();
    if (!isProbeOrHelper) isProbeOrHelper = isClaudeProbeOrHelperRequest(body);
    const continuity = rc.continuity;
    if (continuity.initialized) diagnostics = { key: continuity.key, sequence: continuity.sequence, promptID: continuity.promptID };
    const cmState: ClaudeCodeContextManagementState = {
      eligible: cloaked && directAnthropic,
      callerOwned: getAt(tryParse(body), "context_management") !== undefined,
      automaticallyInjected: false,
    };
    if (cmState.eligible) {
      const cm = injectClaudeCodeContextManagement(body);
      body = cm.payload;
      cmState.automaticallyInjected = cm.injected;
      if (injectDiagnostics && !isProbeOrHelper) {
        const injected = continuity.initialized
          ? injectClaudeDiagnosticsWithState(body, continuity.key, continuity.sequence, continuity.previousMessageID, continuity.promptID)
          : injectClaudeDiagnostics(this.continuity, body, auth, sessionID);
        body = injected.body;
        diagnostics = injected.state;
      }
    }

    body = ensureModelMaxTokens(body, baseModel);
    body = disableThinkingIfToolChoiceForced(body);
    body = reconcileClaudeCodeContextManagement(body, cmState);
    body = normalizeClaudeSamplingForUpstream(body, confirmedClaudeCode);

    // Default cache_control for non-native callers; confirmed native Claude Code owns its markers.
    const cpaOwnsCacheControl = shouldEnsureCacheControl(body, cloaked, confirmedClaudeCode, originalPayload, req.payload);
    if (cpaOwnsCacheControl) body = ensureCacheControl(body);
    body = enforceCacheControlLimit(body, 4);
    body = stripPromptCacheOptions(body);

    // Native selects the 1h cache pool only for OAuth credentials and pairs it with extended-cache-ttl.
    const isSubagent = isClaudeSubagentRequest(incomingHeaders, body);
    const subagent1h = isSubagent && claudeSubagentRequests1h(incomingHeaders, body);
    if (cpaOwnsCacheControl && fp.profileClaudeCodeCLI && (!isSubagent || subagent1h) && !isProbeOrHelper) {
      body = upgradeClaudeCacheControlTTL(body, claudeCacheControlTTL1h);
    } else if ((isProbeOrHelper || (isSubagent && !subagent1h)) && !explicitCacheMode) {
      body = stripClaudeCacheControlTTL(body);
    }
    if (!explicitCacheMode) body = normalizeCacheControlTTL(body);
    body = setBoolIfDifferent(body, "stream", upstreamStream);

    const bodyForTranslation = body;
    let bodyForUpstream = body;
    // Cloaked Claude Code traffic carries its client tools as MCP extensions.
    let toolAliases: ClaudeToolAliasMap | undefined;
    if (fp.profileClaudeCodeCLI && cloaked) {
      const aliased = prepareClaudeOAuthToolNamesForRequest(this.toolAliases, bodyForUpstream, resolveClaudeMCPAliasSecret(opts.metadata, req.metadata));
      bodyForUpstream = aliased.body;
      toolAliases = aliased.reverseMap;
    }
    bodyForUpstream = sanitizeClaudeMessagesForClaudeUpstreamWithDebug(bodyForUpstream, baseModel, apiKeyModelIsCompat(req));
    if (fp.applyCLIIdentity) bodyForUpstream = applyClaudeCLIIdentity(bodyForUpstream, auth, apiKey, sessionID, fp.synthesizeIdentity);
    if (cchSigning) {
      let cchBilling = "";
      if (!detection.helperProfile || claudeBodyNeedsBillingFallback(bodyForUpstream)) {
        cchBilling = claudeCCHFallbackBillingHeader(rc, defaultClaudeVersion(this.cfg.headerDefaults), bodyForUpstream, detection.entrypoint);
      }
      bodyForUpstream = ensureClaudeBillingHeaderCCHPlaceholder(bodyForUpstream, cchBilling);
    }
    const lifted = extractAndRemoveBetas(bodyForUpstream);
    bodyForUpstream = stripPromptCacheOptions(lifted.body);
    // CCH covers the final serialized body, so signing is the last mutation.
    if (cchSigning) bodyForUpstream = signAnthropicMessagesBody(bodyForUpstream);
    // Read-only validation must observe the final model and messages.
    validateClaudeMidSystemMessageModel(bodyForUpstream, confirmedClaudeCode, directAnthropic);

    const headers = new Headers();
    applyClaudeHeaders({
      headers,
      url,
      auth,
      apiKey,
      stream: upstreamStream,
      extraBetas: lifted.betas,
      body: bodyForUpstream,
      cfg: this.cfg,
      incomingHeaders,
      confirmedClaudeCode: confirmedClaudeCode && !cloaked,
      sessionID,
    });
    return { url, headers, body: bodyForUpstream, bodyForTranslation, originalPayload, diagnostics, webSearch, toolAliases };
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const decision = this.toolSearchDecision(auth, req, opts);
    req = decision.req;
    opts = decision.opts;
    const replay = this.prepareReplay(auth, req, opts);
    try {
      return await this.executeInner(auth, replay.req, opts, replay.scope, decision.toolSearch);
    } catch (err) {
      this.clearReplayAfterError(replay.scope, err);
      throw err;
    }
  }

  private async executeInner(auth: Auth, req: ExecRequest, opts: ExecOptions, replayScope: ClaudeThinkingReplayScope, toolSearch: boolean): Promise<ExecResponse> {
    const responseFormat = responseFormatOrSource(opts);
    // Native Claude responses use the JSON path; other response formats need the
    // upstream event stream so the registered translator can aggregate it.
    const upstreamStream = responseFormat !== to;
    const prepared = this.prepare(auth, req, opts, upstreamStream, toolSearch);
    const fastRequest = isAnthropicUpstreamURL(prepared.url) && claudeRequestIsFast(prepared.headers, prepared.body);
    const res = await this.sendPrepared(prepared, auth, opts, fastRequest);
    if (res.status < 200 || res.status >= 300) throw await this.upstreamError(res, fastRequest);
    try {
      return this.finishExecute(await readAllText(decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers))), res, req, opts, prepared, upstreamStream, replayScope, toolSearch, responseFormat);
    } catch (err) {
      throw wrapClaudeFastRequestError(fastRequest, res.status, err);
    }
  }

  private finishExecute(
    data: string,
    res: Response,
    req: ExecRequest,
    opts: ExecOptions,
    prepared: ReturnType<ClaudeExecutor["prepare"]>,
    upstreamStream: boolean,
    replayScope: ClaudeThinkingReplayScope,
    toolSearch: boolean,
    responseFormat: string,
  ): ExecResponse {
    const requestID = headerValueCaseInsensitive(res.headers, "request-id");
    if (upstreamStream) {
      validateClaudeStreamingResponse(data);
      const messageID = claudeMessageIDFromSSE(data);
      if (messageID !== "") {
        commitClaudeContinuity(this.continuity, prepared.diagnostics, messageID, requestID);
        rememberClaudeOAuthToolAliases(this.toolAliases, prepared.bodyForTranslation, prepared.toolAliases, messageID);
      }
      data = reverseRemapOAuthToolNamesInSSE(data, prepared.toolAliases);
    } else {
      const messageID = claudeMessageIDFromResponse(data);
      commitClaudeContinuity(this.continuity, prepared.diagnostics, messageID, requestID);
      rememberClaudeOAuthToolAliases(this.toolAliases, prepared.bodyForTranslation, prepared.toolAliases, messageID);
      data = reverseRemapOAuthToolNames(data, prepared.toolAliases);
    }
    data = this.restoreResponseModel(data, req.model);
    recordClaudeWebSearchResults(this.webSearchResults, prepared.webSearch, data);
    cacheClaudeThinkingReplayResponse(this.replayCache, replayScope, data);
    const state: TranslatorState = {};
    const ctx = withClientToolSearch({ signal: opts.signal }, toolSearch);
    let out = translateNonStream(ctx, to, responseFormat, req.model, applyPatchOriginalRequest(req, opts), prepared.bodyForTranslation, data, state);
    if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
    if (out.length === 0) throw new StatusError(502, "claude executor: response translation produced no output");
    if (responseFormat === FormatOpenAIResponse) out = ensureResponsesUsageDetails(out);
    const metadata: Record<string, unknown> = {};
    if (!upstreamStream) metadata.usage = parseClaudeUsage(data);
    return { payload: out, headers: res.headers, metadata };
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    const decision = this.toolSearchDecision(auth, req, opts);
    req = decision.req;
    opts = decision.opts;
    const replay = this.prepareReplay(auth, req, opts);
    let result: StreamResult;
    try {
      result = await this.executeStreamInner(auth, replay.req, opts, decision.toolSearch);
    } catch (err) {
      this.clearReplayAfterError(replay.scope, err);
      throw err;
    }
    return claudeThinkingReplayScopeValid(replay.scope) ? wrapClaudeThinkingReplayStream(this.replayCache, result, replay.scope) : result;
  }

  private async executeStreamInner(auth: Auth, req: ExecRequest, opts: ExecOptions, toolSearch: boolean): Promise<StreamResult> {
    const responseFormat = responseFormatOrSource(opts);
    const prepared = this.prepare(auth, req, opts, true, toolSearch);
    const fastRequest = isAnthropicUpstreamURL(prepared.url) && claudeRequestIsFast(prepared.headers, prepared.body);
    const res = await this.sendPrepared(prepared, auth, opts, fastRequest);
    if (res.status < 200 || res.status >= 300) throw await this.upstreamError(res, fastRequest);
    const decoded = decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers));
    const webSearch = prepared.webSearch;
    const toolAliases = prepared.toolAliases;
    const restore = (frame: string): string => {
      const restored = this.restoreResponseModel(reverseRemapOAuthToolNamesInSSE(frame, toolAliases), req.model);
      recordClaudeWebSearchResults(this.webSearchResults, webSearch, restored);
      return restored;
    };
    const signal = opts.signal;
    const requestID = headerValueCaseInsensitive(res.headers, "request-id");
    // Continuity advances only once the upstream stream reached message_stop.
    const onComplete = (state: ClaudeStreamState): void => {
      commitClaudeContinuity(this.continuity, prepared.diagnostics, state.messageID, requestID);
      rememberClaudeOAuthToolAliases(this.toolAliases, prepared.bodyForTranslation, toolAliases, state.messageID);
    };
    const chunks =
      responseFormat === to
        ? passthroughChunks(decoded, restore, signal, onComplete)
        : translatedChunks(decoded, restore, withClientToolSearch({ signal }, toolSearch), responseFormat, req.model, applyPatchOriginalRequest(req, opts), prepared.bodyForTranslation, onComplete);
    return { headers: res.headers, chunks: fastRequest ? wrapClaudeFastStreamErrors(chunks, fastRequest, res.status) : chunks };
  }

  async countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const decision = this.toolSearchDecision(auth, req, opts);
    req = decision.req;
    opts = decision.opts;
    const baseModel = parseSuffix(req.model).modelName;
    const upstreamModel = this.upstreamModel(baseModel);
    const { apiKey, baseURL: configuredBase } = claudeCreds(auth);
    const baseURL = configuredBase !== "" ? configuredBase : DefaultClaudeBaseURL;
    const url = `${baseURL}/v1/messages/count_tokens?beta=true`;
    const fp = resolveClaudeFingerprintPolicy(auth, apiKey);
    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const originalPayload = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
    const incomingHeaders = opts.headers;
    const detection = detectClaudeCodeRequest(incomingHeaders, originalPayload, true, this.cfg.headerDefaults);
    const [initialPolicy] = resolveClaudeWirePolicy(this.cfg, auth, apiKey, detection.confirmed);
    const confirmedClaudeCode = isEffectiveConfirmedClaudeCode(detection, initialPolicy);
    const sessionID = fp.profileClaudeCodeCLI ? claudeAgentSessionUUIDForRequest(incomingHeaders, originalPayload, req.payload, confirmedClaudeCode, opts.metadata, req.metadata) : "";

    let body = this.translateToClaude(from, baseModel, req, from !== to, decision.toolSearch);
    body = setStringIfDifferent(body, "model", upstreamModel);
    body = normalizeClaudeToolChoice(this.identifier, upstreamModel, body);
    body = applyRequestThinking(body, req, opts, from, to, this.identifier);
    body = restoreClaudeWebSearchResults(this.webSearchResults, this.webSearchScope(auth, req, opts, originalPayload), body);
    if (this.rebuildMidSystemMessageEnabled(auth)) body = rebuildMidSystemMessagesToTopLevel(body);
    const directAnthropic = isAnthropicUpstreamBase(baseURL);
    const [policy] = resolveClaudeWirePolicy(this.cfg, auth, apiKey, confirmedClaudeCode);
    const cloaked = policy.cloak;
    const explicitCacheMode = isExplicitPromptCacheMode(originalPayload, req.payload, body);
    body = enforceCacheControlLimit(body, 4);
    if (!explicitCacheMode) body = normalizeCacheControlTTL(body);
    const lifted = extractAndRemoveBetas(body);
    body = lifted.body;
    // Claude Code 2.1.220's beta.messages.countTokens() always appends this beta.
    const extraBetas = [...lifted.betas, claudeTokenCountingBeta];
    if (fp.profileClaudeCodeCLI && cloaked) body = remapOAuthToolNames(body, resolveClaudeMCPAliasSecret(opts.metadata, req.metadata)).body;
    body = sanitizeClaudeMessagesForClaudeUpstreamWithDebug(body, baseModel);
    body = stripPromptCacheOptions(body);
    // api.anthropic.com rejects these fields on count_tokens ("Extra inputs are not permitted").
    if (directAnthropic || fp.profileClaudeCodeCLI) {
      const root = tryParse<Record<string, unknown>>(body);
      if (isObj(root)) {
        delete root.metadata;
        delete root.context_management;
        delete root.diagnostics;
        body = JSON.stringify(root);
      }
    }
    if (fp.profileClaudeCodeCLI) body = stripClaudeCodeAttributionSystem(body);
    validateClaudeMidSystemMessageModel(body, confirmedClaudeCode, directAnthropic);

    const headers = new Headers();
    applyClaudeHeaders({ headers, url, auth, apiKey, stream: false, extraBetas, body, cfg: this.cfg, incomingHeaders, confirmedClaudeCode: confirmedClaudeCode && !cloaked, sessionID });
    const res = await this.send(url, headers, body, auth, opts);
    if (res.status < 200 || res.status >= 300) throw await this.upstreamError(res);
    const data = await readAllText(decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers)));
    const count = gint(getAt(tryParse(data), "input_tokens"));
    const out = translateTokenCount({ signal: opts.signal }, to, responseFormat, count, data);
    return { payload: out, headers: res.headers };
  }

  /** Refreshes an OAuth credential through the Claude authenticator; API-key auths are returned unchanged. */
  async refresh(auth: Auth): Promise<Auth> {
    log.debug("claude executor: refresh called");
    if (isAPIKeyAuth(auth)) return auth;
    return new ClaudeAuthenticator().refresh(auth, { proxyUrl: auth.proxyUrl ?? this.cfg.proxyUrl, fetch: this.cfg.fetch, now: this.cfg.now });
  }
}

/** Whether the request carried execution session metadata (Go: ClaudeRequestHasExecutionMetadata). */
function claudeRequestHasExecutionMetadata(...metadataSets: Array<Record<string, unknown> | undefined>): boolean {
  return metadataSets.some((m) => typeof m?.[ExecutionSessionMetadataKey] === "string" && (m[ExecutionSessionMetadataKey] as string).trim() !== "");
}

/** Creates the Claude executor (Go: NewClaudeExecutor). */
export function createClaudeExecutor(cfg: ClaudeExecutorConfig = {}): ClaudeExecutor {
  return new ClaudeExecutor(cfg);
}

/** Rebuilds one SSE block in canonical "\n" line form with the trailing blank line. */
function frameOf(raw: string): string {
  return raw.split(/\r\n|\n|\r/).join("\n") + "\n\n";
}

function truncationError(): StatusError {
  return new StatusError(502, "upstream stream closed before message_stop", { streamTruncated: true });
}

/** Terminal check shared by both stream modes; throws the error event's status or a truncation error. */
function finishStream(state: ClaudeStreamState, signal: AbortSignal | undefined, onComplete?: (state: ClaudeStreamState) => void): void {
  if (state.completed) {
    onComplete?.(state);
    return;
  }
  if (state.streamErr) throw state.streamErr;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
  throw truncationError();
}

/** Forwards complete upstream SSE events verbatim (Go: ExecuteStream, responseFormat == to). */
async function* passthroughChunks(
  decoded: ReadableStream<Uint8Array>,
  restore: (frame: string) => string,
  signal: AbortSignal | undefined,
  onComplete?: (state: ClaudeStreamState) => void,
): AsyncGenerator<string> {
  const state = newClaudeStreamState();
  for await (const ev of iterateSSE(decoded, signal)) {
    const frame = restore(frameOf(ev.raw));
    observeClaudeSSEEvent(frame, state);
    yield frame;
    if (state.completed || state.streamErr) break;
  }
  finishStream(state, signal, onComplete);
}

/**
 * Translates each upstream event through the registry (Go: ExecuteStream, other
 * response formats). For Responses output every chunk gets complete usage
 * details, an apply_patch translation failure ends the stream with the
 * sanitised 502 after its one failure frame, and the translator state is
 * finalized at the end of the transport (Go: EndApplyPatchStream).
 */
async function* translatedChunks(
  decoded: ReadableStream<Uint8Array>,
  restore: (frame: string) => string,
  ctx: TranslateContext,
  responseFormat: string,
  model: string,
  originalPayload: string,
  bodyForTranslation: string,
  onComplete?: (state: ClaudeStreamState) => void,
): AsyncGenerator<string> {
  const signal = ctx.signal;
  const state = newClaudeStreamState();
  const translatorState: TranslatorState = {};
  const responses = responseFormat === FormatOpenAIResponse;
  initializeApplyPatchStream(ctx, to, responseFormat, model, originalPayload, bodyForTranslation, translatorState);
  for await (const ev of iterateSSE(decoded, signal)) {
    const frame = restore(frameOf(ev.raw));
    observeClaudeSSEEvent(frame, state);
    // Go fed the translator one scanned line at a time; the translators expect `data: {...}` lines.
    const outputs: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.trim() === "") continue;
      outputs.push(...translateStream(ctx, to, responseFormat, model, originalPayload, bodyForTranslation, line, translatorState));
      if (applyPatchTranslationError(translatorState) !== undefined) break;
    }
    const failed = applyPatchTranslationError(translatorState) !== undefined;
    for (const out of outputs) yield responses && !failed ? ensureResponsesUsageDetails(out) : out;
    if (failed) throw applyPatchUpstreamError();
    if (state.completed || state.streamErr) break;
  }
  for (const out of finalizeApplyPatchStream(translatorState)) yield out;
  if (applyPatchTranslationError(translatorState) !== undefined) throw applyPatchUpstreamError();
  finishStream(state, signal, onComplete);
}

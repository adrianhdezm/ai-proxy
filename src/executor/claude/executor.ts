// The Claude upstream executor (provider key "claude"). Port of
// internal/runtime/executor/claude_executor.go, claude_executor_execute.go,
// claude_executor_stream.go, claude_executor_tokens.go and the refresh part of
// claude_executor_auth.go, reduced to the kept request pipeline:
//
//   parseSuffix -> translate (identity for Claude inbound) -> model -> tool_choice
//   -> thinking -> [rebuild mid-system] -> cloaking -> max_tokens -> forced tool
//   choice -> sampling -> cache_control (ensure/limit/ttl) -> stream flag ->
//   signature sanitising -> CLI identity -> betas lifted from body -> mid-system
//   validation -> headers -> POST
//
// Skipped from upstream (see the slice report): CCH signing, diagnostics and
// context_management injection, MCP alias remapping, web-search result cache,
// thinking replay cache, compaction, tool_search fallback, fast-mode error
// wrappers, usage reporting plugins, payload config rules, preserved-thinking
// block binding, local token estimation and the OAuth profile prefetch.
import { ClaudeAuthenticator } from "../../auth/claude/authenticator.ts";
import { type Auth, isAPIKeyAuth } from "../../auth/types.ts";
import { log } from "../../log.ts";
import { parseSuffix } from "../../thinking/suffix.ts";
import { translateNonStream, translateRequest, translateStream, translateTokenCount } from "../../translator/registry.ts";
import { FormatClaude, type TranslatorState } from "../../translator/types.ts";
import { stripClaudeCodeAttributionSystem } from "../../util/claude_attribution.ts";
import { getAt, gint, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { iterateSSE } from "../../util/sse.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, StatusError, type StreamResult, responseFormatOrSource } from "../types.ts";
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
import { classifyClaudeUpstreamErrorWithCooling } from "./errors.ts";
import { applyClaudeHeaders } from "./headers.ts";
import { applyClaudeCLIIdentity, claudeAgentSessionUUIDForRequest } from "./identity.ts";
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
  claudeResponseContentEncoding,
  decodeResponseBody,
  newClaudeStreamState,
  observeClaudeSSEEvent,
  parseClaudeUsage,
  readAllText,
  restoreClaudeResponseModel,
  validateClaudeStreamingResponse,
} from "./response.ts";
import { DefaultClaudeBaseURL, claudeCreds, isAnthropicUpstreamBase } from "./upstream.ts";

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
  /** Clock for rate-limit deadlines (tests). */
  now?: () => number;
  /** Optional upstream model rewrite; when set the requested model is written back into responses. */
  upstreamModelNormalizer?: (baseModel: string) => string;
}

const to = FormatClaude;

export class ClaudeExecutor implements ProviderExecutor {
  readonly identifier = "claude";
  private readonly cfg: ClaudeExecutorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(cfg: ClaudeExecutorConfig = {}) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.now = cfg.now ?? (() => Date.now());
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
    const proxy = opts.proxyUrl ?? auth.proxyUrl ?? this.cfg.proxyUrl;
    const init: RequestInit & { proxy?: string; decompress?: boolean } = { method: "POST", headers, body, signal: opts.signal, decompress: false };
    if (proxy) init.proxy = proxy;
    return this.fetchImpl(url, init);
  }

  /** Reads and classifies a non-2xx upstream response. */
  private async upstreamError(res: Response): Promise<StatusError> {
    let text: string;
    try {
      text = await readAllText(decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers)));
    } catch (err) {
      const msg = `failed to decode error response body: ${(err as Error).message}`;
      log.warn(msg);
      return classifyClaudeUpstreamErrorWithCooling(res.status, res.headers, msg, this.modelLevelCooling(), this.now());
    }
    log.debug("claude executor: request error", { status: res.status });
    return classifyClaudeUpstreamErrorWithCooling(res.status, res.headers, text, this.modelLevelCooling(), this.now());
  }

  /**
   * Runs the shared request pipeline and returns everything the transport needs.
   * `upstreamStream` selects the SSE transport (always true for executeStream).
   */
  private prepare(auth: Auth, req: ExecRequest, opts: ExecOptions, upstreamStream: boolean): { url: string; headers: Headers; body: string; bodyForTranslation: string; originalPayload: string } {
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

    let body = translateRequest(from, to, baseModel, req.payload, upstreamStream);
    body = setStringIfDifferent(body, "model", upstreamModel);
    body = normalizeClaudeToolChoice(this.identifier, upstreamModel, body);
    body = applyRequestThinking(body, req, opts, from, to, this.identifier);
    if (this.cfg.rebuildMidSystemMessage) body = rebuildMidSystemMessagesToTopLevel(body);

    const explicitCacheMode = isExplicitPromptCacheMode(originalPayload, req.payload, body);
    const cloak = applyCloaking(this.cfg, auth, body, apiKey, confirmedClaudeCode, { explicitCacheMode, sessionID });
    body = cloak.payload;
    const cloaked = cloak.cloaked;

    body = ensureModelMaxTokens(body, baseModel);
    body = disableThinkingIfToolChoiceForced(body);
    body = normalizeClaudeSamplingForUpstream(body, confirmedClaudeCode);

    // Default cache_control for non-native callers; confirmed native Claude Code owns its markers.
    const cpaOwnsCacheControl = shouldEnsureCacheControl(body, cloaked, confirmedClaudeCode, originalPayload, req.payload);
    if (cpaOwnsCacheControl) body = ensureCacheControl(body);
    body = enforceCacheControlLimit(body, 4);
    body = stripPromptCacheOptions(body);

    // Native selects the 1h cache pool only for OAuth credentials and pairs it with extended-cache-ttl.
    const isProbeOrHelper = isClaudeProbeOrHelperRequest(body);
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
    let bodyForUpstream = sanitizeClaudeMessagesForClaudeUpstreamWithDebug(body, baseModel);
    if (fp.applyCLIIdentity) bodyForUpstream = applyClaudeCLIIdentity(bodyForUpstream, auth, apiKey, sessionID, fp.synthesizeIdentity);
    const lifted = extractAndRemoveBetas(bodyForUpstream);
    bodyForUpstream = stripPromptCacheOptions(lifted.body);
    // Read-only validation must observe the final model and messages.
    validateClaudeMidSystemMessageModel(bodyForUpstream, confirmedClaudeCode, isAnthropicUpstreamBase(baseURL));

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
    return { url, headers, body: bodyForUpstream, bodyForTranslation, originalPayload };
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const responseFormat = responseFormatOrSource(opts);
    // Native Claude responses use the JSON path; other response formats need the
    // upstream event stream so the registered translator can aggregate it.
    const upstreamStream = responseFormat !== to;
    const prepared = this.prepare(auth, req, opts, upstreamStream);
    const res = await this.send(prepared.url, prepared.headers, prepared.body, auth, opts);
    if (res.status < 200 || res.status >= 300) throw await this.upstreamError(res);
    let data = await readAllText(decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers)));
    if (upstreamStream) validateClaudeStreamingResponse(data);
    data = this.restoreResponseModel(data, req.model);
    const state: TranslatorState = {};
    const out = translateNonStream({ signal: opts.signal }, to, responseFormat, req.model, prepared.originalPayload, prepared.bodyForTranslation, data, state);
    if (out.length === 0) throw new StatusError(502, "claude executor: response translation produced no output");
    const metadata: Record<string, unknown> = {};
    if (!upstreamStream) metadata.usage = parseClaudeUsage(data);
    return { payload: out, headers: res.headers, metadata };
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    const responseFormat = responseFormatOrSource(opts);
    const prepared = this.prepare(auth, req, opts, true);
    const res = await this.send(prepared.url, prepared.headers, prepared.body, auth, opts);
    if (res.status < 200 || res.status >= 300) throw await this.upstreamError(res);
    const decoded = decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers));
    const restore = (frame: string): string => this.restoreResponseModel(frame, req.model);
    const signal = opts.signal;
    const chunks = responseFormat === to ? passthroughChunks(decoded, restore, signal) : translatedChunks(decoded, restore, signal, responseFormat, req.model, prepared.originalPayload, prepared.bodyForTranslation);
    return { headers: res.headers, chunks };
  }

  async countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
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

    let body = translateRequest(from, to, baseModel, req.payload, from !== to);
    body = setStringIfDifferent(body, "model", upstreamModel);
    body = normalizeClaudeToolChoice(this.identifier, upstreamModel, body);
    body = applyRequestThinking(body, req, opts, from, to, this.identifier);
    if (this.cfg.rebuildMidSystemMessage) body = rebuildMidSystemMessagesToTopLevel(body);
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
    return new ClaudeAuthenticator().refresh(auth, { proxyUrl: auth.proxyUrl ?? this.cfg.proxyUrl });
  }
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
function finishStream(state: ClaudeStreamState, signal: AbortSignal | undefined): void {
  if (state.completed) return;
  if (state.streamErr) throw state.streamErr;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
  throw truncationError();
}

/** Forwards complete upstream SSE events verbatim (Go: ExecuteStream, responseFormat == to). */
async function* passthroughChunks(decoded: ReadableStream<Uint8Array>, restore: (frame: string) => string, signal: AbortSignal | undefined): AsyncGenerator<string> {
  const state = newClaudeStreamState();
  for await (const ev of iterateSSE(decoded, signal)) {
    const frame = restore(frameOf(ev.raw));
    observeClaudeSSEEvent(frame, state);
    yield frame;
    if (state.completed || state.streamErr) break;
  }
  finishStream(state, signal);
}

/** Translates each upstream event through the registry (Go: ExecuteStream, other response formats). */
async function* translatedChunks(
  decoded: ReadableStream<Uint8Array>,
  restore: (frame: string) => string,
  signal: AbortSignal | undefined,
  responseFormat: string,
  model: string,
  originalPayload: string,
  bodyForTranslation: string,
): AsyncGenerator<string> {
  const state = newClaudeStreamState();
  const translatorState: TranslatorState = {};
  for await (const ev of iterateSSE(decoded, signal)) {
    const frame = restore(frameOf(ev.raw));
    observeClaudeSSEEvent(frame, state);
    const outputs = translateStream({ signal }, to, responseFormat, model, originalPayload, bodyForTranslation, frame, translatorState);
    for (const out of outputs) yield out;
    if (state.completed || state.streamErr) break;
  }
  finishStream(state, signal);
}

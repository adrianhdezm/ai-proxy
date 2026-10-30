// Gemini CLI executor (provider "gemini-cli"): Google OAuth credentials from the
// auth metadata against the Cloud Code Assist endpoint
// (https://cloudcode-pa.googleapis.com/v1internal:{generateContent|streamGenerateContent|countTokens}).
// Port of v7.0.12 internal/runtime/executor/gemini_cli_executor.go (Execute,
// ExecuteStream, CountTokens, Refresh, prepareGeminiCLITokenSource,
// updateGeminiCLITokenMetadata, resolveGeminiProjectID, applyGeminiCLIHeaders,
// cliPreviewFallbackOrder) and internal/misc header constants.
//
// Dropped from upstream: the "home" remote-refresh path, shared/virtual
// multi-project credentials (geminicli.ResolveSharedCredential), payload config
// rules, request/response logging and the usage reporter.
import { GeminiAuthenticator, geminiCLIUserAgent } from "../../auth/gemini/index.ts";
import { SingleFlight } from "../../auth/oauth/singleflight.ts";
import type { Auth } from "../../auth/types.ts";
import { wrapGeminiCLIRequest } from "../../translator/gemini/claude/index.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import { FormatGemini, type TranslatorState, toolInputFailed } from "../../translator/types.ts";
import { applyCustomHeadersFromAttrs } from "../../util/header_helpers.ts";
import { getAt, gint, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, StatusError, type StreamResult, responseFormatOrSource } from "../types.ts";
import { newGeminiStatusErr, translatedClaudeErrorPayload } from "./errors.ts";
import { baseModelOf, deleteJSONFields, fixGeminiImageAspectRatio, originalRequestOf, translateToGemini } from "./request.ts";
import { type ExecutorFetch, geminiStreamChunks, postUpstream } from "./stream.ts";
import { parseGeminiCLIUsage } from "./usage.ts";

export const GeminiCLIExecutorIdentifier = "gemini-cli";
export const codeAssistEndpoint = "https://cloudcode-pa.googleapis.com";
export const codeAssistVersion = "v1internal";
/** misc.GeminiCLIApiClientHeader (X-Goog-Api-Client). */
export const GeminiCLIApiClientHeader = "google-genai-sdk/1.41.0 gl-node/v22.19.0";
/** Access tokens expiring within this window are refreshed before use. */
export const geminiCLITokenRefreshSkewMs = 30_000;

/**
 * Preview models tried after a 429 on the base model (Go: cliPreviewFallbackOrder).
 * The upstream table is kept as is: every list is currently empty (the preview
 * models were retired), so only the base model is attempted.
 */
export function cliPreviewFallbackOrder(model: string): string[] {
  switch (model) {
    case "gemini-2.5-pro":
      return [
        // "gemini-2.5-pro-preview-05-06",
        // "gemini-2.5-pro-preview-06-05",
      ];
    case "gemini-2.5-flash":
      return [
        // "gemini-2.5-flash-preview-04-17",
        // "gemini-2.5-flash-preview-05-20",
      ];
    case "gemini-2.5-flash-lite":
      return [
        // "gemini-2.5-flash-lite-preview-06-17",
      ];
    default:
      return [];
  }
}

export interface GeminiCLIExecutorOptions {
  /** Code Assist base URL (default https://cloudcode-pa.googleapis.com); tests point it at a fake server. */
  endpoint?: string;
  /** config quotaExceeded.switchPreviewModel: try cliPreviewFallbackOrder models after a 429. */
  switchPreviewModel?: boolean;
  /** fetch for upstream and token refresh calls. */
  fetch?: ExecutorFetch;
  /** Clock (epoch ms) for token expiry checks. */
  now?: () => number;
  /**
   * Refresher for expired access tokens. Defaults to a GeminiAuthenticator that
   * reads the OAuth client from GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET.
   */
  authenticator?: Pick<GeminiAuthenticator, "refresh">;
  /** Global proxy URL used when neither ExecOptions.proxyUrl nor auth.proxyUrl is set. */
  proxyUrl?: string;
  /** Called after an in-request token refresh updated auth.metadata in place (persist hook). */
  onAuthUpdated?: (auth: Auth) => void;
}

interface CLIToken {
  accessToken: string;
  refreshToken: string;
  expiry?: number;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string {
  const v = meta?.[key];
  return typeof v === "string" ? v : "";
}

function parseExpiry(v: unknown): number | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const ms = Date.parse(v.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

/** Port of prepareGeminiCLITokenSource.buildToken: nested `token` first, then top-level keys. */
export function geminiCLITokenFromMetadata(meta: Record<string, unknown> | undefined): CLIToken {
  const nested = isObj(meta?.token) ? (meta!.token as Record<string, unknown>) : undefined;
  const token: CLIToken = {
    accessToken: metaString(nested, "access_token"),
    refreshToken: metaString(nested, "refresh_token"),
    expiry: parseExpiry(nested?.expiry),
  };
  if (token.accessToken === "") token.accessToken = metaString(meta, "access_token");
  if (token.refreshToken === "") token.refreshToken = metaString(meta, "refresh_token");
  if (token.expiry === undefined) token.expiry = parseExpiry(meta?.expiry);
  return token;
}

/** Project id of the credential (Go: resolveGeminiProjectID). */
export function resolveGeminiProjectID(auth: Auth | undefined): string {
  return metaString(auth?.metadata, "project_id").trim();
}

function tokenUsable(token: CLIToken, now: number): boolean {
  if (token.accessToken === "") return false;
  return token.expiry === undefined || token.expiry - geminiCLITokenRefreshSkewMs > now;
}

/** Sets the Gemini CLI identity headers (Go: applyGeminiCLIHeaders). */
export function applyGeminiCLIHeaders(headers: Headers, model: string): void {
  headers.set("User-Agent", geminiCLIUserAgent(model));
  headers.set("X-Goog-Api-Client", GeminiCLIApiClientHeader);
}

export class GeminiCLIExecutor implements ProviderExecutor {
  readonly identifier = GeminiCLIExecutorIdentifier;
  private readonly endpoint: string;
  private readonly switchPreviewModel: boolean;
  private readonly fetchFn: ExecutorFetch;
  private readonly now: () => number;
  private readonly authenticator: Pick<GeminiAuthenticator, "refresh">;
  private readonly globalProxy: string | undefined;
  private readonly onAuthUpdated: ((auth: Auth) => void) | undefined;
  private readonly refreshFlight = new SingleFlight<Auth>();

  constructor(opts: GeminiCLIExecutorOptions = {}) {
    this.endpoint = (opts.endpoint ?? codeAssistEndpoint).replace(/\/+$/, "");
    this.switchPreviewModel = opts.switchPreviewModel ?? false;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as ExecutorFetch);
    this.now = opts.now ?? Date.now;
    this.authenticator = opts.authenticator ?? new GeminiAuthenticator();
    this.globalProxy = opts.proxyUrl;
    this.onAuthUpdated = opts.onAuthUpdated;
  }

  private proxyFor(auth: Auth, opts?: ExecOptions): string | undefined {
    return opts?.proxyUrl ?? (auth.proxyUrl && auth.proxyUrl !== "" ? auth.proxyUrl : this.globalProxy);
  }

  /**
   * Returns a usable access token, refreshing it (single-flight per auth id)
   * when missing or within 30s of expiry; the refreshed token fields are
   * written into auth.metadata in place (Go: prepareGeminiCLITokenSource +
   * updateGeminiCLITokenMetadata).
   */
  async accessToken(auth: Auth): Promise<string> {
    if (!auth || !auth.metadata) throw new StatusError(401, "gemini-cli auth metadata missing");
    let token = geminiCLITokenFromMetadata(auth.metadata);
    if (tokenUsable(token, this.now())) return token.accessToken;
    if (token.refreshToken === "") {
      if (token.accessToken === "") throw new StatusError(401, "gemini-cli access token missing");
      throw new StatusError(401, "gemini-cli access token expired and no refresh token is set");
    }
    const refreshed = await this.refreshFlight.do(auth.id, () =>
      this.authenticator.refresh(auth, { fetch: this.fetchFn, now: this.now, proxyUrl: this.proxyFor(auth) }),
    );
    if (refreshed !== auth) {
      if (!auth.metadata) auth.metadata = {};
      for (const [k, v] of Object.entries(refreshed.metadata ?? {})) auth.metadata[k] = v;
      if (refreshed.lastRefreshedAt) auth.lastRefreshedAt = refreshed.lastRefreshedAt;
      if (refreshed.updatedAt) auth.updatedAt = refreshed.updatedAt;
      log.debug("gemini-cli executor: access token refreshed", { auth: auth.id });
      this.onAuthUpdated?.(auth);
    }
    token = geminiCLITokenFromMetadata(auth.metadata);
    if (token.accessToken === "") throw new StatusError(401, "gemini-cli access token missing");
    return token.accessToken;
  }

  private attemptModels(baseModel: string): string[] {
    const previews = this.switchPreviewModel ? cliPreviewFallbackOrder(baseModel) : [];
    if (previews.length === 0 || previews[0] !== baseModel) return [baseModel, ...previews];
    return previews;
  }

  private headersFor(auth: Auth, opts: ExecOptions, accessToken: string, model: string, accept: string): Headers {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${accessToken}`);
    applyGeminiCLIHeaders(headers, model);
    headers.set("Accept", accept);
    applyCustomHeadersFromAttrs(headers, auth.attributes, { clientHeaders: opts.headers });
    return headers;
  }

  private url(action: string, query: string): string {
    return `${this.endpoint}/${codeAssistVersion}:${action}${query}`;
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    if (opts.alt === "responses/compact") throw new StatusError(501, "/responses/compact not supported");
    const baseModel = baseModelOf(req.model);
    await this.accessToken(auth);
    const responseFormat = responseFormatOrSource(opts);
    const action = req.metadata?.action === "countTokens" ? "countTokens" : "generateContent";
    let body = translateToGemini(req, opts, false, this.identifier);
    body = fixGeminiImageAspectRatio(baseModel, body);
    const projectId = resolveGeminiProjectID(auth);

    let lastStatus = 0;
    let lastBody = "";
    let lastHeaders: Headers | undefined;
    const models = this.attemptModels(baseModel);
    for (let idx = 0; idx < models.length; idx++) {
      const attemptModel = models[idx]!;
      const payload = action === "countTokens" ? deleteJSONFields(wrapGeminiCLIRequest("", baseModel, body), "project", "model") : wrapGeminiCLIRequest(projectId, attemptModel, body);
      const accessToken = await this.accessToken(auth);
      const query = opts.alt && action !== "countTokens" ? `?$alt=${opts.alt}` : "";
      const resp = await postUpstream(this.fetchFn, {
        url: this.url(action, query),
        headers: this.headersFor(auth, opts, accessToken, attemptModel, "application/json"),
        body: payload,
        signal: opts.signal,
        proxyUrl: this.proxyFor(auth, opts),
      });
      const data = await resp.text();
      if (resp.status >= 200 && resp.status < 300) {
        const state: TranslatorState = {};
        const out = defaultRegistry.translateNonStream({ signal: opts.signal }, FormatGemini, responseFormat, req.model, originalRequestOf(req, opts), body, data, state);
        const errPayload = translatedClaudeErrorPayload(responseFormat, out);
        if (errPayload !== undefined) throw new StatusError(502, errPayload, { body: errPayload });
        if (out === "" || toolInputFailed(state)) throw new StatusError(502, "gemini-cli executor: empty translated response");
        return { payload: out, headers: resp.headers, metadata: { usage: parseGeminiCLIUsage(data) } };
      }
      lastStatus = resp.status;
      lastBody = data;
      lastHeaders = resp.headers;
      if (resp.status === 429) {
        if (idx + 1 < models.length) log.debug(`gemini cli executor: rate limited, retrying with next model: ${models[idx + 1]}`);
        else log.debug("gemini cli executor: rate limited, no additional fallback model");
        continue;
      }
      throw newGeminiStatusErr(resp.status, data, resp.headers);
    }
    throw newGeminiStatusErr(lastStatus === 0 ? 429 : lastStatus, lastBody, lastHeaders);
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    if (opts.alt === "responses/compact") throw new StatusError(501, "/responses/compact not supported");
    const baseModel = baseModelOf(req.model);
    await this.accessToken(auth);
    const responseFormat = responseFormatOrSource(opts);
    let body = translateToGemini(req, opts, true, this.identifier);
    body = fixGeminiImageAspectRatio(baseModel, body);
    const projectId = resolveGeminiProjectID(auth);

    let lastStatus = 0;
    let lastBody = "";
    let lastHeaders: Headers | undefined;
    const models = this.attemptModels(baseModel);
    for (let idx = 0; idx < models.length; idx++) {
      const attemptModel = models[idx]!;
      const payload = wrapGeminiCLIRequest(projectId, attemptModel, body);
      const accessToken = await this.accessToken(auth);
      const query = opts.alt ? `?$alt=${opts.alt}` : "?alt=sse";
      const resp = await postUpstream(this.fetchFn, {
        url: this.url("streamGenerateContent", query),
        headers: this.headersFor(auth, opts, accessToken, attemptModel, "text/event-stream"),
        body: payload,
        signal: opts.signal,
        proxyUrl: this.proxyFor(auth, opts),
      });
      if (resp.status < 200 || resp.status >= 300) {
        const data = await resp.text();
        lastStatus = resp.status;
        lastBody = data;
        lastHeaders = resp.headers;
        if (resp.status === 429) {
          if (idx + 1 < models.length) log.debug(`gemini cli executor: rate limited, retrying with next model: ${models[idx + 1]}`);
          else log.debug("gemini cli executor: rate limited, no additional fallback model");
          continue;
        }
        throw newGeminiStatusErr(resp.status, data, resp.headers);
      }
      const originalRequest = originalRequestOf(req, opts);
      if (opts.alt) {
        // Non-SSE alternate: the whole body is one chunk (v7 behaviour).
        const data = await resp.text();
        const state: TranslatorState = {};
        const ctx = { signal: opts.signal };
        const chunks = async function* (): AsyncGenerator<string> {
          for (const out of defaultRegistry.translateStream(ctx, FormatGemini, responseFormat, req.model, originalRequest, body, data, state)) if (out !== "") yield out;
          for (const out of defaultRegistry.translateStream(ctx, FormatGemini, responseFormat, req.model, originalRequest, body, "[DONE]", state)) if (out !== "") yield out;
        };
        return { headers: resp.headers, chunks: chunks() };
      }
      return {
        headers: resp.headers,
        chunks: geminiStreamChunks({
          response: resp,
          responseFormat,
          model: req.model,
          originalRequest,
          translatedRequest: body,
          missingFinish: "flush",
          detectPromptBlock: false,
          dataLinesOnly: true,
          signal: opts.signal,
        }),
      };
    }
    throw newGeminiStatusErr(lastStatus === 0 ? 429 : lastStatus, lastBody, lastHeaders);
  }

  async countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const baseModel = baseModelOf(req.model);
    const accessToken = await this.accessToken(auth);
    const responseFormat = responseFormatOrSource(opts);
    let body = translateToGemini(req, opts, false, this.identifier);
    body = fixGeminiImageAspectRatio(baseModel, body);
    // Code Assist countTokens takes {"request": {...}} without project/model (v7 CountTokens).
    const payload = deleteJSONFields(wrapGeminiCLIRequest("", baseModel, body), "project", "model", "request.safetySettings");
    const query = opts.alt ? `?$alt=${opts.alt}` : "";
    const resp = await postUpstream(this.fetchFn, {
      url: this.url("countTokens", query),
      headers: this.headersFor(auth, opts, accessToken, baseModel, "application/json"),
      body: payload,
      signal: opts.signal,
      proxyUrl: this.proxyFor(auth, opts),
    });
    const data = await resp.text();
    if (resp.status < 200 || resp.status >= 300) throw newGeminiStatusErr(resp.status, data, resp.headers);
    const count = gint(getAt(tryParse<unknown>(data), "totalTokens"));
    const translated = defaultRegistry.translateTokenCount({ signal: opts.signal }, FormatGemini, responseFormat, count, data);
    return { payload: translated, headers: resp.headers };
  }

  /** Refreshes the Google OAuth token (GeminiAuthenticator.refresh); returns the updated copy. */
  async refresh(auth: Auth): Promise<Auth> {
    return this.authenticator.refresh(auth, { fetch: this.fetchFn, now: this.now, proxyUrl: this.proxyFor(auth) });
  }
}

/** Creates the "gemini-cli" executor. */
export function createGeminiCLIExecutor(opts: GeminiCLIExecutorOptions = {}): GeminiCLIExecutor {
  return new GeminiCLIExecutor(opts);
}

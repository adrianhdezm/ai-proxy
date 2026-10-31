// AI Studio executor (provider "aistudio"): Gemini API key against the
// Generative Language API (https://generativelanguage.googleapis.com/v1beta/models/{model}:{action},
// x-goog-api-key) or a configured attributes.base_url.
// Port of current internal/runtime/executor/gemini_executor.go (Execute,
// ExecuteStream, CountTokens, geminiAPIKey, resolveGeminiBaseURL,
// applyGeminiHeaders, capGeminiMaxOutputTokens, prompt-block and finish-signal
// handling) plus the request cleanup of aistudio_executor.go translateRequest
// that applies to the HTTP path (normalizeAIStudioThinkingLevel).
//
// Dropped: the websocket relay transport of aistudio_executor.go (and its
// relay-only deletion of maxOutputTokens/responseMimeType/responseJsonSchema),
// native Interactions, payload config rules, request logging, the usage
// reporter and apply_patch tool-input handling.
import "../../translator/gemini/claude/index.ts";
import { type Auth, AttributeAPIKey, AttributeBaseURL } from "../../auth/types.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import { FormatGemini, FormatOpenAIResponse, type TranslatorState, toolInputFailed } from "../../translator/types.ts";
import { applyPatchTranslationError, applyPatchUpstreamError, ensureResponsesUsageDetails } from "../responses.ts";
import { applyCustomHeadersFromAttrs } from "../../util/header_helpers.ts";
import { getAt, gint } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { sanitizeNonVertexGeminiRequestThoughtSignatures } from "../../signature/index.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, StatusError, type StreamResult, responseFormatOrSource } from "../types.ts";
import { ensureGeminiBoundaryUserContent, ensureGeminiLeadingUserContent, ensureGeminiTrailingUserContent } from "./content_turns.ts";
import { geminiPromptBlockErrorMessage, newGeminiPromptBlockErr, newGeminiStatusErr, translatedClaudeErrorPayload } from "./errors.ts";
import {
  baseModelOf,
  capGeminiMaxOutputTokens,
  deleteJSONFields,
  fixGeminiImageAspectRatio,
  normalizeAIStudioThinkingLevel,
  originalRequestOf,
  setStringIfDifferent,
  translateToGemini,
} from "./request.ts";
import { type ExecutorFetch, geminiStreamChunks, postUpstream } from "./stream.ts";
import { parseGeminiUsage } from "./usage.ts";

export const AIStudioExecutorIdentifier = "aistudio";
/** glEndpoint. */
export const generativeLanguageEndpoint = "https://generativelanguage.googleapis.com";
/** glAPIVersion. */
export const generativeLanguageVersion = "v1beta";

export interface AIStudioExecutorOptions {
  /** Base URL used when the auth has no attributes.base_url (default https://generativelanguage.googleapis.com). */
  baseUrl?: string;
  fetch?: ExecutorFetch;
  /** Unused by this executor (API keys do not expire); accepted for symmetry with gemini-cli. */
  now?: () => number;
  /** Global proxy URL used when neither ExecOptions.proxyUrl nor auth.proxyUrl is set. */
  proxyUrl?: string;
}

/** The API key of the credential (Go: geminiAPIKey). */
export function geminiAPIKey(auth: Auth | undefined): string {
  return auth?.attributes?.[AttributeAPIKey] ?? "";
}

/** attributes.base_url without trailing slashes, else the default (Go: resolveGeminiBaseURL). */
export function resolveGeminiBaseURL(auth: Auth | undefined, fallback: string = generativeLanguageEndpoint): string {
  const custom = (auth?.attributes?.[AttributeBaseURL] ?? "").trim();
  const base = custom !== "" ? custom.replace(/\/+$/, "") : fallback;
  return base === "" ? generativeLanguageEndpoint : base;
}

type Action = "generateContent" | "streamGenerateContent" | "countTokens";

/**
 * Body pipeline modes: "generate" / "stream" (Execute / ExecuteStream),
 * "executeCountTokens" (Execute with metadata.action = "countTokens") and
 * "countTokens" (the CountTokens entry point).
 */
export type AIStudioRequestMode = "generate" | "stream" | "executeCountTokens" | "countTokens";

/**
 * Builds the Generative Language request body (Go: GeminiExecutor Execute /
 * ExecuteStream / CountTokens body pipelines + the aistudio translateRequest
 * cleanup: session_id removal, thinking level upper-casing, countTokens field
 * stripping).
 */
export function prepareAIStudioRequest(req: ExecRequest, opts: ExecOptions, mode: AIStudioRequestMode, providerKey = AIStudioExecutorIdentifier): string {
  const baseModel = baseModelOf(req.model);
  let body = translateToGemini(req, opts, mode === "stream", providerKey);
  body = fixGeminiImageAspectRatio(baseModel, body);
  if (mode === "countTokens") {
    body = deleteJSONFields(body, "tools", "generationConfig", "safetySettings");
    body = setStringIfDifferent(body, "model", baseModel);
    body = sanitizeNonVertexGeminiRequestThoughtSignatures(body, "contents");
    body = ensureGeminiLeadingUserContent(body, "contents");
    return deleteJSONFields(body, "session_id");
  }
  body = setStringIfDifferent(body, "model", baseModel);
  body = capGeminiMaxOutputTokens(body, baseModel);
  body = sanitizeNonVertexGeminiRequestThoughtSignatures(body, "contents");
  if (mode === "stream") {
    body = ensureGeminiBoundaryUserContent(body, "contents");
  } else {
    body = ensureGeminiLeadingUserContent(body, "contents");
    if (mode === "generate") body = ensureGeminiTrailingUserContent(body, "contents");
  }
  body = deleteJSONFields(body, "session_id");
  body = normalizeAIStudioThinkingLevel(body);
  if (mode === "executeCountTokens") body = deleteJSONFields(body, "generationConfig", "tools", "safetySettings");
  return body;
}

export class AIStudioExecutor implements ProviderExecutor {
  readonly identifier = AIStudioExecutorIdentifier;
  private readonly baseUrl: string;
  private readonly fetchFn: ExecutorFetch;
  private readonly globalProxy: string | undefined;

  constructor(opts: AIStudioExecutorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? generativeLanguageEndpoint).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as ExecutorFetch);
    this.globalProxy = opts.proxyUrl;
  }

  private proxyFor(auth: Auth, opts: ExecOptions): string | undefined {
    return opts.proxyUrl ?? (auth.proxyUrl && auth.proxyUrl !== "" ? auth.proxyUrl : this.globalProxy);
  }

  private url(auth: Auth, model: string, action: Action, query: string): string {
    return `${resolveGeminiBaseURL(auth, this.baseUrl)}/${generativeLanguageVersion}/models/${model}:${action}${query}`;
  }

  /** Content-Type, x-goog-api-key (only when set) and the auth's custom headers (Go: applyGeminiHeaders). */
  private headersFor(auth: Auth, opts: ExecOptions): Headers {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    const apiKey = geminiAPIKey(auth);
    if (apiKey !== "") headers.set("x-goog-api-key", apiKey);
    applyCustomHeadersFromAttrs(headers, auth.attributes, { clientHeaders: opts.headers });
    return headers;
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    if (opts.alt === "responses/compact") throw new StatusError(501, "/responses/compact not supported");
    const baseModel = baseModelOf(req.model);
    const responseFormat = responseFormatOrSource(opts);
    const action: Action = req.metadata?.action === "countTokens" ? "countTokens" : "generateContent";
    const body = prepareAIStudioRequest(req, opts, action === "countTokens" ? "executeCountTokens" : "generate", this.identifier);
    const query = opts.alt && action !== "countTokens" ? `?$alt=${opts.alt}` : "";
    const resp = await postUpstream(this.fetchFn, {
      url: this.url(auth, baseModel, action, query),
      headers: this.headersFor(auth, opts),
      body,
      signal: opts.signal,
      proxyUrl: this.proxyFor(auth, opts),
    });
    const data = await resp.text();
    if (resp.status < 200 || resp.status >= 300) throw newGeminiStatusErr(resp.status, data, resp.headers);
    const blockMsg = geminiPromptBlockErrorMessage(data);
    if (blockMsg !== undefined) throw newGeminiPromptBlockErr(blockMsg);
    const state: TranslatorState = {};
    let out = defaultRegistry.translateNonStream({ signal: opts.signal }, FormatGemini, responseFormat, req.model, originalRequestOf(req, opts), body, data, state);
    if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
    if (toolInputFailed(state) || out === "") throw new StatusError(502, "aistudio executor: empty translated response");
    const errPayload = translatedClaudeErrorPayload(responseFormat, out);
    if (errPayload !== undefined) throw new StatusError(502, errPayload, { body: errPayload });
    if (responseFormat === FormatOpenAIResponse) out = ensureResponsesUsageDetails(out);
    return { payload: out, headers: resp.headers, metadata: { usage: parseGeminiUsage(data) } };
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    if (opts.alt === "responses/compact") throw new StatusError(501, "/responses/compact not supported");
    const baseModel = baseModelOf(req.model);
    const responseFormat = responseFormatOrSource(opts);
    const body = prepareAIStudioRequest(req, opts, "stream", this.identifier);
    const query = opts.alt ? `?$alt=${opts.alt}` : "?alt=sse";
    const resp = await postUpstream(this.fetchFn, {
      url: this.url(auth, baseModel, "streamGenerateContent", query),
      headers: this.headersFor(auth, opts),
      body,
      signal: opts.signal,
      proxyUrl: this.proxyFor(auth, opts),
    });
    if (resp.status < 200 || resp.status >= 300) {
      const data = await resp.text();
      throw newGeminiStatusErr(resp.status, data, resp.headers);
    }
    return {
      headers: resp.headers,
      chunks: geminiStreamChunks({
        response: resp,
        responseFormat,
        model: req.model,
        originalRequest: originalRequestOf(req, opts),
        translatedRequest: body,
        missingFinish: "truncate",
        detectPromptBlock: true,
        dataLinesOnly: false,
        signal: opts.signal,
      }),
    };
  }

  async countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const baseModel = baseModelOf(req.model);
    const responseFormat = responseFormatOrSource(opts);
    const body = prepareAIStudioRequest(req, opts, "countTokens", this.identifier);
    const resp = await postUpstream(this.fetchFn, {
      url: this.url(auth, baseModel, "countTokens", ""),
      headers: this.headersFor(auth, opts),
      body,
      signal: opts.signal,
      proxyUrl: this.proxyFor(auth, opts),
    });
    const data = await resp.text();
    if (resp.status < 200 || resp.status >= 300) throw newGeminiStatusErr(resp.status, data, resp.headers);
    const count = gint(getAt(tryParse<unknown>(data), "totalTokens"));
    const translated = defaultRegistry.translateTokenCount({ signal: opts.signal }, FormatGemini, responseFormat, count, data);
    return { payload: translated, headers: resp.headers };
  }

  /** API keys do not refresh: the auth is returned unchanged. */
  async refresh(auth: Auth): Promise<Auth> {
    return auth;
  }
}

/** Creates the "aistudio" executor. */
export function createAIStudioExecutor(opts: AIStudioExecutorOptions = {}): AIStudioExecutor {
  return new AIStudioExecutor(opts);
}

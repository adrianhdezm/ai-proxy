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
// Not ported (outside this slice): SIWC credentials and body rules, zstd request
// compression, websockets transport, image endpoints and the image_generation
// tool injection, /responses/compact, multi-agent v2 optimisation, the reasoning
// replay cache, bootstrap buffering, prompt-cache keys (Session-Id), the payload
// config finalizer, usage reporting and request logging, the Claude input-token
// estimate on message_start, and the Home refresh/file-lock path.
import type { Auth } from "../../auth/types.ts";
import { CodexAuthenticator } from "../../auth/codex/index.ts";
import { FormatCodex, type Format, type TranslateContext, type TranslatorState } from "../../translator/types.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import "../../translator/codex/claude/index.ts";
import { parseSuffix } from "../../thinking/index.ts";
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, type StreamResult, StatusError, responseFormatOrSource } from "../types.ts";
import { codexAuthUsesAPIKey, codexBaseURL, codexCreds, isNativeCodexRequest } from "./creds.ts";
import {
  codexTerminalFailureErrWithCooling,
  hasMeaningfulCodexOutputDelta,
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
import { CodexSSEScanner, scanCodexSSEText } from "./sse_scanner.ts";
import { asRequestError, applyRequestThinking, resolvedModelInfo } from "./thinking.ts";
import { countCodexInputTokens } from "./tokens.ts";
import { normalizeCodexToolSchemas } from "./tool_schema.ts";

/** Injectable fetch for tests; defaults to the global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
  /** Clock (epoch ms) for resets_at / Retry-After dates and refresh timestamps. */
  now?: () => number;
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
}

/** Stateless executor for the Codex Responses API (Go: CodexExecutor). */
export class CodexExecutor implements ProviderExecutor {
  readonly identifier = "codex";
  private readonly options: CodexExecutorOptions;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(options: CodexExecutorOptions = {}) {
    this.options = options;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  private get modelLevelCooling(): boolean {
    return this.options.modelLevelCooling === true;
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
    const isCompat = resolvedModelInfo(req)?.isCompat === true;
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
    body = normalizeCodexParallelToolCalls(body, opts.headers);
    body = normalizeCodexToolSchemas(body);
    body = sanitizeCodexInputItemIDs(body);

    const url = baseURL.replace(/\/+$/, "") + "/responses";
    const headers = new Headers();
    applyCodexHeaders(headers, auth, apiKey, true, { disableCloaking: this.options.disableCloaking, headerDefaults: this.options.headerDefaults }, opts.headers);
    applyCodexRoutingHint(headers, auth, baseModel, body, opts.headers);
    applyModelHeaderOverrides(headers, baseModel);
    return { url, headers, body, originalPayload, from, responseFormat, preserveNativeOutput };
  }

  private async send(auth: Auth, prepared: PreparedRequest, opts: ExecOptions): Promise<Response> {
    const init: RequestInit & { proxy?: string } = { method: "POST", headers: prepared.headers, body: prepared.body, signal: opts.signal };
    const proxy = (opts.proxyUrl ?? auth.proxyUrl ?? "").trim();
    if (proxy !== "") init.proxy = proxy;
    return this.fetchFn(prepared.url, init);
  }

  /** Reads a rejected response and classifies it (Go: newCodexStatusErrWithHeadersAndCooling). */
  private async statusError(resp: Response): Promise<StatusError> {
    let body = "";
    try {
      body = await resp.text();
    } catch {
      // An unreadable error body is classified by its status alone.
    }
    log.debug("codex executor: request error", { status: resp.status });
    return newCodexStatusErrWithHeadersAndCooling(resp.status, resp.headers, body, this.modelLevelCooling, this.now());
  }

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    const prepared = this.prepare(auth, req, opts, false);
    const resp = await this.send(auth, prepared, opts);
    if (resp.status < 200 || resp.status >= 300) throw await this.statusError(resp);

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
      if (failure) throw failure.error;

      if (eventType === "response.output_item.done") {
        collectCodexOutputItemDone(root, items);
        continue;
      }
      if (eventType !== "response.completed" && eventType !== "response.incomplete") continue;
      if (isCodexTerminalEmptyIncomplete(root, collectedOutputItemCount(items), sawOutputDelta)) throw newCodexEmptyIncompleteStreamError();

      const completedData = patchedEventData(eventData, root, items, false);
      const state: TranslatorState = {};
      const ctx: TranslateContext = { signal: opts.signal };
      const out = defaultRegistry.translateNonStream(ctx, FormatCodex, prepared.responseFormat, req.model, prepared.originalPayload, prepared.body, completedData, state);
      if (out.length === 0) throw new StatusError(502, "upstream returned an unusable response");
      const usage = parseCodexUsage(root);
      return { payload: out, headers: resp.headers, metadata: usage ? { usage } : undefined };
    }
    if (readError !== undefined && opts.signal?.aborted) throw readError;
    throw newCodexIncompleteStreamError();
  }

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    const prepared = this.prepare(auth, req, opts, true);
    const resp = await this.send(auth, prepared, opts);
    if (resp.status < 200 || resp.status >= 300) throw await this.statusError(resp);
    return { headers: resp.headers, chunks: this.streamChunks(resp, req, opts, prepared) };
  }

  /**
   * Translates the upstream SSE body line by line (Go: the ExecuteStream reader
   * goroutine without bootstrap buffering). A terminal failure event throws its
   * classified StatusError after everything already emitted; a body that ends
   * without a terminal event throws the 502 empty-stream error when nothing was
   * emitted (the manager fails over) and otherwise the truncated-stream error.
   */
  private async *streamChunks(resp: Response, req: ExecRequest, opts: ExecOptions, prepared: PreparedRequest): AsyncGenerator<string> {
    const state: TranslatorState = {};
    const ctx: TranslateContext = { signal: opts.signal };
    const items = newCollectedOutputItems();
    let sawOutputDelta = false;
    let emitted = 0;

    // Returns the translated frames of one scanned line and whether it was a terminal success event.
    const handleLine = (line: string): { chunks: string[]; terminal: boolean } => {
      let translatedLine = line;
      let terminal = false;
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        const root = tryParse<unknown>(data);
        translatedLine = "data: " + data;
        const eventType = codexEventType(root, data);
        const failure = codexTerminalFailureErrWithCooling(data, this.modelLevelCooling, this.now());
        if (failure) throw failure.error;
        if (hasMeaningfulCodexOutputDelta(root)) sawOutputDelta = true;
        if (isCodexTerminalEmptyIncomplete(root, collectedOutputItemCount(items), sawOutputDelta)) throw newCodexEmptyIncompleteStreamError();
        switch (eventType) {
          case "response.output_item.done":
            collectCodexOutputItemDone(root, items);
            break;
          case "response.completed":
          case "response.incomplete":
          case "response.done":
            terminal = true;
            translatedLine = "data: " + (prepared.preserveNativeOutput ? normalizedCompletion(data, root) : patchedEventData(data, root, items, true));
            break;
        }
      }
      const chunks = defaultRegistry.translateStream(ctx, FormatCodex, prepared.responseFormat, req.model, prepared.originalPayload, prepared.body, translatedLine, state);
      return { chunks, terminal };
    };

    const body = resp.body;
    if (!body) throw new StatusError(502, codexEmptyStreamMessage);
    const reader = body.getReader();
    const scanner = new CodexSSEScanner({ onDiagnostic: logSSEDiagnostic });
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let drained = false;
    try {
      let readError: unknown;
      for (;;) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (err) {
          readError = err;
          break;
        }
        const lines = result.done ? scanner.flush() : scanner.push(result.value);
        for (const line of lines) {
          const out = handleLine(line);
          for (const chunk of out.chunks) {
            if (chunk.length === 0) continue;
            emitted++;
            yield chunk;
          }
          if (out.terminal) return;
        }
        if (result.done) {
          drained = true;
          break;
        }
      }
      if (opts.signal?.aborted) return;
      if (readError !== undefined) log.debug("codex executor: upstream stream read error", { error: readError instanceof Error ? readError.message : String(readError) });
      if (emitted === 0) throw new StatusError(502, codexEmptyStreamMessage);
      throw newCodexIncompleteStreamError();
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      // Stop the upstream body unless it was read to the end (terminal event, error, early consumer stop).
      if (!drained) reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  /**
   * Token counting (Go: CountTokens). Translates the request like Execute and
   * estimates the prompt locally (ceil(chars / 4), see tokens.ts); Claude
   * responses are `{"input_tokens":N}`.
   */
  async countTokens(_auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
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
    body = normalizeCodexInstructions(body, isNativeCodexRequest(req.payload, from, responseFormat, opts.headers));
    const count = countCodexInputTokens(body);
    const usageJSON = JSON.stringify({ response: { usage: { input_tokens: count, output_tokens: 0, total_tokens: count } } });
    return { payload: defaultRegistry.translateTokenCount({ signal: opts.signal }, FormatCodex, responseFormat, count, usageJSON) };
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

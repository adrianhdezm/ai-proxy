// Translator registry. Port of sdk/translator/registry.go without the plugin hooks.
//
// Dispatch rules (identical to upstream):
// - register(from, to, request, response) stores the request transform under
//   requests[from][to] and the response transform under responses[from][to].
// - translateRequest(from, to) looks up requests[from][to].
// - translateStream / translateNonStream / translateTokenCount(from, to) look up
//   responses[to][from]: `from` is the upstream schema the chunk is in and `to`
//   is the client schema, i.e. the same registration that translated the request.
import {
  type Format,
  type RequestTransform,
  type ResponseTransform,
  type TranslateContext,
  type TranslatorState,
  toolInputFailed,
} from "./types.ts";
import { tryParse } from "../util/json.ts";

export class TranslatorRegistry {
  private readonly requests = new Map<Format, Map<Format, RequestTransform>>();
  private readonly responses = new Map<Format, Map<Format, ResponseTransform>>();

  /** Stores request/response transforms between two formats. */
  register(from: Format, to: Format, request: RequestTransform | undefined, response: ResponseTransform = {}): void {
    if (request) {
      if (!this.requests.has(from)) this.requests.set(from, new Map());
      this.requests.get(from)!.set(to, request);
    }
    if (!this.responses.has(from)) this.responses.set(from, new Map());
    this.responses.get(from)!.set(to, response);
  }

  /** Removes the request and response transforms for one format pair. */
  unregister(from: Format, to: Format): void {
    const req = this.requests.get(from);
    if (req) {
      req.delete(to);
      if (req.size === 0) this.requests.delete(from);
    }
    const res = this.responses.get(from);
    if (res) {
      res.delete(to);
      if (res.size === 0) this.responses.delete(from);
    }
  }

  /**
   * Converts a payload between schemas. Without a registered translator the
   * original payload is returned, except that a prefixed "model" field
   * (e.g. "copilot/gpt-5-mini") is rewritten to the resolved model name.
   */
  translateRequest(from: Format, to: Format, model: string, rawJSON: string, stream: boolean): string {
    const fn = this.requests.get(from)?.get(to);
    if (fn) return fn(model, rawJSON, stream);
    return normalizeFallbackModel(model, rawJSON);
  }

  hasRequestTransformer(from: Format, to: Format): boolean {
    return !!this.requests.get(from)?.get(to);
  }

  hasResponseTransformer(from: Format, to: Format): boolean {
    const fn = this.responses.get(from)?.get(to);
    return !!fn && hasAnyResponseTransform(fn);
  }

  hasStreamResponseTransformer(from: Format, to: Format): boolean {
    return !!this.responses.get(from)?.get(to)?.stream;
  }

  hasNonStreamResponseTransformer(from: Format, to: Format): boolean {
    return !!this.responses.get(from)?.get(to)?.nonStream;
  }

  hasTokenCountTransformer(from: Format, to: Format): boolean {
    return !!this.responses.get(to)?.get(from)?.tokenCount;
  }

  /** Applies the registered streaming response translator (responses[to][from]). */
  translateStream(
    ctx: TranslateContext,
    from: Format,
    to: Format,
    model: string,
    originalRequestRawJSON: string,
    requestRawJSON: string,
    rawJSON: string,
    state: TranslatorState,
  ): string[] {
    const stream = this.responses.get(to)?.get(from)?.stream;
    if (stream) {
      const outputs = stream(ctx, model, originalRequestRawJSON, requestRawJSON, rawJSON, state) ?? [];
      return outputs;
    }
    if (toolInputFailed(state)) return [];
    return [rawJSON];
  }

  /** Applies the registered non-stream response translator (responses[to][from]). */
  translateNonStream(
    ctx: TranslateContext,
    from: Format,
    to: Format,
    model: string,
    originalRequestRawJSON: string,
    requestRawJSON: string,
    rawJSON: string,
    state: TranslatorState,
  ): string {
    const nonStream = this.responses.get(to)?.get(from)?.nonStream;
    if (nonStream) {
      const body = nonStream(ctx, model, originalRequestRawJSON, requestRawJSON, rawJSON, state);
      if (toolInputFailed(state)) return "";
      return body ?? "";
    }
    if (toolInputFailed(state)) return "";
    return rawJSON;
  }

  /** Applies the registered token count translator, or returns rawJSON unchanged. */
  translateTokenCount(ctx: TranslateContext, from: Format, to: Format, count: number, rawJSON: string): string {
    const fn = this.responses.get(to)?.get(from)?.tokenCount;
    return fn ? fn(ctx, count) : rawJSON;
  }
}

function hasAnyResponseTransform(fn: ResponseTransform): boolean {
  return !!(fn.stream || fn.nonStream || fn.tokenCount);
}

/** Rewrites a prefixed "model" field to the resolved model name; otherwise returns rawJSON unchanged. */
export function normalizeFallbackModel(model: string, rawJSON: string): string {
  if (model === "") return rawJSON;
  const parsed = tryParse<Record<string, unknown>>(rawJSON);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawJSON;
  const current = parsed.model;
  if (typeof current !== "string" || current === model) return rawJSON;
  if (!current.endsWith("/" + model)) return rawJSON;
  parsed.model = model;
  return JSON.stringify(parsed);
}

/** Package-level registry shared by the built-in translators. */
export const defaultRegistry = new TranslatorRegistry();

export const register = defaultRegistry.register.bind(defaultRegistry);
export const unregister = defaultRegistry.unregister.bind(defaultRegistry);
export const translateRequest = defaultRegistry.translateRequest.bind(defaultRegistry);
export const translateStream = defaultRegistry.translateStream.bind(defaultRegistry);
export const translateNonStream = defaultRegistry.translateNonStream.bind(defaultRegistry);
export const translateTokenCount = defaultRegistry.translateTokenCount.bind(defaultRegistry);
export const hasRequestTransformer = defaultRegistry.hasRequestTransformer.bind(defaultRegistry);
export const hasResponseTransformer = defaultRegistry.hasResponseTransformer.bind(defaultRegistry);
export const hasStreamResponseTransformer = defaultRegistry.hasStreamResponseTransformer.bind(defaultRegistry);
export const hasNonStreamResponseTransformer = defaultRegistry.hasNonStreamResponseTransformer.bind(defaultRegistry);
export const hasTokenCountTransformer = defaultRegistry.hasTokenCountTransformer.bind(defaultRegistry);

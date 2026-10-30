// Shared fakes for the OpenAI API-key executor tests: a fake chat.completions
// upstream on Bun.serve (port 0), auth/config builders and SSE frame parsing.
import { defaultConfig } from "../../../src/config/load.ts";
import type { Config, ModelOverride } from "../../../src/config/types.ts";
import { type Auth, AttributeConfigIndex, AttributeSourceBackend, AuthSourceConfig, newAuth } from "../../../src/auth/types.ts";
import { getAt, gint, gstr } from "../../../src/util/gpath.ts";
import { tryParse } from "../../../src/util/json.ts";
import type { StreamResult } from "../../../src/executor/types.ts";

export interface CapturedUpstreamRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

export type UpstreamHandler = (req: CapturedUpstreamRequest) => Response | Promise<Response>;

export interface FakeUpstream {
  /** Base URL including the "/v1" suffix, like the Go tests' server.URL + "/v1". */
  baseURL: string;
  requests: CapturedUpstreamRequest[];
  /** Replaces the handler for the next requests. */
  respond(handler: UpstreamHandler): void;
  /** Last captured upstream body ("" when none). */
  lastBody(): string;
  close(): void;
}

/** Starts a fake upstream on 127.0.0.1:0 (Go: httptest.NewServer). */
export function startUpstream(handler: UpstreamHandler): FakeUpstream {
  const requests: CapturedUpstreamRequest[] = [];
  let current = handler;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const captured: CapturedUpstreamRequest = { url: new URL(request.url).pathname, method: request.method, headers: request.headers, body: await request.text() };
      requests.push(captured);
      return current(captured);
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    respond(next) {
      current = next;
    },
    lastBody() {
      return requests.length === 0 ? "" : requests[requests.length - 1]!.body;
    },
    close() {
      server.stop(true);
    },
  };
}

export function jsonResponse(body: string | object, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A text/event-stream response with the given raw body. */
export function sseResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } });
}

/** A text/event-stream response that writes `parts` in order (optionally awaiting a gate between them) then closes. */
export function sseChunkedResponse(parts: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
        await Promise.resolve();
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } });
}

/** A complete chat completion body (Go test fixture shape). */
export const simpleChatCompletion = `{"id":"chatcmpl_1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`;

export interface ApiKeyAuthOptions {
  baseURL: string;
  apiKey?: string;
  /** Extra attributes (e.g. "header:X-Test"). */
  attributes?: Record<string, string>;
  /** Index into cfg.openaiApiKeys for model overrides. */
  configIndex?: number;
  proxyUrl?: string;
}

/** An "openai" API-key auth as the config synthesiser would produce it. */
export function apiKeyAuth(options: ApiKeyAuthOptions): Auth {
  const attributes: Record<string, string> = { base_url: options.baseURL, ...(options.attributes ?? {}) };
  if (options.apiKey !== undefined) attributes.api_key = options.apiKey;
  if (options.configIndex !== undefined) {
    attributes[AttributeSourceBackend] = AuthSourceConfig;
    attributes[AttributeConfigIndex] = String(options.configIndex);
  }
  return newAuth({ id: "openai:test", provider: "openai", attributes, proxyUrl: options.proxyUrl });
}

/** Model override literal with the optional compat knobs the executor reads (Go: config.OpenAICompatibilityModel). */
export type CompatModelOverride = ModelOverride & { useMaxCompletionTokens?: boolean; inputModalities?: string[] };

export function modelOverride(partial: Partial<CompatModelOverride> & Pick<CompatModelOverride, "name">): CompatModelOverride {
  return { alias: "", displayName: "", maxContextLength: 0, isCompat: false, forceMapping: false, ...partial };
}

/** A config whose single openai API key carries the given model overrides. */
export function configWithModels(models: CompatModelOverride[]): Config {
  const cfg = defaultConfig();
  cfg.openaiApiKeys = [
    { apiKey: "test-key", baseUrl: "", models, proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [] },
  ];
  return cfg;
}

// gjson-style readers
export function getString(body: string, path: string): string {
  return gstr(getAt(tryParse(body), path));
}

export function getInt(body: string, path: string): number {
  return gint(getAt(tryParse(body), path));
}

export function getValue(body: string, path: string): unknown {
  return getAt(tryParse(body), path);
}

export function exists(body: string, path: string): boolean {
  return getValue(body, path) !== undefined;
}

export interface ClaudeSSEEvent {
  type: string;
  payload: string;
}

/** Parses "event: X\ndata: Y\n\n" frames (one or more per emitted chunk). */
export function parseClaudeEvents(chunks: string[]): ClaudeSSEEvent[] {
  const events: ClaudeSSEEvent[] = [];
  for (const chunk of chunks) {
    for (const frame of chunk.split(/\n\n+/)) {
      if (!frame.startsWith("event: ")) continue;
      const nl = frame.indexOf("\n");
      if (nl < 0) continue;
      const type = frame.slice("event: ".length, nl);
      const rest = frame.slice(nl + 1);
      if (!rest.startsWith("data: ")) continue;
      events.push({ type, payload: rest.slice("data: ".length) });
    }
  }
  return events;
}

/** Drains a StreamResult, returning the chunks and the terminal error if any. */
export async function drain(result: StreamResult): Promise<{ chunks: string[]; error: unknown }> {
  const chunks: string[] = [];
  try {
    for await (const chunk of result.chunks) chunks.push(chunk);
  } catch (err) {
    return { chunks, error: err };
  }
  return { chunks, error: undefined };
}

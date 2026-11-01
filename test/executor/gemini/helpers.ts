// Fake Generative Language / Code Assist / Google token upstreams for the Gemini
// executor tests (Bun.serve on port 0, localhost only).
import { newAuth, type Auth } from "../../../src/auth/types.ts";
import type { StreamResult } from "../../../src/executor/types.ts";

export interface Captured {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: string;
}

export type Handler = (req: Captured) => Response | Promise<Response>;

export interface FakeUpstream {
  url: string;
  requests: Captured[];
  setHandler(h: Handler): void;
  stop(): void;
}

/** Starts a fake upstream; every request is recorded before the handler runs. */
export function startFakeUpstream(handler: Handler): FakeUpstream {
  let current = handler;
  const requests: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const u = new URL(request.url);
      const captured: Captured = { method: request.method, path: decodeURIComponent(u.pathname), search: u.search, headers: request.headers, body: await request.text() };
      requests.push(captured);
      return current(captured);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setHandler(h) {
      current = h;
    },
    stop() {
      server.stop(true);
    },
  };
}

export function json(body: string | object, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function sse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** An SSE response that emits `text` and then fails the body (truncated transfer). */
export function erroringSSE(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    pull(controller) {
      controller.error(new Error("unexpected EOF"));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/** An SSE response that emits `text` and then stays open until `release` resolves. */
export function hangingSSE(text: string, release: Promise<void>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      await release;
      try {
        controller.close();
      } catch {
        // already cancelled
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

export function aistudioAuth(baseUrl: string, apiKey = "test-key", extra: Record<string, string> = {}): Auth {
  return newAuth({ id: "aistudio-test", provider: "aistudio", attributes: { api_key: apiKey, base_url: baseUrl, ...extra } });
}

/** Drains a stream; returns the concatenated payload and the thrown error, if any. */
export async function drain(result: StreamResult): Promise<{ text: string; chunks: string[]; error?: unknown }> {
  const chunks: string[] = [];
  try {
    for await (const chunk of result.chunks) chunks.push(chunk);
  } catch (error) {
    return { text: chunks.join(""), chunks, error };
  }
  return { text: chunks.join(""), chunks };
}

/** The event names of a Claude SSE text, in order. */
export function claudeEvents(text: string): string[] {
  return [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!);
}

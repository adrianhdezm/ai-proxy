// Shared helpers for the Claude executor tests: a fake Anthropic server on
// Bun.serve (port 0), auth builders, header-application shorthand and stream
// collection. Stand-ins for httptest.NewServer / roundTripperFunc in the Go tests.
import zlib from "node:zlib";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import type { ExecOptions, StreamResult } from "../../../src/executor/types.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { type ApplyClaudeHeadersOptions, applyClaudeHeaders } from "../../../src/executor/claude/headers.ts";

export interface SeenRequest {
  url: string;
  path: string;
  headers: Headers;
  body: string;
}

export interface FakeUpstream {
  url: string;
  requests: SeenRequest[];
  stop(): void;
}

export type UpstreamHandler = (req: SeenRequest, raw: Request) => Response | Promise<Response>;

/** Starts a fake Anthropic-compatible upstream; the handler sees the parsed request. */
export function startUpstream(handler: UpstreamHandler): FakeUpstream {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(raw) {
      const body = await raw.text();
      const u = new URL(raw.url);
      const seen: SeenRequest = { url: raw.url, path: u.pathname, headers: raw.headers, body };
      requests.push(seen);
      return handler(seen, raw);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

export function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function sseResponse(body: string | Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } });
}

/** An SSE response whose body stays open after `prefix` until the client goes away. */
export function heldOpenSSE(prefix: string, released: Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(prefix));
      await released;
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export const okMessageJSON = `{"id":"msg_1","type":"message","model":"claude-opus-4-6","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`;

export function apiKeyAuth(baseUrl: string | undefined, extra: Record<string, string> = {}, id = "claude-auth-1"): Auth {
  const attributes: Record<string, string> = { api_key: "key-123", ...extra };
  if (baseUrl !== undefined) attributes.base_url = baseUrl;
  return newAuth({ id, provider: "claude", attributes });
}

/** The OAuth fixture metadata used across the Go tests (claudeOAuthTestMetadata). */
export function claudeOAuthTestMetadata(): Record<string, unknown> {
  return {
    account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    claude_device_ids: ["0000000000000000000000000000000000000000000000000000000000000000"],
  };
}

export function oauthAuth(baseUrl: string | undefined, token = "sk-ant-oat-test-token", extra: Record<string, string> = {}, id = "claude-oauth-1"): Auth {
  const attributes: Record<string, string> = { ...extra };
  if (baseUrl !== undefined) attributes.base_url = baseUrl;
  return newAuth({ id, provider: "claude", attributes, metadata: { access_token: token, ...claudeOAuthTestMetadata() } });
}

export function claudeOpts(partial: Partial<ExecOptions> = {}): ExecOptions {
  return { stream: false, sourceFormat: "claude", ...partial };
}

export const anthropicMessagesURL = "https://api.anthropic.com/v1/messages?beta=true";

/** Applies the Claude headers to a fresh Headers object (stand-in for applyClaudeHeaders(req, ...)). */
export function headersFor(o: Omit<ApplyClaudeHeadersOptions, "headers"> & { headers?: Headers }): Headers {
  const headers = o.headers ?? new Headers();
  applyClaudeHeaders({ ...o, headers });
  return headers;
}

export interface Collected {
  chunks: string[];
  error?: unknown;
}

/** Drains a StreamResult, capturing the terminal error instead of throwing. */
export async function collect(result: StreamResult): Promise<Collected> {
  const chunks: string[] = [];
  try {
    for await (const chunk of result.chunks) chunks.push(chunk);
    return { chunks };
  } catch (error) {
    return { chunks, error };
  }
}

export async function expectStatusError(p: Promise<unknown>): Promise<StatusError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof StatusError) return err;
    throw new Error(`expected StatusError, got ${String(err)}`);
  }
  throw new Error("expected an error, got none");
}

export function gzip(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(Bun.gzipSync(typeof data === "string" ? new TextEncoder().encode(data) : data));
}

export function encodeBody(encoding: string, plain: Uint8Array): Uint8Array {
  switch (encoding) {
    case "gzip":
      return new Uint8Array(Bun.gzipSync(plain));
    case "deflate":
      return new Uint8Array(Bun.deflateSync(plain));
    case "zlib":
      return new Uint8Array(zlib.deflateSync(plain));
    case "br":
      return new Uint8Array(zlib.brotliCompressSync(plain));
    case "zstd":
      return new Uint8Array(Bun.zstdCompressSync(plain));
    default:
      throw new Error(`unknown encoding ${encoding}`);
  }
}

export function streamOf(...pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(p);
      controller.close();
    },
  });
}

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
export const SECOND = 1000;

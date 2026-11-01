// Shared fakes for the Codex executor tests: a fake /responses upstream on
// Bun.serve (port 0), raw-SSE fetch stubs (Go: the "cliproxy.roundtripper"
// context transports), auth builders and stream draining.
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import type { ExecOptions, ExecRequest, StreamResult } from "../../../src/executor/types.ts";
import { getAt, gstr } from "../../../src/util/gpath.ts";
import { tryParse } from "../../../src/util/json.ts";
import { CodexExecutor, type CodexExecutorOptions, type FetchLike } from "../../../src/executor/codex/index.ts";
import { AuthManager } from "../../../src/auth/manager/index.ts";
import { getGlobalRegistry } from "../../../src/registry/index.ts";

export interface CapturedRequest {
  path: string;
  headers: Headers;
  body: string;
}

export type UpstreamHandler = (req: CapturedRequest) => Response | Promise<Response>;

export interface FakeUpstream {
  url: string;
  requests: CapturedRequest[];
  close(): void;
}

/** Starts a fake upstream on 127.0.0.1:0 (Go: httptest.NewServer). */
export function startUpstream(handler: UpstreamHandler): FakeUpstream {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const captured: CapturedRequest = { path: new URL(request.url).pathname, headers: request.headers, body: await request.text() };
      requests.push(captured);
      return handler(captured);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close() {
      server.stop(true);
    },
  };
}

/** A text/event-stream response with the given raw body. */
export function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * A text/event-stream response whose body yields `parts` and then either ends
 * cleanly or fails with a transport error (Go: io.MultiReader(..., unexpectedEOFReader{})).
 */
export function sseStreamResponse(parts: string[], opts: { failWith?: Error } = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(encoder.encode(parts[index]!));
        index++;
        return;
      }
      if (opts.failWith) controller.error(opts.failWith);
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A fetch stub answering every request with a fresh response (Go: codexAllocationTransport / roundTripperFunc). */
export function stubFetch(make: (url: string, init?: RequestInit) => Response): { fetch: FetchLike; calls: Array<{ url: string; body: string; headers: Headers }> } {
  const calls: Array<{ url: string; body: string; headers: Headers }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "", headers: new Headers(init?.headers) });
      return make(url, init);
    },
  };
}

/** API-key auth (Go: &cliproxyauth.Auth{Attributes: {"api_key", "base_url"}}). */
export function apiKeyAuth(baseURL: string, apiKey = "test", extra: Record<string, string> = {}): Auth {
  const attributes: Record<string, string> = { api_key: apiKey, ...extra };
  if (baseURL !== "") attributes.base_url = baseURL;
  return newAuth({ id: "codex:test", provider: "codex", attributes });
}

/** ChatGPT OAuth auth (metadata.access_token / account_id). */
export function oauthAuth(opts: { accessToken?: string; accountId?: string; baseURL?: string; refreshToken?: string } = {}): Auth {
  const metadata: Record<string, unknown> = { type: "codex", access_token: opts.accessToken ?? "oauth-token", account_id: opts.accountId ?? "acct_123" };
  if (opts.refreshToken !== undefined) metadata.refresh_token = opts.refreshToken;
  const attributes: Record<string, string> = {};
  if (opts.baseURL) attributes.base_url = opts.baseURL;
  return newAuth({ id: "codex-oauth.json", provider: "codex", attributes, metadata });
}

export function request(model: string, payload: string, metadata?: Record<string, unknown>): ExecRequest {
  return { model, payload, format: "claude", metadata };
}

export function options(sourceFormat: string, stream: boolean, extra: Partial<ExecOptions> = {}): ExecOptions {
  return { stream, sourceFormat, ...extra } as ExecOptions;
}

/** Claude Messages payload with a single user turn. */
export function claudePayload(model: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }], ...extra });
}

/** Drains a StreamResult, returning the non-empty chunks and the terminal error if any. */
export async function drain(result: StreamResult): Promise<{ chunks: string[]; error: unknown }> {
  const chunks: string[] = [];
  try {
    for await (const chunk of result.chunks) if (chunk.length > 0) chunks.push(chunk);
  } catch (err) {
    return { chunks, error: err };
  }
  return { chunks, error: undefined };
}

export function getString(body: string, path: string): string {
  return gstr(getAt(tryParse(body), path));
}

export function getValue(body: string, path: string): unknown {
  return getAt(tryParse(body), path);
}

/**
 * A well-formed GPT reasoning encrypted_content (Fernet-shaped: version 0x80,
 * 8-byte timestamp, 16-byte IV, one AES block, 32-byte HMAC) (Go: validCodexReasoningEncryptedContentForTest).
 */
export function validCodexReasoningEncryptedContentForTest(): string {
  const payload = new Uint8Array(1 + 8 + 16 + 16 + 32);
  payload[0] = 0x80;
  for (let i = 9; i < payload.length; i++) payload[i] = i;
  return Buffer.from(payload).toString("base64url");
}

/** JSON.parse validity (Go: json.Valid). */
export function jsonValid(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Asserts `raw` is `{"error":{"type":wantType,"code":wantCode}}` (Go: assertCodexErrorCode). */
export function codexErrorCode(raw: string): { type: string; code: string } {
  const root = tryParse(raw);
  return { type: gstr(getAt(root, "error.type")), code: gstr(getAt(root, "error.code")) };
}

// ---------------------------------------------------------------------------
// Cross-module helpers: the real AuthManager with the global model registry
// ---------------------------------------------------------------------------


export interface CodexManagerHarness {
  manager: AuthManager;
  /** Registers an API-key Codex credential (and its models in the global registry). */
  addAuth(id: string, apiKey: string, baseURL: string, opts: { priority?: number; disableCooling: boolean; models: string[] }): void;
  /** Unregisters every client this harness registered in the global registry. */
  cleanup(): void;
}

/** Go: cliproxyauth.NewManager(nil, &RoundRobinSelector{}, nil) + SetRetryConfig + RegisterExecutor(NewCodexExecutor(cfg)). */
export function codexManager(retry: { requestRetry: number; maxRetryCredentials: number }, executorOptions: CodexExecutorOptions = {}): CodexManagerHarness {
  const manager = new AuthManager({ sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(retry.requestRetry, 0, retry.maxRetryCredentials);
  manager.registerExecutor(new CodexExecutor(executorOptions));
  const registered: string[] = [];
  return {
    manager,
    addAuth(id, apiKey, baseURL, opts) {
      getGlobalRegistry().registerClient(
        id,
        "codex",
        opts.models.map((model) => ({ id: model, type: "codex" })),
      );
      registered.push(id);
      const attributes: Record<string, string> = { base_url: baseURL, api_key: apiKey };
      if (opts.priority !== undefined) attributes.priority = String(opts.priority);
      manager.register(newAuth({ id, provider: "codex", attributes, metadata: { disable_cooling: opts.disableCooling } }));
    },
    cleanup() {
      for (const id of registered) getGlobalRegistry().unregisterClient(id);
    },
  };
}

/** The account a fake upstream request belongs to (Go: strings.TrimPrefix(Authorization, "Bearer ")). */
export function accountOf(req: CapturedRequest): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
}

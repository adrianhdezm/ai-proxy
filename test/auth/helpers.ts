// Shared helpers for the auth tests: a routable fake fetch (stand-in for the
// Go roundTripFunc transports), JWT and compression builders.
import type { FetchLike } from "../../src/auth/oauth/http.ts";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  init: (RequestInit & { proxy?: string; decompress?: boolean }) | undefined;
}

export type Route = (req: CapturedRequest) => Response | Promise<Response>;

export interface FakeFetch extends FetchLike {
  calls: CapturedRequest[];
}

/** Builds a fetch that records every request and delegates to `route`. */
export function fakeFetch(route: Route): FakeFetch {
  const calls: CapturedRequest[] = [];
  const fn = (async (input: string, init?: RequestInit & { proxy?: string; decompress?: boolean }) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? rawBody : rawBody instanceof URLSearchParams ? rawBody.toString() : rawBody ? String(rawBody) : "";
    const req: CapturedRequest = { url: input, method: (init?.method ?? "GET").toUpperCase(), headers, body, init };
    calls.push(req);
    return route(req);
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
}

export function jsonResponse(body: string | object, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** A response whose body stream fails mid-read (io.ErrUnexpectedEOF stand-in). */
export function erroringBodyResponse(status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("unexpected EOF"));
    },
  });
  return new Response(stream, { status });
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unsigned JWT with the given payload (alg none), like makeTestJWT in the Go tests. */
export function makeTestJWT(payload: Record<string, unknown>): string {
  const enc = new TextEncoder();
  const header = base64Url(enc.encode(`{"alg":"none","typ":"JWT"}`));
  const claims = base64Url(enc.encode(JSON.stringify(payload)));
  return `${header}.${claims}.`;
}

/** Codex ID token with the auth claim (makeTestCodexJWT in sdk/auth/codex_auth_record_test.go). */
export function makeTestCodexJWT(planType: string, accountID: string): string {
  const authInfo: Record<string, unknown> = { chatgpt_account_id: accountID };
  if (planType !== "") authInfo.chatgpt_plan_type = planType;
  return makeTestJWT({ email: "user@example.com", "https://api.openai.com/auth": authInfo });
}

export async function compress(bytes: Uint8Array, format: Bun.CompressionFormat): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream(format))).arrayBuffer());
}

export const fixedNowMs = Date.parse("2026-10-28T12:00:00Z");
export const fixedNow = () => fixedNowMs;

/** A deferred promise used to hold a fake upstream call open. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function noopSleep(): Promise<void> {
  return Promise.resolve();
}

/** Yields to the event loop a few times so queued promise callbacks run. */
export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

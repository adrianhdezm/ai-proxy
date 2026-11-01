// Upstream request compression and response decoding for the Codex HTTP
// transport. Port of the zstd half of CodexExecutor.cacheHelper,
// alignCodexContentEncoding, decodeCodexUpstreamResponse and doCodexRequest
// (internal/runtime/executor/codex_executor_request.go), and of
// config.CodexConfig.RequestCompressionMinBytes.
//
// codex.upstream-request-compression (default off) zstd-compresses request
// bodies of at least upstream-request-compression-min-bytes (default 1024)
// when all of these hold: the credential is ChatGPT OAuth (never an API key or
// a SIWC credential), the URL is https?://chatgpt.com/backend-api/codex/...
// (so never a custom base URL), and the compressed body is smaller. A 400 or
// 415 answer to a compressed body is retried once with the plaintext body.
//
// Responses are requested with Accept-Encoding "gzip, deflate, br, zstd" and
// fetched with Bun's automatic decompression off (Bun keeps the
// Content-Encoding header after decoding, which would make a second decode
// ambiguous); a response with a Content-Encoding header is decoded here and
// handed on without Content-Encoding / Content-Length. Deviation: Go also
// sniffed gzip/zstd magic on responses without the header; only labelled
// responses are decoded here.
import type { Auth } from "../../auth/types.ts";
import { decodeResponseBody } from "../claude/response.ts";
import { log } from "../../log.ts";
import { codexAuthUsesAPIKey } from "./creds.ts";

/** Accept-Encoding sent on Codex HTTP requests (Go: cacheHelper). */
export const codexAcceptEncoding = "gzip, deflate, br, zstd";

/** Default minimum body size for request compression (Go: RequestCompressionMinBytes). */
export const codexDefaultRequestCompressionMinBytes = 1024;

export interface CodexRequestCompressionPolicy {
  /** codex.upstream-request-compression (default false). */
  enabled?: boolean;
  /** codex.upstream-request-compression-min-bytes (default 1024; zero or negative means the default). */
  minBytes?: number;
}

/** Go: CodexConfig.RequestCompressionMinBytes. */
export function codexRequestCompressionMinBytes(minBytes: number | undefined): number {
  return minBytes !== undefined && Number.isFinite(minBytes) && minBytes > 0 ? Math.floor(minBytes) : codexDefaultRequestCompressionMinBytes;
}

function usesSIWC(auth: Auth): boolean {
  const raw = auth.metadata?.use_siwc;
  return raw === true || (typeof raw === "string" && raw.trim().toLowerCase() === "true");
}

/** Whether a request to `url` may be sent zstd-compressed (Go: the cacheHelper gate, size excluded). */
export function codexRequestCompressionEligible(policy: CodexRequestCompressionPolicy | undefined, auth: Auth | undefined, url: string): boolean {
  if (policy?.enabled !== true || !auth || codexAuthUsesAPIKey(auth) || usesSIWC(auth)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.hostname.toLowerCase() === "chatgpt.com" && parsed.pathname.startsWith("/backend-api/codex/");
}

const encoder = new TextEncoder();

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? encoder.encode(body) : body;
}

/**
 * The bytes to put on the wire: the zstd-compressed body when compression is
 * eligible, the body reaches the minimum size and compressing makes it
 * smaller, otherwise the plaintext body itself (Go: cacheHelper).
 */
export function codexRequestWireBody(policy: CodexRequestCompressionPolicy | undefined, auth: Auth | undefined, url: string, plain: string | Uint8Array): string | Uint8Array {
  if (!codexRequestCompressionEligible(policy, auth, url)) return plain;
  const bytes = toBytes(plain);
  if (bytes.length < codexRequestCompressionMinBytes(policy?.minBytes)) return plain;
  let compressed: Uint8Array;
  try {
    compressed = Bun.zstdCompressSync(bytes);
  } catch (err) {
    log.error("codex executor: compress request body error", { error: err instanceof Error ? err.message : String(err) });
    return plain;
  }
  return compressed.length < bytes.length ? compressed : plain;
}

function prefixOf(body: string | Uint8Array, n: number): Uint8Array {
  if (typeof body === "string") return encoder.encode(body.slice(0, n));
  return body.subarray(0, n);
}

function encodingTokens(value: string): string[] {
  return value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}

/**
 * Makes Content-Encoding describe the bytes actually sent (an operator
 * "header:Content-Encoding" rule cannot relabel them): JSON or multipart
 * plaintext gets none; a single zstd / gzip layer is named by its magic; a
 * declared chain of several encodings is trusted; a stray "zstd" label on
 * opaque bytes is dropped (Go: alignCodexContentEncoding).
 */
export function alignCodexContentEncoding(headers: Headers, body: string | Uint8Array): void {
  const prefix = prefixOf(body, 512);
  let start = 0;
  while (start < prefix.length && isSpace(prefix[start]!)) start++;
  const first = prefix[start];
  const jsonPlaintext = first === 0x7b || first === 0x5b;
  const contentType = (headers.get("Content-Type") ?? "").trim().toLowerCase();
  const multipartPlaintext = contentType.startsWith("multipart/") && prefix[start] === 0x2d && prefix[start + 1] === 0x2d;
  if (jsonPlaintext || multipartPlaintext) {
    headers.delete("Content-Encoding");
    return;
  }
  const declared = encodingTokens(headers.get("Content-Encoding") ?? "");
  // Magic identifies only the outermost layer, so trust declared encoding chains.
  if (declared.filter((token) => token.toLowerCase() !== "identity").length > 1) return;
  if (prefix[0] === 0x28 && prefix[1] === 0xb5 && prefix[2] === 0x2f && prefix[3] === 0xfd) {
    headers.set("Content-Encoding", "zstd");
    return;
  }
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    headers.set("Content-Encoding", "gzip");
    return;
  }
  // Our zstd encoder always emits its magic; keep opaque non-zstd encodings.
  const remaining = declared.filter((token) => token.toLowerCase() !== "zstd");
  if (remaining.length !== declared.length) {
    headers.delete("Content-Encoding");
    if (remaining.length > 0) headers.set("Content-Encoding", remaining.join(", "));
  }
}

/**
 * Decodes a Content-Encoding-labelled response and drops Content-Encoding /
 * Content-Length from the headers handed on (Go: decodeCodexUpstreamResponse).
 */
export function decodeCodexUpstreamResponse(resp: Response): Response {
  const encoding = (resp.headers.get("Content-Encoding") ?? "").trim();
  if (encoding === "" || encoding.toLowerCase() === "identity" || resp.body === null) return resp;
  let body: ReadableStream<Uint8Array>;
  try {
    body = decodeResponseBody(resp.body, encoding);
  } catch (err) {
    throw new Error(`codex executor: decode upstream response: ${err instanceof Error ? err.message : String(err)}`);
  }
  const headers = new Headers(resp.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers });
}

/** Fetch signature of the Codex transports; `decompress: false` keeps the wire bytes. */
export type CodexFetch = (input: string, init?: RequestInit & { proxy?: string; decompress?: boolean }) => Promise<Response>;

export interface CodexRequestInit {
  headers: Headers;
  signal?: AbortSignal;
  proxy?: string;
}

/**
 * Sends one Codex request and decodes its answer; a compressed body rejected
 * with 400 or 415 is retried once as plaintext, with the same headers minus
 * Content-Encoding (Go: doCodexRequest). `plain` is the final upstream body,
 * `wire` what codexRequestWireBody chose to send.
 */
export async function doCodexRequest(fetchFn: CodexFetch, url: string, init: CodexRequestInit, plain: string | Uint8Array, wire: string | Uint8Array): Promise<Response> {
  const send = (headers: Headers, body: string | Uint8Array) => {
    const request: RequestInit & { proxy?: string; decompress?: boolean } = { method: "POST", headers, body: body as RequestInit["body"], signal: init.signal, decompress: false };
    if (init.proxy !== undefined) request.proxy = init.proxy;
    return fetchFn(url, request);
  };
  alignCodexContentEncoding(init.headers, wire);
  const compressed = init.headers.get("Content-Encoding") === "zstd";
  const resp = decodeCodexUpstreamResponse(await send(init.headers, wire));
  if (!compressed || (resp.status !== 400 && resp.status !== 415)) return resp;
  log.debug("codex executor: compressed request rejected, retrying uncompressed", { status: resp.status });
  try {
    await resp.body?.cancel();
  } catch {
    // The rejected body is discarded either way.
  }
  const headers = new Headers(init.headers);
  headers.delete("Content-Encoding");
  alignCodexContentEncoding(headers, plain);
  return decodeCodexUpstreamResponse(await send(headers, plain));
}

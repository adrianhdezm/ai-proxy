// Ported from: internal/api/response_compression_test.go
// Ported from: internal/api/response_compression_review_test.go
// Ported from: internal/api/response_compression_server_test.go
// Skipped cases: TestResponseCompressionReusesPooledEncoders / TestResponseCompressionReusesEncoderAfterWriteFailure
// (Go sync.Pool encoder reuse; the port creates one node:zlib encoder per response),
// TestResponseCompressionWriteAfterFinishFails / TestResponseCompressionFlushError /
// TestResponseCompressionPlaintextWriterContract / TestResponseCompressionPlaintextHijack /
// TestResponseCompressionWriterContract / TestResponseCompressionWriterHeaderNowContract /
// TestResponseCompressionPanicFinalization / TestResponseCompressionVaryCommitPaths /
// TestResponseCompressionVaryChangedWhileBuffered (gin ResponseWriter Write/WriteHeader/Flush/Hijack
// and panic mechanics; the port compresses a finished Response object whose headers are fixed before
// the body), the informational (103) and explicit_header rows of TestResponseCompression (no
// interim responses or early header commit on a Response), TestWebsocketCompressionServerHotReload
// (permessage-deflate is not negotiated by the Bun server and config hot reload is not ported).
// TestResponseCompressionServerHotReload is adapted: each config is a fresh server instead of a reload.
import { afterAll, describe, expect, test } from "bun:test";
import { constants, gunzipSync, zstdDecompressSync } from "node:zlib";
import { parseConfig } from "../../src/config/load.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import { compressResponse, negotiateResponseCompression, type ResponseCompressionOptions } from "../../src/server/response_compression.ts";
import { createServer, serverOptionsFromConfig } from "../../src/server/server.ts";
import { fakeManager, messagesRequest } from "./helpers.ts";

function decode(encoding: string, body: Uint8Array): string {
  if (encoding === "gzip") return new TextDecoder().decode(gunzipSync(body));
  if (encoding === "zstd") return new TextDecoder().decode(Bun.zstdDecompressSync(body));
  return new TextDecoder().decode(body);
}

async function bodyBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

interface HandlerSpec {
  body: string;
  contentType?: string;
  existingEncoding?: string;
  contentLength?: boolean;
  status?: number;
  vary?: string;
}

/** The gin handler of the Go table test as a Response: Content-Type, Vary: Origin, optional headers, the body in two halves. */
function handlerResponse(spec: HandlerSpec): Response {
  const headers = new Headers({ "Content-Type": spec.contentType ?? "application/json" });
  if (spec.vary !== undefined) headers.set("Vary", spec.vary);
  if (spec.existingEncoding) headers.set("Content-Encoding", spec.existingEncoding);
  if (spec.contentLength) headers.set("Content-Length", String(new TextEncoder().encode(spec.body).byteLength));
  const status = spec.status ?? 200;
  if (status === 204 || status === 304) return new Response(null, { status, headers });
  const half = Math.floor(spec.body.length / 2);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(spec.body.slice(0, half)));
      controller.enqueue(encoder.encode(spec.body.slice(half)));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

function request(accept: string | undefined, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (accept !== undefined) headers["Accept-Encoding"] = accept;
  return new Request("http://proxy.test/", { method: init.method ?? "GET", headers });
}

describe("TestResponseCompression", () => {
  const body = `{"message":"${"compressible text ".repeat(128)}"}`;
  const cases: { name: string; accept?: string; encoding?: string; body?: string; contentType?: string; existingEncoding?: string; status?: number; method?: string; contentLength?: boolean }[] = [
    { name: "zstd", accept: "zstd", encoding: "zstd" },
    { name: "gzip", accept: "gzip", encoding: "gzip" },
    { name: "large_known_length", accept: "gzip", encoding: "gzip", contentLength: true },
    { name: "no_accept" },
    { name: "identity", accept: "identity" },
    { name: "excluded", accept: "gzip;q=0" },
    { name: "preference", accept: "gzip;q=1,zstd;q=0.5", encoding: "gzip" },
    { name: "preference_tie", accept: "zstd;q=0.5,gzip;q=0.5", encoding: "zstd" },
    { name: "small_identity_refused", accept: "gzip, identity;q=0", body: "{}", encoding: "gzip" },
    { name: "small_known_length_identity_refused", accept: "gzip, identity;q=0", body: "{}", encoding: "gzip", contentLength: true },
    { name: "small_wildcard_identity_refused", accept: "gzip, *;q=0", body: "{}", encoding: "gzip" },
    { name: "small_identity_overrides_wildcard", accept: "gzip, *;q=0, identity;q=1", body: "{}" },
    { name: "identity_refused_no_encoding", accept: "identity;q=0,*;q=0", body: "{}" },
    { name: "wildcard", accept: "*;q=0.5", encoding: "zstd" },
    { name: "wildcard_explicit_exclusion", accept: "*;q=1,zstd;q=0", encoding: "gzip" },
    { name: "all_excluded", accept: "*;q=1,zstd;q=0,gzip;q=0" },
    { name: "invalid_quality", accept: "zstd;q=invalid,gzip;q=2" },
    { name: "small", accept: "zstd", body: "{}" },
    { name: "small_known_length", accept: "gzip", body: "{}", contentLength: true },
    { name: "existing_encoding", accept: "gzip", existingEncoding: "br" },
    { name: "binary", accept: "zstd", contentType: "image/png" },
    { name: "json_suffix", accept: "gzip", contentType: "application/problem+json; charset=utf-8", encoding: "gzip" },
    { name: "partial", accept: "gzip", status: 206 },
    { name: "no_content", accept: "gzip", status: 204 },
    { name: "not_modified", accept: "gzip", status: 304 },
    { name: "head", accept: "gzip", method: "HEAD" },
    { name: "string_writer", accept: "gzip", encoding: "gzip" },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const payload = tc.body ?? body;
      const response = await compressResponse(
        request(tc.accept ?? "", { method: tc.method }),
        handlerResponse({ body: payload, contentType: tc.contentType, existingEncoding: tc.existingEncoding, contentLength: tc.contentLength, status: tc.status, vary: "Origin" }),
        {},
      );
      const wantEncoding = tc.existingEncoding ?? tc.encoding ?? "";
      expect(response.headers.get("Content-Encoding") ?? "").toBe(wantEncoding);
      if (tc.encoding) {
        const vary = response.headers.get("Vary") ?? "";
        expect(vary).toContain("Origin");
        expect(vary).toContain("Accept-Encoding");
        expect(response.headers.get("Content-Length")).toBeNull();
      }
      if (tc.contentLength && !tc.encoding) expect(response.headers.get("Content-Length")).toBe(String(payload.length));
      const wantBody = tc.status === 204 || tc.status === 304 ? "" : payload;
      expect(decode(tc.encoding ?? "", await bodyBytes(response))).toBe(wantBody);
    });
  }
});

test("negotiateResponseCompression ranks quality, then zstd over gzip", () => {
  expect(negotiateResponseCompression("gzip, zstd")).toEqual({ encoding: "zstd", identityAllowed: true });
  expect(negotiateResponseCompression("identity;q=0")).toEqual({ encoding: "", identityAllowed: false });
  expect(negotiateResponseCompression("br")).toEqual({ encoding: "", identityAllowed: true });
});

test("TestResponseCompressionDisabled", async () => {
  for (const options of [{ enabled: false }] as ResponseCompressionOptions[]) {
    const response = await compressResponse(request("zstd"), new Response("text".repeat(1024), { headers: { "Content-Type": "text/plain; charset=utf-8" } }), options);
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Vary")).toBeNull();
  }
});

test("TestResponseCompressionWebsocketUpgradeSkipped", async () => {
  const original = new Response("text".repeat(1024), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const response = await compressResponse(request("gzip", { headers: { Upgrade: "websocket" } }), original, {});
  expect(response).toBe(original);
  expect(response.headers.get("Content-Encoding")).toBeNull();
  expect(response.headers.get("Vary")).toBeNull();
});

describe("TestResponseCompressionSSEIncremental", () => {
  const events = ["data: first\n\n", "data: second\n\n", "data: third\n\n"];
  let advance: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index >= events.length) {
            controller.close();
            return;
          }
          if (index > 0) await new Promise<void>((resolve) => (advance = resolve));
          controller.enqueue(encoder.encode(events[index++]!));
        },
      });
      return compressResponse(req, new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), {});
    },
  });
  afterAll(() => server.stop(true));

  for (const encoding of ["zstd", "gzip"]) {
    test(encoding, async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { "Accept-Encoding": encoding }, decompress: false } as RequestInit);
      expect(response.headers.get("Content-Encoding")).toBe(encoding);
      const reader = response.body!.getReader();
      let received = new Uint8Array(0);
      const decodedSoFar = (): string | undefined => {
        if (received.byteLength === 0) return "";
        try {
          if (encoding === "zstd") return new TextDecoder().decode(zstdDecompressSync(received));
          return new TextDecoder().decode(gunzipSync(received, { finishFlush: constants.Z_SYNC_FLUSH }));
        } catch {
          return undefined; // a partial block: keep reading
        }
      };
      let expected = "";
      for (const event of events) {
        expected += event;
        // Each event is decodable before the handler writes the next one.
        while (decodedSoFar() !== expected) {
          const next = await reader.read();
          if (next.done) throw new Error(`stream ended before ${JSON.stringify(event)}`);
          const merged = new Uint8Array(received.byteLength + next.value.byteLength);
          merged.set(received);
          merged.set(next.value, received.byteLength);
          received = merged;
        }
        advance?.();
        advance = undefined;
      }
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const merged = new Uint8Array(received.byteLength + next.value.byteLength);
        merged.set(received);
        merged.set(next.value, received.byteLength);
        received = merged;
      }
      expect(decode(encoding, received)).toBe(events.join(""));
    });
  }
});

describe("TestResponseCompressionVary", () => {
  const cases: { name: string; accept?: string; encoding?: string; minBytes?: number; vary?: string[]; addVary?: string[]; contentLength?: boolean }[] = [
    { name: "below_min", accept: "gzip" },
    { name: "below_min_origin", accept: "gzip", vary: ["Origin"] },
    { name: "below_min_known_length", accept: "gzip", contentLength: true },
    { name: "no_acceptable_encoding", accept: "br" },
    { name: "identity", accept: "identity" },
    { name: "identity_origin", accept: "identity", vary: ["Origin"] },
    { name: "br_added_token", accept: "br", addVary: ["accept-encoding"] },
    { name: "identity_duplicate_tokens", accept: "identity", vary: ["Origin, Accept-Encoding"], addVary: ["accept-encoding, ACCEPT-ENCODING"] },
    { name: "excluded", accept: "gzip;q=0" },
    { name: "identity_refused_no_encoding", accept: "*;q=0, identity;q=0" },
    { name: "empty_accept" },
    { name: "no_accept_origin", vary: ["Origin"] },
    { name: "gzip_origin", accept: "gzip", minBytes: 1, encoding: "gzip", vary: ["Origin"] },
    { name: "zstd_origin", accept: "zstd", minBytes: 1, encoding: "zstd", vary: ["Origin"] },
    { name: "gzip_existing_token", accept: "gzip", minBytes: 1, encoding: "gzip", vary: ["Origin", "accept-encoding"] },
    { name: "gzip_duplicate_tokens", accept: "gzip", minBytes: 1, encoding: "gzip", vary: ["Origin, Accept-Encoding"], addVary: ["accept-encoding"] },
    { name: "zstd_duplicate_tokens", accept: "zstd", minBytes: 1, encoding: "zstd", vary: ["Origin, Accept-Encoding"], addVary: ["ACCEPT-ENCODING"] },
    { name: "plaintext_existing_token", accept: "gzip", vary: ["Origin, ACCEPT-ENCODING"] },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const value of [...(tc.vary ?? []), ...(tc.addVary ?? [])]) headers.append("Vary", value);
      if (tc.contentLength) headers.set("Content-Length", "2");
      const response = await compressResponse(request(tc.accept), new Response("{}", { headers }), { minBytes: tc.minBytes });
      expect(response.headers.get("Content-Encoding") ?? "").toBe(tc.encoding ?? "");
      const tokens = (response.headers.get("Vary") ?? "").split(",").map((t) => t.trim().toLowerCase());
      expect(tokens.filter((t) => t === "accept-encoding")).toHaveLength(1);
      if (tc.vary) expect(tokens.filter((t) => t === "origin")).toHaveLength(1);
      expect(decode(tc.encoding ?? "", await bodyBytes(response))).toBe("{}");
    });
  }
});

describe("TestResponseCompressionVaryPaths", () => {
  for (const name of ["disabled", "head", "websocket", "no_accept", "already_encoded", "binary", "no_content", "not_modified", "empty"]) {
    test(name, async () => {
      const headers = new Headers({ "Content-Type": name === "binary" ? "application/octet-stream" : "application/json", Vary: "Origin" });
      if (name === "already_encoded") headers.set("Content-Encoding", "br");
      let response: Response;
      if (name === "no_content") response = new Response(null, { status: 204, headers });
      else if (name === "not_modified") response = new Response(null, { status: 304, headers });
      else if (name === "empty") response = new Response(null, { status: 200, headers });
      else response = new Response("{}", { headers });
      const extra: Record<string, string> = name === "websocket" ? { Upgrade: "websocket" } : {};
      const out = await compressResponse(request(name === "no_accept" ? undefined : "gzip", { method: name === "head" ? "HEAD" : "GET", headers: extra }), response, name === "disabled" ? { enabled: false } : {});
      const want = name === "disabled" || name === "websocket" ? "Origin" : "Origin, Accept-Encoding";
      expect(out.headers.get("Vary")).toBe(want);
    });
  }
});

describe("server wiring", () => {
  const bigText = "response text ".repeat(128);
  const manager = () =>
    fakeManager({
      execute: async (_providers, req) => ({ payload: JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: bigText }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }),
    });
  const registry = () => {
    const r = new ModelRegistry();
    r.registerClient("c1", "claude", [{ id: "claude-sonnet-4-6", type: "claude" }]);
    return r;
  };

  test("TestResponseCompressionServerHotReload (adapted: one server per setting)", async () => {
    const cases: { options?: ResponseCompressionOptions; encoding: string }[] = [
      { options: { enabled: true }, encoding: "zstd" },
      { options: { enabled: false }, encoding: "" },
      { options: { enabled: true, minBytes: 1_000_000 }, encoding: "" },
      { options: { enabled: true, minBytes: 1 }, encoding: "zstd" },
      { options: undefined, encoding: "zstd" },
    ];
    for (const tc of cases) {
      const server = createServer({ manager: manager(), registry: registry(), responseCompression: tc.options });
      const response = await server.fetch(messagesRequest("claude-sonnet-4-6", false, { headers: { "Accept-Encoding": "zstd" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Encoding") ?? "").toBe(tc.encoding);
      const text = decode(tc.encoding, await bodyBytes(response));
      expect(JSON.parse(text).content[0].text).toBe(bigText);
      // CORS headers are still applied to the compressed response.
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  test("server.response-compression is read from the config", () => {
    const cfg = parseConfig("server:\n  response-compression:\n    enabled: false\n    min-bytes: 64\n");
    expect(cfg.server.responseCompression).toEqual({ enabled: false, minBytes: 64 });
    const options = serverOptionsFromConfig(cfg, manager(), registry());
    expect(options.responseCompression).toEqual({ enabled: false, minBytes: 64 });
    expect(parseConfig("server:\n  port: 8317\n").server.responseCompression).toBeUndefined();
  });
});

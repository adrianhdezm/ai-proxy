// Ported from: internal/api/max_request_body_bytes_test.go
// Skipped cases: the config-version 8 ValidateV8Config call (the port has one config layout; the
// server/legacy/precedence parse checks are kept), the /v1/chat/completions, /v1beta generateContent
// and /v1beta/interactions endpoints (OpenAI chat and Gemini inbound are not ported; /v1/messages and
// /v1/responses carry the cases), "unauthenticated chunked body with plugin auth fallback" (access
// plugins are not ported), the hot-reload half of "default off and hot reload update limit" (config
// hot reload is not ported) and "v8 management chunked body exceeding limit" (Management API).
// "zstd ... with request-log enabled" runs once: the port has no request log.
// The byte counters bound reads to the limit plus one source chunk instead of Go's limit+1 bytes:
// the counting source here yields 16-byte chunks.
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import { createServer } from "../../src/server/server.ts";
import { fakeManager } from "./helpers.ts";

/** A pull-based body that counts the bytes handed to the reader. */
function countingBody(text: string, chunkSize = 16): { stream: ReadableStream<Uint8Array>; read: () => number } {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.byteLength, offset + chunkSize);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, read: () => offset };
}

function post(path: string, body: BodyInit, headers: Record<string, string>): Request {
  return new Request(`http://proxy.test${path}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

function server(maxRequestBodyBytes: number) {
  return createServer({ manager: fakeManager(), registry: new ModelRegistry(), apiKeys: ["test-key"], maxRequestBodyBytes });
}

test("TestMaxRequestBodyBytesConfigV8Validation (parse half)", () => {
  expect(parseConfig("server:\n  max-request-body-bytes: 64\n").server.maxRequestBodyBytes).toBe(64);
  expect(parseConfig("max-request-body-bytes: 128\n").server.maxRequestBodyBytes).toBe(128);
  expect(parseConfig("max-request-body-bytes: 128\nserver:\n  max-request-body-bytes: 0\n").server.maxRequestBodyBytes).toBe(0);
  // A negative limit disables the cap.
  expect(parseConfig("server:\n  max-request-body-bytes: -1\n").server.maxRequestBodyBytes).toBe(0);
});

describe("TestServerMaxRequestBodyBytesRejectsContentLengthAndChunkedBodies", () => {
  test("content-length exceeding limit returns 413 without reading body", async () => {
    const counter = countingBody("a".repeat(128));
    const response = await server(64).fetch(post("/v1/messages", counter.stream, { "Content-Type": "application/json", "Content-Length": "128", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(413);
    expect(counter.read()).toBe(0);
  });

  test("unauthenticated chunked body returns 401 without reading body", async () => {
    const counter = countingBody("b".repeat(1024));
    const response = await server(64).fetch(post("/v1/messages", counter.stream, { "Content-Type": "application/json" }));
    expect(response.status).toBe(401);
    expect(counter.read()).toBe(0);
  });

  test("authenticated chunked body is bounded and returns 413", async () => {
    const counter = countingBody("b".repeat(1024));
    const response = await server(64).fetch(post("/v1/messages", counter.stream, { "Content-Type": "application/json", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(413);
    expect(counter.read()).toBeLessThanOrEqual(64 + 16);
  });

  for (const endpoint of ["/v1/responses", "/v1/messages"]) {
    test(`authenticated chunked body exceeding limit returns 413 on ${endpoint}`, async () => {
      const payload = `{"model":"gpt-5","messages":[{"role":"user","content":"${"x".repeat(128)}"}]}`;
      const response = await server(64).fetch(post(endpoint, countingBody(payload).stream, { "Content-Type": "application/json", Authorization: "Bearer test-key" }));
      expect(response.status).toBe(413);
    });
  }

  test("zstd decompressed body exceeding limit returns 413", async () => {
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(`{"model":"gpt-5","input":"${"z".repeat(512)}"}`));
    expect(compressed.byteLength).toBeLessThan(128);
    const response = await server(128).fetch(post("/v1/responses", compressed, { "Content-Type": "application/json", "Content-Encoding": "zstd", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(413);
  });

  test("default off: a large body reaches routing (400 model_not_found)", async () => {
    const payload = `{"model":"gpt-5","input":"${"d".repeat(128)}"}`;
    const response = await server(0).fetch(post("/v1/responses", payload, { "Content-Type": "application/json", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown provider for model gpt-5");
  });

  test("exact boundary body is accepted", async () => {
    const exactPayload = `{"model":"gpt-5","input":"ok"}`;
    expect(exactPayload.length).toBe(30);
    const response = await server(30).fetch(post("/v1/responses", exactPayload, { "Content-Type": "application/json", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown provider for model gpt-5");
  });

  test("negative limit disables request body cap", async () => {
    const payload = `{"model":"gpt-5","input":"${"a".repeat(256)}"}`;
    const response = await server(-1).fetch(post("/v1/responses", payload, { "Content-Type": "application/json", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown provider for model gpt-5");
  });

  test("multipart chunked body exceeding limit returns 413", async () => {
    const form = new FormData();
    form.set("model", "gpt-image-1");
    form.set("prompt", "p".repeat(128));
    const encoded = new Response(form);
    const contentType = encoded.headers.get("Content-Type")!;
    const bytes = new TextDecoder().decode(await encoded.arrayBuffer());
    const response = await server(30).fetch(post("/v1/images/edits", countingBody(bytes).stream, { "Content-Type": contentType, Authorization: "Bearer test-key" }));
    expect(response.status).toBe(413);
  });

  test("MaxInt64 limit does not overflow the zstd decoder bound", async () => {
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(`{"model":"gpt-5","input":"ok"}`));
    const response = await server(Number.MAX_SAFE_INTEGER).fetch(post("/v1/responses", compressed, { "Content-Type": "application/json", "Content-Encoding": "zstd", Authorization: "Bearer test-key" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown provider for model gpt-5");
  });
});

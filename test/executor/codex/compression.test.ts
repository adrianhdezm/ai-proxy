// Ported from: internal/runtime/executor/codex_executor_compression_test.go
// Ported from: internal/runtime/executor/codex_executor_compression_review_test.go
// Skipped cases: TestCodexUpstreamCompression_FinalPayload (asserts the payload finalizer runs once before
//   compression; payload config rules / finalizers are not ported; the retry tests below still check the plaintext
//   retry carries exactly the body that was compressed), and in TestCodexExecutor_CompressionRejectedFallback,
//   TestCodexUpstreamCompression_DirectImagePayloadRewrite and TestCodexImageCompressionRejectedFallback the
//   `audit` payload-override assertions (payload override rules are not ported).
// Adaptations: Go's cacheHelper / *http.Request become codexRequestWireBody (the wire bytes) plus
//   alignCodexContentEncoding / doCodexRequest on Headers; Go's PrepareRequest (the alpha-search passthrough, not
//   ported) is replaced in the prepare=true variants by applyCodexHeaders, which applies the same operator
//   "header:" rules, followed by the alignment. The "cliproxy.roundtripper" transports are fetch stubs; the
//   compressed-image direct=false cases use a non-direct image model on a ChatGPT OAuth credential (Go: a SIWC
//   credential, not ported) so they take the Responses-tool path.
import { describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import {
  CodexExecutor,
  alignCodexContentEncoding,
  applyCodexHeaders,
  codexAcceptEncoding,
  codexRequestCompressionMinBytes,
  codexRequestWireBody,
  codexRoutingHintHeader,
  doCodexRequest,
  type CodexRequestCompressionPolicy,
} from "../../../src/executor/codex/index.ts";
import { FormatOpenAIImage } from "../../../src/executor/openai/images.ts";
import { RequestPathMetadataKey, type ExecOptions } from "../../../src/executor/types.ts";
import { drain, getString, startUpstream } from "./helpers.ts";

const enabled: CodexRequestCompressionPolicy = { enabled: true };
const chatgptResponses = "https://chatgpt.com/backend-api/codex/responses";
const codexCompletedEventBody = `{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`;
const decoder = new TextDecoder();

/** Go: codexCompressionAuth (ChatGPT OAuth, default base URL). */
function codexCompressionAuth(attributes: Record<string, string> = {}, metadata: Record<string, unknown> = {}): Auth {
  return newAuth({ id: "codex-oauth", provider: "codex", attributes, metadata: { access_token: "test-oauth", ...metadata } });
}

/** Go: codexCompressionPayload. */
function codexCompressionPayload(): string {
  return `{"model":"gpt-5.4","input":[{"role":"user","content":"${"compressible input ".repeat(400)}"}]}`;
}

function bytesOf(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/** Go: codexCompressedResponse. */
function compressed(encoding: string, plain: string | Uint8Array): Uint8Array {
  const data = bytesOf(plain);
  switch (encoding) {
    case "gzip":
      return Bun.gzipSync(data);
    case "br":
      return new Uint8Array(zlib.brotliCompressSync(data));
    case "zstd":
      return Bun.zstdCompressSync(data);
  }
  throw new Error(`unknown encoding ${encoding}`);
}

function imageOptions(path: string, stream: boolean): ExecOptions {
  return { stream, sourceFormat: FormatOpenAIImage, metadata: { [RequestPathMetadataKey]: path } };
}

/** A fetch stub recording each request (headers, encoding, raw body) (Go: roundTripperFunc). */
function recordingFetch(answer: (call: { url: string; headers: Headers; body: Uint8Array; index: number }) => Response) {
  const calls: Array<{ url: string; headers: Headers; body: Uint8Array; decompress?: boolean }> = [];
  const fetch = async (url: string, init?: RequestInit & { decompress?: boolean }) => {
    const raw = init?.body;
    const body = typeof raw === "string" ? new TextEncoder().encode(raw) : raw instanceof Uint8Array ? raw : new Uint8Array(0);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers, body, decompress: init?.decompress });
    return answer({ url, headers, body, index: calls.length - 1 });
  };
  return { fetch, calls };
}

describe("TestCodexUpstreamCompression_EligibleCompressed", () => {
  for (const target of [chatgptResponses, "https://CHATGPT.COM/backend-api/codex/responses/compact"]) {
    test(target, () => {
      const payload = codexCompressionPayload();
      const wire = codexRequestWireBody(enabled, codexCompressionAuth(), target, payload);
      expect(wire).toBeInstanceOf(Uint8Array);
      const bytes = wire as Uint8Array;
      expect(bytes.length).toBeLessThan(payload.length);
      expect(decoder.decode(Bun.zstdDecompressSync(bytes))).toBe(payload);
      const headers = new Headers();
      alignCodexContentEncoding(headers, bytes);
      expect(headers.get("Content-Encoding")).toBe("zstd");
    });
  }

  test("end to end: compressed wire, Accept-Encoding, plaintext body kept for translation", async () => {
    const rec = recordingFetch(() => new Response(`data: ${codexCompletedEventBody}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
    const executor = new CodexExecutor({ fetch: rec.fetch, upstreamRequestCompression: true });
    const payload = codexCompressionPayload();
    const resp = await executor.execute(codexCompressionAuth(), { model: "gpt-5.4", payload, format: "openai-response" }, { stream: false, sourceFormat: "openai-response" });
    expect(getString(resp.payload, "id")).toBe("resp_1");
    const call = rec.calls[0]!;
    expect(call.url).toBe(chatgptResponses);
    expect(call.headers.get("Content-Encoding")).toBe("zstd");
    expect(call.headers.get("Accept-Encoding")).toBe(codexAcceptEncoding);
    expect(call.decompress).toBe(false);
    const plain = decoder.decode(Bun.zstdDecompressSync(call.body));
    expect(getString(plain, "model")).toBe("gpt-5.4");
    expect(getString(plain, "input.0.content.0.text") || getString(plain, "input.0.content")).toContain("compressible input");
  });
});

describe("TestCodexUpstreamCompression_Gates", () => {
  const cases: Record<string, () => { policy: CodexRequestCompressionPolicy | undefined; auth: Auth | undefined; target: string; payload: string }> = {
    disabled: () => ({ policy: { enabled: false }, auth: codexCompressionAuth(), target: chatgptResponses, payload: codexCompressionPayload() }),
    "nil-config": () => ({ policy: undefined, auth: codexCompressionAuth(), target: chatgptResponses, payload: codexCompressionPayload() }),
    "api-key": () => ({ policy: enabled, auth: codexCompressionAuth({ api_key: "test" }), target: chatgptResponses, payload: codexCompressionPayload() }),
    siwc: () => ({ policy: enabled, auth: codexCompressionAuth({}, { use_siwc: true }), target: chatgptResponses, payload: codexCompressionPayload() }),
    "custom-url": () => ({ policy: enabled, auth: codexCompressionAuth(), target: "https://example.com/responses", payload: codexCompressionPayload() }),
    "wrong-path": () => ({ policy: enabled, auth: codexCompressionAuth(), target: "https://chatgpt.com/backend-api/codex-other/responses", payload: codexCompressionPayload() }),
    "below-min": () => ({ policy: { enabled: true, minBytes: codexCompressionPayload().length + 1 }, auth: codexCompressionAuth(), target: chatgptResponses, payload: codexCompressionPayload() }),
    "nil-auth": () => ({ policy: enabled, auth: undefined, target: chatgptResponses, payload: codexCompressionPayload() }),
    "no-size-benefit": () => ({ policy: { enabled: true, minBytes: 1 }, auth: codexCompressionAuth(), target: chatgptResponses, payload: `{}` }),
  };
  for (const [name, make] of Object.entries(cases)) {
    test(name, () => {
      const { policy, auth, target, payload } = make();
      const wire = codexRequestWireBody(policy, auth, target, payload);
      expect(wire).toBe(payload);
      const headers = new Headers();
      alignCodexContentEncoding(headers, wire);
      expect(headers.get("Content-Encoding")).toBeNull();
    });
  }

  test("RequestCompressionMinBytes defaults to 1024", () => {
    expect(codexRequestCompressionMinBytes(undefined)).toBe(1024);
    expect(codexRequestCompressionMinBytes(0)).toBe(1024);
    expect(codexRequestCompressionMinBytes(-1)).toBe(1024);
    expect(codexRequestCompressionMinBytes(2048)).toBe(2048);
  });
});

test("TestCodexUpstreamCompression_ContentEncodingGuard", () => {
  const auth = codexCompressionAuth({ "header:Content-Encoding": "identity" });
  const wire = codexRequestWireBody(enabled, auth, chatgptResponses, codexCompressionPayload());
  const headers = new Headers();
  applyCodexHeaders(headers, auth, "test", true, undefined, undefined);
  expect(headers.get("Content-Encoding")).toBe("identity");
  alignCodexContentEncoding(headers, wire);
  expect(headers.get("Content-Encoding")).toBe("zstd");
  expect(Array.from((wire as Uint8Array).subarray(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
});

describe("TestCodexExecutor_CompressedUpstreamResponseDecoded", () => {
  for (const mode of ["execute", "stream", "compact"]) {
    for (const encoding of ["gzip", "zstd", "br"]) {
      test(`${mode}/${encoding}`, async () => {
        const plain = mode === "compact" ? `{"id":"resp_1","object":"response","status":"completed","output":[]}` : `data: ${codexCompletedEventBody}\n\n`;
        const wire = compressed(encoding, plain);
        let acceptEncoding: string | null = "";
        const upstream = startUpstream((req) => {
          acceptEncoding = req.headers.get("Accept-Encoding");
          return new Response(wire, { headers: { "Content-Type": "text/event-stream", "Content-Encoding": encoding, "Content-Length": String(wire.length) } });
        });
        try {
          const auth = newAuth({ id: "codex-key", provider: "codex", attributes: { base_url: upstream.url, api_key: "test" } });
          const req = { model: "gpt-5.6-terra", payload: `{"model":"gpt-5.6-terra","input":"hello"}`, format: "openai-response" };
          const executor = new CodexExecutor();
          let headers: Headers;
          if (mode === "stream") {
            const result = await executor.executeStream(auth, req, { stream: true, sourceFormat: "openai-response" });
            headers = result.headers!;
            const { chunks, error } = await drain(result);
            expect(error).toBeUndefined();
            expect(chunks.join("")).toContain("hello");
          } else {
            const result = await executor.execute(auth, req, { stream: false, sourceFormat: "openai-response", ...(mode === "compact" ? { alt: "responses/compact" } : {}) });
            headers = result.headers!;
            expect(getString(result.payload, "id")).toBe("resp_1");
          }
          expect(acceptEncoding).toBe(codexAcceptEncoding);
          expect(headers.get("Content-Encoding")).toBeNull();
          expect(headers.get("Content-Length")).toBeNull();
        } finally {
          upstream.close();
        }
      });
    }
  }
});

describe("TestCodexExecutor_CompressionRejectedFallback", () => {
  for (const mode of ["execute", "stream", "compact"]) {
    for (const status of [400, 415]) {
      test(`${mode}/${status}`, async () => {
        let firstPlain = "";
        const encodings: string[] = [];
        const rec = recordingFetch(({ headers, body }) => {
          const encoding = headers.get("Content-Encoding") ?? "";
          encodings.push(encoding);
          if (encoding === "zstd") {
            firstPlain = decoder.decode(Bun.zstdDecompressSync(body));
            return new Response("compression rejected", { status });
          }
          expect(decoder.decode(body)).toBe(firstPlain);
          expect(headers.get(codexRoutingHintHeader)).not.toBeNull();
          expect(headers.get("Authorization")).toBe("Bearer test-oauth");
          const output = mode === "compact" ? `{"id":"resp_1","object":"response","status":"completed","output":[]}` : `data: ${codexCompletedEventBody}\n\n`;
          return new Response(output, { headers: { "Content-Type": "text/event-stream" } });
        });
        const executor = new CodexExecutor({ fetch: rec.fetch, upstreamRequestCompression: true });
        const req = { model: "gpt-5.4", payload: codexCompressionPayload(), format: "openai-response" };
        if (mode === "stream") {
          const { error } = await drain(await executor.executeStream(codexCompressionAuth(), req, { stream: true, sourceFormat: "openai-response" }));
          expect(error).toBeUndefined();
        } else {
          await executor.execute(codexCompressionAuth(), req, { stream: false, sourceFormat: "openai-response", ...(mode === "compact" ? { alt: "responses/compact" } : {}) });
        }
        expect(encodings).toEqual(["zstd", ""]);
      });
    }
  }
});

describe("TestCodexUpstreamCompression_ContentEncodingGuardMatrix", () => {
  const cases = [
    { name: "plain-object", body: " \n{}", encoding: "zstd", want: null },
    { name: "plain-array", body: "[]", encoding: "GZIP", want: null },
    { name: "unknown", body: "opaque", encoding: "custom", want: "custom" },
    { name: "gzip", body: "\x1f\x8bbody", encoding: "identity", want: "gzip" },
    { name: "zstd", body: "\x28\xb5\x2f\xfdbody", encoding: "identity", want: "zstd" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const body = Uint8Array.from(tc.body, (c) => c.charCodeAt(0));
      const headers = new Headers({ "Content-Encoding": tc.encoding });
      alignCodexContentEncoding(headers, body);
      expect(headers.get("Content-Encoding")).toBe(tc.want);
    });
  }
});

describe("TestCodexExecutor_CompressionFallbackRetryLimit", () => {
  const cases = [
    { name: "compressed-415", compressed: true, status: 415, wantCalls: 2 },
    { name: "compressed-400", compressed: true, status: 400, wantCalls: 2 },
    { name: "compressed-500", compressed: true, status: 500, wantCalls: 1 },
    { name: "plain-415", compressed: false, status: 415, wantCalls: 1 },
    { name: "plain-400", compressed: false, status: 400, wantCalls: 1 },
  ];
  for (const tc of cases) {
    test(tc.name, async () => {
      const plain = `{"input":"hello"}`;
      const wire = tc.compressed ? compressed("zstd", plain) : plain;
      let cancelled = 0;
      const rec = recordingFetch(({ headers, index }) => {
        if (index > 0) expect(headers.get("Content-Encoding")).toBeNull();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("rejected"));
          },
          cancel() {
            cancelled++;
          },
        });
        return new Response(body, { status: tc.status });
      });
      const resp = await doCodexRequest(rec.fetch, chatgptResponses, { headers: new Headers() }, plain, wire);
      expect(rec.calls.length).toBe(tc.wantCalls);
      expect(cancelled).toBe(tc.wantCalls - 1);
      expect(resp.status).toBe(tc.status);
      await resp.body?.cancel();
    });
  }
});

describe("TestCodexExecutor_CompressedImageResponsesDecoded", () => {
  for (const direct of [false, true]) {
    for (const stream of [false, true]) {
      for (const encoding of ["gzip", "zstd"]) {
        test(`direct=${direct}/stream=${stream}/${encoding}`, async () => {
          let plain = `data: {"type":"response.completed","response":{"id":"resp_img","output":[{"type":"image_generation_call","result":"AA==","output_format":"png"}]}}\n\n`;
          if (direct && stream) plain = `event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"AA=="}\n\n`;
          else if (direct) plain = `{"created":1713833628,"data":[{"b64_json":"AA=="}]}`;
          const wire = compressed(encoding, plain);
          const upstream = startUpstream((req) => {
            expect(req.headers.get("Accept-Encoding")).toBe(codexAcceptEncoding);
            return new Response(wire, { headers: { "Content-Type": "text/event-stream", "Content-Encoding": encoding } });
          });
          try {
            const auth = newAuth({ id: "codex-img", provider: "codex", attributes: { base_url: upstream.url }, metadata: { access_token: "test-oauth", plan_type: "plus" } });
            const model = direct ? "gpt-image-1.5" : "custom-image";
            const req = { model, payload: `{"model":"${model}","prompt":"a cat"}`, format: FormatOpenAIImage };
            const executor = new CodexExecutor();
            let headers: Headers;
            let output: string;
            if (stream) {
              const result = await executor.executeStream(auth, req, imageOptions("/v1/images/generations", true));
              headers = result.headers!;
              const drained = await drain(result);
              expect(drained.error).toBeUndefined();
              output = drained.chunks.join("");
            } else {
              const result = await executor.execute(auth, req, imageOptions("/v1/images/generations", false));
              headers = result.headers!;
              output = result.payload;
            }
            expect(output).toContain("AA==");
            expect(headers.get("Content-Encoding")).toBeNull();
            expect(headers.get("Content-Length")).toBeNull();
          } finally {
            upstream.close();
          }
        });
      }
    }
  }
});

describe("TestCodexUpstreamCompression_DirectImagePayloadRewrite", () => {
  for (const stream of [false, true]) {
    test(`stream=${stream}`, async () => {
      const rec = recordingFetch(({ headers, body }) => {
        expect(headers.get("Content-Encoding")).toBeNull();
        expect(getString(decoder.decode(body), "prompt")).toContain("large prompt");
        const output = stream ? `event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"AA=="}\n\n` : `{"created":1713833628,"data":[{"b64_json":"AA=="}]}`;
        return new Response(output, { headers: { "Content-Type": "text/event-stream" } });
      });
      const executor = new CodexExecutor({ fetch: rec.fetch, upstreamRequestCompression: true });
      const req = { model: "gpt-image-1.5", payload: `{"model":"gpt-image-1.5","prompt":"${"large prompt ".repeat(400)}"}`, format: FormatOpenAIImage };
      if (stream) {
        const { error } = await drain(await executor.executeStream(codexCompressionAuth({}, { plan_type: "plus" }), req, imageOptions("/v1/images/generations", true)));
        expect(error).toBeUndefined();
      } else {
        await executor.execute(codexCompressionAuth({}, { plan_type: "plus" }), req, imageOptions("/v1/images/generations", false));
      }
      expect(rec.calls.length).toBe(1);
    });
  }
});

describe("TestCodexImageCompressionRejectedFallback", () => {
  for (const direct of [false, true]) {
    for (const stream of [false, true]) {
      for (const status of [400, 415]) {
        test(`direct=${direct}/stream=${stream}/${status}`, async () => {
          const encodings: string[] = [];
          let firstPlain = "";
          const rec = recordingFetch(({ headers, body }) => {
            const encoding = headers.get("Content-Encoding") ?? "";
            encodings.push(encoding);
            if (encoding === "zstd") {
              firstPlain = decoder.decode(Bun.zstdDecompressSync(body));
              return new Response("compression rejected", { status });
            }
            if (!direct) expect(decoder.decode(body)).toBe(firstPlain);
            expect(headers.get("Authorization")).toBe("Bearer test-oauth");
            let output = `data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"AA==","output_format":"png"}]}}\n\n`;
            if (direct && stream) output = `event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"AA=="}\n\n`;
            else if (direct) output = `{"data":[{"b64_json":"AA=="}]}`;
            return new Response(output, { headers: { "Content-Type": "text/event-stream" } });
          });
          const executor = new CodexExecutor({ fetch: rec.fetch, upstreamRequestCompression: true });
          const model = direct ? "gpt-image-2" : "custom-image";
          const req = { model, payload: `{"model":"${model}","prompt":"${"a compressible cat ".repeat(400)}"}`, format: FormatOpenAIImage };
          // Custom headers must not relabel the plaintext fallback or the direct body.
          const auth = codexCompressionAuth({ "header:Content-Encoding": "zstd" }, { plan_type: "plus" });
          let output: string;
          if (stream) {
            const drained = await drain(await executor.executeStream(auth, req, imageOptions("/v1/images/generations", true)));
            expect(drained.error).toBeUndefined();
            output = drained.chunks.join("");
          } else {
            output = (await executor.execute(auth, req, imageOptions("/v1/images/generations", false))).payload;
          }
          expect(output).toContain("AA==");
          expect(encodings).toEqual(direct ? [""] : ["zstd", ""]);
        });
      }
    }
  }
});

describe("TestCodexCompressionContentEncodingChains", () => {
  for (const layers of [["gzip", "gzip"], ["zstd", "zstd"], ["gzip", "zstd"], ["zstd", "gzip"]]) {
    const encoding = layers.join(", ");
    let wire: Uint8Array = new TextEncoder().encode(`{"message":"preserve every encoding layer"}`);
    for (const layer of layers) wire = compressed(layer, wire);
    for (const prepare of [false, true]) {
      test(`${encoding}/prepare=${prepare}`, () => {
        const headers = new Headers({ "Content-Type": "application/json" });
        if (prepare) {
          applyCodexHeaders(headers, codexCompressionAuth({ "header:Content-Encoding": encoding }), "test-oauth", false, undefined, undefined);
          headers.set("Content-Type", "application/json");
        } else {
          for (const layer of layers) headers.append("Content-Encoding", layer);
        }
        alignCodexContentEncoding(headers, wire);
        expect(headers.get("Content-Encoding")).toBe(encoding);
      });
    }
  }
});

describe("TestCodexCompressionContentEncodingAlignment", () => {
  const multipart = "multipart/form-data; boundary=boundary";
  const cases: Array<{ name: string; body: string; contentType?: string; encoding?: string; want?: string }> = [
    { name: "zstd_identity", body: "\x28\xb5\x2f\xfdbody", encoding: "identity", want: "zstd" },
    { name: "zstd_kept", body: "\x28\xb5\x2f\xfdbody", encoding: "zstd", want: "zstd" },
    { name: "zstd_missing", body: "\x28\xb5\x2f\xfdbody", want: "zstd" },
    { name: "zstd_mislabeled_gzip", body: "\x28\xb5\x2f\xfdbody", encoding: "gzip", want: "zstd" },
    { name: "zstd_single_with_identity", body: "\x28\xb5\x2f\xfdbody", encoding: "gzip, identity", want: "zstd" },
    { name: "gzip_identity", body: "\x1f\x8bbody", encoding: "identity", want: "gzip" },
    { name: "json_br", body: " \n{}", encoding: "br" },
    { name: "json_deflate", body: "[]", encoding: "deflate" },
    { name: "json_combined", body: "{}", encoding: "gzip, zstd" },
    { name: "json_double_gzip", body: "{}", encoding: "gzip, gzip" },
    { name: "json_multiple_headers", body: "{}", encoding: "gzip, zstd, br" },
    { name: "multipart_zstd", body: '--boundary\r\nContent-Disposition: form-data; name="image"\r\n\r\nimage\r\n--boundary--\r\n', contentType: multipart, encoding: "zstd" },
    { name: "multipart_br", body: "--boundary\r\n", contentType: multipart, encoding: "br" },
    { name: "multipart_chain", body: "--boundary\r\n", contentType: multipart, encoding: "gzip, zstd" },
    { name: "opaque_zstd", body: "opaque", encoding: "zstd" },
    { name: "opaque_combined", body: "opaque", encoding: "br, ZSTD", want: "br, ZSTD" },
    { name: "opaque_br", body: "opaque", encoding: "br", want: "br" },
    { name: "opaque_custom", body: "opaque", encoding: "custom", want: "custom" },
  ];
  for (const tc of cases) {
    for (const prepare of [false, true]) {
      test(`${tc.name}/prepare=${prepare}`, () => {
        const body = Uint8Array.from(tc.body, (c) => c.charCodeAt(0));
        const headers = new Headers();
        if (prepare) {
          applyCodexHeaders(headers, codexCompressionAuth({ "header:Content-Encoding": tc.encoding ?? "" }), "test-oauth", false, undefined, undefined);
        } else {
          for (const encoding of (tc.encoding ?? "").split(",")) if (encoding.trim() !== "") headers.append("Content-Encoding", encoding.trim());
        }
        if (tc.contentType) headers.set("Content-Type", tc.contentType);
        else headers.delete("Content-Type");
        alignCodexContentEncoding(headers, body);
        expect(headers.get("Content-Encoding")).toBe(tc.want ?? null);
      });
    }
  }
});

// Ported from: internal/runtime/executor/openai_compat_executor_images_test.go
// Skipped cases: the usage-record half of TestOpenAICompatExecutor_ImageStreamChunkBoundaryObservability
//   (executor usage reporting / ResponseModel observation not ported; the verbatim forwarding half is kept).
// New cases (no upstream test): JSON model/stream rewriting, multipart re-encoding with the file
// content type and bytes preserved, Bearer key and default User-Agent, a non-2xx upstream rejection
// classified like the chat path.
import { afterEach, describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { OpenAICompatExecutor } from "../../../src/executor/openai/index.ts";
import {
  FormatOpenAIImage,
  binaryStringToBytes,
  bytesToBinaryString,
  encodeMultipart,
  isUploadedFile,
  parseMultipartForm,
  prepareOpenAICompatImagesPayload,
} from "../../../src/executor/openai/images.ts";
import { RequestPathMetadataKey, StatusError, type ExecOptions } from "../../../src/executor/types.ts";

interface Captured {
  path: string;
  headers: Headers;
  bytes: Uint8Array;
}

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function upstream(respond: (req: Captured) => Response | Promise<Response>): { baseURL: string; requests: Captured[] } {
  const requests: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const captured = { path: new URL(request.url).pathname, headers: request.headers, bytes: new Uint8Array(await request.arrayBuffer()) };
      requests.push(captured);
      return respond(captured);
    },
  });
  servers.push(server);
  return { baseURL: `http://127.0.0.1:${server.port}`, requests };
}

function auth(baseURL: string) {
  return newAuth({ id: "openai:test", provider: "openai", attributes: { base_url: baseURL, api_key: "test-key" } });
}

function imageOptions(path: string | undefined, stream: boolean, extra: Partial<ExecOptions> = {}): ExecOptions {
  return { stream, sourceFormat: FormatOpenAIImage, metadata: path ? { [RequestPathMetadataKey]: path } : {}, ...extra };
}

describe("OpenAI image endpoints", () => {
  test("TestOpenAICompatExecutor_ImageStreamChunkBoundaryObservability (verbatim forwarding)", async () => {
    const cases = [
      [`data: {"id":"img_split","cre`, `ated":123,"mo`, `del":"dall-e-3","data":[{"url":"http://example.com/1.png"}]}` + "\n\n"],
      ['event: ping\ndata: {}\n\nevent: completion\ndata: {"model":"dall-e-3","status":"done"}\n\n'],
      ["event: image_event\n", 'data: {"model":"dall-e-3","data":[]}\n\n'],
    ];
    for (const chunks of cases) {
      const fake = upstream(() => {
        const encoder = new TextEncoder();
        let index = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
            else controller.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      });
      const result = await new OpenAICompatExecutor().executeStream(auth(fake.baseURL), { model: "dall-e-3", payload: `{"model":"dall-e-3","prompt":"a sunset over mountains"}`, format: FormatOpenAIImage }, imageOptions(undefined, true));
      let received = "";
      for await (const chunk of result.chunks) received += chunk;
      expect(received).toBe(chunks.join(""));
      expect(fake.requests[0]!.path).toBe("/images/generations");
      expect(fake.requests[0]!.headers.get("Accept")).toBe("text/event-stream");
    }
  });

  test("TestOpenAICompatExecutor_ImageEndpointPath_HonorsOverriddenRequestPath_Issue6196", async () => {
    const fake = upstream(() => Response.json({ created: 123, data: [{ b64_json: "img" }] }));
    const executor = new OpenAICompatExecutor();
    const payload = `{"model":"gpt-image-2.5","prompt":"a red apple"}`;
    await executor.execute(auth(fake.baseURL), { model: "gpt-image-2.5", payload, format: FormatOpenAIImage }, imageOptions("/v1/images/edits", false));
    expect(fake.requests[0]!.path).toBe("/images/edits");
    const resp = await executor.execute(auth(fake.baseURL), { model: "gpt-image-2.5", payload, format: FormatOpenAIImage }, imageOptions("/v1/images/generations", false));
    expect(resp.payload.length).toBeGreaterThan(0);
    expect(fake.requests[1]!.path).toBe("/images/generations");
  });

  test("JSON requests get the upstream model, lose the stream flag and carry the key", async () => {
    const upstreamBody = `{"created":1,"data":[{"b64_json":"AA=="}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`;
    const fake = upstream(() => new Response(upstreamBody, { headers: { "Content-Type": "application/json" } }));
    const resp = await new OpenAICompatExecutor().execute(
      auth(fake.baseURL),
      { model: "gpt-image-1(high)", payload: `{"model":"alias","prompt":"x","stream":false,"size":"1024x1024"}`, format: FormatOpenAIImage },
      imageOptions("/v1/images/generations", false),
    );
    expect(resp.payload).toBe(upstreamBody);
    const got = fake.requests[0]!;
    expect(got.headers.get("Authorization")).toBe("Bearer test-key");
    expect(got.headers.get("Content-Type")).toBe("application/json");
    expect(got.headers.get("User-Agent")).toBe("cli-proxy-openai-compat");
    expect(JSON.parse(new TextDecoder().decode(got.bytes))).toEqual({ model: "gpt-image-1", prompt: "x", size: "1024x1024" });
  });

  test("multipart edits are re-encoded with model and stream first and files kept byte-exact", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);
    const source = encodeMultipart([
      { name: "model", value: "alias" },
      { name: "stream", value: "false" },
      { name: "prompt", value: "edit" },
      { name: "image[]", value: { name: "a.png", type: "image/x-custom", data: png, arrayBuffer: async () => png.buffer } },
    ]);
    const fake = upstream(() => new Response('event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"AA=="}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
    const result = await new OpenAICompatExecutor().executeStream(
      auth(fake.baseURL),
      { model: "gpt-image-1", payload: bytesToBinaryString(source.bytes), format: FormatOpenAIImage },
      imageOptions("/v1/images/edits", true, { headers: new Headers({ "Content-Type": source.contentType }) }),
    );
    for await (const _ of result.chunks) {
      // drain
    }
    const got = fake.requests[0]!;
    expect(got.path).toBe("/images/edits");
    const form = await parseMultipartForm(got.bytes, got.headers.get("Content-Type")!);
    expect(form.parts.map((p) => p.name)).toEqual(["model", "stream", "prompt", "image[]"]);
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.get("stream")).toBe("true");
    const file = form.get("image[]");
    expect(isUploadedFile(file)).toBe(true);
    if (isUploadedFile(file)) {
      expect(file.type).toBe("image/x-custom");
      expect(file.name).toBe("a.png");
      expect(Array.from(file.data)).toEqual(Array.from(png));
    }
  });

  test("an upstream rejection is a StatusError carrying the body", async () => {
    const fake = upstream(() => Response.json({ error: { message: "bad size", type: "invalid_request_error", code: "invalid_value" } }, { status: 400 }));
    const err = await new OpenAICompatExecutor()
      .execute(auth(fake.baseURL), { model: "gpt-image-1", payload: `{"prompt":"x"}`, format: FormatOpenAIImage }, imageOptions("/v1/images/generations", false))
      .catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(400);
    expect(JSON.parse(err.body).error.message).toBe("bad size");
  });
});

describe("payload helpers", () => {
  test("binary strings round-trip every byte value", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(binaryStringToBytes(bytesToBinaryString(bytes)))).toEqual(Array.from(bytes));
  });

  test("non-JSON, non-multipart bodies pass through", async () => {
    const out = await prepareOpenAICompatImagesPayload("raw", "m", "text/plain", false);
    expect(out).toEqual({ body: "raw", binary: true, contentType: "text/plain" });
  });

  test("multipart without boundary is rejected", async () => {
    const err = await prepareOpenAICompatImagesPayload("--x", "m", "multipart/form-data", false).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(400);
  });
});

// Ported from: sdk/api/handlers/openai/openai_images_handlers_test.go
// Skipped cases: every xAI case (TestCanonicalXAIImagesModelPreservesImage20, TestBuildXAIImages*,
//   TestXAIImages*, TestBuildImagesAPIResponseFromXAI; xAI is not a kept upstream) and the xAI names of
//   TestImagesModelValidationAllowsGPTImageAndXAIModels; TestImagesGenerations_DisableImageGenerationChat_DoesNotReturn404 /
//   TestImagesEdits_DisableImageGenerationChat_DoesNotReturn404 (the "chat" mode is not ported:
//   disableImageGeneration is a boolean); TestSSEFrameAccumulator*, TestCollectImages*,
//   TestForwardImagesStreamCancelsWithPayloadError, TestWriteImagesStreamErrorEventSanitizesPayload
//   (handler-side Responses fallback, unreachable upstream and not ported; the Codex executor does
//   that conversion); TestForwardRawImageStreamPrefersPendingErrorOnClose (Go channel ordering; the
//   iterator forwarder below covers the terminal error frame).
// Adapted: TestImagesModelValidationAllowsOpenAICompatImageModels uses a model served by an "openai"
//   (OpenAI API-key) credential instead of the openai-compatibility image model type; the
//   unsupported-model message no longer lists the xAI models.
import { describe, expect, test } from "bun:test";
import { ModelRegistry } from "../../src/registry/index.ts";
import { StatusError, RequestPathMetadataKey, RequestedModelMetadataKey } from "../../src/executor/types.ts";
import {
  OpenAIImagesHandler,
  buildOpenAICompatImagesJSONRequest,
  forwardImagesStream,
  openAIErrorBody,
  unsupportedImagesModelMessage,
} from "../../src/server/images_handlers.ts";
import { FormatOpenAIImage, binaryStringToBytes, isUploadedFile, parseMultipartForm, rewriteOpenAICompatImagesMultipartForm, encodeMultipart } from "../../src/executor/openai/images.ts";
import { chunkIterator, chunkStream, fakeManager, readText } from "./helpers.ts";

function newHandler(options: { disabled?: boolean; manager?: ReturnType<typeof fakeManager>; registry?: ModelRegistry } = {}) {
  const registry = options.registry ?? new ModelRegistry();
  const manager = options.manager ?? fakeManager();
  return { handler: new OpenAIImagesHandler({ manager, registry, disableImageGeneration: options.disabled }), manager, registry };
}

function jsonRequest(path: string, body: string): Request {
  return new Request(`http://proxy.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

function multipartRequest(path: string, parts: Parameters<typeof encodeMultipart>[0]): Request {
  const encoded = encodeMultipart(parts);
  return new Request(`http://proxy.test${path}`, { method: "POST", headers: { "Content-Type": encoded.contentType }, body: encoded.bytes });
}

async function expectUnsupported(resp: Response, model: string) {
  expect(resp.status).toBe(400);
  const body = (await resp.json()) as { error: { message: string; type: string } };
  expect(body.error.message).toBe(unsupportedImagesModelMessage(model));
  expect(body.error.type).toBe("invalid_request_error");
}

describe("model validation", () => {
  test("TestImagesModelValidationAllowsGPTImageAndXAIModels (GPT Image part)", () => {
    const { handler } = newHandler();
    for (const model of ["gpt-image-1.5", "codex/gpt-image-1.5", "gpt-image-2", "codex/gpt-image-2", "gpt-image-2.5-flare", "codex/gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "codex/gpt-image-2.5-sunburst", "gpt-image-2.5", "codex/gpt-image-2.5"]) {
      expect(handler.isSupportedImagesModel(model), model).toBe(true);
    }
    expect(handler.isSupportedImagesModel("gpt-5.4-mini")).toBe(false);
    expect(handler.isSupportedImagesModel("codex/grok-imagine-image")).toBe(false);
  });

  test("TestImagesModelValidationAllowsOpenAICompatImageModels (OpenAI API-key models)", () => {
    const registry = new ModelRegistry();
    registry.registerClient("openai-key", "openai", [{ id: "compat-image-model", type: "openai" }]);
    registry.registerClient("claude-key", "claude", [{ id: "compat-chat-model", type: "claude" }]);
    const { handler } = newHandler({ registry });
    expect(handler.isSupportedImagesModel("compat-image-model")).toBe(true);
    expect(handler.isSupportedImagesModel("compat-chat-model")).toBe(false);
    expect(handler.imageProvidersFor("compat-image-model")).toEqual(["openai"]);
  });

  test("GPT Image models route to the Codex and OpenAI credentials that serve them", () => {
    const registry = new ModelRegistry();
    registry.registerClient("codex-1", "codex", [{ id: "gpt-image-2", type: "openai" }]);
    registry.registerClient("openai-1", "openai", [{ id: "gpt-image-2", type: "openai" }]);
    registry.registerClient("claude-1", "claude", [{ id: "gpt-image-2", type: "claude" }]);
    const { handler } = newHandler({ registry });
    expect(handler.imageProvidersFor("gpt-image-2").sort()).toEqual(["codex", "openai"]);
  });
});

describe("request builders", () => {
  test("TestBuildOpenAICompatImagesJSONRequestPreservesStreamForStreaming", () => {
    const req = buildOpenAICompatImagesJSONRequest({ model: "compat-image", prompt: "draw", stream: false }, "upstream-image", true);
    expect(JSON.parse(req)).toEqual({ model: "upstream-image", prompt: "draw", stream: true });
  });

  test("TestBuildOpenAICompatImagesJSONRequestDropsStreamForNonStreaming", () => {
    const req = buildOpenAICompatImagesJSONRequest({ model: "compat-image", prompt: "draw", stream: true }, "upstream-image", false);
    expect(JSON.parse(req)).toEqual({ model: "upstream-image", prompt: "draw" });
  });

  test("TestBuildOpenAICompatImagesMultipartRequestPreservesStreamAndFileContentType", async () => {
    const png = new TextEncoder().encode("png-data");
    const source = encodeMultipart([
      { name: "model", value: "compat-image" },
      { name: "stream", value: "false" },
      { name: "prompt", value: "edit" },
      { name: "image", value: { name: "image.png", type: "image/png", data: png, arrayBuffer: async () => png.buffer } },
    ]);
    const form = await parseMultipartForm(source.bytes, source.contentType);
    const out = rewriteOpenAICompatImagesMultipartForm(form, "upstream-image", true);
    expect(out.contentType.startsWith("multipart/form-data; boundary=")).toBe(true);
    const rewritten = await parseMultipartForm(out.bytes, out.contentType);
    expect(rewritten.getAll("model")).toEqual(["upstream-image"]);
    expect(rewritten.getAll("stream")).toEqual(["true"]);
    expect(rewritten.getAll("prompt")).toEqual(["edit"]);
    const files = rewritten.getAll("image").filter(isUploadedFile);
    expect(files.length).toBe(1);
    expect(files[0]!.type).toBe("image/png");
  });
});

describe("handlers", () => {
  test("TestImagesGenerationsRejectsUnsupportedModel", async () => {
    const { handler } = newHandler();
    await expectUnsupported(await handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"model":"gpt-5.4-mini","prompt":"draw a square"}`)), "gpt-5.4-mini");
  });

  test("TestImagesEditsJSONRejectsUnsupportedModel", async () => {
    const { handler } = newHandler();
    await expectUnsupported(await handler.imagesEdits(jsonRequest("/v1/images/edits", `{"model":"gpt-5.4-mini","prompt":"edit this","images":[{"image_url":"data:image/png;base64,AA=="}]}`)), "gpt-5.4-mini");
  });

  test("TestImagesEditsMultipartRejectsUnsupportedModel", async () => {
    const { handler } = newHandler();
    const req = multipartRequest("/v1/images/edits", [
      { name: "model", value: "gpt-5.4-mini" },
      { name: "prompt", value: "edit this" },
    ]);
    await expectUnsupported(await handler.imagesEdits(req), "gpt-5.4-mini");
  });

  test("TestImagesGenerations_DisableImageGeneration_Returns404", async () => {
    const { handler, manager } = newHandler({ disabled: true });
    const resp = await handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"prompt":"draw a square"}`));
    expect(resp.status).toBe(404);
    expect(manager.calls.length).toBe(0);
  });

  test("TestImagesEdits_DisableImageGeneration_Returns404", async () => {
    const { handler } = newHandler({ disabled: true });
    const resp = await handler.imagesEdits(jsonRequest("/v1/images/edits", `{"prompt":"edit this","images":[{"image_url":"data:image/png;base64,AA=="}]}`));
    expect(resp.status).toBe(404);
  });

  test("invalid JSON, missing prompt, missing image and unsupported Content-Type are 400s", async () => {
    const { handler } = newHandler();
    const cases: Array<[Promise<Response>, string]> = [
      [handler.imagesGenerations(jsonRequest("/v1/images/generations", "{")), "Invalid request: body must be valid JSON"],
      [handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"model":"gpt-image-2"}`)), "Invalid request: prompt is required"],
      [handler.imagesEdits(multipartRequest("/v1/images/edits", [{ name: "prompt", value: "x" }])), "Invalid request: image is required"],
      [handler.imagesEdits(new Request("http://proxy.test/v1/images/edits", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" })), 'Invalid request: unsupported Content-Type "text/plain"'],
    ];
    for (const [pending, message] of cases) {
      const resp = await pending;
      expect(resp.status).toBe(400);
      expect(((await resp.json()) as { error: { message: string } }).error.message).toBe(message);
    }
  });

  test("an unrouted model is a 400 model_not_found", async () => {
    const { handler } = newHandler();
    const resp = await handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"prompt":"x"}`));
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: { message: "unknown provider for model gpt-image-2", type: "invalid_request_error", code: "model_not_found", param: "model" } });
  });

  test("JSON generations reach the manager in the openai-image format with the routing metadata", async () => {
    const registry = new ModelRegistry();
    registry.registerClient("codex-1", "codex", [{ id: "gpt-image-2", type: "openai" }]);
    const manager = fakeManager({ execute: async () => ({ payload: `{"created":1,"data":[{"b64_json":"AA=="}]}` }) });
    const { handler } = newHandler({ registry, manager });
    const resp = await handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"prompt":"x","stream":false}`));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ created: 1, data: [{ b64_json: "AA==" }] });
    const call = manager.calls[0]!;
    expect(call.providers).toEqual(["codex"]);
    expect(call.req.format).toBe(FormatOpenAIImage);
    expect(JSON.parse(call.req.payload)).toEqual({ prompt: "x", model: "gpt-image-2" });
    expect(call.opts.metadata?.[RequestPathMetadataKey]).toBe("/v1/images/generations");
    expect(call.opts.metadata?.[RequestedModelMetadataKey]).toBe("gpt-image-2");
    expect(call.opts.metadata?.disallow_free_auth).toBe(true);
  });

  test("multipart edits are rebuilt with model and stream for the executor", async () => {
    const registry = new ModelRegistry();
    registry.registerClient("codex-1", "codex", [{ id: "gpt-image-2", type: "openai" }]);
    const manager = fakeManager({ stream: async () => chunkStream(['event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"AA=="}\n\n']) });
    const { handler } = newHandler({ registry, manager });
    const png = new Uint8Array([1, 2, 255]);
    const resp = await handler.imagesEdits(
      multipartRequest("/v1/images/edits", [
        { name: "prompt", value: "edit" },
        { name: "stream", value: "true" },
        { name: "image", value: { name: "a.png", type: "image/png", data: png, arrayBuffer: async () => png.buffer } },
      ]),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await resp.text()).toContain("event: image_edit.completed");
    const call = manager.calls[0]!;
    const contentType = call.opts.headers!.get("Content-Type")!;
    const form = await parseMultipartForm(binaryStringToBytes(call.req.payload), contentType);
    expect(form.parts.map((p) => p.name)).toEqual(["model", "stream", "prompt", "image"]);
    expect(form.get("model")).toBe("gpt-image-2");
    const file = form.get("image");
    expect(isUploadedFile(file) && Array.from(file.data)).toEqual([1, 2, 255]);
  });

  test("a failure before the first chunk is a JSON OpenAI error; after it an SSE error frame", async () => {
    const registry = new ModelRegistry();
    registry.registerClient("codex-1", "codex", [{ id: "gpt-image-2", type: "openai" }]);
    const upstreamErr = new StatusError(429, `{"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit_exceeded"}}`);
    const early = newHandler({ registry, manager: fakeManager({ stream: async () => chunkStream([], upstreamErr) }) });
    const resp = await early.handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"prompt":"x","stream":true}`));
    expect(resp.status).toBe(429);
    expect(await resp.json()).toEqual({ error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } });

    const late = newHandler({ registry, manager: fakeManager({ stream: async () => chunkStream(['event: image_generation.partial_image\ndata: {"b64_json":"AA=="}'], new StatusError(502, "upstream reset")) }) });
    const lateResp = await late.handler.imagesGenerations(jsonRequest("/v1/images/generations", `{"prompt":"x","stream":true}`));
    expect(lateResp.status).toBe(200);
    expect(await lateResp.text()).toBe('event: image_generation.partial_image\ndata: {"b64_json":"AA=="}\n\nevent: error\ndata: {"error":{"message":"upstream reset","type":"server_error","code":"internal_server_error"}}\n\n');
  });
});

describe("error envelope and forwarder", () => {
  test("openAIErrorBody keeps OpenAI-shaped bodies and wraps the rest", () => {
    expect(openAIErrorBody(400, `{ "error": { "message": "m", "type": "t" } }`)).toBe(`{"error":{"message":"m","type":"t"}}`);
    expect(JSON.parse(openAIErrorBody(502, `{"detail":"Bad gateway"}`))).toEqual({ error: { message: "Bad gateway", type: "server_error", code: "internal_server_error" } });
    expect(JSON.parse(openAIErrorBody(401, "nope"))).toEqual({ error: { message: "nope", type: "authentication_error", code: "invalid_api_key" } });
    expect(JSON.parse(openAIErrorBody(400, ""))).toEqual({ error: { message: "Bad Request", type: "invalid_request_error" } });
  });

  test("forwardImagesStream reports the last usage payload on a clean end", async () => {
    let seen: string | undefined;
    const iterator = chunkIterator(['event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"input_tokens":2,"output_tokens":3}}\n\n']);
    const first = await iterator.next();
    const body = await readText(forwardImagesStream({ first, iterator, onDone: (_t, usage) => (seen = usage) }));
    expect(body).toContain("image_generation.completed");
    expect(JSON.parse(seen!).usage).toEqual({ input_tokens: 2, output_tokens: 3 });
  });
});

// Ported from: internal/runtime/executor/codex_openai_images_test.go
// Ported from: internal/runtime/executor/codex_openai_images_extract_test.go
// Skipped cases: TestCodexImageResolvedModelOnWire "custom upstream", "prefixed builtin upstream",
//   "case sensitive upstream", "configured routing-like prefix", "configured name requested directly",
//   "routing and thinking suffix" (need the per-credential codex-api-key model lookup of
//   directOpenAIImageModel, not ported: the executor has no config), "final payload override",
//   "final payload filter" (payload config rules not ported);
//   TestCodexExecutorDirectOpenAIImageGenerationUsesImagesEndpoint Version / X-Codex-Turn-Metadata /
//   X-Client-Request-Id are passed as opts.headers instead of a gin context.
// New cases (no upstream test): the Responses image_generation tool path (non-stream b64/url,
// edit with mask, partial_image + completed stream frames, missing output), a free-plan
// credential rejected when the handler disallows free auths.
import { describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { codexOriginator, codexUserAgent } from "../../../src/executor/codex/headers.ts";
import {
  DisallowFreeAuthMetadataKey,
  codexBuildImagesAPIResponse,
  codexExtractImageResults,
  codexIsDirectOpenAIImageModel,
  codexOpenAIImageBaseModel,
  codexPrepareDirectOpenAIImagePayload,
  directOpenAIImageModel,
  newCodexImageOutputItems,
} from "../../../src/executor/codex/images.ts";
import { FormatOpenAIImage, bytesToBinaryString } from "../../../src/executor/openai/images.ts";
import { RequestPathMetadataKey, RequestedModelMetadataKey, StatusError, type ExecOptions, type ExecRequest } from "../../../src/executor/types.ts";
import { apiKeyAuth, drain, getString, getValue, jsonValid, sseResponse, startUpstream } from "./helpers.ts";

const generationsPath = "/v1/images/generations";
const editsPath = "/v1/images/edits";

function imageOptions(path: string, stream: boolean, extra: Partial<ExecOptions> = {}): ExecOptions {
  return { stream, sourceFormat: FormatOpenAIImage, metadata: { [RequestPathMetadataKey]: path }, ...extra };
}

function imageRequest(model: string, payload: string): ExecRequest {
  return { model, payload, format: FormatOpenAIImage };
}

async function multipart(fields: Array<[string, string]>, files: Array<{ field: string; name: string; data: string; type?: string }>): Promise<{ payload: string; contentType: string }> {
  const form = new FormData();
  for (const [key, value] of fields) form.append(key, value);
  for (const file of files) form.append(file.field, new Blob([file.data], { type: file.type ?? "application/octet-stream" }), file.name);
  const response = new Response(form);
  const contentType = response.headers.get("Content-Type")!;
  return { payload: bytesToBinaryString(new Uint8Array(await response.arrayBuffer())), contentType };
}

const jsonOK = () => new Response(`{"created":1713833628,"data":[{"b64_json":"AA=="}]}`, { headers: { "Content-Type": "application/json" } });
const sseOK = () => sseResponse('event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"AA=="}\n\n');

describe("direct /images/* route", () => {
  test("TestCodexImagePayloadPreservesResolvedAlias", async () => {
    for (const stream of [false, true]) {
      const req = imageRequest("openai/gpt-image-2-cpr", `{"model":"gpt-image-2","prompt":"diagnostic"}`);
      const opts = imageOptions(generationsPath, stream);
      const model = directOpenAIImageModel(req, opts);
      const prepared = await codexPrepareDirectOpenAIImagePayload(req, opts, model, stream);
      expect(getString(prepared.body, "model")).toBe("openai/gpt-image-2-cpr");
    }
  });

  test("TestCodexImageResolvedModelOnWire (builtin cases)", async () => {
    const cases = [
      { name: "other builtin upstream", requested: "gpt-image-2", resolved: "gpt-image-1.5", want: "gpt-image-1.5" },
      { name: "legacy builtin prefix", requested: "codex/gpt-image-1.5(high)", resolved: "codex/gpt-image-1.5(high)", want: "gpt-image-1.5" },
      { name: "legacy builtin case", requested: "CODEX/GPT-Image-2(high)", resolved: "CODEX/GPT-Image-2(high)", want: "gpt-image-2" },
    ];
    for (const tc of cases) {
      for (const format of ["generation JSON", "edit JSON", "edit multipart"]) {
        for (const stream of [false, true]) {
          const upstream = startUpstream(() => (stream ? sseOK() : jsonOK()));
          try {
            const path = format === "generation JSON" ? generationsPath : editsPath;
            const wantPath = format === "generation JSON" ? "/images/generations" : "/images/edits";
            const opts = imageOptions(path, stream);
            opts.metadata![RequestedModelMetadataKey] = tc.requested;
            let payload = JSON.stringify({ model: tc.requested, prompt: "diagnostic", stream: !stream, images: [{ file_id: "source-image" }] });
            if (format === "edit multipart") {
              const form = await multipart(
                [
                  ["model", tc.requested],
                  ["prompt", "diagnostic"],
                  ["stream", "true"],
                ],
                [{ field: "image", name: "source.png", data: "png-data" }],
              );
              payload = form.payload;
              opts.headers = new Headers({ "Content-Type": form.contentType });
            }
            const executor = new CodexExecutor();
            const auth = apiKeyAuth(upstream.url, "codex-token");
            const req = imageRequest(tc.resolved, payload);
            if (stream) {
              const out = await drain(await executor.executeStream(auth, req, opts));
              expect(out.error).toBeUndefined();
            } else {
              await executor.execute(auth, req, opts);
            }
            const got = upstream.requests[0]!;
            const label = `${tc.name}/${format}/stream=${stream}`;
            expect(got.path, label).toBe(wantPath);
            expect(got.headers.get("Content-Type"), label).toBe("application/json");
            expect(jsonValid(got.body), label).toBe(true);
            expect(getString(got.body, "model"), label).toBe(tc.want);
            expect(getString(got.body, "prompt"), label).toBe("diagnostic");
            const flag = getValue(got.body, "stream");
            expect(flag === undefined ? false : flag, label).toBe(stream ? true : false);
            if (!stream) expect(flag, label).toBeUndefined();
            if (format === "edit multipart") expect(getString(got.body, "images.0.image_url"), label).toBe("data:application/octet-stream;base64,cG5nLWRhdGE=");
            else if (format === "edit JSON") expect(getString(got.body, "images.0.file_id"), label).toBe("source-image");
          } finally {
            upstream.close();
          }
        }
      }
    }
  });

  test("TestCodexExecutorDirectOpenAIImageGenerationUsesImagesEndpoint", async () => {
    const upstreamBody = `{"created":1713833628,"data":[{"b64_json":"AA=="}],"usage":{"total_tokens":100,"input_tokens":50,"output_tokens":50}}`;
    const upstream = startUpstream(() => new Response(upstreamBody, { headers: { "Content-Type": "application/json" } }));
    try {
      const headers = new Headers({
        "User-Agent": "downstream-client/9.9",
        Version: "0.135.0",
        "X-Codex-Turn-Metadata": `{"turn_id":"turn-1"}`,
        "X-Client-Request-Id": "client-request-1",
        Originator: "Codex Desktop",
      });
      const resp = await new CodexExecutor().execute(
        apiKeyAuth(upstream.url, "codex-token"),
        imageRequest(
          "codex/gpt-image-1.5",
          `{"model":"codex/gpt-image-1.5","prompt":"A cute baby sea otter","n":1,"size":"1024x1024","quality":"high","background":"opaque","output_format":"jpeg","output_compression":70,"moderation":"low","extra":{"preserve":true},"stream":false}`,
        ),
        imageOptions(generationsPath, false, { headers }),
      );
      const got = upstream.requests[0]!;
      expect(got.path).toBe("/images/generations");
      expect(got.headers.get("Authorization")).toBe("Bearer codex-token");
      expect(got.headers.get("Accept")).toBe("application/json");
      expect(got.headers.get("User-Agent")).toBe(codexUserAgent);
      expect(got.headers.get("Version")).toBe("0.135.0");
      expect(got.headers.get("X-Codex-Turn-Metadata")).toBe(`{"turn_id":"turn-1"}`);
      expect(got.headers.get("X-Client-Request-Id")).toBe("client-request-1");
      expect(got.headers.get("Originator")).toBe(codexOriginator);
      expect(getString(got.body, "model")).toBe("gpt-image-1.5");
      expect(getValue(got.body, "extra.preserve")).toBe(true);
      expect(getValue(got.body, "output_compression")).toBe(70);
      expect(getValue(got.body, "stream")).toBeUndefined();
      expect(resp.payload).toBe(upstreamBody);
    } finally {
      upstream.close();
    }
  });

  test("TestCodexExecutorDirectOpenAIImageGenerationStreamsImagesEndpoint", async () => {
    const upstream = startUpstream(() =>
      sseResponse(
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"AA==","partial_image_index":0}\n\n' +
          'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"BB==","usage":{"total_tokens":10,"input_tokens":4,"output_tokens":6}}\n\n',
      ),
    );
    try {
      const result = await new CodexExecutor().executeStream(
        apiKeyAuth(upstream.url, "codex-token"),
        imageRequest("gpt-image-2", `{"model":"gpt-image-2","prompt":"A cute baby sea otter","partial_images":2}`),
        imageOptions(generationsPath, true),
      );
      const out = await drain(result);
      expect(out.error).toBeUndefined();
      const got = upstream.requests[0]!;
      expect(got.path).toBe("/images/generations");
      expect(got.headers.get("Accept")).toBe("text/event-stream");
      expect(getValue(got.body, "stream")).toBe(true);
      expect(getValue(got.body, "partial_images")).toBe(2);
      const combined = out.chunks.join("");
      expect(combined).toContain("event: image_generation.partial_image");
      expect(combined).toContain("event: image_generation.completed");
    } finally {
      upstream.close();
    }
  });

  test("TestCodexExecutorDirectOpenAIImageEditUsesImagesEditEndpointForJSON", async () => {
    const upstream = startUpstream(() => new Response(`{"created":1713833628,"data":[{"b64_json":"AA=="}],"usage":{"total_tokens":10}}`, { headers: { "Content-Type": "application/json" } }));
    try {
      await new CodexExecutor().execute(
        apiKeyAuth(upstream.url, "codex-token"),
        imageRequest(
          "gpt-image-2",
          `{"model":"gpt-image-2","prompt":"Replace the background","images":[{"file_id":"file-abc123"}],"mask":{"file_id":"file-mask123"},"size":"1024x1024","quality":"high","output_format":"png","output_compression":100,"stream":false}`,
        ),
        imageOptions(editsPath, false),
      );
      const got = upstream.requests[0]!;
      expect(got.path).toBe("/images/edits");
      expect(getString(got.body, "model")).toBe("gpt-image-2");
      expect(getString(got.body, "images.0.file_id")).toBe("file-abc123");
      expect(getString(got.body, "mask.file_id")).toBe("file-mask123");
      expect(getValue(got.body, "stream")).toBeUndefined();
    } finally {
      upstream.close();
    }
  });

  test("TestCodexExecutorDirectOpenAIImageEditUsesImagesEditEndpointForMultipart", async () => {
    const form = await multipart(
      [
        ["model", "codex/gpt-image-1.5"],
        ["prompt", "Create a lovely gift basket"],
        ["output_format", "webp"],
        ["n", "2"],
        ["stream", "false"],
      ],
      [
        { field: "image[]", name: "source.png", data: "png-data" },
        { field: "mask", name: "mask.png", data: "mask-data" },
      ],
    );
    const upstream = startUpstream(jsonOK);
    try {
      await new CodexExecutor().execute(apiKeyAuth(upstream.url, "codex-token"), imageRequest("codex/gpt-image-1.5", form.payload), imageOptions(editsPath, false, { headers: new Headers({ "Content-Type": form.contentType }) }));
      const got = upstream.requests[0]!;
      expect(got.path).toBe("/images/edits");
      expect(got.headers.get("Content-Type")!.startsWith("application/json")).toBe(true);
      expect(jsonValid(got.body)).toBe(true);
      expect(getString(got.body, "model")).toBe("gpt-image-1.5");
      expect(getString(got.body, "prompt")).toBe("Create a lovely gift basket");
      expect(getString(got.body, "output_format")).toBe("webp");
      expect(getValue(got.body, "n")).toBe(2);
      expect(getValue(got.body, "stream")).toBeUndefined();
      expect(getString(got.body, "images.0.image_url")).toContain(";base64,cG5nLWRhdGE=");
      expect(getString(got.body, "mask.image_url")).toContain(";base64,bWFzay1kYXRh");
    } finally {
      upstream.close();
    }
  });

  test("TestCodexExecutorDirectOpenAIImage25Models", async () => {
    const models = ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "codex/gpt-image-2.5", "codex/gpt-image-2.5-flare", "codex/gpt-image-2.5-sunburst", "GPT-Image-2.5(medium)", "codex/GPT-Image-2.5-Flare(high)"];
    for (const model of models) {
      const baseModel = codexOpenAIImageBaseModel(model);
      expect(codexIsDirectOpenAIImageModel(baseModel), model).toBe(true);
      for (const kind of ["generate", "edit", "stream"] as const) {
        const upstream = startUpstream(() => (kind === "stream" ? sseResponse('event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"BB=="}\n\n') : jsonOK()));
        try {
          const executor = new CodexExecutor();
          const auth = apiKeyAuth(upstream.url, "codex-token");
          if (kind === "generate") {
            await executor.execute(auth, imageRequest(model, `{"model":"${model}","prompt":"draw something"}`), imageOptions(generationsPath, false));
          } else if (kind === "edit") {
            await executor.execute(auth, imageRequest(model, `{"model":"${model}","prompt":"edit something","images":[{"file_id":"f1"}]}`), imageOptions(editsPath, false));
          } else {
            const out = await drain(await executor.executeStream(auth, imageRequest(model, `{"model":"${model}","prompt":"stream something"}`), imageOptions(generationsPath, true)));
            expect(out.error).toBeUndefined();
          }
          const got = upstream.requests[0]!;
          expect(got.path, `${kind}/${model}`).toBe(kind === "edit" ? "/images/edits" : "/images/generations");
          expect(getString(got.body, "model"), `${kind}/${model}`).toBe(baseModel);
        } finally {
          upstream.close();
        }
      }
    }
  });

  test("free-plan credentials are rejected as a capability mismatch when free auths are disallowed", async () => {
    const auth = apiKeyAuth("http://127.0.0.1:1", "codex-token", { plan_type: "free" });
    const opts = imageOptions(generationsPath, false);
    opts.metadata![DisallowFreeAuthMetadataKey] = true;
    const err = await new CodexExecutor().execute(auth, imageRequest("gpt-image-2", `{"model":"gpt-image-2","prompt":"x"}`), opts).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(404);
    expect(getString(err.body, "error.code")).toBe("model_not_found");
  });
});

// ---------------------------------------------------------------------------
// codex_openai_images_extract_test.go
// ---------------------------------------------------------------------------

const imageGenItem = (result: string, format: string) => ({ type: "image_generation_call", result, output_format: format });
const nowSeconds = () => 1_800_000_000;

describe("codexExtractImageResults", () => {
  test("TestCodexExtractImageResults_FromCompletedOutput", () => {
    const completed = { type: "response.completed", response: { created_at: 111, output: [imageGenItem("AAA", "png")] } };
    const out = codexExtractImageResults(completed, undefined, nowSeconds);
    expect(out.createdAt).toBe(111);
    expect(out.results.map((r) => r.result)).toEqual(["AAA"]);
    expect(out.firstMeta.outputFormat).toBe("png");
  });

  test("TestCodexExtractImageResults_FallbackToCollectedItemsOrdered", () => {
    const completed = { type: "response.completed", response: { created_at: 222, output: [] } };
    const items = newCodexImageOutputItems();
    items.byIndex.set(2, imageGenItem("SECOND", "png"));
    items.byIndex.set(0, imageGenItem("FIRST", "jpg"));
    const out = codexExtractImageResults(completed, items, nowSeconds);
    expect(out.createdAt).toBe(222);
    expect(out.results.map((r) => r.result)).toEqual(["FIRST", "SECOND"]);
  });

  test("TestCodexExtractImageResults_PrefersCompletedOutputOverItems", () => {
    const completed = { type: "response.completed", response: { created_at: 333, output: [imageGenItem("FROM_OUTPUT", "png")] } };
    const items = newCodexImageOutputItems();
    items.byIndex.set(0, imageGenItem("FROM_ITEMS", "png"));
    expect(codexExtractImageResults(completed, items, nowSeconds).results.map((r) => r.result)).toEqual(["FROM_OUTPUT"]);
  });

  test("TestCodexExtractImageResults_WrongEventType", () => {
    expect(() => codexExtractImageResults({ type: "response.in_progress" }, undefined, nowSeconds)).toThrow();
  });

  test("TestCodexExtractImageResults_FallbackList", () => {
    const completed = { type: "response.completed", response: { created_at: 444 } };
    const items = newCodexImageOutputItems();
    items.fallback.push(imageGenItem("FB", "webp"));
    const out = codexExtractImageResults(completed, items, nowSeconds);
    expect(out.results.map((r) => r.result)).toEqual(["FB"]);
    expect(out.firstMeta.outputFormat).toBe("webp");
  });

  test("missing created_at falls back to the clock; url format builds data URLs", () => {
    const completed = { type: "response.completed", response: { output: [{ ...imageGenItem("QUJD", "webp"), revised_prompt: "a cat", size: "1024x1024" }], tool_usage: { image_gen: { input_tokens: 3, output_tokens: 7 } } } };
    const out = codexExtractImageResults(completed, undefined, nowSeconds);
    expect(out.createdAt).toBe(1_800_000_000);
    const body = JSON.parse(codexBuildImagesAPIResponse(out, "url"));
    expect(body).toEqual({ created: 1_800_000_000, output_format: "webp", size: "1024x1024", usage: { input_tokens: 3, output_tokens: 7 }, data: [{ revised_prompt: "a cat", url: "data:image/webp;base64,QUJD" }] });
  });
});

// ---------------------------------------------------------------------------
// Responses image_generation tool path (new)
// ---------------------------------------------------------------------------

const ev = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

describe("Responses image_generation tool route", () => {
  // A route model that is not a GPT Image model takes the tool path (upstream: also SIWC credentials).
  const toolModel = "my-image-tool";

  test("non-stream generation builds the forced tool request and returns b64_json", async () => {
    const upstream = startUpstream(() =>
      sseResponse(
        ev({ type: "response.created", response: { id: "r1" } }) +
          ev({ type: "response.output_item.done", output_index: 1, item: { type: "image_generation_call", result: "SU1H", output_format: "png", revised_prompt: "a red fox" } }) +
          ev({ type: "response.completed", response: { id: "r1", created_at: 1700000000, output: [], tool_usage: { image_gen: { input_tokens: 5, output_tokens: 9, total_tokens: 14 } } } }),
      ),
    );
    try {
      const resp = await new CodexExecutor().execute(
        apiKeyAuth(upstream.url, "codex-token"),
        imageRequest(toolModel, `{"model":"${toolModel}","prompt":"a fox","size":"1024x1024","quality":"high","output_compression":80,"partial_images":2}`),
        imageOptions(generationsPath, false),
      );
      const got = upstream.requests[0]!;
      expect(got.path).toBe("/responses");
      expect(got.headers.get("Accept")).toBe("text/event-stream");
      const body = JSON.parse(got.body);
      expect(body.model).toBe("gpt-5.4-mini");
      expect(body.stream).toBe(true);
      expect(body.instructions).toBe("");
      expect(body.tool_choice).toEqual({ type: "image_generation" });
      expect(body.tools).toEqual([{ type: "image_generation", action: "generate", model: toolModel, size: "1024x1024", quality: "high", output_compression: 80, partial_images: 2 }]);
      expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "a fox" }] }]);
      expect(JSON.parse(resp.payload)).toEqual({
        created: 1700000000,
        output_format: "png",
        usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 },
        data: [{ revised_prompt: "a red fox", b64_json: "SU1H" }],
      });
    } finally {
      upstream.close();
    }
  });

  test("JSON edit sends input images and the mask; url response format", async () => {
    const upstream = startUpstream(() => sseResponse(ev({ type: "response.completed", response: { created_at: 5, output: [{ type: "image_generation_call", result: "QQ==", output_format: "jpeg" }] } })));
    try {
      const resp = await new CodexExecutor().execute(
        apiKeyAuth(upstream.url, "codex-token"),
        imageRequest(toolModel, JSON.stringify({ model: toolModel, prompt: "make it blue", images: [{ image_url: "data:image/png;base64,AAA" }, { file_id: "ignored" }], mask: { image_url: "data:image/png;base64,MMM" }, input_fidelity: "high", response_format: "url" })),
        imageOptions(editsPath, false),
      );
      const body = JSON.parse(upstream.requests[0]!.body);
      expect(body.tools[0]).toEqual({ type: "image_generation", action: "edit", model: toolModel, input_fidelity: "high", input_image_mask: { image_url: "data:image/png;base64,MMM" } });
      expect(body.input[0].content).toEqual([
        { type: "input_text", text: "make it blue" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ]);
      expect(JSON.parse(resp.payload).data).toEqual([{ url: "data:image/jpeg;base64,QQ==" }]);
    } finally {
      upstream.close();
    }
  });

  test("stream emits partial_image and completed frames", async () => {
    const upstream = startUpstream(() =>
      sseResponse(
        ev({ type: "response.image_generation_call.partial_image", partial_image_index: 0, partial_image_b64: "UDA=", output_format: "png" }) +
          ev({ type: "response.output_item.done", output_index: 0, item: { type: "image_generation_call", result: "RklOQUw=", output_format: "png" } }) +
          ev({ type: "response.completed", response: { created_at: 9, output: [], tool_usage: { image_gen: { input_tokens: 1, output_tokens: 2 } } } }),
      ),
    );
    try {
      const out = await drain(await new CodexExecutor().executeStream(apiKeyAuth(upstream.url, "codex-token"), imageRequest(toolModel, `{"model":"${toolModel}","prompt":"x"}`), imageOptions(generationsPath, true)));
      expect(out.error).toBeUndefined();
      expect(out.chunks).toEqual([
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"UDA="}\n\n',
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","usage":{"input_tokens":1,"output_tokens":2},"b64_json":"RklOQUw="}\n\n',
      ]);
    } finally {
      upstream.close();
    }
  });

  test("multipart edit stream uses the image_edit prefix", async () => {
    const form = await multipart(
      [
        ["model", toolModel],
        ["prompt", "edit"],
        ["partial_images", "1"],
      ],
      [{ field: "image", name: "a.png", data: "png-data", type: "image/png" }],
    );
    const upstream = startUpstream(() => sseResponse(ev({ type: "response.completed", response: { created_at: 9, output: [{ type: "image_generation_call", result: "RQ==" }] } })));
    try {
      const out = await drain(await new CodexExecutor().executeStream(apiKeyAuth(upstream.url, "codex-token"), imageRequest(toolModel, form.payload), imageOptions(editsPath, true, { headers: new Headers({ "Content-Type": form.contentType }) })));
      expect(out.chunks.join("")).toContain("event: image_edit.completed");
      const body = JSON.parse(upstream.requests[0]!.body);
      expect(body.tools[0].partial_images).toBe(1);
      expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,cG5nLWRhdGE=" });
    } finally {
      upstream.close();
    }
  });

  test("a completed response without image output is a 502", async () => {
    const upstream = startUpstream(() => sseResponse(ev({ type: "response.completed", response: { created_at: 9, output: [{ type: "message", content: [] }] } })));
    try {
      const err = await new CodexExecutor().execute(apiKeyAuth(upstream.url, "codex-token"), imageRequest(toolModel, `{"prompt":"x"}`), imageOptions(generationsPath, false)).catch((e) => e);
      expect(err).toBeInstanceOf(StatusError);
      expect(err.statusCode).toBe(502);
    } finally {
      upstream.close();
    }
  });
});

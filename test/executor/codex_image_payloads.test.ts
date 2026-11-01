// Ported from: internal/runtime/executor/executor_payload_optimization_test.go
// Skipped cases: TestEnsureColonSpacedJSONLeavesInvalidPayloadUnchanged (ensureColonSpacedJSON belongs to the AI Studio
//   websocket relay transport, not ported), TestNormalizeKimiToolMessageLinks* (Kimi dropped), the Go benchmarks
//   (BenchmarkCodexBuildImagesAPIResponseLargePayload, BenchmarkNormalizeKimiToolMessageLinks*).
// Adapted: codexBuildImagesAPIResponse takes the extraction record ({results, createdAt, usage, firstMeta}) the TS
//   executor builds instead of Go's positional arguments.
import { expect, test } from "bun:test";
import { codexBuildImagesAPIResponse, codexBuildImagesResponsesRequest, codexRewriteOpenAIImageEditMultipartToJSON } from "../../src/executor/codex/images.ts";

test("TestCodexMultipartImageEditAppendsExistingImages", async () => {
  const form = new FormData();
  form.append("images", "existing-1");
  form.append("images", "existing-2");
  form.append("image[]", new File([new TextEncoder().encode("png-data")], "source.png"));
  const request = new Request("http://localhost/", { method: "POST", body: form });
  const contentType = request.headers.get("Content-Type")!;
  const body = new Uint8Array(await request.arrayBuffer());
  const out = JSON.parse(await codexRewriteOpenAIImageEditMultipartToJSON(body, contentType, "gpt-image-1.5", false));
  expect(out.images[0]).toBe("existing-1");
  expect(out.images[1]).toBe("existing-2");
  expect(String(out.images[2].image_url).startsWith("data:application/octet-stream;base64,")).toBe(true);
});

test("TestCodexImageBuildersPreservePayloads", () => {
  const tool = { type: "image_generation", model: "gpt-image-2" };
  const request = codexBuildImagesResponsesRequest(`draw "this"`, ["data:image/png;base64,AA==", "", "data:image/jpeg;base64,BB=="], tool);
  const req = JSON.parse(request);
  expect(req.input[0].content[0].text).toBe(`draw "this"`);
  expect(req.input[0].content.length).toBe(3);
  expect(req.tools[0].model).toBe("gpt-image-2");

  const result = { result: "AA==", outputFormat: "png", revisedPrompt: `revised "prompt"`, quality: "high", size: "1024x1024", background: "" };
  const response = JSON.parse(codexBuildImagesAPIResponse({ results: [result], createdAt: 123, usage: { images: 1 }, firstMeta: result }, "b64_json"));
  expect(response.data[0].b64_json).toBe("AA==");
  expect(response.data[0].revised_prompt).toBe(`revised "prompt"`);
  expect(response.usage.images).toBe(1);
});

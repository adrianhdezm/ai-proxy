// Ported from: internal/runtime/executor/codex_executor_imagegen_test.go
// Ported from: internal/runtime/executor/helps/payload_helpers_disable_image_generation_test.go
// Skipped cases: TestApplyPayloadConfigWithRoot_DisableImageGenerationChat_KeepsImageGenerationOnImagesEndpoints,
//   TestApplyPayloadConfigWithRoot_DisableImageGenerationPassthrough_KeepsPayloadUnchanged (the "chat" and
//   "passthrough" modes are not ported: multimedia.disableImageGeneration is a boolean),
//   TestApplyPayloadConfigWithRoot_DisableImageGeneration_PayloadOverrideCanRestoreImageGeneration and the
//   remaining payload-rule cases of that file (payload config rules are not ported); the strip cases run
//   against stripImageGenerationTools, which the Codex executor applies in place of the payload finalizer.
// New cases (no upstream test): Claude requests through the Codex executor get the tool by default, not
// with disableImageGeneration, and a client-declared image_generation tool / tool_choice is stripped then.
import { describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { stripImageGenerationTools } from "../../../src/executor/codex/images.ts";
import { ensureImageGenerationTool } from "../../../src/executor/codex/request.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { apiKeyAuth, claudePayload, drain, getValue, options, request, sseResponse, stubFetch } from "./helpers.ts";

const completed = 'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n';

function toolsOf(body: string): Array<Record<string, unknown>> {
  return (getValue(body, "tools") as Array<Record<string, unknown>> | undefined) ?? [];
}

describe("Responses Lite requests", () => {
  test("TestCodexExecutorExecuteResponsesLiteHeaderDoesNotInjectImageGenerationTool", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const headers = new Headers({ "X-OpenAI-Internal-Codex-Responses-Lite": "true" });
    await new CodexExecutor({ fetch: stub.fetch }).execute(apiKeyAuth("https://example.test", "test", { plan_type: "pro" }), request("gpt-5.6-sol", `{"model":"gpt-5.6-sol","input":"hello"}`), options("openai-response", false, { headers }));
    const body = stub.calls[0]!.body;
    expect(getValue(body, "tools")).toBeUndefined();
    expect(getValue(body, "parallel_tool_calls")).toBe(false);
  });

  test("TestCodexExecutorExecuteStreamResponsesLiteHeaderForcesParallelToolCallsFalse", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const headers = new Headers({ "X-OpenAI-Internal-Codex-Responses-Lite": "true" });
    const result = await new CodexExecutor({ fetch: stub.fetch }).executeStream(apiKeyAuth("https://example.test", "test", { plan_type: "pro" }), request("gpt-5.6-luna", `{"model":"gpt-5.6-luna","input":"hello"}`), options("openai-response", true, { headers }));
    await drain(result);
    expect(getValue(stub.calls[0]!.body, "parallel_tool_calls")).toBe(false);
  });
});

describe("ensureImageGenerationTool", () => {
  test("TestEnsureImageGenerationTool_ResponsesLiteMetadataDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.6-sol","client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":"true"},"input":[{"role":"user","content":"hello"}]}`;
    expect(ensureImageGenerationTool(body, "gpt-5.6-sol", undefined, undefined)).toBe(body);
  });

  test("TestEnsureImageGenerationTool_ResponsesLiteBooleanMetadataDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.6-sol","client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":true},"input":"hello"}`;
    expect(ensureImageGenerationTool(body, "gpt-5.6-sol", undefined, undefined)).toBe(body);
  });

  test("TestEnsureImageGenerationTool_ResponsesLiteHeaderDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.6-sol","input":"hello"}`;
    expect(ensureImageGenerationTool(body, "gpt-5.6-sol", undefined, new Headers({ "X-OpenAI-Internal-Codex-Responses-Lite": "true" }))).toBe(body);
  });

  test("TestEnsureImageGenerationTool_ResponsesLiteFalseMetadataStillInjectsTool", () => {
    const body = `{"model":"gpt-5.6-sol","client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":"false"},"input":"hello"}`;
    expect(toolsOf(ensureImageGenerationTool(body, "gpt-5.6-sol", undefined, undefined))[0]?.type).toBe("image_generation");
  });

  test("TestEnsureImageGenerationTool_NoTools", () => {
    const tools = toolsOf(ensureImageGenerationTool(`{"model":"gpt-5.4","input":"draw a cat"}`, "gpt-5.4", undefined, undefined));
    expect(tools).toEqual([{ type: "image_generation", output_format: "png" }]);
  });

  test("TestEnsureImageGenerationTool_ExistingToolsWithoutImageGen", () => {
    const tools = toolsOf(ensureImageGenerationTool(`{"model":"gpt-5.4","tools":[{"type":"function","name":"get_weather","parameters":{}}]}`, "gpt-5.4", undefined, undefined));
    expect(tools.map((t) => t.type)).toEqual(["function", "image_generation"]);
  });

  test("TestEnsureImageGenerationTool_AlreadyPresent", () => {
    const tools = toolsOf(ensureImageGenerationTool(`{"model":"gpt-5.4","tools":[{"type":"image_generation","output_format":"webp"},{"type":"function","name":"f1"}]}`, "gpt-5.4", undefined, undefined));
    expect(tools.length).toBe(2);
    expect(tools[0]!.output_format).toBe("webp");
  });

  test("TestEnsureImageGenerationTool_ImageGenNamespaceDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.4","tools":[{"type":"namespace","name":"image_gen","tools":[{"type":"function","name":"imagegen","parameters":{}}]}]}`;
    expect(ensureImageGenerationTool(body, "gpt-5.4", undefined, undefined)).toBe(body);
  });

  test("TestEnsureImageGenerationTool_FlattenedImageGenFunctionDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.4","tools":[{"type":"function","name":"image_gen.imagegen","parameters":{}}]}`;
    expect(ensureImageGenerationTool(body, "gpt-5.4", undefined, undefined)).toBe(body);
  });

  test("TestEnsureImageGenerationTool_SimilarNamespaceStillInjectsTool", () => {
    const tools = toolsOf(ensureImageGenerationTool(`{"model":"gpt-5.4","tools":[{"type":"namespace","name":"image_tools","tools":[{"type":"function","name":"imagegen","parameters":{}}]}]}`, "gpt-5.4", undefined, undefined));
    expect(tools.length).toBe(2);
    expect(tools[1]!.type).toBe("image_generation");
  });

  test("TestEnsureImageGenerationTool_EmptyToolsArray", () => {
    expect(toolsOf(ensureImageGenerationTool(`{"model":"gpt-5.4","tools":[]}`, "gpt-5.4", undefined, undefined)).map((t) => t.type)).toEqual(["image_generation"]);
  });

  test("TestEnsureImageGenerationTool_WebSearchAndImageGen", () => {
    expect(toolsOf(ensureImageGenerationTool(`{"model":"gpt-5.4","tools":[{"type":"web_search"}]}`, "gpt-5.4", undefined, undefined)).map((t) => t.type)).toEqual(["web_search", "image_generation"]);
  });

  test("TestEnsureImageGenerationTool_GPT53CodexSparkDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.3-codex-spark","input":"draw a cat"}`;
    expect(ensureImageGenerationTool(body, "gpt-5.3-codex-spark", undefined, undefined)).toBe(body);
  });

  test("TestEnsureImageGenerationTool_FreeCodexAuthDoesNotInjectTool", () => {
    const body = `{"model":"gpt-5.4","input":"draw a cat"}`;
    const freeAuth = newAuth({ id: "free", provider: "codex", attributes: { plan_type: "free" } });
    expect(ensureImageGenerationTool(body, "gpt-5.4", freeAuth, undefined)).toBe(body);
  });
});

describe("disable-image-generation strip", () => {
  test("TestApplyPayloadConfigWithRoot_DisableImageGeneration_RemovesToolsEntry", () => {
    const out = stripImageGenerationTools(`{"tools":[{"type":"image_generation","output_format":"png"},{"type":"function","name":"f1"}]}`);
    expect(toolsOf(out).map((t) => t.type)).toEqual(["function"]);
  });

  test("TestApplyPayloadConfigWithRoot_DisableImageGeneration_RemovesToolsEntryWithRoot", () => {
    const out = stripImageGenerationTools(`{"request":{"tools":[{"type":"image_generation"},{"type":"web_search"}]}}`, "request");
    expect((getValue(out, "request.tools") as Array<{ type: string }>).map((t) => t.type)).toEqual(["web_search"]);
  });

  test("TestApplyPayloadConfigWithRoot_DisableImageGeneration_RemovesToolChoiceByType", () => {
    const out = stripImageGenerationTools(`{"tools":[{"type":"image_generation"},{"type":"function","name":"f1"}],"tool_choice":{"type":"image_generation"}}`);
    expect(getValue(out, "tool_choice")).toBeUndefined();
  });

  test("TestApplyPayloadConfigWithRoot_DisableImageGeneration_RemovesToolChoiceByNameWithRoot", () => {
    const out = stripImageGenerationTools(`{"request":{"tools":[{"type":"image_generation"},{"type":"web_search"}],"tool_choice":{"type":"tool","name":"image_generation"}}}`, "request");
    expect(getValue(out, "request.tool_choice")).toBeUndefined();
  });

  test("other tool choices and payloads without the tool are left untouched", () => {
    const body = `{"tools":[{"type":"function","name":"f1"}],"tool_choice":"auto"}`;
    expect(stripImageGenerationTools(body)).toBe(body);
    expect(getValue(stripImageGenerationTools(`{"tool_choice":"image_generation"}`), "tool_choice")).toBeUndefined();
  });
});

describe("Codex executor wiring", () => {
  test("Claude requests get the image_generation tool by default", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    await new CodexExecutor({ fetch: stub.fetch }).execute(apiKeyAuth("https://example.test", "test", { plan_type: "pro" }), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", false));
    expect(toolsOf(stub.calls[0]!.body)).toContainEqual({ type: "image_generation", output_format: "png" });
  });

  test("disableImageGeneration neither injects nor forwards image_generation", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const executor = new CodexExecutor({ fetch: stub.fetch, disableImageGeneration: true });
    await executor.execute(apiKeyAuth("https://example.test", "test", { plan_type: "pro" }), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", false));
    expect(getValue(stub.calls[0]!.body, "tools")).toBeUndefined();

    const native = `{"model":"gpt-5.4","input":"hi","tools":[{"type":"image_generation"},{"type":"function","name":"f1","parameters":{}}],"tool_choice":{"type":"image_generation"}}`;
    await executor.execute(apiKeyAuth("https://example.test"), request("gpt-5.4", native), options("openai-response", false));
    const body = stub.calls[1]!.body;
    expect(toolsOf(body).map((t) => t.type)).toEqual(["function"]);
    expect(getValue(body, "tool_choice")).toBeUndefined();
  });
});

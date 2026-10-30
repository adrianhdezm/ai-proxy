// Ported from: internal/runtime/executor/openai_compat_executor_reasoning_test.go
// Skipped cases: none. Go bound the resolved model definition through request metadata
//   ("cliproxy.resolved_api_key_model_info"); this port accepts the same key and additionally
//   resolves is-compat from the credential's model overrides.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { OpenAICompatExecutor, ResolvedAPIKeyModelInfoMetadataKey } from "../../../src/executor/openai/index.ts";
import { FormatClaude, FormatOpenAI } from "../../../src/translator/types.ts";
import { apiKeyAuth, configWithModels, exists, getString, jsonResponse, modelOverride, startUpstream } from "./helpers.ts";

const upstream = startUpstream(() => jsonResponse(`{"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`));
afterAll(() => upstream.close());

const payload = `{"model":"deepseek-v4-flash","max_tokens":32,"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"prior reasoning","signature":""},{"type":"tool_use","id":"call_1","name":"Read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"ok"}]}]}`;

describe("OpenAICompatExecutor uses the compatible Claude translation", () => {
  beforeEach(() => {
    upstream.requests.length = 0;
  });

  test("bound model info with isCompat preserves assistant reasoning_content", async () => {
    const executor = new OpenAICompatExecutor();
    const auth = apiKeyAuth({ baseURL: upstream.baseURL.replace(/\/v1$/, ""), apiKey: "test-key" });
    await executor.execute(
      auth,
      { model: "deepseek-v4-flash", payload, format: FormatClaude, metadata: { [ResolvedAPIKeyModelInfoMetadataKey]: { id: "deepseek-v4-flash", type: "openai", isCompat: true } } },
      { stream: false, sourceFormat: FormatClaude, responseFormat: FormatOpenAI },
    );
    const body = upstream.lastBody();
    expect(upstream.requests[0]!.url).toBe("/chat/completions");
    expect(getString(body, "messages.0.reasoning_content")).toBe("prior reasoning");
    expect(exists(body, "messages.0.tool_calls")).toBe(true);
  });

  test("is-compat model override preserves assistant reasoning_content", async () => {
    const executor = new OpenAICompatExecutor(configWithModels([modelOverride({ name: "deepseek-v4-flash", alias: "deepseek-v4-flash", isCompat: true })]));
    const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "test-key", configIndex: 0 });
    await executor.execute(auth, { model: "deepseek-v4-flash", payload, format: FormatClaude }, { stream: false, sourceFormat: FormatClaude, responseFormat: FormatOpenAI });
    const body = upstream.lastBody();
    expect(getString(body, "messages.0.reasoning_content")).toBe("prior reasoning");
    expect(exists(body, "messages.0.tool_calls")).toBe(true);
  });

  test("without compat the thinking block is not relayed as reasoning_content", async () => {
    const executor = new OpenAICompatExecutor();
    const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "test-key" });
    await executor.execute(auth, { model: "deepseek-v4-flash", payload, format: FormatClaude }, { stream: false, sourceFormat: FormatClaude, responseFormat: FormatOpenAI });
    const body = upstream.lastBody();
    expect(exists(body, "messages.0.reasoning_content")).toBe(false);
    expect(exists(body, "messages.0.tool_calls")).toBe(true);
  });
});

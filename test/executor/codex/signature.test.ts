// Ported from: internal/runtime/executor/codex_executor_signature_test.go
// Skipped cases: none. Adaptations: the config codex-api-key model list (Go: cfg.CodexKey[].Models) is given through
//   CodexExecutorOptions.modelOptionsFor; TestCodexExecutorDisambiguatesConfigIndex builds it from a config with
//   codexModelOptionsFromConfig, which resolves the credential's entry by config_index like Go's resolveCodexConfig.
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import type { Config } from "../../../src/config/types.ts";
import { CodexExecutor, type CodexModelOption, codexModelOptionsFromConfig, ResolvedModelInfoMetadataKey } from "../../../src/executor/codex/index.ts";
import { apiKeyAuth, drain, getString, getValue, options, startUpstream, sseResponse, validCodexReasoningEncryptedContentForTest } from "./helpers.ts";

const completedSSE = 'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","background":false,"error":null}}\n\n';
const compactJSON = `{"id":"resp_1","object":"response.compaction","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`;

const upstream = startUpstream((req) => (req.path.endsWith("/responses/compact") ? new Response(compactJSON, { headers: { "Content-Type": "application/json" } }) : sseResponse(completedSSE)));
afterAll(() => upstream.close());

function lastBody(): string {
  return upstream.requests[upstream.requests.length - 1]!.body;
}

function responsesRequest(model: string, payload: string, metadata?: Record<string, unknown>) {
  return { model, payload, format: "openai-response", metadata };
}

const deepseekModels: CodexModelOption[] = [{ name: "DeepSeek-V4.1-Flash", alias: "deepseek-v4.1-flash", isCompat: true }];

describe("invalid reasoning encrypted_content is dropped from the final request", () => {
  test("TestCodexExecutorDropsInvalidReasoningEncryptedContentFromFinalRequest", async () => {
    const valid = validCodexReasoningEncryptedContentForTest();
    const payload =
      `{"model":"gpt-5.4","input":[` +
      `{"id":"rs_bad","type":"reasoning","encrypted_content":"gAAAAABqFTIa\\u2026abc","summary":[]},` +
      `{"id":"rs_non_string","type":"reasoning","encrypted_content":123,"summary":[]},` +
      `{"id":"rs_good","type":"reasoning","encrypted_content":"${valid}","summary":[]},` +
      `{"role":"user","content":"hello","encrypted_content":"leave-message-alone"}` +
      `]}`;
    await new CodexExecutor().execute(apiKeyAuth(upstream.url), responsesRequest("gpt-5.4", payload), options("openai-response", false));
    const body = lastBody();
    expect(getValue(body, "input.0.encrypted_content")).toBeUndefined();
    // store=false default: the orphan id is stripped too.
    expect(getValue(body, "input.0.id")).toBeUndefined();
    expect(getValue(body, "input.1.encrypted_content")).toBeUndefined();
    expect(getValue(body, "input.1.id")).toBeUndefined();
    expect(getString(body, "input.2.encrypted_content")).toBe(valid);
    expect(getString(body, "input.3.encrypted_content")).toBe("leave-message-alone");
  });

  test("TestCodexExecutorExecuteStreamDropsInvalidReasoningEncryptedContentFromFinalRequest", async () => {
    const payload = `{"model":"gpt-5.4","stream":true,"input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"bad","summary":[]}]}`;
    const result = await new CodexExecutor().executeStream(apiKeyAuth(upstream.url), responsesRequest("gpt-5.4", payload), options("openai-response", true));
    await drain(result);
    expect(getValue(lastBody(), "input.0.encrypted_content")).toBeUndefined();
  });

  test("TestCodexExecutorCompactDropsInvalidReasoningEncryptedContentFromFinalRequest", async () => {
    const payload = `{"model":"gpt-5.4","input":[{"id":"rs_bad","type":"reasoning","encrypted_content":"bad","summary":[]}]}`;
    await new CodexExecutor().execute(apiKeyAuth(upstream.url), responsesRequest("gpt-5.4", payload), options("openai-response", false, { alt: "responses/compact" }));
    expect(upstream.requests[upstream.requests.length - 1]!.path).toBe("/responses/compact");
    expect(getValue(lastBody(), "input.0.encrypted_content")).toBeUndefined();
  });
});

describe("is-compat models keep reasoning_text in reasoning.content", () => {
  const executor = () => new CodexExecutor({ modelOptionsFor: () => deepseekModels });
  const auth = () => apiKeyAuth(upstream.url, "test-api-key");

  function expectReasoningText(body: string, text: string): void {
    expect(getString(body, "input.0.type")).toBe("reasoning");
    const content = getValue(body, "input.0.content");
    expect(Array.isArray(content) && content.length > 0).toBe(true);
    expect(getString(body, "input.0.content.0.text")).toBe(text);
  }

  test("TestCodexExecutorPreservesReasoningTextForCompatModelInResponsesRequest", async () => {
    const payload =
      `{"model":"deepseek-v4.1-flash","input":[` +
      `{"id":"rs_prev_turn","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"DeepSeek reasoning CoT step 1"}]},` +
      `{"id":"call_1","type":"function_call","name":"tool_1","arguments":"{}"},` +
      `{"id":"output_1","type":"function_call_output","call_id":"call_1","output":"tool result"}` +
      `]}`;
    await executor().execute(auth(), responsesRequest("deepseek-v4.1-flash", payload), options("openai-response", false));
    expectReasoningText(lastBody(), "DeepSeek reasoning CoT step 1");
  });

  test("TestCodexExecutorExecuteStreamPreservesReasoningTextForCompatModelInResponsesRequest", async () => {
    const payload =
      `{"model":"deepseek-v4.1-flash","stream":true,"input":[` +
      `{"id":"rs_prev_turn","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"DeepSeek streaming CoT step 1"}]},` +
      `{"id":"call_1","type":"function_call","name":"tool_1","arguments":"{}"}` +
      `]}`;
    await drain(await executor().executeStream(auth(), responsesRequest("deepseek-v4.1-flash", payload), options("openai-response", true)));
    expectReasoningText(lastBody(), "DeepSeek streaming CoT step 1");
  });

  test("TestCodexExecutorCompactPreservesReasoningTextForCompatModelInResponsesRequest", async () => {
    const payload =
      `{"model":"deepseek-v4.1-flash","input":[` +
      `{"id":"rs_prev_turn","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"DeepSeek compact CoT step 1"}]},` +
      `{"id":"call_1","type":"function_call","name":"tool_1","arguments":"{}"}` +
      `]}`;
    await executor().execute(auth(), responsesRequest("deepseek-v4.1-flash", payload), options("openai-response", false, { alt: "responses/compact" }));
    expectReasoningText(lastBody(), "DeepSeek compact CoT step 1");
  });

  test("TestCodexExecutorHonorsAuthoritativeResolvedModelInfoIsCompatFalse", async () => {
    // The configured model says compat, the bound model definition says otherwise and wins.
    const exec = new CodexExecutor({ modelOptionsFor: () => [{ name: "gpt-5.4", alias: "gpt-5.4-alias", isCompat: true }] });
    const payload = `{"model":"gpt-5.4","input":[{"id":"rs_native","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"should be promoted and cleared"}]}]}`;
    await exec.execute(auth(), responsesRequest("gpt-5.4", payload, { [ResolvedModelInfoMetadataKey]: { id: "gpt-5.4", isCompat: false } }), options("openai-response", false));
    const body = lastBody();
    expect(getValue(body, "input.0.content")).toEqual([]);
    expect(getString(body, "input.0.summary.0.text")).toBe("should be promoted and cleared");
  });

  test("TestCodexExecutorDisambiguatesConfigIndex", async () => {
    const config = {
      codexApiKeys: [
        { apiKey: "shared-key", baseUrl: upstream.url, models: [{ name: "model-a", alias: "", isCompat: false }] },
        { apiKey: "shared-key", baseUrl: upstream.url, models: [{ name: "model-a", alias: "", isCompat: true }] },
      ],
    } as unknown as Config;
    const exec = new CodexExecutor({ modelOptionsFor: codexModelOptionsFromConfig(config) });
    // Auth pointing to index 1 (is-compat: true).
    const authCompat = newAuth({
      id: "codex-config-1",
      provider: "codex",
      attributes: { auth_kind: "apikey", config_index: "1", source_backend: "config", base_url: upstream.url, api_key: "shared-key" },
    });
    const payload = `{"model":"model-a","input":[{"id":"rs_1","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"keep me"}]}]}`;
    await exec.execute(authCompat, responsesRequest("model-a", payload), options("openai-response", false));
    const body = lastBody();
    const content = getValue(body, "input.0.content");
    expect(Array.isArray(content) && content.length > 0).toBe(true);
    expect(getString(body, "input.0.content.0.text")).toBe("keep me");
  });
});

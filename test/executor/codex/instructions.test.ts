// Ported from: internal/runtime/executor/codex_executor_instructions_test.go
// Skipped cases: none. The openai-response inbound payload is passed through unchanged (no
//   openai-response translator is registered in this port); a Claude Messages case is added.
import { afterAll, describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { apiKeyAuth, claudePayload, drain, getValue, options, request, sseResponse, startUpstream } from "./helpers.ts";

const completed = `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","background":false,"error":null}}\n\n`;

describe("codex executor instructions", () => {
  const upstream = startUpstream(() => sseResponse(completed));
  afterAll(() => upstream.close());
  const executor = new CodexExecutor();
  const last = () => upstream.requests[upstream.requests.length - 1]!;

  test("TestCodexExecutorExecuteNormalizesNullInstructions", async () => {
    await executor.execute(apiKeyAuth(upstream.url), request("gpt-5.4", `{"model":"gpt-5.4","instructions":null,"input":"hello"}`), options("openai-response", false));
    expect(last().path).toBe("/responses");
    expect(getValue(last().body, "instructions")).toBe("");
  });

  test("TestCodexExecutorExecuteStreamNormalizesNullInstructions", async () => {
    const result = await executor.executeStream(apiKeyAuth(upstream.url), request("gpt-5.4", `{"model":"gpt-5.4","instructions":null,"input":"hello"}`), options("openai-response", true));
    await drain(result);
    expect(last().path).toBe("/responses");
    expect(getValue(last().body, "instructions")).toBe("");
  });

  test("TestCodexExecutorCountTokensTreatsNullInstructionsAsEmpty", async () => {
    const auth = apiKeyAuth("");
    const nullResp = await executor.countTokens(auth, request("gpt-5.4", `{"model":"gpt-5.4","instructions":null,"input":"hello"}`), options("openai-response", false));
    const emptyResp = await executor.countTokens(auth, request("gpt-5.4", `{"model":"gpt-5.4","instructions":"","input":"hello"}`), options("openai-response", false));
    expect(nullResp.payload).toBe(emptyResp.payload);
  });

  test("Claude requests without a system prompt send an empty instructions string", async () => {
    await executor.execute(apiKeyAuth(upstream.url), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", false));
    expect(getValue(last().body, "instructions")).toBe("");
    expect(getValue(last().body, "stream")).toBe(true);
  });
});

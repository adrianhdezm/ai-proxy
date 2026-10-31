// Ported from: internal/runtime/executor/codex_executor_tokens_test.go
// Ported from: internal/runtime/executor/codex_executor_translate_test.go
// Skipped cases: none. Adaptations: Go captured the translated body with translator plugin hooks; here
//   CodexExecutor.countTokensBody exposes the body countTokens estimates. Token counting is a ceil(chars / 4)
//   estimate instead of tiktoken, so the count is checked against the estimate of the collected segments
//   (instructions, message text, tool name / parameters) rather than an exact tiktoken number.
import { afterEach, describe, expect, test } from "bun:test";
import { CodexExecutor, ResolvedModelInfoMetadataKey, countCodexInputTokens, estimateTokensByChars, translateCodexRequestPair } from "../../../src/executor/codex/index.ts";
import { register, unregister } from "../../../src/translator/registry.ts";
import { getString, getValue, oauthAuth } from "./helpers.ts";

describe("TestCodexExecutorCountTokensPreservesToolNumberSchemas", () => {
  const sources = [
    { format: "openai-response", payload: `{"input":"hi","tools":[{"type":"function","name":"exec_command","parameters":{"type":"object","properties":{"yield_time_ms":{"type":"number"}}}}]}` },
    { format: "claude", payload: `{"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"exec_command","input_schema":{"type":"object","properties":{"yield_time_ms":{"type":"number"}}}}]}` },
  ];
  for (const source of sources) {
    for (const compat of [false, true]) {
      test(`${source.format}/compat=${compat}`, async () => {
        const executor = new CodexExecutor();
        const req = { model: "gpt-5.4", payload: source.payload, format: source.format, metadata: { [ResolvedModelInfoMetadataKey]: { id: "gpt-5.4", isCompat: compat } } };
        const opts = { stream: false, sourceFormat: source.format, headers: new Headers({ "User-Agent": "codex_cli_rs/0.1" }) };
        // Token counts alone can miss a schema rewrite (number and integer may estimate alike): inspect the body too.
        const body = executor.countTokensBody(req, opts);
        expect(getString(body, "tools.0.parameters.properties.yield_time_ms.type")).toBe("number");
        const resp = await executor.countTokens(oauthAuth(), req, opts);
        expect(resp.payload.length).toBeGreaterThan(0);
        if (source.format === "claude") expect(getValue(resp.payload, "input_tokens")).toBe(countCodexInputTokens(body));
      });
    }
  }
});

describe("countCodexInputTokens counts the same segments as Go (estimate instead of tiktoken)", () => {
  test("instructions, message text, function calls and outputs, tools and text.format", () => {
    const body = JSON.stringify({
      instructions: "  be brief  ",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "data:..." }] },
        { type: "function_call", name: "lookup", arguments: `{"q":"x"}` },
        { type: "function_call_output", output: "result" },
        { type: "reasoning", text: "thought" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Looks up", parameters: { type: "object" } }],
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    });
    const segments = ["be brief", "hello", "lookup", `{"q":"x"}`, "result", "thought", "lookup", "Looks up", `{"type":"object"}`, "answer", `{"type":"object"}`];
    expect(countCodexInputTokens(body)).toBe(estimateTokensByChars(segments.join("\n")));
  });

  test("empty and segment-free bodies count zero", () => {
    expect(countCodexInputTokens("")).toBe(0);
    expect(countCodexInputTokens(`{"model":"gpt-5.4","input":[]}`)).toBe(0);
  });
});

describe("translateCodexRequestPair", () => {
  const registered: Array<[string, string]> = [];
  afterEach(() => {
    for (const [from, to] of registered.splice(0)) unregister(from, to);
  });

  test("TestTranslateCodexRequestPairReusesEqualPayload", () => {
    const from = "codex-test-from-equal";
    const to = "codex-test-to-equal";
    let calls = 0;
    const seen: Array<{ model: string; stream: boolean }> = [];
    register(from, to, (model, rawJSON, stream) => {
      calls++;
      seen.push({ model, stream });
      return rawJSON;
    });
    registered.push([from, to]);
    const payload = `{"model":"test-model","input":[{"role":"user"}]}`;
    const pair = translateCodexRequestPair(from, to, "test-model", payload, payload.slice(), true);
    expect(calls).toBe(1);
    expect(seen).toEqual([{ model: "test-model", stream: true }]);
    expect(pair.originalTranslated).toBe(pair.body);
  });

  test("TestTranslateCodexRequestPairTranslatesDifferentPayloads", () => {
    const from = "codex-test-from-different";
    const to = "codex-test-to-different";
    let calls = 0;
    register(from, to, (_model, rawJSON) => {
      calls++;
      return rawJSON;
    });
    registered.push([from, to]);
    const originalPayload = `{"model":"test-model","input":[{"role":"system"}]}`;
    const payload = `{"model":"test-model","input":[{"role":"user"}]}`;
    const pair = translateCodexRequestPair(from, to, "test-model", originalPayload, payload, false);
    expect(calls).toBe(2);
    expect(pair.originalTranslated).toBe(originalPayload);
    expect(pair.body).toBe(payload);
  });
});

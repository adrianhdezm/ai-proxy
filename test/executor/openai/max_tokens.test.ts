// Ported from: internal/runtime/executor/openai_compat_executor_max_tokens_test.go
// Ported from: internal/runtime/executor/helps/openai_compat_max_tokens_test.go
// Skipped cases: the "responses request" sub-cases (openai-response inbound is not served by this port);
//   the executor-level "max_tokens=null" sub-cases (the Claude -> OpenAI translator cannot carry a null
//   max_tokens; null preservation is covered at the NormalizeOpenAIMaxTokens helper level).
// Adapted: inbound payloads are Claude Messages requests (the only inbound schema of this port).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { OpenAICompatExecutor, normalizeOpenAIMaxTokens, shouldUseMaxCompletionTokensForModel, type OpenAICompatModelOption } from "../../../src/executor/openai/index.ts";
import { FormatClaude } from "../../../src/translator/types.ts";
import { apiKeyAuth, configWithModels, drain, exists, getInt, getValue, modelOverride, sseResponse, startUpstream, jsonResponse } from "./helpers.ts";

const upstream = startUpstream(() => jsonResponse(`{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"hello"}}]}`));
afterAll(() => upstream.close());

const cfg = configWithModels([
  modelOverride({ name: "upstream-new", alias: "alias-new", useMaxCompletionTokens: true }),
  modelOverride({ name: "upstream-legacy", alias: "alias-legacy", useMaxCompletionTokens: false }),
]);
const executor = new OpenAICompatExecutor(cfg);
const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "test-key", configIndex: 0 });

function claudeRequest(model: string, stream: boolean): string {
  return JSON.stringify({ model, max_tokens: 512, messages: [{ role: "user", content: "hi" }], stream });
}

describe("OpenAICompatExecutor max tokens normalization", () => {
  beforeEach(() => {
    upstream.requests.length = 0;
    upstream.respond(() => jsonResponse(`{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"hello"}}]}`));
  });

  test("Execute chat request with max_tokens and use-max-completion-tokens=true converts to max_completion_tokens", async () => {
    await executor.execute(auth, { model: "alias-new", payload: claudeRequest("alias-new", false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    const body = upstream.lastBody();
    expect(getInt(body, "max_completion_tokens")).toBe(512);
    expect(exists(body, "max_tokens")).toBe(false);
  });

  test("Execute chat request with use-max-completion-tokens=false keeps max_tokens", async () => {
    await executor.execute(auth, { model: "alias-legacy", payload: claudeRequest("alias-legacy", false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    const body = upstream.lastBody();
    expect(getInt(body, "max_tokens")).toBe(512);
    expect(exists(body, "max_completion_tokens")).toBe(false);
  });

  test("Execute matches the upstream model name with a thinking suffix", async () => {
    await executor.execute(auth, { model: "upstream-new(high)", payload: claudeRequest("upstream-new", false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    const body = upstream.lastBody();
    expect(getInt(body, "max_completion_tokens")).toBe(512);
    expect(exists(body, "max_tokens")).toBe(false);
    expect(getValue(body, "model")).toBe("upstream-new");
  });

  test("Execute without compat options defaults to max_tokens", async () => {
    const plain = new OpenAICompatExecutor(configWithModels([]));
    await plain.execute(apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "k" }), { model: "gpt-4o", payload: claudeRequest("gpt-4o", false), format: FormatClaude }, { stream: false, sourceFormat: FormatClaude });
    const body = upstream.lastBody();
    expect(getInt(body, "max_tokens")).toBe(512);
    expect(exists(body, "max_completion_tokens")).toBe(false);
  });
});

describe("OpenAICompatExecutor max tokens normalization (stream)", () => {
  beforeEach(() => {
    upstream.requests.length = 0;
    upstream.respond(() => sseResponse('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  });

  test("ExecuteStream with use-max-completion-tokens=true emits max_completion_tokens", async () => {
    const result = await executor.executeStream(auth, { model: "alias-new", payload: claudeRequest("alias-new", true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { error } = await drain(result);
    expect(error).toBeUndefined();
    const body = upstream.lastBody();
    expect(getInt(body, "max_completion_tokens")).toBe(512);
    expect(exists(body, "max_tokens")).toBe(false);
    expect(getValue(body, "stream_options.include_usage")).toBe(true);
  });

  test("ExecuteStream with use-max-completion-tokens=false emits max_tokens", async () => {
    const result = await executor.executeStream(auth, { model: "alias-legacy", payload: claudeRequest("alias-legacy", true), format: FormatClaude }, { stream: true, sourceFormat: FormatClaude });
    const { error } = await drain(result);
    expect(error).toBeUndefined();
    const body = upstream.lastBody();
    expect(getInt(body, "max_tokens")).toBe(512);
    expect(exists(body, "max_completion_tokens")).toBe(false);
  });
});

describe("shouldUseMaxCompletionTokensForModel", () => {
  const compat: OpenAICompatModelOption[] = [
    { name: "azure/o1-preview", alias: "o1-preview", useMaxCompletionTokens: true },
    { name: "deepseek/v3", alias: "deepseek-chat", useMaxCompletionTokens: false },
    { name: "legacy/gpt-3.5", alias: "gpt-3.5" },
  ];
  const cases: Array<{ name: string; compat: OpenAICompatModelOption[] | undefined; upstreamModel: string; requestedModel: string; want: boolean }> = [
    { name: "nil compat returns false", compat: undefined, upstreamModel: "azure/o1-preview", requestedModel: "o1-preview", want: false },
    { name: "match upstreamModel by name with true", compat, upstreamModel: "azure/o1-preview", requestedModel: "other-alias", want: true },
    { name: "match requestedModel by alias with true", compat, upstreamModel: "unknown-upstream", requestedModel: "o1-preview", want: true },
    { name: "match with thinking suffix on upstreamModel", compat, upstreamModel: "azure/o1-preview(high)", requestedModel: "unknown-alias", want: true },
    { name: "match with thinking suffix on requestedModel", compat, upstreamModel: "unknown", requestedModel: "o1-preview(medium)", want: true },
    { name: "case-insensitive match", compat, upstreamModel: "AZURE/O1-PREVIEW", requestedModel: "O1-PREVIEW", want: true },
    { name: "explicit false returns false", compat, upstreamModel: "deepseek/v3", requestedModel: "deepseek-chat", want: false },
    { name: "omitted default returns false", compat, upstreamModel: "legacy/gpt-3.5", requestedModel: "gpt-3.5", want: false },
    { name: "unmatched model returns false", compat, upstreamModel: "completely-unknown", requestedModel: "unknown-alias", want: false },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(shouldUseMaxCompletionTokensForModel(tt.compat, tt.upstreamModel, tt.requestedModel)).toBe(tt.want);
    });
  }
});

describe("normalizeOpenAIMaxTokens", () => {
  test("useMaxCompletionTokens=true converts max_tokens", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"o1","max_tokens":1024,"messages":[]}`, true);
    expect(getInt(got, "max_completion_tokens")).toBe(1024);
    expect(exists(got, "max_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=true preserves existing max_completion_tokens and removes max_tokens", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"o1","max_tokens":512,"max_completion_tokens":2048}`, true);
    expect(getInt(got, "max_completion_tokens")).toBe(2048);
    expect(exists(got, "max_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=true keeps max_completion_tokens when max_tokens is absent", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"o1","max_completion_tokens":4096}`, true);
    expect(getInt(got, "max_completion_tokens")).toBe(4096);
    expect(exists(got, "max_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=false converts max_completion_tokens to max_tokens", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"deepseek","max_completion_tokens":1024,"messages":[]}`, false);
    expect(getInt(got, "max_tokens")).toBe(1024);
    expect(exists(got, "max_completion_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=false preserves existing max_tokens and removes max_completion_tokens", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"deepseek","max_tokens":512,"max_completion_tokens":2048}`, false);
    expect(getInt(got, "max_tokens")).toBe(512);
    expect(exists(got, "max_completion_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=false keeps max_tokens when max_completion_tokens is absent", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"deepseek","max_tokens":4096}`, false);
    expect(getInt(got, "max_tokens")).toBe(4096);
    expect(exists(got, "max_completion_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=true preserves null value", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"o1","max_tokens":null}`, true);
    expect(exists(got, "max_completion_tokens")).toBe(true);
    expect(getValue(got, "max_completion_tokens")).toBeNull();
    expect(exists(got, "max_tokens")).toBe(false);
  });

  test("useMaxCompletionTokens=false preserves null value", () => {
    const got = normalizeOpenAIMaxTokens(`{"model":"deepseek","max_completion_tokens":null}`, false);
    expect(exists(got, "max_tokens")).toBe(true);
    expect(getValue(got, "max_tokens")).toBeNull();
    expect(exists(got, "max_completion_tokens")).toBe(false);
  });

  test("payload without max tokens remains unchanged", () => {
    const input = `{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}`;
    for (const flag of [true, false]) {
      const got = normalizeOpenAIMaxTokens(input, flag);
      expect(exists(got, "max_tokens")).toBe(false);
      expect(exists(got, "max_completion_tokens")).toBe(false);
      expect(got).toBe(input);
    }
  });

  test("empty payload returns empty", () => {
    expect(normalizeOpenAIMaxTokens("", true)).toBe("");
    expect(normalizeOpenAIMaxTokens("", false)).toBe("");
  });
});

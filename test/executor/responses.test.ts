// Ported from: internal/runtime/executor/helps/responses_usage_helpers_test.go
// Ported from: test/builtin_tools_translation_test.go
// Ported from: test/summary_intent_translation_test.go
// Skipped cases: TestOpenAIToCodex_PreservesBuiltinTools (OpenAI chat inbound is not served); every
//   TestSummaryIntentTranslation row whose source is not OpenAI Responses (Claude-inbound rows are ported in
//   test/translator/*/summary_intent.test.ts; Chat / Gemini / Interactions inbound are not served) and the
//   Responses -> Antigravity / Interactions rows (targets not ported); TestSummaryIntentFinalPipeline,
//   TestInvalidInteractionsSummaryDoesNotWriteTargetControl, TestGeminiSummaryOnlyProducesValidClaudeThinking,
//   TestNativeClaudeMissingDisplayPreservesSignatureOnlyHistory, TestAntigravityIncludeThoughtsPreservesExplicitness
//   (they need the upstream test model catalogue or Interactions / Antigravity / Gemini-inbound translators).
//   Adaptation: the TS registry has no summary wrapper, so the rows apply extractTranslatedSummaryConfig /
//   applySummaryConfigForModel around translateRequest like test/translator/codex/summary_intent.test.ts.
// Also covers (new): the OpenAI executor's Responses stream end (CanFinalizeResponseStream synthesizes the
//   missing [DONE]; an unfinished stream fails with a 502 server error).
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import { createOpenAIExecutor } from "../../src/executor/openai/index.ts";
import { ensureResponsesUsageDetails } from "../../src/executor/responses.ts";
import { StatusError } from "../../src/executor/types.ts";
import { applySummaryConfigForModel, extractTranslatedSummaryConfig } from "../../src/thinking/index.ts";
import "../../src/translator/claude/openai/responses/index.ts";
import "../../src/translator/gemini/openai/responses/index.ts";
import "../../src/translator/openai/openai/responses/index.ts";
import { defaultRegistry } from "../../src/translator/registry.ts";
import { FormatClaude, FormatGemini, FormatOpenAI, FormatOpenAIResponse } from "../../src/translator/types.ts";
import { getAt } from "../../src/util/gpath.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (text: string): any => JSON.parse(text);

describe("responses_usage_helpers_test", () => {
  test("TestEnsureResponsesUsageDetails_NonStreamJSON", () => {
    const got = parse(ensureResponsesUsageDetails(`{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":84,"output_tokens":16,"total_tokens":100}}`));
    expect(got.usage.output_tokens_details.reasoning_tokens).toBe(0);
    expect(got.usage.input_tokens_details.cached_tokens).toBe(0);
  });

  test("TestEnsureResponsesUsageDetails_NonStreamJSONWithDataSubstring", () => {
    const got = parse(
      ensureResponsesUsageDetails(
        `{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","content":[{"type":"text","text":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"}]}],"usage":{"input_tokens":84,"output_tokens":16,"total_tokens":100}}`,
      ),
    );
    expect(got.usage.output_tokens_details.reasoning_tokens).toBe(0);
    expect(got.usage.input_tokens_details.cached_tokens).toBe(0);
  });

  test("TestEnsureResponsesUsageDetails_SSEData", () => {
    const got = ensureResponsesUsageDetails(`data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}`);
    expect(got.startsWith("data: ")).toBe(true);
    const body = parse(got.slice("data: ".length));
    expect(body.response.usage.output_tokens_details.reasoning_tokens).toBe(0);
    expect(body.response.usage.input_tokens_details.cached_tokens).toBe(0);
  });

  test("TestEnsureResponsesUsageDetails_SSEEventDataMultiLine", () => {
    const got = ensureResponsesUsageDetails('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":84,"output_tokens":16,"total_tokens":100}}}\n\n');
    expect(got.startsWith("event: response.completed\n")).toBe(true);
    const dataLines = got.split("\n").filter((line) => line.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    const body = parse(dataLines[0]!.slice("data: ".length));
    expect(body.response.usage.output_tokens_details.reasoning_tokens).toBe(0);
    expect(body.response.usage.input_tokens_details.cached_tokens).toBe(0);
  });

  test("TestEnsureResponsesUsageDetails_PreservesExistingDetails", () => {
    const got = ensureResponsesUsageDetails(
      `data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":3},"output_tokens":4,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":14}}}`,
    );
    const body = parse(got.slice("data: ".length));
    expect(body.response.usage.output_tokens_details.reasoning_tokens).toBe(2);
    expect(body.response.usage.input_tokens_details.cached_tokens).toBe(3);
  });

  test("TestEnsureResponsesUsageDetails_HandlesNullOrEmptyDetails", () => {
    const got = parse(ensureResponsesUsageDetails(`{"id":"resp_1","usage":{"input_tokens":10,"input_tokens_details":null,"output_tokens":4,"output_tokens_details":{},"total_tokens":14}}`));
    expect(got.usage.output_tokens_details.reasoning_tokens).toBe(0);
    expect(got.usage.input_tokens_details.cached_tokens).toBe(0);
  });

  test("TestEnsureResponsesUsageDetails_NonJSONAndDone", () => {
    for (const c of ["data: [DONE]", "[DONE]", ": keepalive", "", `{"type":"response.output_item.added"}`]) expect(ensureResponsesUsageDetails(c)).toBe(c);
  });

  test("response.compaction objects are left alone", () => {
    const compaction = `{"id":"resp_1","object":"response.compaction","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`;
    expect(ensureResponsesUsageDetails(compaction)).toBe(compaction);
  });
});

describe("builtin_tools_translation_test", () => {
  test("TestOpenAIResponsesToOpenAI_IgnoresBuiltinTools", () => {
    const input = `{
      "model":"gpt-5",
      "input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],
      "tools":[{"type":"web_search","search_context_size":"low"}]
    }`;
    const out = parse(defaultRegistry.translateRequest(FormatOpenAIResponse, FormatOpenAI, "gpt-5", input, false));
    expect((out.tools ?? []).length).toBe(0);
  });
});

describe("summary_intent_translation_test (Responses rows)", () => {
  const translate = (from: string, to: string, body: string): string => {
    const summary = extractTranslatedSummaryConfig(body, from, to);
    return applySummaryConfigForModel(defaultRegistry.translateRequest(from, to, "", body, true), to, "", summary);
  };
  const rows: { name: string; to: string; body: string; path: string; want?: unknown }[] = [
    { name: "Responses summary only invents no Chat effort", to: FormatOpenAI, body: `{"model":"gpt-5.4","reasoning":{"summary":"auto"},"input":"hi"}`, path: "reasoning_effort" },
    // Chat has no field for "reason but hide": a disabled summary keeps the requested effort.
    { name: "Responses disabled summary keeps Chat effort", to: FormatOpenAI, body: `{"model":"gpt-5.4","reasoning":{"effort":"high","summary":null},"input":"hi"}`, path: "reasoning_effort", want: "high" },
    { name: "Responses effort alone leaves Claude display absent", to: FormatClaude, body: `{"model":"claude-opus-5","reasoning":{"effort":"high"},"input":"hi"}`, path: "thinking.display" },
    { name: "Responses summary enables Claude summary", to: FormatClaude, body: `{"model":"claude-opus-5","reasoning":{"effort":"high","summary":"auto"},"input":"hi"}`, path: "thinking.display", want: "summarized" },
    { name: "Responses null summary disables Claude summary", to: FormatClaude, body: `{"model":"claude-opus-5","reasoning":{"effort":"high","summary":null},"input":"hi"}`, path: "thinking.display", want: "omitted" },
    { name: "Responses effort alone leaves Gemini summary absent", to: FormatGemini, body: `{"model":"gemini-3.6-flash","reasoning":{"effort":"high"},"input":"hi"}`, path: "generationConfig.thinkingConfig.includeThoughts" },
    { name: "Responses detailed summary enables Gemini summary", to: FormatGemini, body: `{"model":"gemini-3.6-flash","reasoning":{"effort":"high","summary":"detailed"},"input":"hi"}`, path: "generationConfig.thinkingConfig.includeThoughts", want: true },
  ];
  for (const row of rows) {
    test(`TestSummaryIntentTranslation/${row.name}`, () => {
      const out = translate(FormatOpenAIResponse, row.to, row.body);
      const value = getAt(JSON.parse(out), row.path);
      if (row.want === undefined) expect(value, `${row.path} in ${out}`).toBeUndefined();
      else expect(value, `${row.path} in ${out}`).toBe(row.want);
    });
  }
});

describe("OpenAI executor Responses stream end (new)", () => {
  let respond: () => Response = () => new Response("");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => respond() });
  afterAll(() => server.stop(true));
  const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const run = async () => {
    const executor = createOpenAIExecutor(defaultConfig());
    const auth = newAuth({ id: "o1", provider: "openai", attributes: { api_key: "k", base_url: `http://127.0.0.1:${server.port}/v1` } });
    const result = await executor.executeStream(auth, { model: "gpt-test", payload: `{"model":"gpt-test","input":"hi","stream":true}`, format: FormatOpenAIResponse }, { stream: true, sourceFormat: FormatOpenAIResponse });
    const chunks: string[] = [];
    try {
      for await (const c of result.chunks) chunks.push(c);
    } catch (err) {
      return { text: chunks.join(""), err };
    }
    return { text: chunks.join(""), err: undefined };
  };

  test("a finished stream without [DONE] synthesizes response.completed with full usage details", async () => {
    respond = () =>
      new Response(chunk({ role: "assistant", content: "hello" }, null) + chunk({}, "stop") + chunk({}, null, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), {
        headers: { "content-type": "text/event-stream" },
      });
    const { text, err } = await run();
    expect(err).toBeUndefined();
    const completed = text.split("\n").find((line) => line.startsWith("data: ") && line.includes(`"response.completed"`));
    expect(completed).toBeDefined();
    const usage = parse(completed!.slice(6)).response.usage;
    expect(usage.input_tokens_details.cached_tokens).toBe(0);
    expect(usage.output_tokens_details.reasoning_tokens).toBe(0);
  });

  test("an unfinished stream fails with a 502", async () => {
    respond = () => new Response(chunk({ role: "assistant", content: "hel" }, null), { headers: { "content-type": "text/event-stream" } });
    const { err } = await run();
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).statusCode).toBe(502);
  });
});

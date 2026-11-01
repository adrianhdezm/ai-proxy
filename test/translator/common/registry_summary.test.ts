// Ported from: sdk/translator/registry_summary_test.go
// Skipped cases: the port's translator registry is a frozen contract that does not wrap transforms with summary
// post-processing, so the cases run against the translators that apply summary intent themselves
// (Responses -> Claude: convertOpenAIResponsesRequestToClaude). Not ported: the two OpenAI chat -> Claude rows of
// TestRegistryTranslateRequestAppliesSummaryIntent and the "Google Chat extension overrides effort" row (OpenAI
// chat-completions inbound is not ported); the "responses null summary disables Gemini summaries" row (the
// Responses -> Gemini translator does not apply summary intent, the registry wrapper did);
// TestRegistryTranslateRequestPreservesNativeClaudeMissingDisplay (Claude -> Claude is a passthrough without a
// registered translator); TestRegistryTranslateRequestDoesNotMixSummaryIntoFallback (registry fallback wrapper);
// TestRegistryTranslateRequestPluginMissDoesNotMixSummary, TestRegistryTranslateRequestAppliesSummaryAfterPluginTranslation,
// TestRegistryTranslateRequestPluginNormalizerOwnsSourceSummaryIntent and
// TestRegistryTranslateRequestNormalizerOwnsFinalSummaryField (translator plugin hooks are not ported).
import { describe, expect, test } from "bun:test";
import { convertOpenAIResponsesRequestToClaude } from "../../../src/translator/claude/openai/responses/request.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const translate = (model: string, body: unknown): any => JSON.parse(convertOpenAIResponsesRequestToClaude(model, JSON.stringify(body), false));

describe("TestRegistryTranslateRequestAppliesSummaryIntent (Responses -> Claude rows)", () => {
  test("responses effort alone leaves Claude display absent", () => {
    const out = translate("claude-opus-5", { reasoning: { effort: "high" }, input: "hi" });
    expect(out.thinking?.display).toBeUndefined();
  });

  test("responses summary enables Claude summary", () => {
    const out = translate("claude-opus-5", { reasoning: { effort: "high", summary: "auto" }, input: "hi" });
    expect(out.thinking?.display).toBe("summarized");
  });
});

test("TestRegistryTranslateRequestActivatesClaudeForEnabledSummary", () => {
  const out = translate("claude-opus-5", { reasoning: { summary: "auto" }, input: "hi" });
  expect(out.thinking?.type).toBe("adaptive");
  expect(out.thinking?.display).toBe("summarized");
});

test("TestRegistryTranslateRequestDoesNotActivateClaudeForDisabledSummary", () => {
  const out = translate("claude-opus-5", { reasoning: { summary: null }, input: "hi" });
  expect(out.thinking).toBeUndefined();
});

// Ported from: test/summary_intent_translation_test.go
// Skipped cases: every TestSummaryIntentTranslation row other than the two Claude -> Gemini rows
//   ("Native Claude summarized enables Gemini summary", "Claude auto compatibility budget keeps Gemini summary"):
//   they target translators outside this slice; TestSummaryIntentTranslationWithModel,
//   TestGeminiSummaryOnlyProducesValidClaudeThinking, TestNativeClaudeMissingDisplayPreservesSignatureOnlyHistory,
//   TestInvalidInteractionsSummaryDoesNotWriteTargetControl (other translator pairs)
import { describe, expect, test } from "bun:test";
import "../../../src/translator/gemini/claude/index.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { FormatClaude, FormatGemini } from "../../../src/translator/types.ts";
import { exists, getStr } from "./helpers.ts";

describe("SummaryIntentTranslation", () => {
  const cases = [
    {
      name: "Native Claude summarized enables Gemini summary",
      body: `{"model":"claude-opus-5","thinking":{"type":"adaptive","display":"summarized"},"messages":[{"role":"user","content":"hi"}]}`,
      path: "generationConfig.thinkingConfig.includeThoughts",
      want: "true",
      wantExists: true,
    },
    {
      name: "Claude auto compatibility budget keeps Gemini summary",
      body: `{"model":"gemini-3.6-flash","thinking":{"type":"enabled","budget_tokens":-1,"display":"summarized"},"messages":[{"role":"user","content":"hi"}]}`,
      path: "generationConfig.thinkingConfig.includeThoughts",
      want: "true",
      wantExists: true,
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const out = defaultRegistry.translateRequest(FormatClaude, FormatGemini, "", tc.body, true);
      expect(exists(out, tc.path), `body=${out}`).toBe(tc.wantExists);
      if (tc.wantExists) expect(getStr(out, tc.path), `body=${out}`).toBe(tc.want);
    });
  }
});

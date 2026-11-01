// Ported from: test/summary_intent_translation_test.go
// Skipped cases: every row of TestSummaryIntentTranslation whose pair is not Claude->Codex (other
//   translators are outside this slice); TestInvalidInteractionsSummaryDoesNotWriteTargetControl,
//   TestSummaryIntentFinalPipeline, TestGeminiSummaryOnlyProducesValidClaudeThinking,
//   TestNativeClaudeMissingDisplayPreservesSignatureOnlyHistory, TestAntigravityIncludeThoughtsPreservesExplicitness
//
// Upstream's sdk registry wraps every request transform with
// ExtractTranslatedSummaryConfig (before) and ApplySummaryConfigForModel (after). The TS
// registry contract is frozen without that wrapper, so this port applies the same two
// calls around defaultRegistry.translateRequest to exercise the identical pipeline.
import { describe, expect, test } from "bun:test";
import "../../../src/translator/codex/claude/index.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { FormatClaude, FormatCodex } from "../../../src/translator/types.ts";
import { applySummaryConfigForModel, extractTranslatedSummaryConfig } from "../../../src/thinking/index.ts";
import { get } from "./helpers.ts";

function translateRequestWithSummary(from: string, to: string, model: string, body: string): string {
  const summaryConfig = extractTranslatedSummaryConfig(body, from, to);
  const out = defaultRegistry.translateRequest(from, to, model, body, true);
  return applySummaryConfigForModel(out, to, model, summaryConfig);
}

describe("summary intent translation (Claude -> Codex)", () => {
  const tests: { name: string; from: string; to: string; body: string; path: string; want?: string; wantExists: boolean }[] = [
    // The Responses API makes reasoning.summary an explicit opt-in, so an
    // absent source intent must remain absent when translated to Codex.
    {
      name: "Claude absent display leaves Codex summary absent",
      from: FormatClaude,
      to: FormatCodex,
      body: `{"model":"gpt-5.4","max_tokens":1024,"thinking":{"type":"adaptive"},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"hi"}]}`,
      path: "reasoning.summary",
      wantExists: false,
    },
    {
      name: "Claude summarized enables Codex summary",
      from: FormatClaude,
      to: FormatCodex,
      body: `{"model":"gpt-5.4","max_tokens":1024,"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"hi"}]}`,
      path: "reasoning.summary",
      want: "auto",
      wantExists: true,
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const out = translateRequestWithSummary(tt.from, tt.to, "", tt.body);
      const result = get(out, tt.path);
      expect(result !== undefined, `${tt.path} exists; body=${out}`).toBe(tt.wantExists);
      if (tt.wantExists) expect(result).toBe(tt.want);
    });
  }
});

// Ported from: internal/thinking/claude_enabled_effort_test.go
// Skipped cases: TestApplyThinkingClaudeEnabledWithOutputConfigEffort (ported in test/thinking/claude_enabled_effort.test.ts;
//   only the chained Claude -> OpenAI translation case lives here because it needs this slice's request translator)
import { expect, test } from "bun:test";
import { applyThinkingWithSourceAndSummary, emptySummaryConfig } from "../../../src/thinking/index.ts";
import { convertClaudeRequestToOpenAI } from "../../../src/translator/openai/claude/index.ts";
import { getString } from "./helpers.ts";

test("ClaudeToOpenAITranslationAndThinkingChained", () => {
  const rawClaude = `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`;
  const translated = convertClaudeRequestToOpenAI("custom-openai", rawClaude, false);
  expect(getString(translated, "reasoning_effort")).toBe("high");

  const final = applyThinkingWithSourceAndSummary(translated, rawClaude, "custom-openai", "claude", "openai", "openai", emptySummaryConfig());
  expect(getString(final, "reasoning_effort")).toBe("high");
});

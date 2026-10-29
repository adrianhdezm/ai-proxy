// Ported from: test/summary_intent_translation_test.go
// Skipped cases: every row other than "Claude omitted display keeps Chat effort" (the other rows exercise
//   translators outside this slice: OpenAI/Responses/Gemini/Interactions inbound, and Codex, Gemini,
//   Antigravity and Interactions targets); TestInvalidInteractionsSummaryDoesNotWriteTargetControl (Interactions)
import { expect, test } from "bun:test";
import { FormatClaude, FormatOpenAI } from "../../../src/translator/types.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import "../../../src/translator/openai/claude/index.ts";
import { exists, getString } from "./helpers.ts";

// Chat has no field for "reason but hide": OpenAI documents none and rejects
// unknown parameters, so a disabled summary must leave the requested effort
// alone instead of turning reasoning off upstream.
test("SummaryIntentTranslation: Claude omitted display keeps Chat effort", () => {
  const body = `{"model":"gpt-5.4","thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"hi"}]}`;
  const out = defaultRegistry.translateRequest(FormatClaude, FormatOpenAI, "", body, true);
  expect(exists(out, "reasoning_effort")).toBe(true);
  expect(getString(out, "reasoning_effort")).toBe("high");
});

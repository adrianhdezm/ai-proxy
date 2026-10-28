// Ported from: internal/thinking/claude_enabled_effort_test.go
// Skipped cases: TestClaudeToOpenAITranslationAndThinkingChained (needs the Claude->OpenAI request
//   translator, which is outside this slice and not yet in the repo)
import { describe, expect, test } from "bun:test";
import { applyThinking } from "../../src/thinking/index.ts";
import { getString } from "./helpers.ts";

describe("ApplyThinking Claude enabled with output_config effort", () => {
  const cases = [
    { name: "explicit output_config effort is preserved without budget", body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`, wantEffort: "high" },
    { name: "legacy budget remains authoritative when both are present", body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":8192},"output_config":{"effort":"high"}}`, wantEffort: "medium" },
    { name: "enabled without budget or effort keeps auto default", body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"}}`, wantEffort: "auto" },
    { name: "enabled with empty effort string falls back to auto", body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":""}}`, wantEffort: "auto" },
    { name: "enabled with whitespace-only effort falls back to auto", body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":"   "}}`, wantEffort: "auto" },
    { name: "enabled with non-string effort falls back to auto", body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":123}}`, wantEffort: "auto" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applyThinking(tt.body, "custom-openai", "claude", "openai", "openai");
      expect(getString(out, "reasoning_effort")).toBe(tt.wantEffort);
    });
  }
});

// Ported from: internal/thinking/claude_standalone_effort_test.go
// Skipped cases: TestClaudeToCodexStandaloneEffort (needs the Claude->Codex request translator,
//   which is outside this slice and not yet in the repo)
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../src/registry/types.ts";
import { applyThinking, applyThinkingWithModelInfo } from "../../src/thinking/index.ts";
import { exists, getString } from "./helpers.ts";

describe("ApplyThinking Claude standalone effort", () => {
  const cases = [
    { name: "high without thinking", body: `{"output_config":{"effort":"high"}}`, wantEffort: "high" },
    { name: "low without thinking", body: `{"output_config":{"effort":"low"}}`, wantEffort: "low" },
    { name: "normalized effort", body: `{"output_config":{"effort":" HIGH "}}`, wantEffort: "high" },
    { name: "none without thinking", body: `{"output_config":{"effort":"none"}}`, wantEffort: "none" },
    { name: "auto without thinking", body: `{"output_config":{"effort":"auto"}}`, wantEffort: "auto" },
    { name: "missing effort", body: `{}`, wantEffort: "" },
    { name: "empty effort", body: `{"output_config":{"effort":""}}`, wantEffort: "" },
    { name: "blank effort", body: `{"output_config":{"effort":"   "}}`, wantEffort: "" },
    { name: "non-string effort", body: `{"output_config":{"effort":123}}`, wantEffort: "" },
    { name: "disabled wins", body: `{"thinking":{"type":"disabled"},"output_config":{"effort":"high"}}`, wantEffort: "none" },
    { name: "budget wins", body: `{"thinking":{"type":"enabled","budget_tokens":8192},"output_config":{"effort":"high"}}`, wantEffort: "medium" },
    { name: "enabled without budget", body: `{"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`, wantEffort: "high" },
    { name: "unknown thinking type unchanged", body: `{"thinking":{"type":"unknown"},"output_config":{"effort":"high"}}`, wantEffort: "" },
    { name: "empty thinking object unchanged", body: `{"thinking":{},"output_config":{"effort":"high"}}`, wantEffort: "" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applyThinking(tt.body, "custom-openai", "claude", "openai", "openai");
      expect(getString(out, "reasoning_effort")).toBe(tt.wantEffort);
    });
  }
});

describe("Claude standalone effort preserves native thinking default", () => {
  const cases: Array<{ name: string; info?: ModelInfo }> = [
    { name: "adaptive model", info: { id: "claude-opus-4-6", type: "claude", thinking: { levels: ["low", "medium", "high", "max"] } } },
    { name: "budget model", info: { id: "claude-sonnet-4-5", type: "claude", thinking: { min: 1024, max: 32768, zeroAllowed: true } } },
    { name: "custom model" },
    { name: "model without thinking support", info: { id: "claude-no-thinking", type: "claude" } },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const body = `{"max_tokens":32768,"messages":[{"role":"user","content":"hi"}],"output_config":{"effort":"high"}}`;
      let out = applyThinkingWithModelInfo(body, body, "native-claude", "claude", "claude", "claude", tt.info);
      expect(out).toBe(body);
      if (tt.info && !tt.info.thinking) return;
      out = applyThinkingWithModelInfo(body, body, "native-claude(low)", "claude", "claude", "claude", tt.info);
      expect(exists(out, "thinking.type")).toBe(true);
    });
  }
});

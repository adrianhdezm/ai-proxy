// Ported from: internal/util/claude_attribution_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { isClaudeCodeAttributionSystemText, stripClaudeCodeAttributionSystem } from "../../src/util/claude_attribution.ts";

describe("isClaudeCodeAttributionSystemText", () => {
  const tests: [string, string, boolean][] = [
    ["Claude Code attribution block", "x-anthropic-billing-header: cc_version=2.1.63.abc; cc_entrypoint=cli; cch=12345;", true],
    ["leading whitespace", "\n\t x-anthropic-billing-header: cc_version=2.1.63.abc; cch=12345;", true],
    ["regular system prompt", "You are helpful.", false],
    ["empty text", "", false],
  ];
  for (const [name, text, want] of tests) {
    test(name, () => {
      expect(isClaudeCodeAttributionSystemText(text)).toBe(want);
    });
  }
});

describe("stripClaudeCodeAttributionSystem", () => {
  const tests = [
    { name: "string attribution deleted", body: `{"system":"x-anthropic-billing-header: cc_version=2.1.220; cch=abcde;","messages":[]}`, wantSystem: undefined, wantPresent: false },
    { name: "string regular prompt kept", body: `{"system":"You are helpful.","messages":[]}`, wantSystem: `"You are helpful."`, wantPresent: true },
    {
      name: "array drops billing keeps identity",
      body: `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220; cch=abcde;"},{"type":"text","text":"You are Claude Code"}],"messages":[]}`,
      wantSystem: `[{"type":"text","text":"You are Claude Code"}]`,
      wantPresent: true,
    },
    { name: "array only billing deleted", body: `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220; cch=abcde;"}],"messages":[]}`, wantSystem: undefined, wantPresent: false },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const got = stripClaudeCodeAttributionSystem(tt.body);
      const parsed = JSON.parse(got);
      expect("system" in parsed).toBe(tt.wantPresent);
      if (tt.wantPresent) expect(JSON.stringify(parsed.system)).toBe(tt.wantSystem!);
      expect(got.includes("cch=")).toBe(false);
    });
  }
});

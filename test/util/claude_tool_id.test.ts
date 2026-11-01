// Ported from: internal/util/claude_tool_id_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { geminiClaudeToolUseID, isGeminiClaudeToolUseID } from "../../src/util/claude_tool_id.ts";

test("GeminiClaudeToolUseID stable and bound", () => {
  const args = `{"file_path":"/tmp/a","old_string":"x","new_string":"y"}`;
  const first = geminiClaudeToolUseID("native-call-1", "Edit", args);
  const second = geminiClaudeToolUseID("native-call-1", "Edit", `{"new_string":"y","old_string":"x","file_path":"/tmp/a"}`);
  expect(first).not.toBe("");
  expect(first).toBe(second);
  expect(isGeminiClaudeToolUseID(first)).toBe(true);
  const changed = geminiClaudeToolUseID("native-call-1", "Edit", `{"file_path":"/tmp/a","old_string":"x","new_string":"z"}`);
  expect(changed).not.toBe(first);
  expect(geminiClaudeToolUseID("", "Edit", args)).toBe("");
  expect(isGeminiClaudeToolUseID("toolu_client_value")).toBe(false);
});

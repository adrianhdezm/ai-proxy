// Ported from: internal/util/claude_model_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { isClaudeModel, isClaudeThinkingModel } from "../../src/util/claude_model.ts";

describe("isClaudeThinkingModel", () => {
  const tests: [string, string, boolean][] = [
    ["claude-sonnet-4-5-thinking", "claude-sonnet-4-5-thinking", true],
    ["claude-opus-4-5-thinking", "claude-opus-4-5-thinking", true],
    ["claude-opus-4-6-thinking", "claude-opus-4-6-thinking", true],
    ["Claude-Sonnet-Thinking uppercase", "Claude-Sonnet-4-5-Thinking", true],
    ["claude thinking mixed case", "Claude-THINKING-Model", true],
    ["claude-sonnet-4-5 (no thinking)", "claude-sonnet-4-5", false],
    ["claude-opus-4-5 (no thinking)", "claude-opus-4-5", false],
    ["claude-3-5-sonnet", "claude-3-5-sonnet-20240620", false],
    ["gemini-3-pro-preview", "gemini-3-pro-preview", false],
    ["gemini-thinking model", "gemini-3-pro-thinking", false],
    ["gpt-4o", "gpt-4o", false],
    ["empty string", "", false],
    ["thinking without claude", "thinking-model", false],
    ["claude without thinking", "claude-model", false],
  ];
  for (const [name, model, expected] of tests) {
    test(name, () => {
      expect(isClaudeThinkingModel(model)).toBe(expected);
    });
  }
});

describe("isClaudeModel", () => {
  const tests: [string, string, boolean][] = [
    ["Claude model", "claude-sonnet-4-6", true],
    ["Claude thinking model", "claude-opus-4-6-thinking", true],
    ["case insensitive", "Claude-Sonnet-4-5", true],
    ["Gemini model", "gemini-3-pro-preview", false],
    ["empty string", "", false],
  ];
  for (const [name, model, expected] of tests) {
    test(name, () => {
      expect(isClaudeModel(model)).toBe(expected);
    });
  }
});

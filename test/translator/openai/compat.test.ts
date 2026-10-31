// Ported from: internal/translator/openai/claude/openai_claude_compat_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { convertClaudeRequestToOpenAI, convertClaudeRequestToOpenAIWithCompat } from "../../../src/translator/openai/claude/index.ts";
import { exists, getString } from "./helpers.ts";

test("ConvertClaudeRequestToOpenAIWithCompatPreservesEmptySignatureThinking", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":""}]}]}`;
  const withoutCompat = convertClaudeRequestToOpenAI("deepseek-v4", payload, false);
  expect(exists(withoutCompat, "messages.0.reasoning_content")).toBe(false);
  const withCompat = convertClaudeRequestToOpenAIWithCompat("deepseek-v4", payload, false);
  expect(getString(withCompat, "messages.0.reasoning_content")).toBe("reason");
});

test("ConvertClaudeRequestToOpenAIWithCompatPreservesThinkingWithToolCalls", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":""},{"type":"text","text":"Reading files."},{"type":"tool_use","id":"call_1","name":"Read","input":{"path":"main.go"}}]}]}`;
  const result = convertClaudeRequestToOpenAIWithCompat("deepseek-v4", payload, false);
  expect(getString(result, "messages.0.reasoning_content")).toBe("reason");
  expect(exists(result, "messages.0.tool_calls")).toBe(true);
});

test("ConvertClaudeRequestToOpenAIWithCompatDoesNotAddReasoningWithoutThinking", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{}}]}]}`;
  const result = convertClaudeRequestToOpenAIWithCompat("deepseek-v4", payload, false);
  expect(exists(result, "messages.0.reasoning_content")).toBe(false);
  expect(exists(result, "messages.0.tool_calls")).toBe(true);
});

test("ConvertClaudeRequestToOpenAIWithCompatPreservesIncompatibleThinking", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"claude#opaque"},{"type":"tool_use","id":"call_1","name":"Read","input":{}}]}]}`;
  const result = convertClaudeRequestToOpenAIWithCompat("deepseek-v4", payload, false);
  expect(getString(result, "messages.0.reasoning_content")).toBe("reason");
  expect(exists(result, "messages.0.tool_calls")).toBe(true);
});

test("ConvertClaudeRequestToOpenAIWithoutCompatDoesNotAddReasoningForToolCalls", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{}}]}]}`;
  const result = convertClaudeRequestToOpenAI("deepseek-v4", payload, false);
  expect(exists(result, "messages.0.reasoning_content")).toBe(false);
});

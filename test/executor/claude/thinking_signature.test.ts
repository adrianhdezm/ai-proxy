// Ported from: internal/runtime/executor/claude_executor_thinking_signature_test.go
// Skipped cases: TestClaudeThinkingSignaturesSurviveUpstreamPreparation drops its MCP alias stage (MCP alias
// remapping is not ported) and adds a CCH-signing stage instead; TestClaudeThinkingSignaturesSurviveSensitiveWord
// Obfuscation (sensitive-word obfuscation not ported).
import { expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { applyCloaking } from "../../../src/executor/claude/cloaking.ts";
import { finalizeAnthropicMessagesBodyCCH } from "../../../src/executor/claude/signing.ts";

const signatures = [
  "ErUBCkYIBRgCKkDq+9zN/vQ7aB1c2dEf==",
  `sig/with+slashes==and"quotes"and\\backslashes`,
  "line\nbreak\ttab\u0000null\u001fcontrol",
  "unicode-中文-\u{1f600}-​-﻿",
  "a/b<c>d&e'f  ",
  "EqQBCkYIBRgCKkD".repeat(400) + "==",
];

function collect(body: string): string[] {
  const found: string[] = [];
  for (const message of JSON.parse(body).messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) if (block.signature !== undefined) found.push(block.signature);
  }
  return found;
}

function buildPayload(firstUserText: string): string {
  const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: firstUserText }] }];
  signatures.forEach((signature, i) => {
    const id = "toolu_" + String.fromCharCode(97 + i);
    messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "reasoning step", signature }, { type: "tool_use", id, name: "search_web", input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "tool output" }] });
  });
  return JSON.stringify({ model: "claude-opus-5", max_tokens: 1024, thinking: { type: "adaptive" }, messages, tools: [{ name: "search_web", input_schema: { type: "object" } }] });
}

test("ClaudeThinkingSignaturesSurviveUpstreamPreparation", () => {
  const payload = buildPayload("first question");
  expect(collect(payload)).toEqual(signatures);
  const auth = newAuth({ id: "sig", provider: "claude", metadata: { cloak_mode: "always" } });
  const cloaked = applyCloaking({}, auth, payload, "sk-ant-oat-test", false, { cchSigning: true });
  expect(cloaked.cloaked).toBe(true);
  const signed = finalizeAnthropicMessagesBodyCCH(cloaked.payload, "");
  for (const body of [cloaked.payload, signed]) expect(collect(body)).toEqual(signatures);
});

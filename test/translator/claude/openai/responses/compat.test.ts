// Ported from: internal/translator/claude/openai/responses/claude_openai_responses_compat_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import {
  convertOpenAIResponsesRequestToClaude,
  convertOpenAIResponsesRequestToClaudeWithCompat,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { get, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

test("compat preserves empty reasoning", () => {
  const payload = `{"input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"reason"}],"encrypted_content":""}]}`;
  expect(get(convertOpenAIResponsesRequestToClaude("deepseek-v4", payload, false), "messages.#")).toBe(0);
  const part = get(convertOpenAIResponsesRequestToClaudeWithCompat("deepseek-v4", payload, false), "messages.0.content.0");
  expect(part.type).toBe("thinking");
  expect(part.signature).toBe("");
  const opaque = `{"input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"reason"}],"encrypted_content":"opaque-deepseek-id"}]}`;
  const opaquePart = get(convertOpenAIResponsesRequestToClaudeWithCompat("deepseek-v4", opaque, false), "messages.0.content.0");
  expect([opaquePart.type, opaquePart.thinking, opaquePart.signature]).toEqual(["thinking", "reason", "opaque-deepseek-id"]);
});


// Ported from: internal/translator/common/claude_native_response_test.go
// Skipped cases: the "chat" provider of TestClaudeNativeResponseNonStreamModelAndContent
// (claude/openai/chat-completions: OpenAI chat-completions inbound is not ported); the "responses" provider is kept.
import { describe, expect, test } from "bun:test";
import { claudeResponsesRedactedThinkingPrefix } from "../../../src/translator/claude/openai/responses/request.ts";
import { convertClaudeResponseToOpenAIResponsesNonStream } from "../../../src/translator/claude/openai/responses/response.ts";
import { emptyContext } from "../../../src/translator/types.ts";

describe("TestClaudeNativeResponseNonStreamModelAndContent (responses)", () => {
  const text = 'line 1\n"quoted" \\ 雪 <tag>';
  const input = { nested: { text, items: [true, null, 2] }, empty: {} };
  const raw = JSON.stringify({
    id: "msg_native",
    type: "message",
    role: "assistant",
    model: "claude-native",
    content: [
      { type: "thinking", thinking: text, signature: 'sig\n"native' },
      { type: "redacted_thinking", data: "opaque-data" },
      { type: "text", text },
      { type: "tool_use", id: "tool_native", name: "lookup", input },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 9 },
  });
  for (const request of ["{}", `{"model":"request-alias"}`]) {
    test(request, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "executor-alias", request, request, raw, undefined)) as any;
      expect(root.model).toBe("claude-native");
      expect(root.id).toBe("msg_native");
      expect(root.output[2].content[0].text).toBe(text);
      expect(root.output[0].summary[0].text).toBe(text);
      expect(JSON.parse(root.output[3].arguments)).toEqual(input);
      expect(root.output[0].type).toBe("reasoning");
      expect(root.output[0].encrypted_content).toBe('sig\n"native');
      expect(root.output[1].type).toBe("reasoning");
      expect(root.output[1].encrypted_content).toBe(claudeResponsesRedactedThinkingPrefix + "opaque-data");
      expect(root.output[3].call_id).toBe("tool_native");
      expect(root.output[3].name).toBe("lookup");
    });
  }
});

// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_pause_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { convertClaudeResponseToOpenAIResponsesNonStream } from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import { type JSONObject, claudeWebSearchStreamChunks, streamEvents, translateStreamThroughRegistry, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

describe("server tool stop reason", () => {
  const cases: { reason: string; status: string; detail?: JSONObject; endTurn?: boolean }[] = [
    // pause_turn is an unfinished but valid turn: completed with end_turn=false.
    { reason: "pause_turn", status: "completed", endTurn: false },
    { reason: " PAUSE_TURN ", status: "completed", endTurn: false },
    { reason: "max_tokens", status: "incomplete", detail: { reason: "max_output_tokens" } },
    { reason: "refusal", status: "incomplete", detail: { reason: "content_filter" } },
    { reason: "model_context_window_exceeded", status: "incomplete", detail: { reason: "max_output_tokens" } },
    { reason: "end_turn", status: "completed" },
    { reason: "tool_use", status: "completed" },
    { reason: "stop_sequence", status: "completed" },
  ];
  for (const tc of cases) {
    const chunks = claudeWebSearchStreamChunks();
    const stop = chunks.pop()!;
    chunks.push(`data: {"type":"message_delta","delta":{"stop_reason":${JSON.stringify(tc.reason)}},"usage":{"output_tokens":12}}`, stop);
    const check = (response: JSONObject): void => {
      expect(response.status).toBe(tc.status);
      if (tc.detail) expect(response.incomplete_details).toEqual(tc.detail);
      else expect(response.incomplete_details ?? null).toBeNull();
      expect(response.error?.code).toBeUndefined();
      expect(response.end_turn).toBe(tc.endTurn);
      expect(response.output[0].action.query).toBe("lindorm vector");
      expect(response.output[0].results[0].encrypted_content).toBe("ENC_A");
      expect(response.usage.output_tokens).toBe(12);
    };
    test(`${tc.reason} stream`, () => {
      let terminals = 0;
      for (const [event, data] of streamEvents(translateStreamThroughRegistry(chunks))) {
        if (event !== "response.completed" && event !== "response.incomplete" && event !== "response.failed") continue;
        terminals++;
        expect(event).toBe("response." + tc.status);
        check(data.response);
      }
      expect(terminals).toBe(1);
    });
    test(`${tc.reason} buffered`, () => {
      check(JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", "", "", chunks.join("\n"), undefined)));
    });
  }
});

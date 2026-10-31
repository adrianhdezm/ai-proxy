// Ported from: internal/translator/claude/openai/responses/claude_openai_native_response_test.go
// Ported from: internal/translator/claude/openai/responses/claude_openai_responses_compat_test.go
// Ported from: internal/translator/claude/openai/responses/noop_optimization_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  convertClaudeResponseToOpenAIResponsesNonStream,
  convertOpenAIResponsesRequestToClaude,
  convertOpenAIResponsesRequestToClaudeWithCompat,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import { get, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

describe("non-stream native Messages JSON", () => {
  const cases: [string, string, string, string, boolean][] = [
    ["text", `[{"type":"text","text":"Hello "},{"type":"text","text":"world!"}]`, "end_turn", "completed", false],
    [
      "tools",
      `[{"type":"text","text":"Hello world!"},{"type":"tool_use","id":"toolu_weather","name":"get_weather","input":{"city":"Paris","days":2}},{"type":"tool_use","id":"toolu_clock","name":"get_time","input":{}}]`,
      "tool_use",
      "completed",
      true,
    ],
    ["max_tokens", `[{"type":"text","text":"Hello world!"}]`, "max_tokens", "incomplete", false],
  ];
  for (const [name, content, stopReason, status, tools] of cases) {
    test(name, () => {
      const raw = `{"id":"msg_native","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":${content},"stop_reason":${JSON.stringify(stopReason)},"stop_sequence":null,"usage":{"input_tokens":13,"cache_read_input_tokens":7,"cache_creation_input_tokens":3,"output_tokens":5}}`;
      const request = `{"model":"claude-sonnet-4-6"}`;
      const root = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-sonnet-4-6", request, request, raw, undefined));
      expect(root.id).toBe("msg_native");
      expect(root.object).toBe("response");
      expect(root.model).toBe("claude-sonnet-4-6");
      expect(root.status).toBe(status);
      expect(root.output[0].type).toBe("message");
      expect(root.output[0].role).toBe("assistant");
      expect(root.output[0].status).toBe(status);
      expect(root.output[0].content[0].type).toBe("output_text");
      expect(root.output[0].content[0].text).toBe("Hello world!");
      expect(root.usage.input_tokens).toBe(23);
      expect(root.usage.output_tokens).toBe(5);
      expect(root.usage.total_tokens).toBe(28);
      expect(root.usage.input_tokens_details.cached_tokens).toBe(7);
      if (status === "incomplete") expect(root.incomplete_details.reason).toBe("max_output_tokens");
      else expect(root.incomplete_details).toBeNull();
      if (!tools) {
        expect(root.output.length).toBe(1);
        return;
      }
      expect(root.output.length).toBe(3);
      expect([root.output[1].call_id, root.output[1].type, root.output[1].name, root.output[1].status]).toEqual(["toolu_weather", "function_call", "get_weather", "completed"]);
      expect([root.output[2].call_id, root.output[2].type, root.output[2].name, root.output[2].status]).toEqual(["toolu_clock", "function_call", "get_time", "completed"]);
      expect(JSON.parse(root.output[1].arguments)).toEqual({ city: "Paris", days: 2 });
      expect(JSON.parse(root.output[2].arguments)).toEqual({});
    });
  }
});

test("native Messages JSON citations", () => {
  const raw = `{"id":"msg_citations","type":"message","model":"claude-native","content":[{"type":"text","text":"Answer.","citations":[{"type":"web_search_result_location","url":"https://example.com","title":"Source","cited_text":"Answer.","encrypted_index":"IDX"}]}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}`;
  const annotations = get(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "", "", "", raw, undefined), "output.0.content.0.annotations");
  expect(annotations.length).toBe(1);
  expect(annotations[0].url).toBe("https://example.com");
  expect(annotations[0].encrypted_index).toBe("IDX");
});

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

test("non-stream keeps zero usage defaults", () => {
  const input = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`;
  const output = convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "", "", "", input, undefined);
  for (const path of ["usage.input_tokens", "usage.input_tokens_details.cached_tokens", "usage.output_tokens", "usage.total_tokens"]) expect(get(output, path)).toBe(0);
});

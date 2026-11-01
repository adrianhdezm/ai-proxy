// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_citations_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { convertClaudeResponseToOpenAIResponsesNonStream } from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import { type JSONObject, streamEvents, translateStreamThroughRegistry, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

describe("adjacent cited text blocks share message", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_citations","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[]}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"The store reopened in 2024"}}`,
    `data: {"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com/store","title":"Store"}}}`,
    `data: {"type":"content_block_stop","index":2}`,
    `data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":", and "}}`,
    `data: {"type":"content_block_stop","index":3}`,
    `data: {"type":"content_block_start","index":4,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"Olga was named for Ohlert."}}`,
    `data: {"type":"content_block_delta","index":4,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com/olga","title":"Olga"}}}`,
    `data: {"type":"content_block_stop","index":4}`,
    `data: {"type":"message_stop"}`,
  ];
  const wantText = "The store reopened in 2024, and Olga was named for Ohlert.";
  const checkOutput = (items: JSONObject[]): void => {
    expect(items.length).toBe(2);
    expect(items[0]!.type).toBe("web_search_call");
    const message = items[1]!;
    expect(message.type).toBe("message");
    expect(message.content.length).toBe(1);
    expect(message.content[0].text).toBe(wantText);
    const annotations = message.content[0].annotations;
    expect(annotations.map((a: JSONObject) => a.url)).toEqual(["https://example.com/store", "https://example.com/olga"]);
  };

  test("stream", () => {
    const counts: Record<string, number> = {};
    let completed: JSONObject | undefined;
    for (const [event, data] of streamEvents(translateStreamThroughRegistry(chunks))) {
      counts[event] = (counts[event] ?? 0) + 1;
      if (event === "response.completed") completed = data;
    }
    checkOutput(completed!.response.output);
    for (const event of ["response.content_part.added", "response.output_text.done", "response.content_part.done"]) expect(counts[event]).toBe(1);
    expect(counts["response.output_item.done"]).toBe(2);
  });

  test("nonstream", () => {
    const out = convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", "", "", chunks.join("\n"), undefined);
    checkOutput(JSON.parse(out).output);
  });
});

// Ported from: internal/translator/common/claude_native_sse_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { claudeMessagesJSONToSSE } from "../../../src/translator/common/claude_native_response.ts";
import { garray, getAt, gstr } from "../../../src/util/gpath.ts";

function sseEvents(out: string): unknown[] {
  const events: unknown[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    events.push(JSON.parse(line.slice("data: ".length)));
  }
  return events;
}

test("ClaudeMessagesJSONToSSE passthrough", () => {
  for (const raw of [
    'event: message_start\r\ndata: {"type":"message_start","message":{"model":"sse-model"}}\r\n\r\n: keepalive\r\n',
    'data: {"type":"message_stop"}\n\n',
    '{"type":"error","error":{"message":"bad request"}}',
    '{"type":"message","content":',
    '{"type":"message","content":"not an array"}',
    "",
  ]) {
    const { payload, model } = claudeMessagesJSONToSSE(raw);
    expect(payload).toBe(raw);
    expect(model).toBe("");
  }
});

test("ClaudeMessagesJSONToSSE events", () => {
  const raw = `{
    "id":"msg_native","type":"message","role":"assistant","model":"claude-native",
    "content":[
      {"type":"text","text":"line 1\\n\\"quoted\\" \\\\ 雪 <tag>"},
      {"type":"tool_use","id":"tool_nested","name":"lookup","input":{"nested":{"text":"line\\n\\"quoted\\"","items":[true,null,2]},"empty":{}}},
      {"type":"tool_use","id":"tool_empty","name":"clock","input":{}},
      {"type":"thinking","thinking":"plan\\nnext","signature":"sig\\"native"},
      {"type":"redacted_thinking","data":"opaque"}
    ],
    "stop_reason":"stop_sequence","stop_sequence":"END\\n",
    "usage":{"input_tokens":13,"output_tokens":5,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}
  }`;
  const { payload, model } = claudeMessagesJSONToSSE(raw);
  expect(model).toBe("claude-native");
  const events = sseEvents(payload);
  const wantTypes = [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_stop",
    "message_delta", "message_stop",
  ];
  expect(events.map((e) => gstr(getAt(e, "type")))).toEqual(wantTypes);
  const root = JSON.parse(raw) as unknown;
  for (const path of ["id", "model", "role", "usage"]) {
    expect(getAt(events[0], "message." + path)).toEqual(getAt(root, path));
  }
  expect(garray(getAt(events[0], "message.content"))).toEqual([]);
  for (const block of [{ start: 1, stop: 3, index: 0 }, { start: 4, stop: 6, index: 1 }, { start: 7, stop: 9, index: 2 }, { start: 10, stop: 13, index: 3 }, { start: 14, stop: 15, index: 4 }]) {
    for (let i = block.start; i <= block.stop; i++) {
      expect(getAt(events[i], "index")).toBe(block.index);
    }
  }
  const checks: [number, string, string][] = [
    [2, "delta.type", "text_delta"], [2, "delta.text", gstr(getAt(root, "content.0.text"))],
    [4, "content_block.id", "tool_nested"], [4, "content_block.name", "lookup"],
    [5, "delta.type", "input_json_delta"], [8, "delta.type", "input_json_delta"],
    [11, "delta.type", "thinking_delta"], [11, "delta.thinking", "plan\nnext"],
    [12, "delta.type", "signature_delta"], [12, "delta.signature", 'sig"native'],
    [14, "content_block.type", "redacted_thinking"], [14, "content_block.data", "opaque"],
    [16, "delta.stop_reason", "stop_sequence"], [16, "delta.stop_sequence", "END\n"],
  ];
  for (const [event, path, want] of checks) {
    expect(gstr(getAt(events[event], path))).toBe(want);
  }
  for (const check of [{ event: 5, block: 1 }, { event: 8, block: 2 }]) {
    const got = JSON.parse(gstr(getAt(events[check.event], "delta.partial_json"))) as unknown;
    expect(got).toEqual(getAt(root, `content.${check.block}.input`));
  }
  expect(getAt(events[16], "usage")).toEqual(getAt(root, "usage"));
});

test("ClaudeMessagesJSONToSSE citations", () => {
  const raw = '{"type":"message","content":[{"type":"text","text":"Answer.","citations":[{"type":"web_search_result_location","url":"https://example.com","title":"Source","cited_text":"Answer.","encrypted_index":"IDX"}]}]}';
  const { payload } = claudeMessagesJSONToSSE(raw);
  let count = 0;
  for (const event of sseEvents(payload)) {
    if (gstr(getAt(event, "delta.type")) === "citations_delta") {
      count++;
      expect(getAt(event, "index")).toBe(0);
      expect(getAt(event, "delta.citation.encrypted_index")).toBe("IDX");
    }
  }
  expect(count).toBe(1);
});

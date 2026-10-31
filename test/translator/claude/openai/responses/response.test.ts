// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_response_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  ClaudeToResponsesState,
  claudeResponsesRedactedThinkingPrefix,
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import { type JSONObject, parseSSEEvent, streamEvents, translateStreamThroughRegistry, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

function runStream(chunks: string[], request = "", model = "claude-test", state: TranslatorState = {}): [string, JSONObject][] {
  const outputs: string[] = [];
  for (const chunk of chunks) outputs.push(...convertClaudeResponseToOpenAIResponses(emptyContext, model, request, "", chunk, state));
  return streamEvents(outputs);
}
const nonStream = (chunks: string[] | string, request = "", model = "claude-test", state?: TranslatorState): JSONObject =>
  JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, model, request, "", Array.isArray(chunks) ? chunks.join("\n") : chunks, state));
const last = (events: [string, JSONObject][], event: string, pred: (d: JSONObject) => boolean = () => true): JSONObject | undefined => {
  let found: JSONObject | undefined;
  for (const [e, d] of events) if (e === event && pred(d)) found = d;
  return found;
};
const start = `data: {"type":"message_start","message":{"id":"msg_123","usage":{"input_tokens":1,"output_tokens":0}}}`;
const stop = `data: {"type":"message_stop"}`;

test("created includes original request model", () => {
  const state: TranslatorState = {};
  const outputs = convertClaudeResponseToOpenAIResponses(
    emptyContext,
    "fallback-model",
    `{"model":"original-claude-model"}`,
    `{"model":"translated-claude-model"}`,
    `data: {"type":"message_start","message":{"id":"msg_123"}}`,
    state,
  );
  expect(outputs.length).toBeGreaterThanOrEqual(2);
  const events = streamEvents(outputs);
  expect(last(events, "response.created")!.response.model).toBe("original-claude-model");
  expect(last(events, "response.in_progress")!.response.model).toBe("original-claude-model");
});

test("thinking includes signature", () => {
  const signature = "claude_sig_123";
  const events = runStream([
    start,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"internal "}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${signature}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    stop,
  ]);
  const done = last(events, "response.output_item.done", (d) => d.item.type === "reasoning")!;
  expect(done.item.encrypted_content).toBe(signature);
  expect(done.item.summary[0].text).toBe("internal reasoning");
  const completed = last(events, "response.completed")!;
  expect(completed.response.output[0].encrypted_content).toBe(signature);
  expect(completed.response.output[0].summary[0].text).toBe("internal reasoning");
});

test("redacted_thinking becomes marked reasoning item", () => {
  const data = "EroBCkYIBRgCKkA";
  const events = runStream([
    start,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"${data}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    stop,
  ]);
  const want = claudeResponsesRedactedThinkingPrefix + data;
  expect(last(events, "response.output_item.done", (d) => d.item.type === "reasoning")!.item.encrypted_content).toBe(want);
  const completed = last(events, "response.completed")!;
  expect(completed.response.output[0].encrypted_content).toBe(want);
  expect(completed.response.output[1].type).toBe("message");
});

test("non-stream redacted_thinking becomes marked reasoning item", () => {
  const data = "EroBCkYIBRgCKkA";
  const out = nonStream([start, `data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"${data}"}}`, `data: {"type":"content_block_stop","index":0}`, stop]);
  expect(out.output[0].type).toBe("reasoning");
  expect(out.output[0].encrypted_content).toBe(claudeResponsesRedactedThinkingPrefix + data);
});

test("suppresses signature_delta passthrough", () => {
  expect(translateStreamThroughRegistry([`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"claude_sig_123"}}`])).toEqual([]);
});

test("aggregates text blocks until message_stop", () => {
  const events = streamEvents(
    translateStreamThroughRegistry([
      start,
      `data: {"type":"content_block_start","index":4,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"**Compare competitors**\\n- "}}`,
      `data: {"type":"content_block_stop","index":4}`,
      `data: {"type":"content_block_start","index":5,"content_block":{"type":"server_tool_use","id":"srv_123","name":"web_search","input":{}}}`,
      `data: {"type":"content_block_delta","index":5,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"Qwen3\\"}"}}`,
      `data: {"type":"content_block_stop","index":5}`,
      `data: {"type":"content_block_start","index":6,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_123","content":[{"type":"web_search_result","title":"Example","url":"https://example.com"}]}}`,
      `data: {"type":"content_block_stop","index":6}`,
      `data: {"type":"content_block_delta","index":5,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","cited_text":"Qwen 3.7 Max","url":"https://example.com","title":"Example"}}}`,
      `data: {"type":"content_block_start","index":7,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":7,"delta":{"type":"text_delta","text":"Qwen 3.7 Max leads."}}`,
      `data: {"type":"content_block_stop","index":7}`,
      `data: {"type":"message_delta","usage":{"output_tokens":12}}`,
      stop,
    ]),
  );
  const counts: Record<string, number> = {};
  for (const [event] of events) {
    counts[event] = (counts[event] ?? 0) + 1;
    expect(event.startsWith("content_block_") || event === "message_delta").toBe(false);
  }
  expect(counts["response.output_item.added"]).toBe(3);
  expect(counts["response.content_part.added"]).toBe(2);
  expect(counts["response.output_text.done"]).toBe(2);
  expect(counts["response.content_part.done"]).toBe(2);
  expect(counts["response.output_item.done"]).toBe(3);
  expect(counts["response.function_call_arguments.delta"]).toBeUndefined();
  const output = last(events, "response.completed")!.response.output;
  expect(output[0].content[0].text).toBe("**Compare competitors**\n- ");
  expect(output[1].type).toBe("web_search_call");
  expect(output[2].content[0].text).toBe("Qwen 3.7 Max leads.");
  expect(output[2].content[0].annotations[0].type).toBe("web_search_result_location");
});

test("finalizes message before function call", () => {
  const events = streamEvents(
    translateStreamThroughRegistry([
      start,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking the workspace."}}`,
      `data: {"type":"content_block_stop","index":0}`,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_123","name":"exec_command","input":{}}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
      stop,
    ]),
  );
  const pos: Record<string, number> = {};
  const counts: Record<string, number> = {};
  events.forEach(([event, data], position) => {
    const key = `${event}:${data.item?.type ?? ""}`;
    if (!(key in pos)) pos[key] = position;
    counts[key] = (counts[key] ?? 0) + 1;
    if (data.item?.type === "message") expect(data.output_index).toBe(0);
    if (data.item?.type === "function_call") expect(data.output_index).toBe(1);
  });
  expect(pos["response.output_item.done:message"]!).toBeLessThan(pos["response.output_item.added:function_call"]!);
  expect(pos["response.output_item.added:function_call"]!).toBeLessThan(pos["response.output_item.done:function_call"]!);
  expect(counts["response.output_item.done:message"]).toBe(1);
  expect(counts["response.output_item.done:function_call"]).toBe(1);
  const output = last(events, "response.completed")!.response.output;
  expect(output.length).toBe(2);
  expect([output[0].type, output[0].content[0].text]).toEqual(["message", "Checking the workspace."]);
  expect([output[1].type, output[1].call_id]).toEqual(["function_call", "call_123"]);
});

test("uses contiguous indices for reasoning, text and tool", () => {
  const events = streamEvents(
    translateStreamThroughRegistry([
      start,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_123","name":"web_search","input":{}}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"Qwen3\\"}"}}`,
      `data: {"type":"content_block_stop","index":0}`,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_123","content":[]}}`,
      `data: {"type":"content_block_stop","index":1}`,
      `data: {"type":"content_block_start","index":2,"content_block":{"type":"thinking","thinking":""}}`,
      `data: {"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"Inspect first."}}`,
      `data: {"type":"content_block_stop","index":2}`,
      `data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"Checking the workspace."}}`,
      `data: {"type":"content_block_stop","index":3}`,
      `data: {"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"call_123","name":"exec_command","input":{}}}`,
      `data: {"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}`,
      `data: {"type":"content_block_stop","index":4}`,
      stop,
    ]),
  );
  const wantIndex: Record<string, number> = { web_search_call: 0, reasoning: 1, message: 2, function_call: 3 };
  const seen: Record<string, number> = {};
  for (const [event, data] of events) {
    let itemType = "";
    if (event === "response.output_item.added" || event === "response.output_item.done") itemType = data.item.type;
    else if (event.startsWith("response.reasoning_")) itemType = "reasoning";
    else if (event.startsWith("response.output_text.") || event.startsWith("response.content_part.")) itemType = "message";
    else if (event.startsWith("response.function_call_arguments.")) itemType = "function_call";
    if (!(itemType in wantIndex)) continue;
    expect(data.output_index).toBe(wantIndex[itemType]!);
    seen[itemType] = (seen[itemType] ?? 0) + 1;
  }
  for (const t of ["reasoning", "message", "function_call"]) expect(seen[t]).toBeGreaterThan(0);
  expect(last(events, "response.completed")!.response.output.map((o: JSONObject) => o.type)).toEqual(["web_search_call", "reasoning", "message", "function_call"]);
});

const lifecycleOf = (events: [string, JSONObject][]): string =>
  events
    .filter(([e]) => e === "response.output_item.added" || e === "response.output_item.done")
    .map(([e, d]) => `${e}:${d.output_index}:${d.item.type}`)
    .join(",");
const text = (index: number, value: string): string[] => [
  `data: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}`,
  `data: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":${JSON.stringify(value)}}}`,
  `data: {"type":"content_block_stop","index":${index}}`,
];
const thinkingBlock = (index: number, value: string): string[] => [
  `data: {"type":"content_block_start","index":${index},"content_block":{"type":"thinking","thinking":""}}`,
  `data: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":${JSON.stringify(value)}}}`,
  `data: {"type":"content_block_stop","index":${index}}`,
];
const execTool = (index: number, id = "call_123"): string[] => [
  `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"${id}","name":"exec_command","input":{}}}`,
  `data: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}`,
  `data: {"type":"content_block_stop","index":${index}}`,
];

test("server tools surface without output index gaps", () => {
  const events = streamEvents(
    translateStreamThroughRegistry([
      start,
      ...text(0, "Searching. "),
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srv_123","name":"web_search","input":{}}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"Qwen3\\"}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
      `data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_123","content":[]}}`,
      `data: {"type":"content_block_stop","index":2}`,
      ...text(3, "Found it."),
      ...execTool(4),
      stop,
    ]),
  );
  let added = 0;
  let done = 0;
  for (const [event, data] of events) {
    if (event === "response.output_item.added" && data.item.type === "message") added++;
    else if (event === "response.output_item.done" && data.item.type === "message") done++;
    else if (data.item?.type === "function_call" || event.startsWith("response.function_call_arguments.")) expect(data.output_index).toBe(3);
  }
  expect([added, done]).toEqual([2, 2]);
  expect(last(events, "response.completed")!.response.output.map((o: JSONObject) => o.type)).toEqual(["message", "web_search_call", "message", "function_call"]);
});

test("starts new message after function call", () => {
  const events = streamEvents(translateStreamThroughRegistry([start, ...text(0, "Before tool."), ...execTool(1), ...text(2, "After tool."), stop]));
  expect(lifecycleOf(events)).toBe(
    [
      "response.output_item.added:0:message",
      "response.output_item.done:0:message",
      "response.output_item.added:1:function_call",
      "response.output_item.done:1:function_call",
      "response.output_item.added:2:message",
      "response.output_item.done:2:message",
    ].join(","),
  );
  const ids = events.filter(([e, d]) => e === "response.output_item.added" && d.item.type === "message").map(([, d]) => d.item.id);
  expect(ids.length).toBe(2);
  expect(ids[0]).not.toBe(ids[1]);
  const output = last(events, "response.completed")!.response.output;
  expect(output.map((o: JSONObject) => o.type)).toEqual(["message", "function_call", "message"]);
  expect(output[0].content[0].text).toBe("Before tool.");
  expect(output[2].content[0].text).toBe("After tool.");
});

test("finalizes message before reasoning", () => {
  const events = streamEvents(translateStreamThroughRegistry([start, ...text(0, "Visible first."), ...thinkingBlock(1, "Reason later."), stop]));
  expect(lifecycleOf(events)).toBe(
    ["response.output_item.added:0:message", "response.output_item.done:0:message", "response.output_item.added:1:reasoning", "response.output_item.done:1:reasoning"].join(","),
  );
  expect(last(events, "response.completed")!.response.output.map((o: JSONObject) => o.type)).toEqual(["message", "reasoning"]);
});

test("preserves multiple reasoning items", () => {
  const events = streamEvents(translateStreamThroughRegistry([start, ...thinkingBlock(0, "First reason."), ...thinkingBlock(1, "Second reason."), ...text(2, "Visible response."), stop]));
  const reasoningDone = events.filter(([e, d]) => e === "response.output_item.done" && d.item.type === "reasoning");
  expect(reasoningDone.map(([, d]) => d.output_index)).toEqual([0, 1]);
  const output = last(events, "response.completed")!.response.output;
  expect(output.map((o: JSONObject) => o.type)).toEqual(["reasoning", "reasoning", "message"]);
  expect([output[0].summary[0].text, output[1].summary[0].text]).toEqual(["First reason.", "Second reason."]);
});

test("normalizes empty function arguments", () => {
  const events = streamEvents(
    translateStreamThroughRegistry([
      start,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_123","name":"exec_command","input":{}}}`,
      `data: {"type":"content_block_stop","index":0}`,
      stop,
    ]),
  );
  expect(last(events, "response.output_item.done", (d) => d.item.type === "function_call")!.item.arguments).toBe("{}");
  expect(last(events, "response.completed")!.response.output[0].arguments).toBe("{}");
});

test("includes empty reasoning in completed output", () => {
  const events = streamEvents(
    translateStreamThroughRegistry([
      start,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
      `data: {"type":"content_block_stop","index":0}`,
      ...text(1, "Visible response."),
      stop,
    ]),
  );
  expect(last(events, "response.output_item.done", (d) => d.item.type === "reasoning")!.item.summary.length).toBe(1);
  const output = last(events, "response.completed")!.response.output;
  expect(output.length).toBe(2);
  expect(output[0].type).toBe("reasoning");
  expect(output[0].summary.length).toBe(1);
  expect(output[1].type).toBe("message");
});

test("reports cache tokens", () => {
  const events = runStream([
    `data: {"type":"message_start","message":{"id":"msg_123","usage":{"input_tokens":13,"output_tokens":1,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}}}`,
    `data: {"type":"message_delta","usage":{"output_tokens":4,"cache_read_input_tokens":22000,"cache_creation_input_tokens":31}}`,
    stop,
  ]);
  const usage = last(events, "response.completed")!.response.usage;
  expect([usage.input_tokens, usage.input_tokens_details.cached_tokens, usage.output_tokens, usage.total_tokens]).toEqual([22044, 22000, 4, 22048]);
});

test("non-stream thinking includes signature", () => {
  const signature = "claude_sig_nonstream";
  const out = nonStream([
    `data: {"type":"message_start","message":{"id":"msg_nonstream","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"nonstream reasoning"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${signature}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    stop,
  ]);
  expect(out.output[0].encrypted_content).toBe(signature);
  expect(out.output[0].summary[0].text).toBe("nonstream reasoning");
});

test("non-stream preserves content block order", () => {
  const root = nonStream([
    `data: {"type":"message_start","message":{"id":"msg_nonstream_order","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_order","name":"exec_command","input":{}}}`,
    `data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"plan"}}`,
    `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}`,
    `data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"done"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"content_block_stop","index":2}`,
    `data: {"type":"content_block_stop","index":3}`,
    `data: {"type":"content_block_start","index":4,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":4,"delta":{"type":"thinking_delta","thinking":"more"}}`,
    `data: {"type":"content_block_stop","index":4}`,
    stop,
  ]);
  expect(root.output.map((o: JSONObject) => o.type)).toEqual(["message", "reasoning", "function_call", "message", "reasoning"]);
  expect(root.output[0].content[0].text).toBe("");
  expect(root.output[1].summary[0].text).toBe("plan");
  expect(root.output[2].call_id).toBe("call_order");
  expect(root.output[2].arguments).toBe(`{"cmd":"pwd"}`);
  expect(root.output[3].content[0].text).toBe("done");
  expect(root.output[4].summary[0].text).toBe("more");
  expect(root.usage.output_tokens_details.reasoning_tokens).toBe(2);
});

test("non-stream reports cache tokens", () => {
  const root = nonStream([
    `data: {"type":"message_start","message":{"id":"msg_nonstream","usage":{"input_tokens":13,"output_tokens":1,"cache_read_input_tokens":22000,"cache_creation_input_tokens":31}}}`,
    `data: {"type":"message_delta","usage":{"output_tokens":4}}`,
    stop,
  ]);
  expect([root.usage.input_tokens, root.usage.input_tokens_details.cached_tokens, root.usage.output_tokens, root.usage.total_tokens]).toEqual([22044, 22000, 4, 22048]);
});

const customExecChunks = (id: string, name: string, input: string | undefined, msgID: string): string[] => [
  `data: {"type":"message_start","message":{"id":"${msgID}","usage":{"input_tokens":1,"output_tokens":0}}}`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"${id}","name":"${name}","input":{}}}`,
  ...(input === undefined ? [] : [`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(input)}}}`]),
  `data: {"type":"content_block_stop","index":0}`,
  stop,
];
const additionalNamespaceRequest = `{"model":"gpt-test","input":[{"type":"additional_tools","role":"developer","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}]}]}`;

test("restores additional namespace custom tool call", () => {
  const events = runStream(customExecChunks("call_custom", "functions__exec", `{"input":"pwd"}`, "msg_custom"), additionalNamespaceRequest);
  const added = last(events, "response.output_item.added", (d) => d.item.type === "custom_tool_call")!;
  const inputDone = last(events, "response.custom_tool_call_input.done")!;
  const done = last(events, "response.output_item.done", (d) => d.item.type === "custom_tool_call")!;
  const completed = last(events, "response.completed")!;
  expect(events.filter(([e]) => e.startsWith("response.function_call_arguments.")).length).toBe(0);
  for (const item of [added.item, done.item, completed.response.output[0]]) expect([item.name, item.namespace]).toEqual(["exec", "functions"]);
  expect(inputDone.input).toBe("pwd");
  expect(done.item.input).toBe("pwd");
  expect(completed.response.output[0].type).toBe("custom_tool_call");
  expect(completed.response.output[0].input).toBe("pwd");
});

test("direct custom wins namespace collision", () => {
  const request = `{"model":"gpt-test","tools":[{"type":"namespace","name":"n","tools":[{"type":"function","name":"x"}]},{"type":"custom","name":"n__x"}]}`;
  const streamed = last(runStream(customExecChunks("call_collision", "n__x", `{"input":"pwd"}`, "msg_collision"), request), "response.completed")!.response.output[0];
  const buffered = nonStream(customExecChunks("call_collision_nonstream", "n__x", `{"input":"pwd"}`, "msg_collision_nonstream"), request).output[0];
  for (const item of [streamed, buffered]) {
    expect([item.type, item.input, item.name]).toEqual(["custom_tool_call", "pwd", "n__x"]);
    expect(item.namespace).toBeUndefined();
  }
});

test("non-stream restores additional namespace custom tool call", () => {
  const item = nonStream(customExecChunks("call_custom_nonstream", "functions__exec", `{"input":"pwd"}`, "msg_custom_nonstream"), additionalNamespaceRequest).output[0];
  expect([item.type, item.input, item.call_id, item.name, item.namespace]).toEqual(["custom_tool_call", "pwd", "call_custom_nonstream", "exec", "functions"]);
});

test("custom tool empty input matches non-stream", () => {
  const request = `{"model":"gpt-test","tools":[{"type":"custom","name":"exec"}]}`;
  expect(last(runStream(customExecChunks("call_custom_empty", "exec", undefined, "msg_custom_empty"), request), "response.completed")!.response.output[0].input).toBe("");
  expect(nonStream(customExecChunks("call_custom_empty", "exec", undefined, "msg_custom_empty_nonstream"), request).output[0].input).toBe("");
});

const nodeReplRequest = `{"model":"gpt-test","tools":[{"type":"namespace","name":"mcp__node_repl","tools":[{"type":"function","name":"js","parameters":{"type":"object","properties":{}}}]}]}`;

test("restores namespace function call", () => {
  const events = runStream(
    [
      start,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_abc","name":"mcp__node_repl__js","input":{}}}`,
      // The Go fixture's partial_json line is not valid JSON; it is kept verbatim.
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{"code":"nodeRepl.write('hello')"}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
      stop,
    ],
    nodeReplRequest,
  );
  for (const d of [last(events, "response.output_item.added", (x) => x.item.type === "function_call")!, last(events, "response.output_item.done", (x) => x.item.type === "function_call")!]) {
    expect([d.item.name, d.item.namespace]).toEqual(["js", "mcp__node_repl"]);
  }
  const output = last(events, "response.completed")!.response.output[0];
  expect([output.name, output.namespace]).toEqual(["js", "mcp__node_repl"]);
});

test("non-stream restores namespace function call", () => {
  const out = nonStream(
    [
      `data: {"type":"message_start","message":{"id":"msg_nonstream","usage":{"input_tokens":1,"output_tokens":0}}}`,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_abc","name":"mcp__node_repl__js","input":{}}}`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"nodeRepl.write('hello')\\"}"}}`,
      `data: {"type":"content_block_stop","index":1}`,
      stop,
    ],
    nodeReplRequest,
  );
  expect([out.output[0].name, out.output[0].namespace]).toEqual(["js", "mcp__node_repl"]);
});

test("max_tokens emits incomplete", () => {
  const events = runStream(
    [
      `data: {"type":"message_start","message":{"id":"msg_max_tokens","usage":{"input_tokens":10,"output_tokens":0}}}`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"unfinished reasoning"}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_max_tokens"}}`,
      `data: {"type":"content_block_stop","index":0}`,
      `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":64000}}`,
      stop,
    ],
    "",
    "claude-fable-5-1",
  );
  expect(last(events, "response.completed")).toBeUndefined();
  const incomplete = last(events, "response.incomplete")!.response;
  expect(incomplete.status).toBe("incomplete");
  expect(incomplete.incomplete_details.reason).toBe("max_output_tokens");
  expect([incomplete.output[0].type, incomplete.output[0].status, incomplete.output[0].summary[0].text]).toEqual(["reasoning", "incomplete", "unfinished reasoning"]);
  expect(incomplete.usage.output_tokens).toBe(64000);
});

const maxTokensDelta = `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":64000}}`;
const msgStart = (id: string): string => `data: {"type":"message_start","message":{"id":"${id}","usage":{"input_tokens":10,"output_tokens":0}}}`;
const fable = (chunks: string[], request = ""): [string, JSONObject][] => runStream(chunks, request, "claude-fable-5-1");

test("non-stream max_tokens preserves partial text", () => {
  const root = nonStream(
    [
      msgStart("msg_partial"),
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}`,
      maxTokensDelta,
      stop,
    ],
    "",
    "claude-fable-5-1",
  );
  expect(root.status).toBe("incomplete");
  expect(root.incomplete_details.reason).toBe("max_output_tokens");
  expect(root.output[0].status).toBe("incomplete");
  expect(root.output[0].content[0].text).toBe("partial answer");
});

test("max_tokens with tool call and text emits incomplete", () => {
  const events = fable([
    msgStart("msg_tool_incomplete"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"calling tool"}}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_inc_1","name":"get_weather","input":{}}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"San"}}`,
    maxTokensDelta,
    stop,
  ]);
  const funcDone = last(events, "response.output_item.done", (d) => d.item.type === "function_call")!;
  expect(funcDone.item.status).toBe("incomplete");
  expect(funcDone.item.arguments).toBe(`{"city":"San`);
  const incomplete = last(events, "response.incomplete")!.response;
  expect(incomplete.status).toBe("incomplete");
  expect(incomplete.incomplete_details.reason).toBe("max_output_tokens");
  expect([incomplete.output[0].status, incomplete.output[0].content[0].text]).toEqual(["completed", "calling tool"]);
  expect([incomplete.output[1].status, incomplete.output[1].type, incomplete.output[1].arguments]).toEqual(["incomplete", "function_call", `{"city":"San`]);
});

test("max_tokens with web search emits incomplete", () => {
  const chunks = [
    msgStart("msg_ws_incomplete"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"golang\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    maxTokensDelta,
    stop,
  ];
  const events = fable(chunks);
  expect(last(events, "response.output_item.done", (d) => d.item.type === "web_search_call")!.item.status).toBe("incomplete");
  expect(last(events, "response.incomplete")!.response.output[0].status).toBe("incomplete");
  const ns = nonStream(chunks, "", "claude-fable-5-1");
  expect(ns.status).toBe("incomplete");
  expect(ns.output[0].status).toBe("incomplete");
});

test("max_tokens reasoning without block stop", () => {
  const events = fable([
    msgStart("msg_reasoning_nostop"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"partial thought before cut"}}`,
    maxTokensDelta,
    stop,
  ]);
  expect(last(events, "response.output_item.done", (d) => d.item.type === "reasoning")!.item.status).toBe("incomplete");
  const output = last(events, "response.incomplete")!.response.output[0];
  expect([output.status, output.type, output.summary[0].text]).toEqual(["incomplete", "reasoning", "partial thought before cut"]);
});

test("max_tokens with tool block stop emits incomplete", () => {
  const events = fable([
    msgStart("msg_tool_blockstop"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_stop_1","name":"do_work","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"step\\":1}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    maxTokensDelta,
    stop,
  ]);
  expect(last(events, "response.output_item.done", (d) => d.item.type === "function_call")!.item.status).toBe("incomplete");
  expect(last(events, "response.incomplete")!.response.output[0].status).toBe("incomplete");
});

test("max_tokens with web search results emits incomplete", () => {
  const events = fable([
    msgStart("msg_ws_res_incomplete"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_2","name":"web_search"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"golang\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_2","content":[{"type":"web_search_result","title":"Go","url":"https://golang.org"}]}}`,
    `data: {"type":"content_block_stop","index":1}`,
    maxTokensDelta,
    stop,
  ]);
  expect(last(events, "response.output_item.done", (d) => d.item.type === "web_search_call")!.item.status).toBe("incomplete");
  expect(last(events, "response.incomplete")!.response.output[0].status).toBe("incomplete");
});

test("reasoning events not duplicated", () => {
  const counts: Record<string, number> = {};
  for (const [event] of fable([
    msgStart("msg_rs_once"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"full thought"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}`,
    stop,
  ])) {
    counts[event] = (counts[event] ?? 0) + 1;
  }
  expect(counts["response.reasoning_summary_text.done"]).toBe(1);
  expect(counts["response.reasoning_summary_part.done"]).toBe(1);
  expect(counts["response.output_item.done"]).toBe(1);
});

test("custom tool truncated input unwrapped", () => {
  const events = fable(
    [
      msgStart("msg_custom_trunc"),
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_c1","name":"bash","input":{}}}`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"input\\":\\"echo \\\\u4F60"}}`,
      maxTokensDelta,
      stop,
    ],
    `{"tools":[{"type":"custom","name":"bash"}]}`,
  );
  const done = last(events, "response.output_item.done", (d) => d.item.type === "custom_tool_call")!;
  expect([done.item.input, done.item.status]).toEqual(["echo 你", "incomplete"]);
  const output = last(events, "response.incomplete")!.response.output[0];
  expect([output.input, output.status]).toEqual(["echo 你", "incomplete"]);
});

test("empty function args consistent on truncation", () => {
  const events = fable([
    msgStart("msg_empty_args_trunc"),
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_empty","name":"get_info","input":{}}}`,
    `data: {"type":"content_block_stop","index":0}`,
    maxTokensDelta,
    stop,
  ]);
  expect(last(events, "response.function_call_arguments.done")!.arguments).toBe("");
  const done = last(events, "response.output_item.done", (d) => d.item.type === "function_call")!;
  expect([done.item.arguments, done.item.status]).toEqual(["", "incomplete"]);
  expect(last(events, "response.incomplete")!.response.output[0].arguments).toBe("");
});

// --- apply_patch through Claude ---------------------------------------------

const applyPatchClaudeRequest = `{"tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: patch"}}]}`;
const apStart = (index: number, id: string, name: string): string =>
  `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":${JSON.stringify(id)},"name":${JSON.stringify(name)},"input":{}}}`;
const apFragment = (index: number, fragment: string): string =>
  `data: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(fragment)}}}`;
const apEnd = (): string[] => [`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`, stop];
const apSnapshot = (id: string, name: string, input: string, index = 0): string =>
  `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"${id}","name":"${name}","input":${input}}}`;

function feeder(request = applyPatchClaudeRequest): { feed: (chunk: string) => JSONObject[]; state: TranslatorState; st: () => ClaudeToResponsesState } {
  const state: TranslatorState = {};
  return {
    state,
    st: () => state.value as ClaudeToResponsesState,
    feed: (chunk: string) => convertClaudeResponseToOpenAIResponses(emptyContext, "test", request, "", chunk, state).map((o) => parseSSEEvent(o)[1]),
  };
}
const toolInputErr = (state: TranslatorState): Error | undefined => (state.value as ClaudeToResponsesState).toolInputError();

function assertDeferredFailure(events: JSONObject[], state: TranslatorState): void {
  let failures = 0;
  for (const event of events) {
    if (event.type === "response.failed") {
      failures++;
      expect(event.response.error.code).toBe("invalid_tool_arguments");
    }
    expect(["response.completed", "response.incomplete", "response.custom_tool_call_input.done", "response.output_item.done"]).not.toContain(event.type);
  }
  expect(failures).toBe(1);
  expect(toolInputErr(state)).toBeDefined();
}

test("apply_patch preview before done", () => {
  const { feed } = feeder();
  feed(apStart(0, "c1", "apply_patch"));
  const preview = feed(apFragment(0, `{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n`));
  expect(preview.length).toBe(1);
  expect([preview[0]!.type, preview[0]!.delta, preview[0]!.call_id, preview[0]!.item_id]).toEqual([
    "response.custom_tool_call_input.delta",
    "*** Begin Patch\n*** Add File: a.txt\n+hello\n",
    "c1",
    "ctc_c1",
  ]);
  const events = [...preview, ...feed(apFragment(0, `*** End Patch"}`))];
  for (const chunk of apEnd()) events.push(...feed(chunk));
  const want = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";
  let deltas = "";
  let seenDone = false;
  let seenItem = false;
  let seenCompleted = false;
  let lastSequence = 0;
  for (const event of events) {
    expect(event.sequence_number).toBeGreaterThan(lastSequence);
    lastSequence = event.sequence_number;
    switch (event.type) {
      case "response.custom_tool_call_input.delta":
        deltas += event.delta;
        break;
      case "response.custom_tool_call_input.done":
        seenDone = true;
        expect([deltas, event.input, event.call_id]).toEqual([want, want, "c1"]);
        break;
      case "response.output_item.done":
        seenItem = true;
        expect(seenDone).toBe(true);
        expect(event.item.input).toBe(want);
        break;
      case "response.completed":
        seenCompleted = true;
        expect(seenItem).toBe(true);
        expect(event.response.output[0].input).toBe(want);
    }
  }
  expect([seenDone, seenItem, seenCompleted]).toEqual([true, true, true]);
});

test("apply_patch late identity and interleaved calls", () => {
  const { feed } = feeder();
  feed(apStart(0, "", ""));
  for (const event of feed(apFragment(0, `{"input":"first\\n`))) {
    expect(event.type.includes("arguments.delta") || event.type === "response.custom_tool_call_input.delta").toBe(false);
  }
  const events = [
    ...feed(apStart(0, "c1", "apply_patch")),
    ...feed(apStart(1, "c2", "apply_patch")),
    ...feed(apFragment(1, `{"input":"second`)),
    ...feed(apFragment(0, `tail"}`)),
    ...feed(apFragment(1, ` tail"}`)),
  ];
  for (const chunk of apEnd()) events.push(...feed(chunk));
  const inputs: Record<string, string> = {};
  const indices: Record<string, number> = {};
  const done: Record<string, string> = {};
  for (const event of events) {
    if (event.type === "response.custom_tool_call_input.delta") {
      inputs[event.call_id] = (inputs[event.call_id] ?? "") + event.delta;
      indices[event.call_id] = event.output_index;
    } else if (event.type === "response.custom_tool_call_input.done") done[event.call_id] = event.input;
    expect(event.type).not.toBe("response.failed");
  }
  expect(inputs.c1).toBe("first\ntail");
  expect(inputs.c2).toBe("second tail");
  expect(done.c1).toBe(inputs.c1);
  expect(done.c2).toBe(inputs.c2);
  expect(indices.c1).not.toBe(indices.c2);
});

describe("apply_patch invalid arguments fail once", () => {
  for (const args of [`plain patch`, `{}`, `{"input":42}`, `{"input":"x","extra":1}`, `{"input":"x","input":"y"}`, `{"input":"x"} {}`, `{"input":"unfinished`, `{"input":"bad\\q"}`, `{"input":"\\ud800"}`]) {
    test(args, () => {
      const { feed, state } = feeder();
      const events = [...feed(apStart(0, "c1", "apply_patch")), ...feed(apFragment(0, args))];
      for (const chunk of [...apEnd(), ...apEnd()]) events.push(...feed(chunk));
      assertDeferredFailure(events, state);
    });
  }
});

describe("apply_patch winner and namespace", () => {
  const cases: [string, string, string, string, string, string | undefined][] = [
    ["function", `{"tools":[{"type":"function","name":"apply_patch"}]}`, "apply_patch", "function_call", "apply_patch", undefined],
    ["function wins", `{"tools":[{"type":"function","name":"apply_patch"}],"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]}]}`, "apply_patch", "function_call", "apply_patch", undefined],
    ["custom wins", `{"tools":[{"type":"custom","name":"apply_patch"}],"input":[{"type":"additional_tools","tools":[{"type":"function","name":"apply_patch"}]}]}`, "apply_patch", "custom_tool_call", "apply_patch", undefined],
    ["namespace", `{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]}]}`, "editor__apply_patch", "custom_tool_call", "apply_patch", "editor"],
    ["flat collision", `{"tools":[{"type":"function","name":"editor__apply_patch"},{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]}]}`, "editor__apply_patch", "function_call", "editor__apply_patch", undefined],
    ["same source custom first", `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"apply_patch"}]}`, "apply_patch", "custom_tool_call", "apply_patch", undefined],
    ["same source function first", `{"tools":[{"type":"function","name":"apply_patch"},{"type":"custom","name":"apply_patch"}]}`, "apply_patch", "function_call", "apply_patch", undefined],
    ["namespace before flat", `{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]},{"type":"function","name":"editor__apply_patch"}]}`, "editor__apply_patch", "function_call", "editor__apply_patch", undefined],
    ["sanitized namespace", `{"tools":[{"type":"namespace","name":"mcp.editor","tools":[{"type":"custom","name":"apply_patch"}]}]}`, "mcp_editor__apply_patch", "custom_tool_call", "apply_patch", "mcp.editor"],
    ["other custom", `{"tools":[{"type":"custom","name":"edit"}]}`, "edit", "custom_tool_call", "edit", undefined],
  ];
  for (const [name, request, upstream, wantType, wantName, namespace] of cases) {
    test(name, () => {
      const { feed } = feeder(request);
      feed(apStart(0, "c1", upstream));
      const args = wantType === "function_call" || name === "other custom" ? `{"not_input":42}` : `{"input":"x"}`;
      const events = feed(apFragment(0, args));
      for (const chunk of apEnd()) events.push(...feed(chunk));
      const item = events.find((e) => e.type === "response.completed")!.response.output[0];
      expect([item.type, item.name, item.namespace]).toEqual([wantType, wantName, namespace]);
      if (wantType === "function_call") expect(item.arguments).toBe(args);
      if (name === "other custom") expect(item.input).toBe(args);
    });
  }
});

describe("apply_patch non-stream strict input", () => {
  const cases: [string, string, boolean][] = [
    [`{"input":"*** Begin Patch\\n*** End Patch"}`, "*** Begin Patch\n*** End Patch", false],
    [`{"input":12}`, "", true],
    [`{"input":"truncated`, "", true],
    [`{"input":"x","extra":true}`, "", true],
    [`{"input":"\\ud800"}`, "", true],
  ];
  for (const [args, want, invalid] of cases) {
    test(args, () => {
      const state: TranslatorState = {};
      const result = nonStream([apStart(0, "c1", "apply_patch"), apFragment(0, args), stop], applyPatchClaudeRequest, "test", state);
      if (invalid) {
        expect(result.status).toBe("failed");
        expect(result.error.code).toBe("invalid_tool_arguments");
        expect(toolInputErr(state)).toBeDefined();
      } else {
        expect(result.output[0].input).toBe(want);
      }
    });
  }
});

test("apply_patch terminal validates truncated call", () => {
  const { feed } = feeder();
  feed(apStart(0, "c1", "apply_patch"));
  feed(apFragment(0, `{"input":"unfinished`));
  const events = feed(apEnd()[1]!);
  expect(events.length).toBe(1);
  expect(events[0]!.type).toBe("response.failed");
});

test("apply_patch unicode fragments", () => {
  const args = `{"input":"line\\n\\u4f60\\u597d \\ud83d\\ude00 \\" \\\\ \\u96ea"}`;
  for (let split = 1; split < args.length; split++) {
    const { feed } = feeder();
    feed(apStart(0, "c1", "apply_patch"));
    const events = [...feed(apFragment(0, args.slice(0, split))), ...feed(apFragment(0, args.slice(split)))];
    for (const chunk of apEnd()) events.push(...feed(chunk));
    const input = events.filter((e) => e.type === "response.custom_tool_call_input.delta").map((e) => e.delta).join("");
    expect(input).toBe('line\n你好 😀 " \\ 雪');
  }
});

test("apply_patch identity fields arrive separately", () => {
  for (const [id, name] of [
    ["c1", ""],
    ["", "apply_patch"],
  ]) {
    const { feed } = feeder();
    feed(apStart(0, id!, name!));
    expect(feed(apFragment(0, `{"input":"preview`))).toEqual([]);
    const events = feed(apStart(0, "c1", "apply_patch"));
    const delta = events.find((e) => e.type === "response.custom_tool_call_input.delta");
    expect(delta?.delta).toBe("preview");
    expect(delta?.call_id).toBe("c1");
  }
});

test("apply_patch conflicting identity fails", () => {
  for (const [id, name] of [
    ["other", "apply_patch"],
    ["c1", "other"],
  ]) {
    const { feed } = feeder();
    feed(apStart(0, "c1", "apply_patch"));
    feed(apFragment(0, `{"input":"preview`));
    const events = feed(apStart(0, id!, name!));
    for (const chunk of apEnd()) events.push(...feed(chunk));
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("response.failed");
  }
});

test("apply_patch non-stream original declaration wins", () => {
  const state: TranslatorState = {};
  const result = JSON.parse(
    convertClaudeResponseToOpenAIResponsesNonStream(
      emptyContext,
      "test",
      `{"tools":[{"type":"function","name":"apply_patch"}]}`,
      applyPatchClaudeRequest,
      [apStart(0, "c1", "apply_patch"), apFragment(0, `{"not_input":42}`), stop].join("\n"),
      state,
    ),
  );
  expect(result.output[0].type).toBe("function_call");
  expect(result.output[0].arguments).toBe(`{"not_input":42}`);
});

describe("apply_patch snapshots validate and do not preview", () => {
  const cases: [string, string, string, string, boolean][] = [
    ["snapshot only", "", `{"input":"whole"}`, "whole", false],
    ["matching suffix", `{"input":"pre`, `{"input":"prefix"}`, "prefix", false],
    ["conflict", `{"input":"wrong`, `{"input":"prefix"}`, "", true],
    ["completed conflict", `{"input":"pre"}`, `{"input":"prefix"}`, "", true],
    ["invalid snapshot", `{"input":"pre`, `{"input":7}`, "", true],
  ];
  for (const [name, fragment, snapshotInput, want, invalid] of cases) {
    test(name, () => {
      const { feed } = feeder();
      const s = apStart(0, "c1", "apply_patch");
      const events = feed(s);
      const raw = [s];
      if (fragment !== "") {
        const chunk = apFragment(0, fragment);
        events.push(...feed(chunk));
        raw.push(chunk);
      }
      const snapshot = apSnapshot("c1", "apply_patch", snapshotInput);
      const snapshotEvents = feed(snapshot);
      for (const event of snapshotEvents) expect(event.type).not.toBe("response.custom_tool_call_input.delta");
      events.push(...snapshotEvents);
      raw.push(snapshot);
      for (const chunk of apEnd()) {
        events.push(...feed(chunk));
        raw.push(chunk);
      }
      let terminal: JSONObject | undefined;
      let input = "";
      for (const event of events) {
        if (event.type === "response.custom_tool_call_input.delta") input += event.delta;
        if (event.type === "response.failed" || event.type === "response.completed") terminal = event;
      }
      const ns = nonStream(raw, applyPatchClaudeRequest, "test", {});
      if (invalid) {
        expect(terminal!.type).toBe("response.failed");
        expect(ns.status).toBe("failed");
      } else {
        expect(input).toBe(want);
        expect(terminal!.response.output[0].input).toBe(want);
        expect(ns.output[0].input).toBe(want);
      }
    });
  }
});

test("apply_patch non-stream conflicting identity fails", () => {
  const state: TranslatorState = {};
  const result = nonStream([apStart(0, "c1", "apply_patch"), apFragment(0, `{"input":"x"}`), apStart(0, "c2", "apply_patch"), stop], applyPatchClaudeRequest, "test", state);
  expect(result.status).toBe("failed");
  expect(toolInputErr(state)).toBeDefined();
});

test("apply_patch conflicting snapshots fail", () => {
  const { feed } = feeder();
  const raw: string[] = [];
  const events: JSONObject[] = [];
  for (const input of [`{"input":"first"}`, `{"input":"replacement"}`]) {
    const chunk = apSnapshot("c1", "apply_patch", input);
    raw.push(chunk);
    events.push(...feed(chunk));
  }
  for (const chunk of apEnd()) {
    raw.push(chunk);
    events.push(...feed(chunk));
  }
  let failures = 0;
  for (const event of events) {
    if (event.type === "response.failed") failures++;
    expect(["response.completed", "response.custom_tool_call_input.done"]).not.toContain(event.type);
  }
  expect(failures).toBe(1);
  expect(nonStream(raw, applyPatchClaudeRequest, "test", {}).status).toBe("failed");
});

test("apply_patch pending identity conflict fails", () => {
  const { feed } = feeder();
  feed(apStart(0, "c1", ""));
  feed(apFragment(0, `{"input":"x"}`));
  const events = feed(apStart(0, "c2", "apply_patch"));
  expect(events.length).toBe(1);
  expect(events[0]!.type).toBe("response.failed");
});

test("apply_patch missing id synthesized at terminal", () => {
  const { feed } = feeder();
  feed(apStart(0, "", "apply_patch"));
  feed(apFragment(0, `{"input":"x"}`));
  const events: JSONObject[] = [];
  for (const chunk of apEnd()) events.push(...feed(chunk));
  const item = events.find((e) => e.type === "response.completed")!.response.output[0];
  expect(item.type).toBe("custom_tool_call");
  expect(item.input).toBe("x");
  expect(item.call_id).not.toBe("");
});

test("apply_patch non-stream late identity", () => {
  const item = nonStream([apStart(0, "", "apply_patch"), apFragment(0, `{"input":"x"}`), apStart(0, "c1", ""), stop], applyPatchClaudeRequest, "test", {}).output[0];
  expect([item.type, item.input, item.id]).toEqual(["custom_tool_call", "x", "ctc_c1"]);
});

describe("apply_patch deferred identity conflict", () => {
  const cases: [string, string, string, string, string, boolean][] = [
    ["keep second ID", applyPatchClaudeRequest, "c2", "apply_patch", "", true],
    ["return to first ID", applyPatchClaudeRequest, "c1", "apply_patch", "", true],
    ["omit final ID", applyPatchClaudeRequest, "", "apply_patch", "", true],
    ["ordinary function", `{"tools":[{"type":"function","name":"apply_patch"}]}`, "c2", "apply_patch", "function_call", false],
    ["function winner", `{"tools":[{"type":"function","name":"apply_patch"},{"type":"custom","name":"apply_patch"}]}`, "c2", "apply_patch", "function_call", false],
    ["other custom", `{"tools":[{"type":"custom","name":"edit"}]}`, "c2", "edit", "custom_tool_call", false],
  ];
  for (const [name, request, resolvedID, resolvedName, wantType, invalid] of cases) {
    const chunks = [apStart(0, "c1", ""), apStart(0, "c2", ""), apStart(0, resolvedID, resolvedName), apFragment(0, `{"input":"x"}`), ...apEnd()];
    for (const stream of [true, false]) {
      test(`${name}/${stream ? "stream" : "nonstream"}`, () => {
        let result: JSONObject;
        let state: TranslatorState;
        if (stream) {
          const f = feeder(request);
          state = f.state;
          const events: JSONObject[] = [];
          chunks.forEach((chunk, i) => {
            const current = f.feed(chunk);
            if (i < 2) expect(current).toEqual([]);
            events.push(...current);
          });
          if (invalid) return assertDeferredFailure(events, state);
          result = events.find((e) => e.type === "response.completed")!.response;
        } else {
          state = {};
          result = nonStream(chunks, request, "test", state);
          if (invalid) {
            expect(result.status).toBe("failed");
            expect(result.error.code).toBe("invalid_tool_arguments");
            expect(toolInputErr(state)).toBeDefined();
            return;
          }
        }
        const item = result.output[0];
        expect([result.status, item.type, item.call_id]).toEqual(["completed", wantType, "c2"]);
        expect(toolInputErr(state)).toBeUndefined();
        if (wantType === "function_call") expect(item.arguments).toBe(`{"input":"x"}`);
        if (wantType === "custom_tool_call") expect(item.input).toBe("x");
      });
    }
  }
});

describe("apply_patch deferred snapshots", () => {
  type C = { name: string; first: string; second: string; fragment?: string; toolName?: string; request?: string; want?: string; invalid?: boolean };
  const cases: C[] = [
    { name: "different complete snapshots", first: `{"input":"first"}`, second: `{"input":"replacement"}`, invalid: true },
    { name: "complete snapshot cannot extend", first: `{"input":"pre"}`, second: `{"input":"prefix"}`, invalid: true },
    { name: "early wrong type", first: `{"input":42}`, second: `{"input":"replacement"}`, invalid: true },
    { name: "early extra field", first: `{"input":"first","extra":1}`, second: `{"input":"replacement"}`, invalid: true },
    { name: "early duplicate key", first: `{"input":"first","input":"replacement"}`, second: `{"input":"replacement"}`, invalid: true },
    { name: "early invalid surrogate", first: `{"input":"\\ud800"}`, second: `{"input":"replacement"}`, invalid: true },
    { name: "early invalid then placeholder", first: `{"input":null}`, second: `{}`, fragment: `{"input":"replacement"}`, invalid: true },
    { name: "early invalid then equal decoded input", first: `{"input":"first","extra":1}`, second: `{"input":"first"}`, invalid: true },
    { name: "equivalent complete snapshots", first: `{"input":"\\u0078\\n"}`, second: ` { "input" : "x\\n" } `, want: "x\n" },
    { name: "single snapshot and placeholders", first: `{"input":"whole"}`, second: `{}`, want: "whole" },
    { name: "partial source extension", first: `{}`, second: `{"input":"prefix"}`, fragment: `{"input":"pre`, want: "prefix" },
    { name: "complete source conflict", first: `{}`, second: `{"input":"prefix"}`, fragment: `{"input":"pre"}`, invalid: true },
    { name: "ordinary placeholders", first: `{}`, second: `{}`, fragment: `{"input":"x"}`, want: "x" },
    {
      name: "ordinary function ignores patch evidence",
      first: `{"input":42}`,
      second: `{"input":"replacement"}`,
      fragment: `{"other":42}`,
      request: `{"tools":[{"type":"function","name":"apply_patch"}]}`,
      want: `{"other":42}`,
    },
    {
      name: "other custom ignores patch evidence",
      first: `{"input":42}`,
      second: `{"input":"replacement"}`,
      fragment: `{"other":42}`,
      toolName: "edit",
      request: `{"tools":[{"type":"custom","name":"edit"}]}`,
      want: `{"other":42}`,
    },
  ];
  for (const tc of cases) {
    const request = tc.request ?? applyPatchClaudeRequest;
    const toolName = tc.toolName ?? "apply_patch";
    const chunks = [apSnapshot("c1", "", tc.first)];
    if (tc.fragment) chunks.push(apFragment(0, tc.fragment));
    chunks.push(apSnapshot("c1", "", tc.second), apStart(0, "c1", toolName), ...apEnd());
    for (const stream of [true, false]) {
      test(`${tc.name}/${stream ? "stream" : "nonstream"}`, () => {
        let result: JSONObject;
        let state: TranslatorState;
        if (stream) {
          const f = feeder(request);
          state = f.state;
          const events: JSONObject[] = [];
          let deltas = "";
          chunks.forEach((chunk, i) => {
            const current = f.feed(chunk);
            if (i < chunks.length - 3) expect(current).toEqual([]);
            events.push(...current);
          });
          if (tc.invalid) return assertDeferredFailure(events, state);
          for (const event of events) if (event.type === "response.custom_tool_call_input.delta") deltas += event.delta;
          result = events.find((e) => e.type === "response.completed")!.response;
          if (tc.request === undefined) expect(deltas).toBe(tc.want!);
        } else {
          state = {};
          result = nonStream(chunks, request, "test", state);
          if (tc.invalid) {
            expect(result.status).toBe("failed");
            expect(result.error.code).toBe("invalid_tool_arguments");
            expect(toolInputErr(state)).toBeDefined();
            return;
          }
        }
        const field = tc.request !== undefined && toolName === "apply_patch" ? "arguments" : "input";
        expect(result.status).toBe("completed");
        expect(result.output[0][field]).toBe(tc.want!);
        expect(toolInputErr(state)).toBeUndefined();
      });
    }
  }
});

describe("apply_patch snapshot after item completion", () => {
  const cases: [string, string, boolean][] = [
    ["conflicting complete snapshot", `{"input":"y"}`, true],
    ["complete snapshot cannot extend finished input", `{"input":"xy"}`, true],
    ["equivalent reencoded snapshot", ` { "input" : "\\u0078" } `, false],
    ["placeholder after item completion", `{}`, false],
  ];
  for (const [name, snapshot, invalid] of cases) {
    const chunks = [
      apStart(0, "c1", "apply_patch"),
      apFragment(0, `{"input":"x"}`),
      `data: {"type":"content_block_stop","index":0}`,
      apStart(1, "c2", "apply_patch"),
      apFragment(1, `{"input":"ok"}`),
      apSnapshot("c1", "apply_patch", snapshot),
      ...apEnd(),
    ];
    for (const stream of [true, false]) {
      test(`${name}/${stream ? "stream" : "nonstream"}`, () => {
        let result: JSONObject | undefined;
        let state: TranslatorState;
        if (stream) {
          const f = feeder();
          state = f.state;
          const events: JSONObject[] = [];
          for (const chunk of chunks.slice(0, 5)) events.push(...f.feed(chunk));
          let inputDone = 0;
          let itemDone = 0;
          let preview = "";
          for (const event of events) {
            switch (event.type) {
              case "response.custom_tool_call_input.delta":
                if (event.call_id === "c1") preview += event.delta;
                break;
              case "response.custom_tool_call_input.done":
                inputDone++;
                expect([event.call_id, event.input]).toEqual(["c1", "x"]);
                break;
              case "response.output_item.done":
                itemDone++;
                expect([event.item.call_id, event.item.input]).toEqual(["c1", "x"]);
                break;
              default:
                expect(["response.completed", "response.incomplete", "response.failed"]).not.toContain(event.type);
            }
          }
          const st = f.st();
          expect([inputDone, itemDone, preview, st.funcItemDone.get(0), st.funcInputSnapshot.get(0) ?? ""]).toEqual([1, 1, "x", true, ""]);
          const snapshotEvents = f.feed(chunks[5]!);
          if (!invalid) expect(snapshotEvents).toEqual([]);
          const after = [...snapshotEvents];
          for (const chunk of chunks.slice(6)) after.push(...f.feed(chunk));
          if (invalid) {
            assertDeferredFailure(after, state);
            expect(snapshotEvents.length).toBe(1);
            expect(snapshotEvents[0]!.type).toBe("response.failed");
            return;
          }
          let completions = 0;
          for (const event of after) {
            if (event.type === "response.custom_tool_call_input.delta" || event.type === "response.custom_tool_call_input.done") expect(event.call_id).toBe("c2");
            if (event.type === "response.output_item.done") expect(event.item.call_id).toBe("c2");
            if (event.type === "response.completed") {
              completions++;
              result = event.response;
            }
          }
          expect(completions).toBe(1);
        } else {
          state = {};
          result = nonStream(chunks, applyPatchClaudeRequest, "test", state);
          if (invalid) {
            expect(result.status).toBe("failed");
            expect(result.error.code).toBe("invalid_tool_arguments");
            expect(toolInputErr(state)).toBeDefined();
            return;
          }
        }
        expect([result!.status, result!.output[0].call_id, result!.output[0].input, result!.output[1].call_id, result!.output[1].input]).toEqual(["completed", "c1", "x", "c2", "ok"]);
        expect(toolInputErr(state)).toBeUndefined();
      });
    }
  }
});

describe("apply_patch successful terminal seals state", () => {
  const cases: [string, string][] = [
    ["duplicate message_stop", stop],
    ["post-terminal fragment", apFragment(0, `{"input":"late"}`)],
    ["post-terminal conflicting snapshot", apSnapshot("c1", "apply_patch", `{"input":"y"}`)],
  ];
  for (const [name, late] of cases) {
    const chunks = [apStart(0, "c1", "apply_patch"), apFragment(0, `{"input":"x"}`), ...apEnd()];
    for (const stream of [true, false]) {
      test(`${name}/${stream ? "stream" : "nonstream"}`, () => {
        let state: TranslatorState;
        if (stream) {
          const f = feeder();
          state = f.state;
          let completions = 0;
          for (const chunk of chunks) {
            for (const event of f.feed(chunk)) {
              if (event.type !== "response.completed") continue;
              completions++;
              expect(event.response.output[0].input).toBe("x");
            }
          }
          expect(completions).toBe(1);
          for (const chunk of [late, stop]) expect(f.feed(chunk)).toEqual([]);
        } else {
          state = {};
          const result = nonStream([...chunks, late], applyPatchClaudeRequest, "test", state);
          expect(result.status).toBe("completed");
          expect(result.output[0].input).toBe("x");
        }
        expect(toolInputErr(state)).toBeUndefined();
      });
    }
  }
});

test("pins request per stream", () => {
  const originalRequest = `{"model":"gpt-test","instructions":"pinned-instructions","input":[{"type":"additional_tools","role":"developer","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}]}]}`;
  const chunks = customExecChunks("call_pinned", "functions__exec", `{"input":"pwd"}`, "msg_pinned");
  const state: TranslatorState = {};
  let added: JSONObject | undefined;
  let completed: JSONObject | undefined;
  chunks.forEach((chunk, i) => {
    for (const output of convertClaudeResponseToOpenAIResponses(emptyContext, "claude-test", i === 0 ? originalRequest : "", "", chunk, state)) {
      const [event, data] = parseSSEEvent(output);
      if (event === "response.output_item.added" && data.item.type === "custom_tool_call") added = data;
      if (event === "response.completed") completed = data;
    }
  });
  expect([added!.item.name, added!.item.namespace]).toEqual(["exec", "functions"]);
  expect(completed!.response.instructions).toBe("pinned-instructions");
});

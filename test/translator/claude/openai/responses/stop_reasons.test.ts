// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_stop_reasons_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  convertClaudeResponseToOpenAIResponsesNonStream,
  responsesWebSearchCallID,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import {
  type JSONObject,
  claudeWebSearchStreamChunks,
  convertRequest,
  get,
  streamEvents,
  testClaudeThinkingSignatureForModel,
  translateStreamThroughRegistry,
  useClientToolSearchDefault,
} from "./helpers.ts";

useClientToolSearchDefault();

function pausedSearchChunks(messageID: string, signature: string, finishedID: string, pausedID: string, pausedQuery: string): string[] {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"${messageID}","usage":{"input_tokens":10,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"searching"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${signature}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
  ];
  let index = 1;
  if (finishedID !== "") {
    chunks.push(
      `data: {"type":"content_block_start","index":${index},"content_block":{"type":"server_tool_use","id":${JSON.stringify(finishedID)},"name":"web_search","input":{}}}`,
      `data: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"done query\\"}"}}`,
      `data: {"type":"content_block_stop","index":${index}}`,
      `data: {"type":"content_block_start","index":${index + 1},"content_block":{"type":"web_search_tool_result","tool_use_id":${JSON.stringify(finishedID)},"content":[{"type":"web_search_result","url":"https://example.com/done","title":"Done","encrypted_content":"ENC_DONE"}]}}`,
      `data: {"type":"content_block_stop","index":${index + 1}}`,
    );
    index += 2;
  }
  chunks.push(
    `data: {"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":"Partial answer."}}`,
    `data: {"type":"content_block_stop","index":${index}}`,
    `data: {"type":"content_block_start","index":${index + 1},"content_block":{"type":"server_tool_use","id":${JSON.stringify(pausedID)},"name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":${index + 1},"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"${pausedQuery}\\"}"}}`,
    `data: {"type":"content_block_stop","index":${index + 1}}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":5}}`,
    `data: {"type":"message_stop"}`,
  );
  return chunks;
}

function continuationChunks(messageID: string, pausedID: string, stopReason: string): string[] {
  return [
    `data: {"type":"message_start","message":{"id":"${messageID}","usage":{"input_tokens":10,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","tool_use_id":${JSON.stringify(pausedID)},"content":[{"type":"web_search_result","url":"https://example.com/p","title":"P","encrypted_content":"ENC_PAUSED"}]}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final answer."}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_delta","delta":{"stop_reason":${JSON.stringify(stopReason)}},"usage":{"output_tokens":5}}`,
    `data: {"type":"message_stop"}`,
  ];
}

function streamTerminal(chunks: string[]): [string, JSONObject] {
  let name = "";
  let response: JSONObject = {};
  for (const [event, data] of streamEvents(translateStreamThroughRegistry(chunks))) {
    if (event === "response.completed" || event === "response.incomplete" || event === "response.failed") {
      name = event;
      response = data.response;
    }
  }
  expect(name).not.toBe("");
  return [name, response];
}

/** The next Responses request as a client would build it (web_search_call results dropped). */
function codexHistoryRequest(...responses: JSONObject[]): JSONObject {
  const request: JSONObject = JSON.parse(`{"model":"claude-test","tools":[{"type":"web_search"}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"research"}]}]}`);
  for (const response of responses) {
    for (const item of response.output ?? []) {
      const copy = { ...item };
      if (copy.type === "web_search_call") delete copy.results;
      request.input.push(copy);
    }
  }
  return request;
}

function claudeAssistantBlocks(claudeRequest: string): JSONObject[] {
  const blocks: JSONObject[] = [];
  for (const message of get(claudeRequest, "messages")) if (message.role === "assistant") blocks.push(...message.content);
  return blocks;
}
const blockTypes = (blocks: JSONObject[]): string => blocks.map((b) => b.type).join(",");
const signature = (): string => testClaudeThinkingSignatureForModel()[0];

test("pause_turn round trip sends paused search back without result", () => {
  const [event, response] = streamTerminal(pausedSearchChunks("msg_p1", signature(), "srvtoolu_done", "srvtoolu_paused", "paused query"));
  expect(event).toBe("response.completed");
  expect(response.end_turn).toBe(false);
  const pausedItem = response.output.find((item: JSONObject) => item.id === responsesWebSearchCallID("srvtoolu_paused"));
  expect(pausedItem.status).toBe("in_progress");
  expect(pausedItem.results).toBeUndefined();

  const claudeRequest = convertRequest("claude-test", JSON.stringify(codexHistoryRequest(response)), true);
  const messages = get(claudeRequest, "messages");
  expect(messages[messages.length - 1].role).toBe("assistant");
  const blocks = claudeAssistantBlocks(claudeRequest);
  expect(blockTypes(blocks)).toBe("thinking,server_tool_use,web_search_tool_result,text,server_tool_use");
  expect(blocks[0]!.signature).not.toBe("");
  expect(blocks[1]!.id).toBe("srvtoolu_done");
  expect(blocks[2]!.tool_use_id).toBe("srvtoolu_done");
  expect(blocks[4]!.id).toBe("srvtoolu_paused");
  expect(blocks[4]!.input.query).toBe("paused query");
});

test("pause_turn continuation emits single pair under paused id", () => {
  const [, paused] = streamTerminal(pausedSearchChunks("msg_p1", signature(), "", "srvtoolu_paused", "paused query"));
  const [event, finished] = streamTerminal(continuationChunks("msg_p2", "srvtoolu_paused", "end_turn"));
  expect(event).toBe("response.completed");
  expect(finished.end_turn).toBeUndefined();
  const claudeRequest = convertRequest("claude-test", JSON.stringify(codexHistoryRequest(paused, finished)), true);
  const blocks = claudeAssistantBlocks(claudeRequest);
  let uses = 0;
  blocks.forEach((block, i) => {
    if (block.type !== "server_tool_use") return;
    uses++;
    expect(block.id).toBe("srvtoolu_paused");
    expect(block.input.query).toBe("paused query");
    expect(blocks[i + 1]?.type).toBe("web_search_tool_result");
    expect(blocks[i + 1]?.tool_use_id).toBe("srvtoolu_paused");
  });
  expect(uses).toBe(1);
});

test("pause_turn twice keeps only latest search unanswered", () => {
  const [, first] = streamTerminal(pausedSearchChunks("msg_p1", signature(), "", "srvtoolu_a", "query a"));
  const second = [
    `data: {"type":"message_start","message":{"id":"msg_p2","usage":{"input_tokens":10,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_a","content":[{"type":"web_search_result","url":"https://example.com/a","title":"A","encrypted_content":"ENC_A"}]}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_b","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"query b\\"}"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":5}}`,
    `data: {"type":"message_stop"}`,
  ];
  const [event, secondResponse] = streamTerminal(second);
  expect(event).toBe("response.completed");
  expect(secondResponse.end_turn).toBe(false);
  const blocks = claudeAssistantBlocks(convertRequest("claude-test", JSON.stringify(codexHistoryRequest(first, secondResponse)), true));
  expect(blockTypes(blocks)).toBe("thinking,text,server_tool_use,web_search_tool_result,server_tool_use");
  expect(blocks[2]!.id).toBe("srvtoolu_a");
  expect(blocks[4]!.id).toBe("srvtoolu_b");
  expect(blocks[4]!.input.query).toBe("query b");
});

test("paused search followed by user turn keeps legacy pair", () => {
  const [, paused] = streamTerminal(pausedSearchChunks("msg_p1", signature(), "", "srvtoolu_paused", "paused query"));
  const request = codexHistoryRequest(paused);
  request.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "never mind" }] });
  expect(blockTypes(claudeAssistantBlocks(convertRequest("claude-test", JSON.stringify(request), true)))).toBe("thinking,text,server_tool_use,web_search_tool_result");
});

describe("stop reason errors keep output emitted before terminal", () => {
  for (const reason of ["refusal", "model_context_window_exceeded"]) {
    test(reason, () => {
      const chunks = [
        `data: {"type":"message_start","message":{"id":"msg_e","usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":3}}}`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Some text."}}`,
        `data: {"type":"content_block_stop","index":0}`,
        `data: {"type":"message_delta","delta":{"stop_reason":${JSON.stringify(reason)}},"usage":{"output_tokens":4}}`,
        `data: {"type":"message_stop"}`,
      ];
      const order: string[] = [];
      let terminal: JSONObject = {};
      for (const [event, data] of streamEvents(translateStreamThroughRegistry(chunks))) {
        if (event === "response.output_item.done" && data.item.type === "message") order.push("message_done:" + data.item.content[0].text);
        if (event === "response.incomplete") {
          order.push(event);
          terminal = data.response;
        }
        expect(event).not.toBe("response.completed");
      }
      expect(order.join("|")).toBe("message_done:Some text.|response.incomplete");
      expect(terminal.status).toBe("incomplete");
      expect(terminal.error ?? null).toBeNull();
      expect(terminal.usage.input_tokens).toBe(10);
      expect(terminal.usage.input_tokens_details.cached_tokens).toBe(3);
      expect(terminal.usage.output_tokens).toBe(4);
    });
  }
});

test("repeated web_search ids across turns are not merged", () => {
  for (const boundary of [
    `{"type":"message","role":"user","content":[{"type":"input_text","text":"again"}]}`,
    `{"type":"function_call_output","call_id":"call_1","output":"ok"}`,
  ]) {
    const request = JSON.parse(
      `{"model":"claude-test","tools":[{"type":"web_search"},{"type":"function","name":"f","parameters":{"type":"object","properties":{}}}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}]}`,
    );
    const first = `{"id":"${responsesWebSearchCallID("srvtoolu_x")}","type":"web_search_call","status":"completed","action":{"type":"search","query":"query a"}}`;
    const second = `{"id":"${responsesWebSearchCallID("srvtoolu_x")}","type":"web_search_call","status":"completed","action":{"type":"search","query":"query b"}}`;
    const items = [first];
    if (boundary.includes("function_call_output")) items.push(`{"type":"function_call","call_id":"call_1","name":"f","arguments":"{}"}`);
    items.push(boundary, second);
    for (const item of items) request.input.push(JSON.parse(item));
    const queries = claudeAssistantBlocks(convertRequest("claude-test", JSON.stringify(request), true))
      .filter((b) => b.type === "server_tool_use")
      .map((b) => b.input.query);
    expect(queries.join(",")).toBe("query a,query b");
  }
});

test("paused search continuation requires same assistant run", () => {
  const request = JSON.parse(`{"model":"claude-test","tools":[{"type":"web_search"}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}]}`);
  request.input.push(
    { id: responsesWebSearchCallID("srvtoolu_p"), type: "web_search_call", status: "in_progress", action: { type: "search", query: "paused" } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    { id: responsesWebSearchCallID("srvtoolu_p"), type: "web_search_call", status: "completed", action: { type: "search", query: "" } },
  );
  const uses = claudeAssistantBlocks(convertRequest("claude-test", JSON.stringify(request), true)).filter((b) => b.type === "server_tool_use").length;
  expect(uses).toBe(2);
});

describe("parallel_tool_calls=false maps to disable_parallel_tool_use", () => {
  const tools = `[{"type":"function","name":"shell","parameters":{"type":"object","properties":{}}}]`;
  const cases: [string, string, string | undefined][] = [
    ["no tool_choice", `{"model":"claude-test","parallel_tool_calls":false,"tools":${tools},"input":"hi"}`, `{"type":"auto","disable_parallel_tool_use":true}`],
    ["auto", `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":"auto","tools":${tools},"input":"hi"}`, `{"type":"auto","disable_parallel_tool_use":true}`],
    ["required", `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":"required","tools":${tools},"input":"hi"}`, `{"type":"any","disable_parallel_tool_use":true}`],
    [
      "forced tool",
      `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":{"type":"function","name":"shell"},"tools":${tools},"input":"hi"}`,
      `{"name":"shell","type":"tool","disable_parallel_tool_use":true}`,
    ],
    ["none", `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":"none","tools":${tools},"input":"hi"}`, undefined],
    ["no tools", `{"model":"claude-test","parallel_tool_calls":false,"input":"hi"}`, undefined],
    ["forced tool filtered out", `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":{"type":"function","name":"missing"},"tools":${tools},"input":"hi"}`, undefined],
    [
      "builtin web_search present",
      `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":{"type":"web_search"},"tools":[{"type":"web_search"}],"input":"hi"}`,
      `{"type":"auto","disable_parallel_tool_use":true}`,
    ],
    ["builtin web_search filtered out", `{"model":"claude-test","parallel_tool_calls":false,"tool_choice":{"type":"web_search"},"tools":${tools},"input":"hi"}`, undefined],
    ["true", `{"model":"claude-test","parallel_tool_calls":true,"tools":${tools},"input":"hi"}`, undefined],
    ["absent", `{"model":"claude-test","tools":${tools},"input":"hi"}`, undefined],
    ["true with auto", `{"model":"claude-test","parallel_tool_calls":true,"tool_choice":"auto","tools":${tools},"input":"hi"}`, `{"type":"auto"}`],
  ];
  for (const [name, request, want] of cases) {
    test(name, () => {
      const got = get(convertRequest("claude-test", request, true), "tool_choice");
      expect(got === undefined ? undefined : JSON.stringify(got)).toBe(want);
    });
  }
});

test("context window exceeded non-stream is incomplete max_output_tokens", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_c","usage":{"input_tokens":5,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"},"usage":{"output_tokens":2}}`,
    `data: {"type":"message_stop"}`,
  ];
  const output = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", "", "", chunks.join("\n"), undefined));
  expect(output.status).toBe("incomplete");
  expect(output.incomplete_details.reason).toBe("max_output_tokens");
  expect(output.error ?? null).toBeNull();
  expect(output.output[0].status).toBe("incomplete");
  expect(output.output[0].content[0].text).toBe("cut");
  expect(output.usage.output_tokens).toBe(2);
  expect(output.usage.input_tokens).toBe(5);
});

test("prefill-rejecting model still drops completed thinking+text trailing assistant", () => {
  const raw = JSON.stringify({
    model: "claude-sonnet-4-6",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", encrypted_content: signature(), summary: [{ type: "summary_text", text: "thought" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "prefill text" }] },
    ],
  });
  const messages = get(convertRequest("claude-sonnet-4-6", raw), "messages");
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("user");
});

test("pause_turn after completed search preserved on prefill-rejecting model", () => {
  const chunks = claudeWebSearchStreamChunks();
  const stop = chunks.pop()!;
  chunks.push(`data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":12}}`, stop);
  const [event, response] = streamTerminal(chunks);
  expect(event).toBe("response.completed");
  expect(response.end_turn).toBe(false);
  const req = codexHistoryRequest(response);
  req.model = "claude-opus-5-5";
  const claudeRequest = convertRequest("claude-opus-5-5", JSON.stringify(req), true);
  const messages = get(claudeRequest, "messages");
  expect(messages.length).toBe(2);
  expect(messages[1].role).toBe("assistant");
  expect(blockTypes(claudeAssistantBlocks(claudeRequest))).toBe("server_tool_use,web_search_tool_result");
});

function deferredSearchChunks(): string[] {
  return [
    `data: {"type":"message_start","message":{"id":"msg_d1","usage":{"input_tokens":10,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_deferred","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"deferred query\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_exec","name":"exec","input":{}}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"uname\\"}"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
    `data: {"type":"message_stop"}`,
  ];
}
const execOutput = { output: [{ type: "function_call_output", call_id: "toolu_exec", output: "Linux" }] };

test("deferred search replays without result alongside tool output", () => {
  const [, response] = streamTerminal(deferredSearchChunks());
  expect(response.output[0].status).toBe("in_progress");
  expect(response.output[0].results).toBeUndefined();
  const nonStream = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", "", "", deferredSearchChunks().join("\n"), undefined));
  expect(nonStream.output[0].status).toBe("in_progress");
  expect(nonStream.output[0].results).toBeUndefined();
  const claudeRequest = convertRequest("claude-test", JSON.stringify(codexHistoryRequest(response, execOutput)), true);
  expect(blockTypes(claudeAssistantBlocks(claudeRequest))).toBe("server_tool_use,tool_use");
});

test("deferred search continuation emits single pair", () => {
  const [, deferred] = streamTerminal(deferredSearchChunks());
  const [, continued] = streamTerminal(continuationChunks("msg_d2", "srvtoolu_deferred", "end_turn"));
  const request = codexHistoryRequest(deferred, execOutput, continued);
  request.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] });
  const blocks = claudeAssistantBlocks(convertRequest("claude-test", JSON.stringify(request), true));
  expect(blockTypes(blocks)).toBe("tool_use,server_tool_use,web_search_tool_result,text");
  expect(blocks[1]!.input.query).toBe("deferred query");
});

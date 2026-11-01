// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_server_tool_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  convertClaudeResponseToOpenAIResponsesNonStream,
  responsesWebSearchCallID,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import {
  type JSONObject,
  claudeAssistantBlockTypes,
  claudeWebSearchStreamChunks,
  convertRequest,
  get,
  responsesRequestFromItems,
  streamEvents,
  terminalEvent,
  testClaudeThinkingSignatureForModel,
  translateStreamThroughRegistry,
  useClientToolSearchDefault,
} from "./helpers.ts";

useClientToolSearchDefault();

const nonStream = (chunks: string[]): JSONObject => JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", "", "", chunks.join("\n"), undefined));
const completedOf = (chunks: string[]): JSONObject => terminalEvent(translateStreamThroughRegistry(chunks))!;

test("web search blocks become web_search_call item", () => {
  const items = completedOf(claudeWebSearchStreamChunks()).response.output;
  expect(items.length).toBe(1);
  const item = items[0];
  expect(item.type).toBe("web_search_call");
  expect(item.action.query).toBe("lindorm vector");
  expect(item.status).toBe("completed");
  expect(item.results.length).toBe(2);
  expect(item.results[0].url).toBe("https://example.com/a");
  // Anthropic validates encrypted_content on replay, so it must survive the hop.
  expect(item.results[0].encrypted_content).toBe("ENC_A");
});

test("web search blocks become web_search_call item (non-stream)", () => {
  const items = nonStream(claudeWebSearchStreamChunks()).output;
  expect(items.length).toBe(1);
  expect(items[0].type).toBe("web_search_call");
  expect(items[0].action.query).toBe("lindorm vector");
  expect(items[0].results.length).toBe(2);
});

test("web_search_call item replays as Claude server tool blocks", () => {
  const raw = responsesRequestFromItems(
    `{"type":"web_search_call","id":"ws_srvtoolu_1","status":"completed","action":{"type":"search","query":"lindorm vector"},"results":[{"title":"Lindorm Vector","url":"https://example.com/a","encrypted_content":"ENC_A"}]}`,
  );
  const out = convertRequest("claude-test", raw);
  expect(claudeAssistantBlockTypes(out)).toEqual(["server_tool_use", "web_search_tool_result"]);
  const [use, result] = get(out, "messages.0.content");
  expect(use.id).toBe("srvtoolu_1");
  expect(use.name).toBe("web_search");
  expect(use.input.query).toBe("lindorm vector");
  expect(result.tool_use_id).toBe("srvtoolu_1");
  expect(result.content[0].url).toBe("https://example.com/a");
  expect(result.content[0].encrypted_content).toBe("ENC_A");
});

test("web_search_call without encrypted_content replays empty results", () => {
  const raw = responsesRequestFromItems(
    `{"type":"web_search_call","id":"ws_srvtoolu_1","status":"completed","action":{"type":"search","query":"q"},"results":[{"title":"T","url":"https://example.com/a"}]}`,
  );
  const out = convertRequest("claude-test", raw);
  expect(claudeAssistantBlockTypes(out).length).toBe(2);
  expect(get(out, "messages.0.content.1.content.#")).toBe(0);
});

test("output_text annotations replay as Claude citations", () => {
  const raw = responsesRequestFromItems(
    `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Answer.","annotations":[{"type":"web_search_result_location","url":"https://example.com/a","title":"A","cited_text":"Answer","encrypted_index":"IDX_A"}]}]}`,
  );
  const block = get(convertRequest("claude-test", raw), "messages.0.content.0");
  expect(block.type).toBe("text");
  expect(block.citations.length).toBe(1);
  expect(block.citations[0].url).toBe("https://example.com/a");
  expect(block.citations[0].encrypted_index).toBe("IDX_A");
});

test("annotations without encrypted_index are not replayed as citations", () => {
  const raw = responsesRequestFromItems(
    `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Answer.","annotations":[{"type":"url_citation","url":"https://example.com/a","title":"A"}]}]}`,
  );
  expect(get(convertRequest("claude-test", raw), "messages.0.content.0.citations")).toBeUndefined();
});

test("refusal part replays as Claude text", () => {
  const raw = responsesRequestFromItems(`{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"I cannot help with that."}]}`);
  const block = get(convertRequest("claude-test", raw), "messages.0.content");
  expect(typeof block === "string" ? block : block[0].text).toBe("I cannot help with that.");
});

test("round trip preserves reachable Claude blocks", () => {
  const [sig] = testClaudeThinkingSignatureForModel();
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_rt","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ponder"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${sig}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Researching."}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"q\\"}"}}`,
    `data: {"type":"content_block_stop","index":2}`,
    `data: {"type":"content_block_start","index":3,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"T","url":"https://example.com/a"}]}}`,
    `data: {"type":"content_block_stop","index":3}`,
    `data: {"type":"content_block_start","index":4,"content_block":{"type":"thinking","thinking":""}}`,
    `data: {"type":"content_block_delta","index":4,"delta":{"type":"thinking_delta","thinking":"more"}}`,
    `data: {"type":"content_block_delta","index":4,"delta":{"type":"signature_delta","signature":"${sig}"}}`,
    `data: {"type":"content_block_stop","index":4}`,
    `data: {"type":"content_block_start","index":5,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec","input":{}}}`,
    `data: {"type":"content_block_delta","index":5,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}`,
    `data: {"type":"content_block_stop","index":5}`,
    `data: {"type":"message_stop"}`,
  ];
  const req = JSON.stringify({ model: "claude-test", input: completedOf(chunks).response.output });
  expect(claudeAssistantBlockTypes(convertRequest("claude-test", req))).toEqual(["thinking", "text", "server_tool_use", "web_search_tool_result", "thinking", "tool_use"]);
});

describe("web_search_call id normalised to Claude server tool pattern", () => {
  const cases: [string, string, string][] = [
    ["claude round trip keeps the original id", "ws_srvtoolu_abc123", "srvtoolu_abc123"],
    ["native OpenAI id gains the required prefix", "ws_00112233aabb", "srvtoolu_00112233aabb"],
    ["characters outside the pattern are replaced", "ws_00112233-aabb.cc", "srvtoolu_00112233_aabb_cc"],
  ];
  for (const [name, id, want] of cases) {
    test(name, () => {
      const out = convertRequest("claude-test", responsesRequestFromItems(`{"type":"web_search_call","id":"${id}","status":"completed","action":{"type":"search","query":"q"}}`));
      expect(get(out, "messages.0.content.0.id")).toBe(want);
      expect(get(out, "messages.0.content.1.tool_use_id")).toBe(want);
    });
  }
});

test("web_search_call without id produces no blocks", () => {
  for (const id of ["", "ws_"]) {
    const out = convertRequest("claude-test", responsesRequestFromItems(`{"type":"web_search_call","id":"${id}","status":"completed","action":{"type":"search","query":"q"}}`));
    expect(claudeAssistantBlockTypes(out)).toEqual([]);
  }
});

test("web search without result block still emits item", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_ws","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"q\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_stop"}`,
  ];
  let done = 0;
  let completed: JSONObject | undefined;
  for (const [event, data] of streamEvents(translateStreamThroughRegistry(chunks))) {
    if (event === "response.output_item.done" && data.item.type === "web_search_call") done++;
    if (event === "response.completed") completed = data;
  }
  expect(done).toBe(1);
  expect(completed!.response.output[0].results).toBeUndefined();
});

test("unmapped server tool produces no item", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_ws","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"code_execution","input":{}}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_stop"}`,
  ];
  const output = completedOf(chunks).response.output;
  expect(output.length).toBe(1);
  expect(output[0].type).toBe("message");
});

test("web search result without matching use keeps continuation result", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_ws","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_paused","content":[{"type":"web_search_result","url":"https://example.com","title":"Example","encrypted_content":"ENC_P"}]}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_stop"}`,
  ];
  const check = (response: JSONObject): void => {
    expect(response.output.length).toBe(1);
    const item = response.output[0];
    expect(item.type).toBe("web_search_call");
    expect(item.id).toBe(responsesWebSearchCallID("srvtoolu_paused"));
    expect(item.results[0].encrypted_content).toBe("ENC_P");
    expect(item.status).toBe("completed");
  };
  const completed = streamEvents(translateStreamThroughRegistry(chunks)).filter(([event]) => event === "response.completed");
  expect(completed.length).toBe(1);
  check(completed[0]![1].response);
  check(nonStream(chunks));
});

describe("web_search_call query accepts native OpenAI action shapes", () => {
  const cases: [string, string, string][] = [
    ["search with query", `{"type":"search","query":"go release","queries":["go release"]}`, "go release"],
    ["search with only queries", `{"type":"search","queries":["go release"]}`, "go release"],
    ["open_page falls back to the url", `{"type":"open_page","url":"https://go.dev/dl"}`, "https://go.dev/dl"],
  ];
  for (const [name, action, want] of cases) {
    test(name, () => {
      const out = convertRequest("claude-test", responsesRequestFromItems(`{"type":"web_search_call","id":"ws_srvtoolu_1","status":"completed","action":${action}}`));
      expect(get(out, "messages.0.content.0.input.query")).toBe(want);
    });
  }
});

test("web search with empty results keeps empty list", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_ws","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"q\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_stop"}`,
  ];
  expect(completedOf(chunks).response.output[0].results).toEqual([]);
});

test("web search error result survives round trip", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_ws_err","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_err","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"err_query\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_err","content":[{"type":"web_search_tool_result_error","error_code":"rate_limited"}]}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_stop"}`,
  ];
  const items = completedOf(chunks).response.output;
  expect(items.length).toBe(1);
  expect(items[0].type).toBe("web_search_call");
  expect(items[0].results[0].type).toBe("web_search_tool_result_error");
  expect(items[0].results[0].error_code).toBe("rate_limited");
  const replayed = convertRequest("claude-test", JSON.stringify({ model: "claude-test", input: [items[0]] }));
  expect(get(replayed, "messages.0.content.1.content.0.type")).toBe("web_search_tool_result_error");
  expect(get(replayed, "messages.0.content.1.content.0.error_code")).toBe("rate_limited");
});

test("text/search/text order preserved in streaming and replay", () => {
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_order","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Before search."}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_order","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"query\\"}"}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_order","content":[{"type":"web_search_result","title":"T","url":"https://example.com/order","encrypted_content":"ENC_ORD"}]}}`,
    `data: {"type":"content_block_stop","index":2}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","cited_text":"After search.","url":"https://example.com/order","title":"T","encrypted_index":"IDX_ORD"}}}`,
    `data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"After search."}}`,
    `data: {"type":"content_block_stop","index":3}`,
    `data: {"type":"message_stop"}`,
  ];
  for (const items of [completedOf(chunks).response.output, nonStream(chunks).output]) {
    expect(items.length).toBe(3);
    expect(items[0].type).toBe("message");
    expect(items[0].content[0].text).toBe("Before search.");
    expect(items[1].type).toBe("web_search_call");
    expect(items[2].type).toBe("message");
    expect(items[2].content[0].text).toBe("After search.");
    expect(items[2].content[0].annotations[0].encrypted_index).toBe("IDX_ORD");
  }
  const replayed = convertRequest("claude-test", JSON.stringify({ model: "claude-test", input: completedOf(chunks).response.output }));
  expect(claudeAssistantBlockTypes(replayed)).toEqual(["text", "server_tool_use", "web_search_tool_result", "text"]);
});

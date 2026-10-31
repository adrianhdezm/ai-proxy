// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_tool_search_test.go
// Skipped cases: none. TestConvertOpenAIResponsesRequestToClaude_WithoutToolSearchIsUnchanged compares parsed
// JSON (Go's schema normalizer re-marshalled maps with sorted keys).
import { describe, expect, test } from "bun:test";
import {
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
  responsesDeferredAnchorName,
  responsesToolSearchType,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import { type JSONObject, convertRequestWithError, parseSSEEvent, useClientToolSearchDefault, withToolSearch } from "./helpers.ts";
import {
  codexCalendarNamespace,
  codexDeferredNSTool,
  codexDeferredTool,
  codexExecCommandTool,
  codexNSCall,
  codexNSCallOutput,
  codexSearchCall1,
  codexSearchCall2,
  codexSearchOutput1,
  codexSearchOutput2,
  codexToolSearchDeclaration,
  codexToolSearchRequest,
  codexUserTurn,
} from "./tool_search_fixtures.ts";

useClientToolSearchDefault();

function convertToolSearchRequest(request: string): JSONObject {
  const { body, err } = convertRequestWithError("claude-sonnet-4-5", request, true);
  expect(err).toBeUndefined();
  return JSON.parse(body);
}
const toolNames = (req: JSONObject): string[] => (req.tools ?? []).map((t: JSONObject) => t.name);
const toolNamed = (req: JSONObject, name: string): JSONObject | undefined => (req.tools ?? []).find((t: JSONObject) => t.name === name);

test("tool_search becomes query function tool", () => {
  const tool = toolNamed(convertToolSearchRequest(codexToolSearchRequest(codexUserTurn)), "tool_search")!;
  expect(tool).toBeDefined();
  expect(tool.type).toBeUndefined();
  expect(tool.execution).toBeUndefined();
  expect(tool.input_schema.properties.query.type).toBe("string");
  expect(tool.input_schema.required).toContain("query");
  expect(tool.input_schema.properties.limit.type).toBe("number");
  expect(tool.description.startsWith("# Tool discovery")).toBe(true);
});

test("tool_search schema always requires query", () => {
  for (const declaration of [
    `{"type":"tool_search","execution":"client"}`,
    `{"type":"tool_search","execution":"client","parameters":{"type":"object","properties":{"limit":{"type":"number"}}}}`,
  ]) {
    const tool = convertToolSearchRequest(`{"model":"claude-sonnet-4-5","input":"hi","tools":[${declaration}]}`).tools[0];
    expect(tool.name).toBe(responsesToolSearchType);
    expect(tool.input_schema.properties.query.type).toBe("string");
    expect(tool.input_schema.required).toContain("query");
  }
});

test("hosted tool_search is not forwarded", () => {
  const req = convertToolSearchRequest(`{"model":"claude-sonnet-4-5","input":"hi","tools":[${codexExecCommandTool},{"type":"tool_search","name":"ToolSearch"},${codexDeferredTool}]}`);
  expect(toolNames(req).join(",")).toBe("exec_command,lookup_order");
});

test("tool_search name is collision safe", () => {
  const names = toolNames(convertToolSearchRequest(`{"model":"claude-sonnet-4-5","input":"hi","tools":[{"type":"function","name":"tool.search","parameters":{"type":"object"}},${codexToolSearchDeclaration}]}`));
  // The third tool is the deferred anchor native tool search declares.
  expect(names.length).toBe(3);
  expect(names[1]).toBe(responsesToolSearchType);
  expect(names[0]).not.toBe(names[1]);
  expect(names[2]).toBe(responsesDeferredAnchorName);
});

test("tool_search omits deferred tools", () => {
  expect(toolNames(convertToolSearchRequest(codexToolSearchRequest(codexUserTurn))).join(",")).toBe("exec_command,tool_search," + responsesDeferredAnchorName);
});

test("tool_search history replays and activates tools", () => {
  const turn2 = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1));
  const wantTurn2 = "exec_command,tool_search," + responsesDeferredAnchorName + ",mcp__codex_apps__calendar_create_event,lookup_order";
  expect(toolNames(turn2).join(",")).toBe(wantTurn2);
  for (const name of ["mcp__codex_apps__calendar_create_event", "lookup_order"]) expect(toolNamed(turn2, name)!.defer_loading).toBe(true);
  for (const name of ["exec_command", "tool_search"]) expect(toolNamed(turn2, name)!.defer_loading).toBeUndefined();
  expect(toolNamed(turn2, "mcp__codex_apps__calendar_create_event")!.input_schema.required[0]).toBe("title");

  const toolUse = turn2.messages[1].content[0];
  expect([toolUse.type, toolUse.id, toolUse.name, toolUse.input.query, toolUse.input.limit]).toEqual(["tool_use", "call_search_1", "tool_search", "calendar create", 8]);
  const toolResult = turn2.messages[2].content[0];
  expect(toolResult.type).toBe("tool_result");
  expect(toolResult.tool_use_id).toBe("call_search_1");
  expect(JSON.stringify(toolResult.content)).toBe(
    `[{"type":"tool_reference","tool_name":"mcp__codex_apps__calendar_create_event"},{"type":"tool_reference","tool_name":"lookup_order"}]`,
  );

  const turn3 = convertToolSearchRequest(
    codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1, codexNSCall, codexNSCallOutput, codexSearchCall2, codexSearchOutput2),
  );
  expect(toolNames(turn3).join(",")).toBe(wantTurn2 + ",mcp__node_repl__js");
  turn2.tools.forEach((tool: JSONObject, i: number) => expect(JSON.stringify(turn3.tools[i])).toBe(JSON.stringify(tool)));
});

test("namespaced function_call history is qualified", () => {
  const req = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1, codexNSCall, codexNSCallOutput));
  let replayed: JSONObject | undefined;
  for (const message of req.messages) for (const block of Array.isArray(message.content) ? message.content : []) if (block.id === "call_cal_1") replayed = block;
  expect(replayed!.name).toBe("mcp__codex_apps__calendar_create_event");
  expect(toolNamed(req, "mcp__codex_apps__calendar_create_event")).toBeDefined();
});

test("without tool_search is unchanged", () => {
  // Golden output captured from the translator before tool_search support.
  const request =
    `{"model":"claude-sonnet-4-5","instructions":"You are Codex.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run js"}]},{"type":"function_call","call_id":"call_js_1","name":"js","namespace":"mcp__node_repl__","arguments":"{\\"code\\":\\"1+1\\"}"},{"type":"function_call_output","call_id":"call_js_1","output":"2"}],"tools":[` +
    `${codexExecCommandTool},${codexDeferredTool},${codexDeferredNSTool}],"tool_choice":"auto","stream":true}`;
  const want = `{"model":"claude-sonnet-4-5","max_tokens":32000,"messages":[{"role":"user","content":"run js"},{"role":"assistant","content":[{"type":"tool_use","id":"call_js_1","name":"mcp__node_repl__js","input":{"code":"1+1"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_js_1","content":"2"}]}],"metadata":{"user_id":"89d5fa27ec7781d2e5b32a000710e2eba99246913042b9a3b01805bcdc3111ef"},"stream":true,"system":[{"type":"text","text":"You are Codex."}],"tools":[{"name":"exec_command","description":"Run a command.","input_schema":{"properties":{"cmd":{"type":"string"}},"required":["cmd"],"type":"object"}},{"name":"lookup_order","description":"Look up an order.","input_schema":{"properties":{"id":{"type":"string"}},"required":["id"],"type":"object"}},{"name":"mcp__node_repl__js","description":"Run JavaScript.","input_schema":{"properties":{"code":{"type":"string"}},"required":["code"],"type":"object"}}],"tool_choice":{"type":"auto"}}`;
  expect(convertToolSearchRequest(request)).toEqual(JSON.parse(want));
});

const claudeToolSearchStream = [
  `data: {"type":"message_start","message":{"id":"msg_ts","usage":{"input_tokens":1,"output_tokens":0}}}`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_search","name":"tool_search","input":{}}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"calendar"}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" create\\",\\"limit\\":8}"}}`,
  `data: {"type":"content_block_stop","index":0}`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_cal","name":"mcp__codex_apps__calendar_create_event","input":{}}}`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"title\\":\\"Standup\\"}"}}`,
  `data: {"type":"content_block_stop","index":1}`,
  `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_exec","name":"exec_command","input":{}}}`,
  `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}`,
  `data: {"type":"content_block_stop","index":2}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
  `data: {"type":"message_stop"}`,
];

function assertCodexToolSearchCall(item: JSONObject): void {
  expect([item.type, item.call_id, item.execution, item.status, item.id]).toEqual(["tool_search_call", "toolu_search", "client", "completed", "tsc_toolu_search"]);
  expect(item.arguments).toEqual({ query: "calendar create", limit: 8 });
}

function assertOrdinaryToolCalls(calendar: JSONObject, exec: JSONObject): void {
  expect([calendar.type, calendar.name, calendar.namespace, calendar.arguments]).toEqual(["function_call", "calendar_create_event", "mcp__codex_apps__", `{"title":"Standup"}`]);
  expect([exec.type, exec.name, exec.arguments]).toEqual(["function_call", "exec_command", `{"cmd":"ls"}`]);
  expect(exec.namespace).toBeUndefined();
}

test("stream: tool_search becomes tool_search_call", () => {
  const request = codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1);
  const state: TranslatorState = {};
  const added: JSONObject[] = [];
  const done: JSONObject[] = [];
  let completed: JSONObject | undefined;
  for (const chunk of claudeToolSearchStream) {
    for (const output of convertClaudeResponseToOpenAIResponses(emptyContext, "claude-test", request, "", chunk, state)) {
      const [event, data] = parseSSEEvent(output);
      if (event === "response.output_item.added") added.push(data);
      else if (event === "response.output_item.done") done.push(data);
      else if (event === "response.function_call_arguments.delta" || event === "response.function_call_arguments.done") {
        expect(data.item_id === "tsc_toolu_search" || data.output_index === 0).toBe(false);
      } else if (event === "response.completed") completed = data;
    }
  }
  expect(added.length).toBe(3);
  expect(done.length).toBe(3);
  expect([added[0]!.item.type, added[0]!.item.call_id, added[0]!.item.execution]).toEqual(["tool_search_call", "toolu_search", "client"]);
  assertCodexToolSearchCall(done[0]!.item);
  assertOrdinaryToolCalls(done[1]!.item, done[2]!.item);
  const output = completed!.response.output;
  expect(output.length).toBe(3);
  assertCodexToolSearchCall(output[0]);
  assertOrdinaryToolCalls(output[1], output[2]);
});

test("non-stream: tool_search becomes tool_search_call", () => {
  const request = codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1);
  const output = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", request, "", claudeToolSearchStream.join("\n"), undefined)).output;
  expect(output.length).toBe(3);
  assertCodexToolSearchCall(output[0]);
  assertOrdinaryToolCalls(output[1], output[2]);
});

describe("truncated tool_search is incomplete", () => {
  const request = codexToolSearchRequest(codexUserTurn);
  const start = `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_search","name":"tool_search","input":{}}}`;
  const cases: [string, string[], string, unknown][] = [
    ["max_tokens mid input", [start, `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"calen"}}`], "max_tokens", {}],
    [
      "max_tokens after complete input keeps arguments",
      [start, `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"calendar\\"}"}}`, `data: {"type":"content_block_stop","index":0}`],
      "max_tokens",
      { query: "calendar" },
    ],
    ["tool_use stop without input", [start, `data: {"type":"content_block_stop","index":0}`], "tool_use", {}],
  ];
  for (const [name, body, stopReason, wantArguments] of cases) {
    test(name, () => {
      const chunks = [
        `data: {"type":"message_start","message":{"id":"msg_trunc","usage":{"input_tokens":1,"output_tokens":0}}}`,
        ...body,
        `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":5}}`,
        `data: {"type":"message_stop"}`,
      ];
      const state: TranslatorState = {};
      let done: JSONObject | undefined;
      let terminal: JSONObject | undefined;
      for (const chunk of chunks) {
        for (const output of convertClaudeResponseToOpenAIResponses(emptyContext, "claude-test", request, "", chunk, state)) {
          const [event, data] = parseSSEEvent(output);
          if (event === "response.output_item.done") done = data.item;
          if (event === "response.completed" || event === "response.incomplete") terminal = data.response.output[0];
        }
      }
      for (const item of [done!, terminal!]) {
        expect(item.type).toBe("tool_search_call");
        expect(item.status).toBe("incomplete");
        expect(item.arguments).toEqual(wantArguments);
      }
    });
  }
});

describe("tool_search name collision routes consistently", () => {
  const userFunction = `{"type":"function","name":"tool_search","description":"User tool.","parameters":{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}}`;
  const claudeCall = [
    `data: {"type":"message_start","message":{"id":"msg_collide","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"tool_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":\\"1\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_stop"}`,
  ].join("\n");
  const cases: [string, string, string, string, string][] = [
    ["user function first", userFunction + "," + codexToolSearchDeclaration, "tool_search,lookup_order", "function_call", "x"],
    ["client declaration first", codexToolSearchDeclaration + "," + userFunction, "tool_search," + responsesDeferredAnchorName, "tool_search_call", "query"],
  ];
  for (const [name, tools, wantTools, wantType, wantProp] of cases) {
    test(name, () => {
      const request = `{"model":"claude-sonnet-4-5","input":"hi","tools":[${tools},${codexDeferredTool}]}`;
      const req = convertToolSearchRequest(request);
      expect(toolNames(req).join(",")).toBe(wantTools);
      expect(req.tools[0].input_schema.properties[wantProp]).toBeDefined();
      const out = JSON.parse(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", request, "", claudeCall, undefined));
      expect(out.output[0].type).toBe(wantType);
    });
  }
  test("user function first keeps history as text", () => {
    const request = `{"model":"claude-sonnet-4-5","input":[${[codexUserTurn, codexSearchCall1, codexSearchOutput1].join(",")}],"tools":[${userFunction},${codexToolSearchDeclaration},${codexDeferredTool}]}`;
    const raw = JSON.stringify(convertToolSearchRequest(request));
    expect(raw).not.toContain(`"defer_loading"`);
    expect(raw).not.toContain(`"tool_reference"`);
  });
});

test("tool_search_output skips directly declared tools", () => {
  const declaredOnly = `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[${codexExecCommandTool}]}`;
  let req = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, declaredOnly));
  expect(req.messages[2].content[0].content).toBe("Tools now available to call: exec_command.");
  const mixed = `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[${codexExecCommandTool},${codexCalendarNamespace}]}`;
  req = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, mixed));
  expect(JSON.stringify(req.messages[2].content[0].content)).toBe(`[{"type":"tool_reference","tool_name":"mcp__codex_apps__calendar_create_event"}]`);
  expect(toolNamed(req, "exec_command")!.defer_loading).toBeUndefined();
});

test("tool_search_output deduplicates references", () => {
  const twice = `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[${codexCalendarNamespace},${codexCalendarNamespace}]}`;
  let req = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, twice));
  expect(JSON.stringify(req.messages[2].content[0].content)).toBe(`[{"type":"tool_reference","tool_name":"mcp__codex_apps__calendar_create_event"}]`);
  const rediscovered = `{"type":"tool_search_output","call_id":"call_search_2","status":"completed","execution":"client","tools":[${codexCalendarNamespace}]}`;
  req = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1, codexSearchCall2, rediscovered));
  expect(req.tools.filter((t: JSONObject) => t.name === "mcp__codex_apps__calendar_create_event").length).toBe(1);
  const references: string[] = [];
  for (const message of req.messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      for (const part of Array.isArray(block.content) ? block.content : []) {
        if (part.type === "tool_reference" && part.tool_name === "mcp__codex_apps__calendar_create_event") references.push(block.tool_use_id);
      }
    }
  }
  expect(references.join(",")).toBe("call_search_1,call_search_2");
});

test("tool_search_output without tools keeps text", () => {
  const empty = `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[]}`;
  expect(convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, empty)).messages[2].content[0].content).toBe("No matching tools were found.");
});

test("deferred tools drop cache_control", () => {
  const cached =
    `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[` +
    `{"type":"function","name":"cached_fn","description":"Cached.","cache_control":{"type":"ephemeral"},"defer_loading":true,"parameters":{"type":"object","properties":{}}},` +
    `{"type":"custom","name":"cached_custom","description":"Cached custom.","cache_control":{"type":"ephemeral"},"defer_loading":true}]}`;
  const req = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, cached));
  for (const name of ["cached_fn", "cached_custom"]) {
    const tool = toolNamed(req, name)!;
    expect(tool.defer_loading).toBe(true);
    expect(tool.cache_control).toBeUndefined();
  }
});

test("deferred anchor keeps tools prefix stable", () => {
  const turn1 = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn));
  const turn2 = convertToolSearchRequest(codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1));
  expect(toolNames(turn1).join(",")).toBe("exec_command,tool_search," + responsesDeferredAnchorName);
  const anchor = toolNamed(turn1, responsesDeferredAnchorName)!;
  expect(anchor.defer_loading).toBe(true);
  expect(anchor.cache_control).toBeUndefined();
  expect(typeof anchor.input_schema).toBe("object");
  expect(turn2.tools.length).toBeGreaterThan(turn1.tools.length);
  turn1.tools.forEach((tool: JSONObject, i: number) => expect(JSON.stringify(turn2.tools[i])).toBe(JSON.stringify(tool)));
  expect(JSON.stringify(turn2.messages[2].content[0].content)).not.toContain(responsesDeferredAnchorName);
});

test("deferred anchor yields to client tool name", () => {
  const declared = (name: string): string => `{"type":"function","name":"${name}","description":"Client tool.","parameters":{"type":"object","properties":{}}}`;
  const discovered = `{"type":"tool_search_output","call_id":"call_search_1","status":"completed","execution":"client","tools":[{"type":"function","name":"${responsesDeferredAnchorName}","description":"Client tool.","defer_loading":true,"parameters":{"type":"object","properties":{}}}]}`;
  for (const request of [
    `{"model":"claude-sonnet-4-5","input":"hi","tools":[${codexToolSearchDeclaration},${declared(responsesDeferredAnchorName)}]}`,
    `{"model":"claude-sonnet-4-5","input":"hi","tools":[${codexToolSearchDeclaration},${declared("tool.search.deferred.anchor")}]}`,
    codexToolSearchRequest(codexUserTurn, codexSearchCall1, discovered),
  ]) {
    const matches = convertToolSearchRequest(request).tools.filter((t: JSONObject) => t.name === responsesDeferredAnchorName);
    expect(matches.length).toBe(1);
    expect(matches[0].description).toBe("Client tool.");
  }
});

test("no deferred anchor without native tool search", () => {
  const userFunction = `{"type":"function","name":"tool_search","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}`;
  for (const request of [
    `{"model":"claude-sonnet-4-5","input":"hi","tools":[${codexExecCommandTool},${codexDeferredTool}]}`,
    `{"model":"claude-sonnet-4-5","input":"hi","tools":[${userFunction},${codexToolSearchDeclaration},${codexDeferredTool}]}`,
  ]) {
    expect(JSON.stringify(convertToolSearchRequest(request).tools)).not.toContain(responsesDeferredAnchorName);
  }
  const on = convertRequestWithError("claude-sonnet-4-5", codexToolSearchRequest(codexUserTurn), true).body;
  const off = withToolSearch(false, () => convertRequestWithError("claude-sonnet-4-5", codexToolSearchRequest(codexUserTurn), true).body);
  expect(on).toContain(responsesDeferredAnchorName);
  expect(off).not.toContain(responsesDeferredAnchorName);
});

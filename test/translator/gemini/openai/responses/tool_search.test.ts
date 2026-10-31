// Ported from: internal/translator/gemini/openai/responses/gemini_openai-responses_tool_search_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { g, J, nonStream, streamEvents, toGemini } from "./helpers.ts";

const toolSearchFixtureRequest = `{
	"model": "gemini-3.8-flash-high",
	"stream": true,
	"tools": [
		{"type": "function", "name": "exec_command", "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}},
		{"type": "tool_search", "execution": "client", "description": "Search available deferred tools. Multi-agent tools: Spawn and manage sub-agents.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"], "additionalProperties": false}},
		{"type": "function", "name": "spawn_agent", "defer_loading": true, "parameters": {"type": "object", "properties": {"prompt": {"type": "string"}}}}
	],
	"input": [
		{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Find the multi-agent tools before answering."}]},
		{"type": "tool_search_call", "id": "tsc_search_1", "execution": "client", "call_id": "search_1", "status": "completed", "arguments": {"query": "fixture tools", "limit": 1}},
		{"type": "tool_search_output", "id": "tso_search_1", "execution": "client", "call_id": "search_1", "status": "completed", "tools": [
			{"type": "namespace", "name": "fixture_tools", "description": "Minimal discovery fixture, not the actual Codex agent schema", "tools": [
				{"type": "function", "name": "ping", "description": "Return a test reply", "defer_loading": true, "parameters": {"type": "object", "properties": {}, "additionalProperties": false}}
			]}
		]},
		{"type": "function_call", "call_id": "call_ping", "name": "ping", "namespace": "fixture_tools", "arguments": "{}"},
		{"type": "function_call_output", "call_id": "call_ping", "output": "pong"}
	]
}`;

const model = "gemini-3.8-flash-high";

test("TestConvertOpenAIResponsesRequestToGemini_ToolSearchRoundTrip", () => {
  const root = J.parse(toGemini(model, toolSearchFixtureRequest, true));
  const declarations = root.get("tools.0.functionDeclarations");
  expect(declarations.arr().map((d) => d.str("name"))).toEqual(["exec_command", "tool_search", "fixture_tools__ping"]);
  expect(declarations.str("1.description")).toBe("Search available deferred tools. Multi-agent tools: Spawn and manage sub-agents.");
  expect(declarations.str("1.parametersJsonSchema.required.0")).toBe("query");
  expect(declarations.str("2.description")).toBe("Return a test reply");
  const contents = root.arr("contents");
  expect(contents.length).toBe(5);
  const searchCall = contents[1]!;
  expect(searchCall.str("role")).toBe("model");
  expect(searchCall.str("parts.0.functionCall.name")).toBe("tool_search");
  expect(searchCall.str("parts.0.functionCall.id")).toBe("search_1");
  expect(searchCall.str("parts.0.functionCall.args.query")).toBe("fixture tools");
  expect(searchCall.int("parts.0.functionCall.args.limit")).toBe(1);
  const searchOutput = contents[2]!;
  expect(searchOutput.str("role")).toBe("user");
  expect(searchOutput.str("parts.0.functionResponse.name")).toBe("tool_search");
  expect(searchOutput.str("parts.0.functionResponse.id")).toBe("search_1");
  const result = J.parse(searchOutput.str("parts.0.functionResponse.response.result"));
  expect(result.str("status")).toBe("completed");
  expect(result.str("tools.0")).toBe("fixture_tools__ping");
  expect(result.arr("tools").length).toBe(1);
  expect(contents[3]!.str("parts.0.functionCall.name")).toBe("fixture_tools__ping");
  expect(contents[4]!.str("parts.0.functionResponse.name")).toBe("fixture_tools__ping");
});

test("TestConvertGeminiResponseToOpenAIResponses_ToolSearchCallStream", () => {
  const events = streamEvents(model, toolSearchFixtureRequest, "", [
    `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":{"query":"fixture tools","limit":2}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.8-flash-high","responseId":"resp_tool_search"}`,
    `data: [DONE]`,
  ]);
  let added = new J(undefined);
  let done = new J(undefined);
  let completed = new J(undefined);
  for (const { event, data } of events) {
    if (event === "response.output_item.added") added = data;
    if (event === "response.output_item.done") done = data;
    expect(["response.function_call_arguments.delta", "response.function_call_arguments.done"]).not.toContain(event);
    if (event === "response.completed") completed = data;
  }
  expect([added.exists(), done.exists(), completed.exists()]).toEqual([true, true, true]);
  for (const [item, status] of [
    [added.get("item"), "in_progress"],
    [done.get("item"), "completed"],
    [completed.get("response.output.0"), "completed"],
  ] as const) {
    expect(item.str("type")).toBe("tool_search_call");
    expect(item.str("execution")).toBe("client");
    expect(item.str("status")).toBe(status);
    expect(item.exists("name")).toBe(false);
  }
  for (const item of [done.get("item"), completed.get("response.output.0")]) {
    expect(typeof item.get("arguments").v === "object" && !Array.isArray(item.get("arguments").v)).toBe(true);
    expect(item.str("arguments.query")).toBe("fixture tools");
    expect(item.int("arguments.limit")).toBe(2);
  }
  expect(added.str("item.call_id")).not.toBe("");
  expect(added.str("item.call_id")).toBe(done.str("item.call_id"));
  expect(done.str("item.call_id")).toBe(completed.str("response.output.0.call_id"));
});

test("TestConvertGeminiResponseToOpenAIResponsesNonStream_ToolSearchCall", () => {
  const raw = `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":{"query":"fixture tools"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.8-flash-high","responseId":"resp_tool_search_nonstream"}`;
  const item = g(nonStream(model, toolSearchFixtureRequest, "", raw), "output.0");
  expect(item.str("type")).toBe("tool_search_call");
  expect(item.str("execution")).toBe("client");
  expect(item.str("status")).toBe("completed");
  expect(item.str("arguments.query")).toBe("fixture tools");
  expect(item.exists("name")).toBe(false);
});

test("TestConvertOpenAIResponsesRequestToGemini_ToolSearchCallWithStringArgumentsAndEmptyOutput", () => {
  const request = `{
		"model": "gemini-3.8-flash-high",
		"tools": [{"type": "tool_search", "execution": "client"}],
		"input": [
			{"type": "message", "role": "user", "content": "hi"},
			{"type": "tool_search_call", "execution": "client", "call_id": "search_2", "arguments": "{\\"query\\":\\"nothing\\"}"},
			{"type": "tool_search_output", "execution": "client", "call_id": "search_2", "status": "completed", "tools": []}
		]
	}`;
  const contents = J.parse(toGemini(model, request)).arr("contents");
  expect(contents.length).toBe(3);
  expect(contents[1]!.str("parts.0.functionCall.args.query")).toBe("nothing");
  const result = J.parse(contents[2]!.str("parts.0.functionResponse.response.result"));
  expect(result.isArray("tools")).toBe(true);
  expect(result.arr("tools").length).toBe(0);
});

test("TestConvertGeminiResponseToOpenAIResponses_DiscoveredToolCallRestoresNamespace", () => {
  const events = streamEvents(model, toolSearchFixtureRequest, "", [
    `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"fixture_tools__ping","args":{}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.8-flash-high","responseId":"resp_discovered"}`,
    `data: [DONE]`,
  ]);
  const done = events.find((e) => e.event === "response.output_item.done" && e.data.str("item.type") === "function_call")?.data;
  expect(done).toBeDefined();
  expect(done!.str("item.name")).toBe("ping");
  expect(done!.str("item.namespace")).toBe("fixture_tools");
});

test("TestConvertGeminiResponseToOpenAIResponses_UserToolSearchFunctionStaysFunctionCall", () => {
  const request = `{"model":"gemini-3.8-flash-high","tools":[{"type":"function","name":"tool_search","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}]}`;
  const events = streamEvents(model, request, "", [
    `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"tool_search","args":{"query":"x"}}}]},"finishReason":"STOP"}],"responseId":"resp_user_fn"}`,
    `data: [DONE]`,
  ]);
  const doneTypes = events.filter((e) => e.event === "response.output_item.done").map((e) => e.data.str("item.type"));
  expect(doneTypes).toContain("function_call");
  expect(doneTypes).not.toContain("tool_search_call");
});

describe("TestConvertGeminiResponses_SameNamedUserFunctionAndClientToolSearchCoexist", () => {
  const userFn = `{"type":"function","name":"tool_search","description":"User tool.","parameters":{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}}`;
  const clientSearch = `{"type":"tool_search","execution":"client","description":"Search deferred tools.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}`;
  const deferredFn = `{"type":"function","name":"hidden_until_discovered","defer_loading":true,"parameters":{"type":"object","properties":{}}}`;
  for (const c of [
    { name: "user function first", tools: `${userFn},${clientSearch},${deferredFn}` },
    { name: "client tool_search first", tools: `${clientSearch},${userFn},${deferredFn}` },
  ]) {
    test(c.name, () => {
      const request = `{
				"model": "gemini-3.8-flash-high",
				"tools": [${c.tools}],
				"input": [
					{"type": "message", "role": "user", "content": "hi"},
					{"type": "tool_search_call", "execution": "client", "call_id": "search_1", "status": "completed", "arguments": {"query": "ping"}},
					{"type": "tool_search_output", "execution": "client", "call_id": "search_1", "status": "completed", "tools": []},
					{"type": "function_call", "call_id": "user_call_1", "name": "tool_search", "arguments": "{\\"x\\":\\"val\\"}"},
					{"type": "function_call_output", "call_id": "user_call_1", "output": "user_ok"}
				]
			}`;
      const geminiReq = J.parse(toGemini(model, request, true));
      const decls = geminiReq.arr("tools.0.functionDeclarations");
      expect(decls.length).toBe(2);
      const shimGeminiName = decls.map((d) => d.str("name")).find((n) => n !== "tool_search") ?? "";
      expect(shimGeminiName).not.toBe("");
      const contents = geminiReq.arr("contents");
      expect(contents.length).toBe(5);
      expect(contents[1]!.str("parts.0.functionCall.name")).toBe(shimGeminiName);
      expect(contents[2]!.str("parts.0.functionResponse.name")).toBe(shimGeminiName);
      expect(contents[3]!.str("parts.0.functionCall.name")).toBe("tool_search");
      expect(contents[4]!.str("parts.0.functionResponse.name")).toBe("tool_search");
      const chunk = `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"c_shim","name":"${shimGeminiName}","args":{"query":"agents"}}},{"functionCall":{"id":"c_user","name":"tool_search","args":{"x":"abc"}}}]},"finishReason":"STOP"}],"responseId":"resp_coexist"}`;
      const doneItems = streamEvents(model, request, "", [chunk, "data: [DONE]"])
        .filter((e) => e.event === "response.output_item.done")
        .map((e) => e.data.get("item"));
      expect(doneItems.length).toBe(2);
      expect(doneItems[0]!.str("type")).toBe("tool_search_call");
      expect(doneItems[0]!.str("arguments.query")).toBe("agents");
      expect(doneItems[1]!.str("type")).toBe("function_call");
      expect(doneItems[1]!.str("name")).toBe("tool_search");
    });
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_HistoryOnlyWithNamespacedToolSearchChild", () => {
  const request = `{"model":"gemini-3.8-flash-high","stream":true,"tools":[],"input":[
    {"type":"tool_search_call","execution":"client","call_id":"search_1","status":"completed","arguments":{"query":"fixture tools","limit":1}},
    {"type":"tool_search_output","execution":"client","call_id":"search_1","status":"completed","tools":[{"type":"namespace","name":"fixture_tools","tools":[{"type":"function","name":"tool_search","description":"Namespaced child named tool_search","parameters":{"type":"object","properties":{},"additionalProperties":false}}]}]}]}`;
  const root = J.parse(toGemini(model, request, true));
  expect(root.str("tools.0.functionDeclarations.0.name")).toBe("fixture_tools__tool_search");
  const contents = root.arr("contents");
  expect(contents.length).toBe(2);
  expect(contents[0]!.str("parts.0.functionCall.name")).toBe("tool_search");
  expect(contents[1]!.str("parts.0.functionResponse.name")).toBe("tool_search");
});

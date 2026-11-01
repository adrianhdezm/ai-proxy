// Ported from: internal/translator/openai/openai/responses/openai_openai-responses_response_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { capResponsesChatToolName } from "../../../../../src/translator/openai/openai/responses/index.ts";
import { type Event, Stream, arr, get, has, int, nonStream, q, str } from "./helpers.ts";

const gpt54Request = `{"model":"gpt-5.4","tool_choice":"auto","parallel_tool_calls":true}`;

function runStream(request: string, lines: string[], model = "model"): Event[] {
  const s = new Stream(request, request, model);
  return s.feedAll(lines);
}
const validJSON = (raw: string) => {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
};

describe("ResponseCompletedWaitsForDone", () => {
  const tests = [
    {
      name: "late usage after finish reason",
      in: [
        `data: {"id":"resp_late_usage","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_late_usage","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
        `data: {"id":"resp_late_usage","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\\\\\\\README.md\\"}"}}]},"finish_reason":"tool_calls"}]}`,
        `data: {"id":"resp_late_usage","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
        `data: [DONE]`,
      ],
      doneInputIndex: 3,
      usage: [11, 7, 18],
    },
    {
      name: "usage on finish reason chunk",
      in: [
        `data: {"id":"resp_usage_same_chunk","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_usage_same_chunk","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
        `data: {"id":"resp_usage_same_chunk","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\\\\\\\README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":13,"completion_tokens":5,"total_tokens":18}}`,
        `data: [DONE]`,
      ],
      doneInputIndex: 2,
      usage: [13, 5, 18],
    },
    {
      name: "no finish reason",
      in: [`data: {"id":"resp_no_finish_reason","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}`, `data: [DONE]`],
      doneInputIndex: 1,
      usage: undefined,
    },
    {
      name: "no usage chunk",
      in: [
        `data: {"id":"resp_no_usage","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_no_usage","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
        `data: {"id":"resp_no_usage","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\\\\\\\README.md\\"}"}}]},"finish_reason":"tool_calls"}]}`,
        `data: [DONE]`,
      ],
      doneInputIndex: 2,
      usage: undefined,
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const s = new Stream(gpt54Request, gpt54Request);
      let completedCount = 0;
      let completedInputIndex = -1;
      let created: unknown;
      let inProgress: unknown;
      let completed: unknown;
      tt.in.forEach((line, i) => {
        for (const { event, data } of s.feed(line)) {
          if (event === "response.created") created = data;
          else if (event === "response.in_progress") inProgress = data;
          else if (event === "response.completed") {
            completedCount++;
            completedInputIndex = i;
            completed = data;
            expect(i).toBeGreaterThanOrEqual(tt.doneInputIndex);
          }
        }
      });
      expect(completedCount).toBe(1);
      expect(completedInputIndex).toBe(tt.doneInputIndex);
      expect(str(created, "response.model")).toBe("gpt-5.4");
      expect(str(inProgress, "response.model")).toBe("gpt-5.4");
      if (!tt.usage) {
        expect(has(completed, "response.usage")).toBe(false);
        return;
      }
      expect(int(completed, "response.usage.input_tokens")).toBe(tt.usage[0]!);
      expect(int(completed, "response.usage.output_tokens")).toBe(tt.usage[1]!);
      expect(int(completed, "response.usage.total_tokens")).toBe(tt.usage[2]!);
    });
  }
});

describe("FinalizesOpenMessageAtStreamEnd", () => {
  const request = `{"model":"gpt-5.4"}`;
  for (const tt of [
    { name: "missing finish reason", chunk: `data: {"id":"resp_missing_finish_reason","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}` },
    {
      name: "null finish reason",
      chunk: `data: {"id":"resp_null_finish_reason","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}`,
    },
  ]) {
    test(tt.name, () => {
      const events = runStream(request, [tt.chunk, `data: [DONE]`]);
      expect(events.map((e) => e.event)).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);
      const by = (name: string) => events.find((e) => e.event === name)!.data;
      expect(str(by("response.output_text.done"), "text")).toBe("hello");
      expect(str(by("response.content_part.done"), "part.text")).toBe("hello");
      expect(str(by("response.output_item.done"), "item.content.0.text")).toBe("hello");
      expect(str(by("response.completed"), "response.status")).toBe("completed");
    });
  }
});

test("MultipleToolCallsRemainSeparate", () => {
  const events = runStream(gpt54Request, [
    `data: {"id":"resp_test","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_test","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\",\\"limit\\":400,\\"offset\\":1}"}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_test","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":1,"id":"call_glob","type":"function","function":{"name":"glob","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_test","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":1,"function":{"arguments":"{\\"path\\":\\"C:\\\\\\\\repo\\",\\"pattern\\":\\"*.{yml,yaml}\\"}"}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_test","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":10,"total_tokens":20,"prompt_tokens":10}}`,
    `data: [DONE]`,
  ]);
  const addedNames: Record<string, string> = {};
  const doneArgs: Record<string, string> = {};
  const doneNames: Record<string, string> = {};
  const outputItems: Record<string, unknown> = {};
  for (const { event, data } of events) {
    if (event === "response.output_item.added" && str(data, "item.type") === "function_call") addedNames[str(data, "item.call_id")] = str(data, "item.name");
    if (event === "response.output_item.done" && str(data, "item.type") === "function_call") {
      doneArgs[str(data, "item.call_id")] = str(data, "item.arguments");
      doneNames[str(data, "item.call_id")] = str(data, "item.name");
    }
    if (event === "response.completed") for (const item of arr(data, "response.output")) if (str(item, "type") === "function_call") outputItems[str(item, "call_id")] = item;
  }
  expect(addedNames).toEqual({ call_read: "read", call_glob: "glob" });
  expect(Object.keys(doneArgs).length).toBe(2);
  for (const id of ["call_read", "call_glob"]) {
    expect(validJSON(doneArgs[id]!)).toBe(true);
    expect(doneArgs[id]!.includes("}{")).toBe(false);
  }
  expect(doneNames).toEqual({ call_read: "read", call_glob: "glob" });
  expect(str(JSON.parse(doneArgs.call_read!), "filePath")).toBe("C:\\repo");
  expect(str(JSON.parse(doneArgs.call_glob!), "path")).toBe("C:\\repo");
  expect(str(JSON.parse(doneArgs.call_glob!), "pattern")).toBe("*.{yml,yaml}");
  expect(Object.keys(outputItems).length).toBe(2);
  expect(str(outputItems.call_read, "name")).toBe("read");
  expect(str(outputItems.call_glob, "name")).toBe("glob");
});

test("MultiChoiceToolCallsUseDistinctOutputIndexes", () => {
  const events = runStream(gpt54Request, [
    `data: {"id":"resp_multi_choice","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_choice0","type":"function","function":{"name":"glob","arguments":""}}]},"finish_reason":null},{"index":1,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_choice1","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_multi_choice","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"C:\\\\\\\\repo\\",\\"pattern\\":\\"*.go\\"}"}}]},"finish_reason":null},{"index":1,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\\\\\\\README.md\\",\\"limit\\":20,\\"offset\\":1}"}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_multi_choice","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"tool_calls"},{"index":1,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":10,"total_tokens":20,"prompt_tokens":10}}`,
    `data: [DONE]`,
  ]);
  const added: Record<string, { index: number; name: string }> = {};
  const done: Record<string, { index: number; name: string; args: string }> = {};
  for (const { event, data } of events) {
    if (str(data, "item.type") !== "function_call") continue;
    if (event === "response.output_item.added") added[str(data, "item.call_id")] = { index: int(data, "output_index"), name: str(data, "item.name") };
    if (event === "response.output_item.done") done[str(data, "item.call_id")] = { index: int(data, "output_index"), name: str(data, "item.name"), args: str(data, "item.arguments") };
  }
  expect(Object.keys(added).length).toBe(2);
  expect(Object.keys(done).length).toBe(2);
  expect(added.call_choice0!.name).toBe("glob");
  expect(added.call_choice1!.name).toBe("read");
  expect(added.call_choice0!.index).not.toBe(added.call_choice1!.index);
  expect(validJSON(done.call_choice0!.args)).toBe(true);
  expect(validJSON(done.call_choice1!.args)).toBe(true);
  expect(done.call_choice0!.index).not.toBe(done.call_choice1!.index);
  expect(done.call_choice0!.name).toBe("glob");
  expect(done.call_choice1!.name).toBe("read");
});

test("MixedMessageAndToolUseDistinctOutputIndexes", () => {
  const events = runStream(gpt54Request, [
    `data: {"id":"resp_mixed","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello","reasoning_content":null,"tool_calls":null},"finish_reason":null},{"index":1,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_choice1","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_mixed","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"stop"},{"index":1,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\\\\\\\README.md\\",\\"limit\\":20,\\"offset\\":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":10,"total_tokens":20,"prompt_tokens":10}}`,
    `data: [DONE]`,
  ]);
  let messageOutputIndex = -1;
  let toolOutputIndex = -1;
  for (const { event, data } of events) {
    if (event !== "response.output_item.added") continue;
    if (str(data, "item.type") === "message" && str(data, "item.id") === "msg_resp_mixed_0") messageOutputIndex = int(data, "output_index");
    if (str(data, "item.type") === "function_call" && str(data, "item.call_id") === "call_choice1") toolOutputIndex = int(data, "output_index");
  }
  expect(messageOutputIndex).toBeGreaterThanOrEqual(0);
  expect(toolOutputIndex).toBeGreaterThanOrEqual(0);
  expect(messageOutputIndex).not.toBe(toolOutputIndex);
});

function completedOf(events: Event[]): unknown {
  return events.find((e) => e.event === "response.completed")?.data;
}

test("CompletedOmitsTopLevelOutputText", () => {
  const events = runStream(`{"model":"gpt-5.4"}`, [
    `data: {"id":"resp_output_text","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello ","reasoning_content":null,"tool_calls":null},"finish_reason":null}]}`,
    `data: {"id":"resp_output_text","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":"world","reasoning_content":null,"tool_calls":null},"finish_reason":"stop"}],"usage":{"completion_tokens":2,"total_tokens":4,"prompt_tokens":2}}`,
    `data: [DONE]`,
  ]);
  const completed = completedOf(events);
  expect(completed).toBeDefined();
  expect(has(completed, "response.output_text")).toBe(false);
  expect(str(completed, "response.output.0.content.0.text")).toBe("hello world");
});

test("ToolCallCompletedOmitsTopLevelOutputText", () => {
  const events = runStream(gpt54Request, [
    `data: {"id":"resp_tool_output_text","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"I will call the weather tool.","reasoning_content":null,"tool_calls":null},"finish_reason":null}]}`,
    `data: {"id":"resp_tool_output_text","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_tool_output_text","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":\\"北京\\",\\"unit\\":\\"celsius\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":10,"total_tokens":20,"prompt_tokens":10}}`,
    `data: [DONE]`,
  ]);
  const completed = completedOf(events);
  expect(has(completed, "response.output_text")).toBe(false);
  expect(str(completed, "response.output.0.content.0.text")).toBe("I will call the weather tool.");
  expect(str(completed, "response.output.1.arguments")).toContain("北京");
});

test("FunctionCallDoneAndCompletedOutputStayAscending", () => {
  const events = runStream(gpt54Request, [
    `data: {"id":"resp_order","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_glob","type":"function","function":{"name":"glob","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_order","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"C:\\\\\\\\repo\\",\\"pattern\\":\\"*.go\\"}"}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_order","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":1,"id":"call_read","type":"function","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_order","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":[{"index":1,"function":{"arguments":"{\\"filePath\\":\\"C:\\\\\\\\repo\\\\\\\\README.md\\",\\"limit\\":20,\\"offset\\":1}"}}]},"finish_reason":null}]}`,
    `data: {"id":"resp_order","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"role":null,"content":null,"reasoning_content":null,"tool_calls":null},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":10,"total_tokens":20,"prompt_tokens":10}}`,
    `data: [DONE]`,
  ]);
  const doneIndexes = events.filter((e) => e.event === "response.output_item.done" && str(e.data, "item.type") === "function_call").map((e) => int(e.data, "output_index"));
  expect(doneIndexes.length).toBe(2);
  expect(doneIndexes[0]!).toBeLessThan(doneIndexes[1]!);
  const completedOrder = arr(completedOf(events), "response.output")
    .filter((i) => str(i, "type") === "function_call")
    .map((i) => str(i, "call_id"));
  expect(completedOrder).toEqual(["call_glob", "call_read"]);
});

test("NonStream_OmitsTopLevelOutputText", () => {
  const request = `{"model":"gpt-5.4"}`;
  const raw = `{"id":"chatcmpl_output_text","object":"chat.completion","created":1773896263,"model":"model","choices":[{"index":0,"message":{"role":"assistant","content":"ping"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}`;
  const resp = nonStream(request, request, raw);
  expect(has(resp, "output_text")).toBe(false);
  expect(str(resp, "output.0.content.0.text")).toBe("ping");
});

function functionCallEvents(events: Event[]): { added: unknown; done: unknown; completed: unknown } {
  let added: unknown;
  let done: unknown;
  for (const { event, data } of events) {
    if (event === "response.output_item.added" && str(data, "item.type") === "function_call") added = data;
    if (event === "response.output_item.done" && str(data, "item.type") === "function_call") done = data;
  }
  return { added, done, completed: completedOf(events) };
}

function expectIdentity(events: Event[], name: string, namespace: string): void {
  const { added, done, completed } = functionCallEvents(events);
  for (const got of [added, done]) {
    expect(got).toBeDefined();
    expect(str(got, "item.name")).toBe(name);
    expect(str(got, "item.namespace")).toBe(namespace);
  }
  expect(completed).toBeDefined();
  expect(str(completed, "response.output.0.name")).toBe(name);
  expect(str(completed, "response.output.0.namespace")).toBe(namespace);
}

const testMcpRequest = `{"model":"deepseek-v4-flash","tools":[{"type":"namespace","name":"mcp__test_mcp__","tools":[{"type":"function","name":"add_numbers","parameters":{"type":"object","properties":{}}}]}]}`;

test("RestoresNamespaceFunctionCall", () => {
  const s = new Stream(testMcpRequest, "");
  const events = s.feedAll([
    `data: {"id":"chatcmpl_namespace_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ns","type":"function","function":{"name":"mcp__test_mcp__add_numbers","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl_namespace_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":3,\\"b\\":5}"}}]},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
  ]);
  expectIdentity(events, "add_numbers", "mcp__test_mcp__");
});

test("NonStream_RestoresNamespaceFunctionCall", () => {
  const raw = `{"id":"chatcmpl_namespace_nonstream","object":"chat.completion","created":1773896263,"model":"model","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_ns","type":"function","function":{"name":"mcp__test_mcp__add_numbers","arguments":"{\\"a\\":3,\\"b\\":5}"}}]},"finish_reason":"tool_calls"}]}`;
  const resp = nonStream(testMcpRequest, "", raw);
  expect(str(resp, "output.0.name")).toBe("add_numbers");
  expect(str(resp, "output.0.namespace")).toBe("mcp__test_mcp__");
});

const cappedRequest = `{"model":"deepseek-v4-flash","tools":[{"type":"namespace","name":"mcp__codex_apps__codex_document_control","tools":[{"type":"function","name":"_execute_document_command","parameters":{"type":"object"}}]}]}`;
const cappedChatName = capResponsesChatToolName("mcp__codex_apps__codex_document_control___execute_document_command");

test("RestoresCappedNamespaceFunctionCall", () => {
  const s = new Stream(cappedRequest, "");
  const events = s.feedAll([
    `data: {"id":"chatcmpl_capped_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_capped","type":"function","function":{"name":"${cappedChatName}","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl_capped_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"run\\"}"}}]},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
  ]);
  expectIdentity(events, "_execute_document_command", "mcp__codex_apps__codex_document_control");
});

test("NonStream_RestoresCappedNamespaceFunctionCall", () => {
  const raw = `{"id":"chatcmpl_capped_nonstream","object":"chat.completion","created":1773896263,"model":"model","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_capped","type":"function","function":{"name":"${cappedChatName}","arguments":"{\\"cmd\\":\\"run\\"}"}}]},"finish_reason":"tool_calls"}]}`;
  const resp = nonStream(cappedRequest, "", raw);
  expect(str(resp, "output.0.name")).toBe("_execute_document_command");
  expect(str(resp, "output.0.namespace")).toBe("mcp__codex_apps__codex_document_control");
});

test("CustomToolNameArrivesLate", () => {
  const s = new Stream(`{"model":"gpt-5.4","tools":[{"type":"custom","name":"exec"}]}`, "");
  let added: unknown;
  let inputDone: unknown;
  let itemDone: unknown;
  let completed: unknown;
  for (const { event, data } of s.feedAll([
    `data: {"id":"chatcmpl_custom_late_name","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_exec","type":"function","function":{"arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl_custom_late_name","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"exec","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl_custom_late_name","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"input\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
  ])) {
    if (event === "response.output_item.added" && str(data, "item.call_id") === "call_exec") added = data;
    else if (event === "response.custom_tool_call_input.done") inputDone = data;
    else if (event === "response.output_item.done" && str(data, "item.call_id") === "call_exec") itemDone = data;
    else if (event === "response.completed") completed = data;
    expect(event.startsWith("response.function_call_arguments.")).toBe(false);
  }
  for (const [got, path] of [
    [added, "item"],
    [itemDone, "item"],
    [completed, "response.output.0"],
  ] as const) {
    expect(got).toBeDefined();
    expect(str(got, path + ".type")).toBe("custom_tool_call");
    expect(str(got, path + ".id")).toBe("ctc_call_exec");
    expect(str(got, path + ".name")).toBe("exec");
  }
  expect(str(inputDone, "item_id")).toBe("ctc_call_exec");
  expect(str(inputDone, "input")).toBe("pwd");
});

test("CustomToolNameAndIDAreMissing", () => {
  const s = new Stream(`{"model":"gpt-5.4","tools":[{"type":"custom","name":"exec"}]}`, "");
  let added: unknown;
  let done: unknown;
  let completed: unknown;
  for (const { event, data } of s.feedAll([
    `data: {"id":"chatcmpl_custom_missing_fields","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"{\\"input\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
  ])) {
    if (event === "response.output_item.added") added = data;
    else if (event === "response.output_item.done") done = data;
    else if (event === "response.completed") completed = data;
  }
  const wantCallID = "call_chatcmpl_custom_missing_fields_0_0";
  for (const [got, path] of [
    [added, "item"],
    [done, "item"],
    [completed, "response.output.0"],
  ] as const) {
    expect(str(got, path + ".type")).toBe("custom_tool_call");
    expect(str(got, path + ".id")).toBe("ctc_" + wantCallID);
    expect(str(got, path + ".call_id")).toBe(wantCallID);
    expect(str(got, path + ".name")).toBe("exec");
  }
});

describe("ToolCallIDMayArriveLateOrBeMissing", () => {
  for (const tt of [
    {
      name: "late id",
      chunks: [
        `data: {"id":"chatcmpl_late_id","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"read","arguments":"{\\"file"}}]},"finish_reason":null}]}`,
        `data: {"id":"chatcmpl_late_id","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"Path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}`,
      ],
      wantCallID: "call_late",
    },
    {
      name: "missing id",
      chunks: [
        `data: {"id":"chatcmpl_missing_id","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}`,
      ],
      wantCallID: "call_chatcmpl_missing_id_0_0",
    },
  ]) {
    test(tt.name, () => {
      const events = new Stream("", "").feedAll([...tt.chunks, `data: [DONE]`]);
      const by = (name: string) => events.find((e) => e.event === name)?.data;
      const wantItemID = "fc_" + tt.wantCallID;
      expect(str(by("response.output_item.added"), "item.id")).toBe(wantItemID);
      expect(str(by("response.output_item.added"), "item.call_id")).toBe(tt.wantCallID);
      expect(str(by("response.function_call_arguments.delta"), "item_id")).toBe(wantItemID);
      expect(str(by("response.function_call_arguments.delta"), "delta")).toBe(`{"filePath":"README.md"}`);
      expect(str(by("response.function_call_arguments.done"), "item_id")).toBe(wantItemID);
      expect(str(by("response.output_item.done"), "item.id")).toBe(wantItemID);
    });
  }
});

const additionalNamespaceRequest = `{"model":"gpt-5.4","input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"collaboration","tools":[{"type":"function","name":"send_message","parameters":{"type":"object","properties":{}}}]}]}]}`;
const additionalCustomRequest = `{"model":"gpt-5.4","input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}]}]}`;

function lastByEvent(events: Event[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { event, data } of events) out[event] = data;
  return out;
}

test("RestoresAdditionalNamespaceFunctionCall", () => {
  const by = lastByEvent(
    new Stream(additionalNamespaceRequest, "").feedAll([
      `data: {"id":"chatcmpl_additional_namespace_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_send","type":"function","function":{"name":"collaboration__send_message","arguments":""}}]},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_additional_namespace_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"target\\":\\"worker\\",\\"message\\":\\"ping\\"}"}}]},"finish_reason":"tool_calls"}]}`,
      `data: [DONE]`,
    ]),
  );
  for (const [got, path] of [
    [by["response.output_item.added"], "item"],
    [by["response.output_item.done"], "item"],
    [by["response.completed"], "response.output.0"],
  ] as const) {
    expect(str(got, path + ".name")).toBe("send_message");
    expect(str(got, path + ".namespace")).toBe("collaboration");
  }
});

test("NonStream_RestoresAdditionalNamespaceFunctionCall", () => {
  const raw = `{"id":"chatcmpl_additional_namespace_nonstream","object":"chat.completion","created":1773896263,"model":"model","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_send","type":"function","function":{"name":"collaboration__send_message","arguments":"{\\"target\\":\\"worker\\",\\"message\\":\\"ping\\"}"}}]},"finish_reason":"tool_calls"}]}`;
  const resp = nonStream(additionalNamespaceRequest, "", raw);
  expect(str(resp, "output.0.name")).toBe("send_message");
  expect(str(resp, "output.0.namespace")).toBe("collaboration");
});

test("RestoresAdditionalNamespaceCustomToolCall", () => {
  const events = new Stream(additionalCustomRequest, "").feedAll([
    `data: {"id":"chatcmpl_additional_namespace_custom_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_exec","type":"function","function":{"name":"functions__exec","arguments":""}}]},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl_additional_namespace_custom_stream","object":"chat.completion.chunk","created":1773896263,"model":"model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"input\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
  ]);
  for (const e of events) expect(e.event.startsWith("response.function_call_arguments.")).toBe(false);
  const by = lastByEvent(events);
  for (const [got, path] of [
    [by["response.output_item.added"], "item"],
    [by["response.output_item.done"], "item"],
    [by["response.completed"], "response.output.0"],
  ] as const) {
    expect(got).toBeDefined();
    expect(str(got, path + ".type")).toBe("custom_tool_call");
    expect(str(got, path + ".name")).toBe("exec");
    expect(str(got, path + ".namespace")).toBe("functions");
  }
  expect(str(by["response.custom_tool_call_input.done"], "input")).toBe("pwd");
  expect(str(by["response.output_item.done"], "item.input")).toBe("pwd");
  expect(str(by["response.completed"], "response.output.0.input")).toBe("pwd");
});

test("NonStream_RestoresAdditionalNamespaceCustomToolCall", () => {
  const raw = `{"id":"chatcmpl_additional_namespace_custom_nonstream","object":"chat.completion","created":1773896263,"model":"model","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_exec","type":"function","function":{"name":"functions__exec","arguments":"{\\"input\\":\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}`;
  const resp = nonStream(additionalCustomRequest, "", raw);
  expect(str(resp, "output.0.type")).toBe("custom_tool_call");
  expect(str(resp, "output.0.name")).toBe("exec");
  expect(str(resp, "output.0.namespace")).toBe("functions");
  expect(str(resp, "output.0.input")).toBe("pwd");
});

test("DoesNotCompleteReasoningOnlyStream", () => {
  const events = runStream(
    `{"model":"deepseek-v4-flash"}`,
    [
      `data: {"id":"resp_reasoning_only","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"still thinking"},"finish_reason":null}]}`,
      `data: [DONE]`,
    ],
    "deepseek-v4-flash",
  );
  expect(events.some((e) => e.event === "response.reasoning_summary_text.delta")).toBe(true);
  expect(events.some((e) => e.event === "response.completed")).toBe(false);
});

describe("IncompleteToolStreamDoesNotFinalizeAsCompleted", () => {
  for (const tt of [
    {
      name: "zero argument bytes without finish reason",
      chunks: [
        `data: {"id":"resp_interrupted_tool","object":"chat.completion.chunk","created":1773896263,"model":"gpt-5.6-terra","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":""}}]},"finish_reason":null}]}`,
        `data: [DONE]`,
      ],
    },
    {
      name: "partial json arguments without finish reason",
      chunks: [
        `data: {"id":"resp_interrupted_partial","object":"chat.completion.chunk","created":1773896263,"model":"gpt-5.6-terra","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":"{\\"filePath\\":\\"foo"}}]},"finish_reason":null}]}`,
        `data: [DONE]`,
      ],
    },
  ]) {
    test(tt.name, () => {
      for (const { event } of runStream(`{"model":"gpt-5.6-terra"}`, tt.chunks, "gpt-5.6-terra")) {
        expect(["response.completed", "response.output_item.done", "response.function_call_arguments.done"].includes(event)).toBe(false);
      }
    });
  }
});

describe("FinishReasonEmitsIncomplete", () => {
  for (const [reason, wantReason] of [
    ["length", "max_output_tokens"],
    ["content_filter", "content_filter"],
  ]) {
    test(reason!, () => {
      const id = reason === "length" ? "resp_length_tool" : "resp_filter_tool";
      const events = runStream(
        `{"model":"gpt-5.6-luna"}`,
        [
          `data: {"id":"${id}","object":"chat.completion.chunk","created":1773896263,"model":"gpt-5.6-luna","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"apply_patch","arguments":""}}]},"finish_reason":null}]}`,
          `data: {"id":"${id}","object":"chat.completion.chunk","created":1773896263,"model":"gpt-5.6-luna","choices":[{"index":0,"delta":{},"finish_reason":"${reason}"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
          `data: [DONE]`,
        ],
        "gpt-5.6-luna",
      );
      let incompleteSeen = false;
      let itemDoneSeen = false;
      for (const { event, data } of events) {
        expect(event).not.toBe("response.completed");
        if (event === "response.output_item.done") {
          itemDoneSeen = true;
          expect(str(data, "item.status")).toBe("incomplete");
          if (reason === "length") expect(str(data, "item.arguments")).not.toBe("{}");
        }
        if (event === "response.incomplete") {
          incompleteSeen = true;
          expect(str(data, "response.status")).toBe("incomplete");
          expect(str(data, "response.incomplete_details.reason")).toBe(wantReason!);
          if (reason === "length") expect(str(data, "response.output.0.status")).toBe("incomplete");
        }
      }
      expect(itemDoneSeen).toBe(true);
      expect(incompleteSeen).toBe(true);
    });
  }
});

describe("NonStream_FinishReasonIncomplete", () => {
  for (const [reason, id, text, wantReason] of [
    ["length", "chatcmpl_len", "truncated text", "max_output_tokens"],
    ["content_filter", "chatcmpl_filter", "blocked text", "content_filter"],
  ]) {
    test(reason!, () => {
      const raw = `{"id":"${id}","object":"chat.completion","created":1773896263,"model":"gpt-5.6","choices":[{"index":0,"message":{"role":"assistant","content":"${text}"},"finish_reason":"${reason}"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`;
      const out = nonStream("", "", raw, {}, "gpt-5.6");
      expect(str(out, "status")).toBe("incomplete");
      expect(str(out, "incomplete_details.reason")).toBe(wantReason!);
      expect(str(out, "output.0.status")).toBe("incomplete");
    });
  }
});

describe("NonStream_ReasoningFallback", () => {
  for (const tt of [
    {
      name: "reasoning_content field present",
      rawJSON: `{"id":"chatcmpl_rc","object":"chat.completion","created":1773896263,"model":"o3-mini","choices":[{"index":0,"message":{"role":"assistant","content":"hello","reasoning_content":"thought from reasoning_content"},"finish_reason":"stop"}]}`,
      requestJSON: "",
      wantReasoning: true,
      wantText: "thought from reasoning_content",
    },
    {
      name: "reasoning fallback field present",
      rawJSON: `{"id":"chatcmpl_r","object":"chat.completion","created":1773896263,"model":"o3-mini","choices":[{"index":0,"message":{"role":"assistant","content":"hello","reasoning":"thought from reasoning"},"finish_reason":"stop"}]}`,
      requestJSON: "",
      wantReasoning: true,
      wantText: "thought from reasoning",
    },
    {
      name: "both reasoning_content and reasoning present (reasoning_content priority)",
      rawJSON: `{"id":"chatcmpl_both","object":"chat.completion","created":1773896263,"model":"o3-mini","choices":[{"index":0,"message":{"role":"assistant","content":"hello","reasoning_content":"priority thought","reasoning":"ignored thought"},"finish_reason":"stop"}]}`,
      requestJSON: "",
      wantReasoning: true,
      wantText: "priority thought",
    },
    {
      name: "empty reasoning_content falls back to reasoning",
      rawJSON: `{"id":"chatcmpl_empty_rc","object":"chat.completion","created":1773896263,"model":"o3-mini","choices":[{"index":0,"message":{"role":"assistant","content":"hello","reasoning_content":"","reasoning":"fallback thought"},"finish_reason":"stop"}]}`,
      requestJSON: "",
      wantReasoning: true,
      wantText: "fallback thought",
    },
    {
      name: "neither field present without request reasoning",
      rawJSON: `{"id":"chatcmpl_none","object":"chat.completion","created":1773896263,"model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}`,
      requestJSON: "",
      wantReasoning: false,
      wantText: "",
    },
    {
      name: "neither field present with request reasoning produces empty summary",
      rawJSON: `{"id":"chatcmpl_req_only","object":"chat.completion","created":1773896263,"model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}`,
      requestJSON: `{"model":"gpt-4o","reasoning":{"effort":"medium"}}`,
      wantReasoning: true,
      wantText: "",
    },
  ]) {
    test(tt.name, () => {
      const out = nonStream(tt.requestJSON, tt.requestJSON, tt.rawJSON, {}, "o3-mini");
      const reasoningItem = arr(out, "output").find((item) => str(item, "type") === "reasoning");
      expect(reasoningItem !== undefined).toBe(tt.wantReasoning);
      if (!tt.wantReasoning) return;
      if (tt.wantText !== "") {
        expect(str(reasoningItem, "summary.0.text")).toBe(tt.wantText);
        expect(str(reasoningItem, "summary.0.type")).toBe("summary_text");
      } else {
        expect(arr(reasoningItem, "summary").length).toBe(0);
      }
    });
  }
});

test("EmptyToolCallsArrayDoesNotTerminateItems", () => {
  const events = runStream(
    `{"model":"codebuddy-hy4"}`,
    [
      `data: {"id":"chatcmpl_empty_tc","object":"chat.completion.chunk","created":1773896263,"model":"codebuddy-hy4","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"Thinking part 1, ","function_call":null,"refusal":"","tool_calls":[]},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_empty_tc","object":"chat.completion.chunk","created":1773896263,"model":"codebuddy-hy4","choices":[{"index":0,"delta":{"content":"","reasoning_content":"thinking part 2.","function_call":null,"refusal":"","tool_calls":[]},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_empty_tc","object":"chat.completion.chunk","created":1773896263,"model":"codebuddy-hy4","choices":[{"index":0,"delta":{"content":"Hello ","reasoning_content":"","function_call":null,"refusal":"","tool_calls":[]},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_empty_tc","object":"chat.completion.chunk","created":1773896263,"model":"codebuddy-hy4","choices":[{"index":0,"delta":{"content":"world!","reasoning_content":"","function_call":null,"refusal":"","tool_calls":[]},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ],
    "codebuddy-hy4",
  );
  const count = (event: string, type: string) => events.filter((e) => e.event === event && str(e.data, "item.type") === type);
  expect(count("response.output_item.added", "reasoning").length).toBe(1);
  expect(count("response.output_item.done", "reasoning").length).toBe(1);
  expect(str(count("response.output_item.done", "reasoning")[0]!.data, "item.summary.0.text")).toBe("Thinking part 1, thinking part 2.");
  expect(count("response.output_item.added", "message").length).toBe(1);
  expect(count("response.output_item.done", "message").length).toBe(1);
  expect(str(count("response.output_item.done", "message")[0]!.data, "item.content.0.text")).toBe("Hello world!");
  const completed = events.filter((e) => e.event === "response.completed");
  expect(completed.length).toBe(1);
  expect(str(completed[0]!.data, "response.output.0.summary.0.text")).toBe("Thinking part 1, thinking part 2.");
  expect(str(completed[0]!.data, "response.output.1.content.0.text")).toBe("Hello world!");
});

function itemOrder(events: Event[]): string[] {
  return events
    .filter((e) => e.event === "response.output_item.added" || e.event === "response.output_item.done")
    .map((e) => `${e.event === "response.output_item.added" ? "added" : "done"}:${str(e.data, "item.type")}:${int(e.data, "output_index")}`);
}

test("ChunkWithContentAndReasoningContent", () => {
  const events = runStream(
    `{"model":"deepseek-v4-flash"}`,
    [
      `data: {"id":"chatcmpl_ds","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Thinking part 1,"},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_ds","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"Bien","reasoning_content":" Just professional."},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_ds","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":" continues here."},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ],
    "deepseek-v4-flash",
  );
  expect(itemOrder(events)).toEqual(["added:reasoning:0", "done:reasoning:0", "added:message:1", "done:message:1"]);
  const doneOf = (type: string) => events.find((e) => e.event === "response.output_item.done" && str(e.data, "item.type") === type)!.data;
  expect(str(doneOf("reasoning"), "item.summary.0.text")).toBe("Thinking part 1, Just professional.");
  expect(str(doneOf("message"), "item.content.0.text")).toBe("Bien continues here.");
  const addedIDs = events.filter((e) => e.event === "response.output_item.added").map((e) => str(e.data, "item.id"));
  expect(addedIDs.length).toBe(2);
  expect(addedIDs[0]).not.toBe(addedIDs[1]);
  const completed = events.filter((e) => e.event === "response.completed");
  expect(completed.length).toBe(1);
  expect(str(completed[0]!.data, "response.output.0.summary.0.text")).toBe("Thinking part 1, Just professional.");
  expect(str(completed[0]!.data, "response.output.1.content.0.text")).toBe("Bien continues here.");
});

test("SingleChunkWithBothContentAndReasoningContent", () => {
  const events = runStream(
    `{"model":"deepseek-v4-flash"}`,
    [
      `data: {"id":"chatcmpl_single","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"Answer","reasoning_content":"Thought"},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ],
    "deepseek-v4-flash",
  );
  expect(itemOrder(events)).toEqual(["added:reasoning:0", "done:reasoning:0", "added:message:1", "done:message:1"]);
  const completed = completedOf(events);
  expect(str(completed, "response.output.0.summary.0.text")).toBe("Thought");
  expect(str(completed, "response.output.1.content.0.text")).toBe("Answer");
});

// --- apply_patch over Chat Completions ---

const applyPatchChatStart = (index: number, id: string, name: string) =>
  `data: {"id":"r1","choices":[{"index":0,"delta":{"tool_calls":[{"index":${index},"id":${q(id)},"type":"function","function":{"name":${q(name)},"arguments":""}}]}}]}`;
const applyPatchChatFragment = (index: number, fragment: string) => `data: {"id":"r1","choices":[{"index":0,"delta":{"tool_calls":[{"index":${index},"function":{"arguments":${q(fragment)}}}]}}]}`;
const applyPatchChatEnd = () => [`data: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`, `data: [DONE]`];
const applyPatchChatRequest = `{"tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: patch"}}]}`;

/** Feeds chunks with the original request only (Go passed nil as the translated request). */
function patchStream(request = applyPatchChatRequest): { s: Stream; feed: (chunk: string) => unknown[] } {
  const s = new Stream(request, "", "test");
  return { s, feed: (chunk: string) => s.feed(chunk).map((e) => e.data) };
}
const toolInputError = (s: Stream) => (s.state.value as { toolInputError(): Error | undefined }).toolInputError();

test("ApplyPatchChatPreviewBeforeDone", () => {
  const { feed } = patchStream();
  feed(applyPatchChatStart(0, "c1", "apply_patch"));
  const preview = feed(applyPatchChatFragment(0, `{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n`));
  expect(preview.length).toBe(1);
  expect(str(preview[0], "type")).toBe("response.custom_tool_call_input.delta");
  expect(str(preview[0], "delta")).toBe("*** Begin Patch\n*** Add File: a.txt\n+hello\n");
  expect(str(preview[0], "call_id")).toBe("c1");
  expect(str(preview[0], "item_id")).toBe("ctc_c1");
  const events = [...preview, ...feed(applyPatchChatFragment(0, `*** End Patch"}`)), ...applyPatchChatEnd().flatMap(feed)];
  const want = "*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch";
  let deltas = "";
  let seenDone = false;
  let seenItem = false;
  let seenCompleted = false;
  let lastSequence = 0;
  for (const event of events) {
    const sequence = int(event, "sequence_number");
    expect(sequence).toBeGreaterThan(lastSequence);
    lastSequence = sequence;
    switch (str(event, "type")) {
      case "response.custom_tool_call_input.delta":
        deltas += str(event, "delta");
        break;
      case "response.custom_tool_call_input.done":
        seenDone = true;
        expect(deltas).toBe(want);
        expect(str(event, "input")).toBe(want);
        expect(str(event, "call_id")).toBe("c1");
        break;
      case "response.output_item.done":
        seenItem = true;
        expect(seenDone).toBe(true);
        expect(str(event, "item.input")).toBe(want);
        break;
      case "response.completed":
        seenCompleted = true;
        expect(seenItem).toBe(true);
        expect(str(event, "response.output.0.input")).toBe(want);
        break;
    }
  }
  expect(seenDone && seenItem && seenCompleted).toBe(true);
});

test("ApplyPatchChatLateIdentityAndInterleavedCalls", () => {
  const { feed } = patchStream();
  feed(applyPatchChatStart(0, "", ""));
  for (const event of feed(applyPatchChatFragment(0, `{"input":"first\\n`))) {
    expect(str(event, "type").includes("arguments.delta") || str(event, "type") === "response.custom_tool_call_input.delta").toBe(false);
  }
  const events = [
    ...feed(applyPatchChatStart(0, "c1", "apply_patch")),
    ...feed(applyPatchChatStart(1, "c2", "apply_patch")),
    ...feed(applyPatchChatFragment(1, `{"input":"second`)),
    ...feed(applyPatchChatFragment(0, `tail"}`)),
    ...feed(applyPatchChatFragment(1, ` tail"}`)),
    ...applyPatchChatEnd().flatMap(feed),
  ];
  const inputs: Record<string, string> = {};
  const indices: Record<string, number> = {};
  const done: Record<string, string> = {};
  for (const event of events) {
    switch (str(event, "type")) {
      case "response.custom_tool_call_input.delta":
        inputs[str(event, "call_id")] = (inputs[str(event, "call_id")] ?? "") + str(event, "delta");
        indices[str(event, "call_id")] = int(event, "output_index");
        break;
      case "response.custom_tool_call_input.done":
        done[str(event, "call_id")] = str(event, "input");
        break;
      case "response.failed":
        throw new Error(`interleaved calls failed: ${JSON.stringify(event)}`);
    }
  }
  expect(inputs.c1).toBe("first\ntail");
  expect(inputs.c2).toBe("second tail");
  expect(done.c1).toBe(inputs.c1!);
  expect(done.c2).toBe(inputs.c2!);
  expect(indices.c1).not.toBe(indices.c2);
});

describe("ApplyPatchChatInvalidArgumentsFailOnce", () => {
  for (const args of [`plain patch`, `{}`, `{"input":42}`, `{"input":"x","extra":1}`, `{"input":"x","input":"y"}`, `{"input":"x"} {}`, `{"input":"unfinished`, `{"input":"bad\\q"}`, `{"input":"\\ud800"}`]) {
    test(args, () => {
      const { s, feed } = patchStream();
      const events = [
        ...feed(applyPatchChatStart(0, "c1", "apply_patch")),
        ...feed(applyPatchChatFragment(0, args)),
        ...applyPatchChatEnd().flatMap(feed),
        ...applyPatchChatEnd().flatMap(feed),
      ];
      let failureCount = 0;
      for (const event of events) {
        const type = str(event, "type");
        if (type === "response.failed") {
          failureCount++;
          expect(str(event, "response.error.code")).toBe("invalid_tool_arguments");
        }
        expect(["response.completed", "response.incomplete", "response.custom_tool_call_input.done", "response.output_item.done"].includes(type)).toBe(false);
      }
      expect(failureCount).toBe(1);
      expect(toolInputError(s)).toBeDefined();
    });
  }
});

describe("ApplyPatchChatWinnerAndNamespace", () => {
  for (const tc of [
    { name: "function", request: `{"tools":[{"type":"function","name":"apply_patch"}]}`, upstream: "apply_patch", wantType: "function_call", wantName: "apply_patch", namespace: "" },
    {
      name: "function wins",
      request: `{"tools":[{"type":"function","name":"apply_patch"}],"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]}]}`,
      upstream: "apply_patch",
      wantType: "function_call",
      wantName: "apply_patch",
      namespace: "",
    },
    {
      name: "custom wins",
      request: `{"tools":[{"type":"custom","name":"apply_patch"}],"input":[{"type":"additional_tools","tools":[{"type":"function","name":"apply_patch"}]}]}`,
      upstream: "apply_patch",
      wantType: "custom_tool_call",
      wantName: "apply_patch",
      namespace: "",
    },
    {
      name: "namespace",
      request: `{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]}]}`,
      upstream: "editor__apply_patch",
      wantType: "custom_tool_call",
      wantName: "apply_patch",
      namespace: "editor",
    },
    {
      name: "flat collision",
      request: `{"tools":[{"type":"function","name":"editor__apply_patch"},{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]}]}`,
      upstream: "editor__apply_patch",
      wantType: "function_call",
      wantName: "editor__apply_patch",
      namespace: "",
    },
    {
      name: "same source custom first",
      request: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"apply_patch"}]}`,
      upstream: "apply_patch",
      wantType: "custom_tool_call",
      wantName: "apply_patch",
      namespace: "",
    },
    {
      name: "same source function first",
      request: `{"tools":[{"type":"function","name":"apply_patch"},{"type":"custom","name":"apply_patch"}]}`,
      upstream: "apply_patch",
      wantType: "function_call",
      wantName: "apply_patch",
      namespace: "",
    },
    {
      name: "namespace before flat",
      request: `{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch"}]},{"type":"function","name":"editor__apply_patch"}]}`,
      upstream: "editor__apply_patch",
      wantType: "custom_tool_call",
      wantName: "apply_patch",
      namespace: "editor",
    },
    { name: "other custom", request: `{"tools":[{"type":"custom","name":"edit"}]}`, upstream: "edit", wantType: "custom_tool_call", wantName: "edit", namespace: "" },
  ]) {
    test(tc.name, () => {
      const { feed } = patchStream(tc.request);
      feed(applyPatchChatStart(0, "c1", tc.upstream));
      const args = tc.wantType === "function_call" || tc.name === "other custom" ? `{"not_input":42}` : `{"input":"x"}`;
      const events = [...feed(applyPatchChatFragment(0, args)), ...applyPatchChatEnd().flatMap(feed)];
      const item = get(events.find((e) => str(e, "type") === "response.completed"), "response.output.0");
      expect(str(item, "type")).toBe(tc.wantType);
      expect(str(item, "name")).toBe(tc.wantName);
      expect(str(item, "namespace")).toBe(tc.namespace);
      if (tc.wantType === "function_call") expect(str(item, "arguments")).toBe(args);
      if (tc.name === "other custom") expect(str(item, "input")).toBe(args);
    });
  }
});

describe("ApplyPatchChatNonStreamStrictInput", () => {
  for (const tc of [
    { args: `{"input":"*** Begin Patch\\n*** End Patch"}`, want: "*** Begin Patch\n*** End Patch", invalid: false },
    { args: `{"input":12}`, want: "", invalid: true },
    { args: `{"input":"truncated`, want: "", invalid: true },
    { args: `{"input":"x","extra":true}`, want: "", invalid: true },
    { args: `{"input":"\\ud800"}`, want: "", invalid: true },
  ]) {
    test(tc.args, () => {
      const state: { value?: unknown } = {};
      const raw = `{"id":"r1","choices":[{"index":0,"message":{"tool_calls":[{"id":"c1","function":{"name":"apply_patch","arguments":${q(tc.args)}}}]},"finish_reason":"tool_calls"}]}`;
      const result = nonStream(applyPatchChatRequest, "", raw, state, "test");
      if (tc.invalid) {
        expect(str(result, "status")).toBe("failed");
        expect(str(result, "error.code")).toBe("invalid_tool_arguments");
        expect((state.value as { toolInputError(): Error | undefined }).toolInputError()).toBeDefined();
      } else {
        expect(str(result, "output.0.input")).toBe(tc.want);
      }
    });
  }
});

test("ApplyPatchChatTerminalValidatesTruncatedCall", () => {
  const { feed } = patchStream();
  feed(applyPatchChatStart(0, "c1", "apply_patch"));
  feed(applyPatchChatFragment(0, `{"input":"unfinished`));
  const chunks = applyPatchChatEnd();
  const events = feed(chunks[chunks.length - 1]!);
  expect(events.length).toBe(1);
  expect(str(events[0], "type")).toBe("response.failed");
});

test("ApplyPatchChatUnicodeFragments", () => {
  const args = `{"input":"line\\n\\u4f60\\u597d \\ud83d\\ude00 \\" \\\\ \\u96ea"}`;
  for (let split = 1; split < args.length; split++) {
    const { feed } = patchStream();
    feed(applyPatchChatStart(0, "c1", "apply_patch"));
    const events = [...feed(applyPatchChatFragment(0, args.slice(0, split))), ...feed(applyPatchChatFragment(0, args.slice(split))), ...applyPatchChatEnd().flatMap(feed)];
    const input = events
      .filter((e) => str(e, "type") === "response.custom_tool_call_input.delta")
      .map((e) => str(e, "delta"))
      .join("");
    expect(input, `split ${split}`).toBe('line\n你好 😀 " \\ 雪');
  }
});

test("ApplyPatchChatIdentityFieldsArriveSeparately", () => {
  for (const tc of [
    { id: "c1", name: "" },
    { id: "", name: "apply_patch" },
  ]) {
    const { feed } = patchStream();
    feed(applyPatchChatStart(0, tc.id, tc.name));
    expect(feed(applyPatchChatFragment(0, `{"input":"preview`)).length).toBe(0);
    let found = false;
    for (const event of feed(applyPatchChatStart(0, "c1", "apply_patch"))) {
      if (str(event, "type") === "response.custom_tool_call_input.delta") found = str(event, "delta") === "preview" && str(event, "call_id") === "c1";
    }
    expect(found).toBe(true);
  }
});

test("ApplyPatchChatConflictingIdentityFails", () => {
  for (const tc of [
    { id: "other", name: "apply_patch" },
    { id: "c1", name: "other" },
  ]) {
    const { feed } = patchStream();
    feed(applyPatchChatStart(0, "c1", "apply_patch"));
    feed(applyPatchChatFragment(0, `{"input":"preview`));
    const events = [...feed(applyPatchChatStart(0, tc.id, tc.name)), ...applyPatchChatEnd().flatMap(feed)];
    expect(events.length).toBe(1);
    expect(str(events[0], "type")).toBe("response.failed");
  }
});

test("ApplyPatchChatNonStreamOriginalDeclarationWins", () => {
  const raw = `{"id":"r1","choices":[{"index":0,"message":{"tool_calls":[{"id":"c1","function":{"name":"apply_patch","arguments":"{\\"not_input\\":42}"}}]},"finish_reason":"tool_calls"}]}`;
  const result = nonStream(`{"tools":[{"type":"function","name":"apply_patch"}]}`, applyPatchChatRequest, raw, {}, "test");
  expect(str(result, "output.0.type")).toBe("function_call");
  expect(str(result, "output.0.arguments")).toBe(`{"not_input":42}`);
});

test("ApplyPatchChatPendingIdentityConflictFails", () => {
  const { feed } = patchStream();
  feed(applyPatchChatStart(0, "c1", ""));
  feed(applyPatchChatFragment(0, `{"input":"x"}`));
  const events = feed(applyPatchChatStart(0, "c2", "apply_patch"));
  expect(events.length).toBe(1);
  expect(str(events[0], "type")).toBe("response.failed");
});

test("ApplyPatchChatMissingIDSynthesizedAtTerminal", () => {
  const { feed } = patchStream();
  feed(applyPatchChatStart(0, "", "apply_patch"));
  feed(applyPatchChatFragment(0, `{"input":"x"}`));
  const completed = applyPatchChatEnd()
    .flatMap(feed)
    .find((e) => str(e, "type") === "response.completed");
  const item = get(completed, "response.output.0");
  expect(str(item, "type")).toBe("custom_tool_call");
  expect(str(item, "input")).toBe("x");
  expect(str(item, "call_id")).not.toBe("");
});

describe("ApplyPatchChatDeferredIdentityConflict", () => {
  for (const tc of [
    { name: "return to first ID", request: applyPatchChatRequest, resolvedID: "c1", resolvedName: "apply_patch", wantType: "", invalid: true },
    { name: "keep second ID", request: applyPatchChatRequest, resolvedID: "c2", resolvedName: "apply_patch", wantType: "", invalid: true },
    { name: "omit final ID", request: applyPatchChatRequest, resolvedID: "", resolvedName: "apply_patch", wantType: "", invalid: true },
    { name: "infer name at terminal", request: applyPatchChatRequest, resolvedID: "c1", resolvedName: "", wantType: "", invalid: true },
    { name: "ordinary function", request: `{"tools":[{"type":"function","name":"apply_patch"}]}`, resolvedID: "c1", resolvedName: "apply_patch", wantType: "function_call", invalid: false },
    {
      name: "function winner",
      request: `{"tools":[{"type":"function","name":"apply_patch"},{"type":"custom","name":"apply_patch"}]}`,
      resolvedID: "c1",
      resolvedName: "apply_patch",
      wantType: "function_call",
      invalid: false,
    },
    { name: "other custom", request: `{"tools":[{"type":"custom","name":"edit"}]}`, resolvedID: "c1", resolvedName: "edit", wantType: "custom_tool_call", invalid: false },
  ]) {
    test(tc.name, () => {
      const { s, feed } = patchStream(tc.request);
      feed(applyPatchChatStart(0, "c1", ""));
      expect(feed(`data: {"id":"r1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"","arguments":"{\\"input\\":\\"x\\"}"}}]}}]}`).length).toBe(0);
      const events = [...feed(applyPatchChatStart(0, tc.resolvedID, tc.resolvedName)), ...applyPatchChatEnd().flatMap(feed)];
      let failures = 0;
      let completions = 0;
      let item: unknown;
      for (const event of events) {
        const type = str(event, "type");
        if (type === "response.failed") {
          failures++;
          expect(tc.invalid).toBe(true);
          expect(str(event, "response.error.code")).toBe("invalid_tool_arguments");
        } else if (type === "response.completed") {
          completions++;
          item = get(event, "response.output.0");
        } else if (["response.incomplete", "response.custom_tool_call_input.done", "response.output_item.done"].includes(type)) {
          expect(tc.invalid).toBe(false);
        }
      }
      if (tc.invalid) {
        expect(failures).toBe(1);
        expect(completions).toBe(0);
        expect(toolInputError(s)).toBeDefined();
        return;
      }
      expect(completions).toBe(1);
      expect(toolInputError(s)).toBeUndefined();
      expect(str(item, "type")).toBe(tc.wantType);
      expect(str(item, "call_id")).toBe("c1");
      if (tc.wantType === "function_call") expect(str(item, "arguments")).toBe(`{"input":"x"}`);
      if (tc.wantType === "custom_tool_call") expect(str(item, "input")).toBe("x");
    });
  }
});

describe("ApplyPatchChatSuccessfulTerminalSealsState", () => {
  for (const tc of [
    { name: "duplicate DONE", late: `data: [DONE]` },
    { name: "post-terminal fragment", late: applyPatchChatFragment(0, `{"input":"late"}`) },
  ]) {
    test(tc.name, () => {
      const { s, feed } = patchStream();
      feed(applyPatchChatStart(0, "c1", "apply_patch"));
      feed(applyPatchChatFragment(0, `{"input":"x"}`));
      const end = applyPatchChatEnd();
      for (const event of feed(end[0]!)) expect(str(event, "type")).not.toBe("response.completed");
      feed(`data: {"id":"r1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}`);
      const events = feed(end[1]!);
      expect(events.length).toBe(1);
      expect(str(events[0], "type")).toBe("response.completed");
      expect(str(events[0], "response.output.0.input")).toBe("x");
      expect(int(events[0], "response.usage.total_tokens")).toBe(15);
      for (const chunk of [tc.late, end[1]!]) expect(feed(chunk).length).toBe(0);
      expect(toolInputError(s)).toBeUndefined();
    });
  }
});

describe("NonStream_MapsCompletionTokensDetailsReasoningTokens", () => {
  const request = `{"model":"mercury-3"}`;
  for (const tc of [
    { name: "completion_tokens_details.reasoning_tokens", usageJSON: `{"prompt_tokens":9,"completion_tokens":99,"total_tokens":108,"completion_tokens_details":{"reasoning_tokens":60}}`, want: 60 },
    { name: "output_tokens_details.reasoning_tokens", usageJSON: `{"prompt_tokens":9,"completion_tokens":99,"total_tokens":108,"output_tokens_details":{"reasoning_tokens":45}}`, want: 45 },
  ]) {
    test(tc.name, () => {
      const raw = `{"id":"chatcmpl_reasoning","object":"chat.completion","created":1773896263,"model":"mercury-3","choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":${tc.usageJSON}}`;
      const resp = nonStream(request, request, raw, {}, "mercury-3");
      expect(has(resp, "usage.output_tokens_details.reasoning_tokens")).toBe(true);
      expect(int(resp, "usage.output_tokens_details.reasoning_tokens")).toBe(tc.want);
    });
  }
});

test("finalizeToolInput fails an apply_patch stream that ended without [DONE]", () => {
  const { s, feed } = patchStream();
  feed(applyPatchChatStart(0, "c1", "apply_patch"));
  feed(applyPatchChatFragment(0, `{"input":"x`));
  const state = s.state.value as { canFinalizeResponseStream(): boolean; finalizeToolInput(): string[] };
  expect(state.canFinalizeResponseStream()).toBe(false);
  const frames = state.finalizeToolInput();
  expect(frames.length).toBe(1);
  expect(frames[0]!.startsWith("event: response.failed\n")).toBe(true);
  expect(toolInputError(s)).toBeDefined();
});

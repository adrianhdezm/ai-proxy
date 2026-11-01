// Ported from: internal/translator/openai/openai/responses/shell_tool_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import {
  convertOpenAIChatCompletionsResponseToOpenAIResponses,
  convertOpenAIResponsesRequestToOpenAIChatCompletions,
} from "../../../../../src/translator/openai/openai/responses/index.ts";
import { arr, get, has, nonStream, str } from "./helpers.ts";

test("LocalShellDeclarationSurvivesChatTranslation", () => {
  const got = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", `{"tools":[{"type":"shell","environment":{"type":"local"}}],"tool_choice":"auto","input":"Run echo SHELL_OK"}`, false);
  expect(arr(got, "tools").length).toBe(1);
  expect(str(got, "tools.0.function.parameters.properties.commands.items.type")).toBe("string");
});

const shellRequest = `{"tools":[{"type":"shell","environment":{"type":"local"}},{"type":"function","name":"__cpa_local_shell","parameters":{}},{"type":"custom","name":"__cpa_local_shell_1"},{"type":"namespace","name":"ns","tools":[{"type":"function","name":"lookup","parameters":{}}]}],"tool_choice":{"type":"shell"}}`;

function shellUpstreamCall(name: string | undefined, args: string, id: string | undefined = "call_shell"): Record<string, unknown> {
  const fn: Record<string, unknown> = {};
  if (name !== undefined) fn.name = name;
  fn.arguments = args;
  const call: Record<string, unknown> = { index: 0 };
  if (id !== undefined) call.id = id;
  call.type = "function";
  call.function = fn;
  return call;
}

function shellNonStream(request: string, name: string, args: string): string {
  const upstream = { id: "resp_test", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [shellUpstreamCall(name, args)] } }] };
  return nonStream(request, "", JSON.stringify(upstream));
}

function shellStream(request: string, name: string, args: string): unknown[] {
  const state: TranslatorState = {};
  const events: unknown[] = [];
  const push = (chunk: string) => {
    for (const output of convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, "test", request, "", chunk, state)) {
      for (const line of output.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
    }
  };
  const half = Math.floor(args.length / 2);
  [args.slice(0, half), args.slice(half)].forEach((fragment, i) => {
    const call = i === 1 ? shellUpstreamCall(undefined, fragment, undefined) : shellUpstreamCall(name, fragment);
    push("data: " + JSON.stringify({ id: "resp_test", choices: [{ index: 0, delta: { tool_calls: [call] } }] }));
  });
  push(`data: {"id":"resp_test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`);
  push("data: [DONE]");
  return events;
}

test("LocalShellRoundTrip", () => {
  const chat = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", shellRequest, false);
  const name = str(chat, "tools.0.function.name");
  expect(name).not.toBe("");
  expect(name).not.toBe("__cpa_local_shell");
  expect(name).not.toBe("__cpa_local_shell_1");
  expect(arr(chat, "tools").length).toBe(4);
  expect(str(chat, "tool_choice.function.name")).toBe(name);

  const args = `{"commands":["echo SHELL_OK","pwd"],"timeout_ms":120000,"max_output_length":4096}`;
  const nonstream = shellNonStream(shellRequest, name, args);
  const item = get(nonstream, "output.0");
  expect(str(item, "type")).toBe("shell_call");
  expect(str(item, "action.commands.0")).toBe("echo SHELL_OK");
  expect(str(item, "status")).toBe("completed");
  expect(has(item, "name")).toBe(false);
  expect(has(item, "arguments")).toBe(false);

  let done: unknown;
  let completed: unknown;
  for (const event of shellStream(shellRequest, name, args)) {
    switch (str(event, "type")) {
      case "response.output_item.added":
        expect(str(event, "item.type")).toBe("shell_call");
        break;
      case "response.output_item.done":
        done = get(event, "item");
        break;
      case "response.completed":
        completed = get(event, "response.output.0");
        break;
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        throw new Error(`shell leaked function event: ${JSON.stringify(event)}`);
    }
  }
  expect(done).toEqual(item);
  expect(completed).toEqual(item);

  const output = `{"type":"shell_call_output","call_id":"call_shell","max_output_length":4096,"output":[{"stdout":"SHELL_OK\\n","stderr":"warning","outcome":{"type":"exit","exit_code":0}},{"stdout":"partial","stderr":"","outcome":{"type":"timeout"}}]}`;
  const replay = JSON.parse(shellRequest);
  replay.input = JSON.parse(
    "[" + JSON.stringify(item) + `,{"type":"function_call","call_id":"call_user","name":"__cpa_local_shell","arguments":"{}"},` + output + `,{"type":"function_call_output","call_id":"call_user","output":"ok"}]`,
  );
  const replayed = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", JSON.stringify(replay), false);
  expect(arr(replayed, "messages.0.tool_calls").length).toBe(2);
  expect(str(replayed, "messages.0.tool_calls.0.function.name")).toBe(name);
  expect(JSON.parse(str(replayed, "messages.0.tool_calls.0.function.arguments"))).toEqual(JSON.parse(args));
  expect(str(replayed, "messages.1.role")).toBe("tool");
  expect(JSON.parse(str(replayed, "messages.1.content"))).toEqual(JSON.parse(output));

  for (const tc of [
    { name: "__cpa_local_shell", kind: "function_call" },
    { name: "__cpa_local_shell_1", kind: "custom_tool_call" },
    { name: "ns__lookup", kind: "function_call" },
  ]) {
    expect(str(shellNonStream(shellRequest, tc.name, `{"input":"hello"}`), "output.0.type")).toBe(tc.kind);
  }
  expect(str(shellNonStream(`{}`, name, args), "output.0.type")).toBe("function_call");
});

describe("LocalShellInvalidActions", () => {
  const request = `{"tools":[{"type":"shell","environment":{"type":"local"}}]}`;
  for (const args of [
    `{`,
    `{}`,
    `{"commands":[]}`,
    `{"commands":[42]}`,
    `{"commands":[" "]}`,
    `{"command":["echo","ok"]}`,
    `{"commands":["pwd"],"timeout_ms":-1}`,
    `{"commands":["pwd"],"timeout_ms":1.5}`,
    `{"commands":["pwd"],"env":{}}`,
  ]) {
    test(args, () => {
      const got = shellNonStream(request, "__cpa_local_shell", args);
      expect(str(got, "status")).toBe("failed");
      expect(str(got, "error.message")).toContain("shell");
      let failed = false;
      for (const event of shellStream(request, "__cpa_local_shell", args)) {
        const type = str(event, "type");
        if (type === "response.failed") failed = true;
        expect(type === "response.completed" || type === "response.output_item.done").toBe(false);
      }
      expect(failed).toBe(true);
    });
  }
});

test("LocalShellOnlyExplicitLocalEnvironment", () => {
  for (const environment of [`{"type":"container_auto"}`, `{"type":"container_reference","container_id":"cntr_x"}`, `{}`]) {
    const got = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", `{"tools":[{"type":"shell","environment":${environment}}]}`, false);
    expect(arr(got, "tools").length).toBe(0);
  }
  for (const choice of [`"auto"`, `"required"`, `"none"`]) {
    const got = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", `{"tools":[{"type":"shell","environment":{"type":"local"}}],"tool_choice":${choice}}`, false);
    expect(str(got, "tool_choice")).toBe(JSON.parse(choice));
  }
});

test("LocalShellHistoryWithoutDeclaration", () => {
  for (const tools of [``, `,"tools":[]`, `,"tools":[{"type":"function","name":"__cpa_local_shell_1","parameters":{}}]`]) {
    const request = `{"input":[{"type":"shell_call","call_id":"shell_1","action":{"commands":["pwd"]}},{"type":"shell_call_output","call_id":"shell_1","output":[{"stdout":"/workspace","stderr":"","outcome":{"type":"exit","exit_code":0}}]},{"type":"function_call","call_id":"user_1","name":"__cpa_local_shell","arguments":"{}"},{"type":"function_call_output","call_id":"user_1","output":"ok"}]${tools}}`;
    const got = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", request, false);
    const calls = arr(got, "messages.0.tool_calls");
    expect(calls.length).toBe(1);
    expect(str(calls[0], "id")).toBe("shell_1");
    expect(str(got, "messages.2.tool_calls.0.id")).toBe("user_1");
    const name = str(calls[0], "function.name");
    expect(name).not.toBe("__cpa_local_shell");
    if (tools !== "" && tools !== `,"tools":[]`) expect(name).not.toBe("__cpa_local_shell_1");
    expect(str(JSON.parse(str(got, "messages.1.content")), "output.0.stdout")).toBe("/workspace");
    expect(arr(got, "tools").length).toBe(arr(request, "tools").length);
  }
});

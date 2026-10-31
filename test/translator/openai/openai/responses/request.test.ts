// Ported from: internal/translator/openai/openai/responses/openai_openai-responses_request_test.go
// Skipped cases: none (prettyJSONForTest logging is dropped)
import { describe, expect, test } from "bun:test";
import {
  capResponsesChatToolName,
  convertOpenAIResponsesRequestToOpenAIChatCompletions,
  rawResponsesNamespaceQualifiedName,
  responsesChatToolNameLimit,
  mergeResponsesRequestChatTools,
  responsesCustomToolNames,
  responsesSingleCustomToolName,
  splitResponsesQualifiedFunctionCallFromRequest,
} from "../../../../../src/translator/openai/openai/responses/index.ts";
import { arr, convertReq, get, has, int, q, str } from "./helpers.ts";

const len = (out: string, path: string) => arr(out, path).length;

test("MergeConsecutiveFunctionCalls", () => {
  const raw = `{
    "input": [
      {"type":"function_call","call_id":"exec_command:0","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"},
      {"type":"function_call","call_id":"exec_command:1","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"},
      {"type":"function_call_output","call_id":"exec_command:0","output":"ok0"},
      {"type":"function_call_output","call_id":"exec_command:1","output":"ok1"}
    ]
  }`;
  const out = convertReq(raw, "kimi-k2.6", true);
  expect(len(out, "messages")).toBe(3);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(len(out, "messages.0.tool_calls")).toBe(2);
  expect(str(out, "messages.0.tool_calls.0.id")).toBe("exec_command:0");
  expect(str(out, "messages.0.tool_calls.1.id")).toBe("exec_command:1");
  expect(str(out, "messages.1.tool_call_id")).toBe("exec_command:0");
  expect(str(out, "messages.2.tool_call_id")).toBe("exec_command:1");
});

test("SplitFunctionCallsWhenInterrupted", () => {
  const raw = `{"input": [
    {"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
    {"type":"message","role":"user","content":"next"},
    {"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"}
  ]}`;
  const out = convertReq(raw, "kimi-k2.6");
  expect(len(out, "messages")).toBe(3);
  expect(str(out, "messages.0.tool_calls.0.id")).toBe("call_a");
  expect(str(out, "messages.2.tool_calls.0.id")).toBe("call_b");
});

test("DefersMessageUntilToolOutput", () => {
  const raw = `{"input": [
    {"type":"function_call","call_id":"call_x","name":"exec_command","arguments":"{\\"cmd\\":\\"echo hi\\"}"},
    {"type":"message","role":"user","content":"Approved command prefix saved"},
    {"type":"function_call_output","call_id":"call_x","output":"ok"},
    {"type":"message","role":"user","content":"next"}
  ]}`;
  const out = convertReq(raw, "kimi-k2.6", true);
  expect(len(out, "messages")).toBe(4);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(str(out, "messages.1.role")).toBe("tool");
  expect(str(out, "messages.1.tool_call_id")).toBe("call_x");
  expect(str(out, "messages.2.role")).toBe("user");
  expect(str(out, "messages.2.content")).toBe("Approved command prefix saved");
  expect(str(out, "messages.3.content")).toBe("next");
});

describe("UnwrapsStringifiedToolOutputImages", () => {
  const tests = [
    {
      name: "Codex input image",
      output: `[{"type":"input_text","text":"Captured screenshot."},{"detail":"original","image_url":"data:image/png;base64,AA==","type":"input_image"}]`,
      imageIndex: 1,
      expectedURL: "data:image/png;base64,AA==",
      expectedText: "Captured screenshot.",
      detail: "high",
    },
    {
      name: "OpenAI image URL",
      output: `[{"type":"image_url","image_url":{"url":"https://example.com/generated.png","detail":"high"}}]`,
      imageIndex: 0,
      expectedURL: "https://example.com/generated.png",
      expectedText: "",
      detail: "high",
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const raw = `{"input": [
        {"type":"function_call","call_id":"call_image","name":"view_image","arguments":"{}"},
        {"type":"function_call_output","call_id":"call_image","output":${q(tt.output)}}
      ]}`;
      const out = convertReq(raw, "k3");
      const parts = get(out, "messages.1.content") as unknown[];
      expect(Array.isArray(parts)).toBe(true);
      const imagePart = parts[tt.imageIndex];
      expect(str(imagePart, "type")).toBe("image_url");
      expect(str(imagePart, "image_url.url")).toBe(tt.expectedURL);
      expect(str(imagePart, "image_url.detail")).toBe(tt.detail);
      if (tt.expectedText !== "") {
        expect(str(parts[0], "type")).toBe("text");
        expect(str(parts[0], "text")).toBe(tt.expectedText);
      }
    });
  }
});

test("UnwrapsStringifiedCustomToolOutputImages", () => {
  const raw = `{"input": [
    {"type":"custom_tool_call","call_id":"call_image","name":"view_image","input":"{}"},
    {"type":"custom_tool_call_output","call_id":"call_image","output":"[{\\"type\\":\\"input_image\\",\\"image_url\\":\\"data:image/png;base64,AA==\\",\\"detail\\":\\"original\\"}]"}
  ]}`;
  const out = convertReq(raw, "kimi-k3");
  expect(Array.isArray(get(out, "messages.1.content"))).toBe(true);
  expect(str(out, "messages.1.content.0.type")).toBe("image_url");
  expect(str(out, "messages.1.content.0.image_url.url")).toBe("data:image/png;base64,AA==");
  expect(str(out, "messages.1.content.0.image_url.detail")).toBe("high");
});

describe("PreservesCustomToolOutputFallbacks", () => {
  for (const tt of [
    { name: "plain text", output: `"plain output"`, expected: "plain output" },
    { name: "text content array", output: `[{"type":"input_text","text":"done"}]`, expected: "done" },
    { name: "invalid image array", output: `[{"type":"input_image","detail":"low"}]`, expected: "" },
  ]) {
    test(tt.name, () => {
      const raw = `{"input": [
        {"type":"custom_tool_call","call_id":"call_output","name":"inspect","input":"{}"},
        {"type":"custom_tool_call_output","call_id":"call_output","output":${tt.output}}
      ]}`;
      const content = get(convertReq(raw, "kimi-k3"), "messages.1.content");
      expect(content).toBe(tt.expected);
    });
  }
});

test("ConvertsStructuredToolOutputImages", () => {
  const raw = `{"input": [
    {"type":"function_call","call_id":"call_image","name":"view_image","arguments":"{}"},
    {"type":"function_call_output","call_id":"call_image","output":[
      {"type":"input_text","text":"Captured screenshot."},
      {"type":"input_image","image_url":"data:image/png;base64,AA==","detail":"original"}
    ]}
  ]}`;
  const out = convertReq(raw, "k3");
  expect(Array.isArray(get(out, "messages.1.content"))).toBe(true);
  expect(str(out, "messages.1.content.1.type")).toBe("image_url");
  expect(str(out, "messages.1.content.1.image_url.url")).toBe("data:image/png;base64,AA==");
  expect(str(out, "messages.1.content.1.image_url.detail")).toBe("high");
});

describe("KeepsNonImageToolOutputStrings", () => {
  for (const tt of [
    { name: "plain text", output: "plain output" },
    { name: "JSON object", output: `{"status":"ok"}` },
    { name: "text-only array", output: `[{"type":"input_text","text":"still text"}]` },
    { name: "invalid image array", output: `[{"type":"input_image","detail":"low"}]` },
    { name: "image array with trailing text", output: `[{"type":"input_image","image_url":"data:image/png;base64,AA=="}] trailing` },
    { name: "truncated image array", output: `[{"type":"input_image","image_url":"data:image/png;base64,AA=="}` },
    { name: "non-string image URL", output: `[{"type":"input_image","image_url":123}]` },
    { name: "non-string image detail", output: `[{"type":"input_image","image_url":"data:image/png;base64,AA==","detail":123}]` },
    { name: "non-string text in image array", output: `[{"type":"input_text","text":123},{"type":"input_image","image_url":"data:image/png;base64,AA=="}]` },
  ]) {
    test(tt.name, () => {
      const raw = `{"input": [
        {"type":"function_call","call_id":"call_output","name":"inspect","arguments":"{}"},
        {"type":"function_call_output","call_id":"call_output","output":${q(tt.output)}}
      ]}`;
      expect(get(convertReq(raw, "k3"), "messages.1.content")).toBe(tt.output);
    });
  }
});

test("AttachesReasoningToAssistantMessage", () => {
  const raw = `{"input": [
    {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "first line\\n"}, {"type": "summary_text", "text": "second line"}]},
    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "answer"}]},
    {"type": "message", "role": "user", "content": "next"}
  ]}`;
  const out = convertReq(raw, "deepseek-v4-flash");
  expect(len(out, "messages")).toBe(2);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(str(out, "messages.0.reasoning_content")).toBe("first line\nsecond line");
  expect(str(out, "messages.0.content.0.text")).toBe("answer");
  expect(str(out, "messages.1.role")).toBe("user");
});

test("PreservesAssistantContentWithToolCalls", () => {
  const raw = `{"input": [
    {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "inspect the next step"}]},
    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Step 3 completed; continue to step 4."}]},
    {"type":"function_call","call_id":"call_4","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"},
    {"type":"function_call_output","call_id":"call_4","output":"ok"}
  ]}`;
  const out = convertReq(raw, "kimi-k3");
  expect(len(out, "messages")).toBe(2);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(str(out, "messages.0.reasoning_content")).toBe("inspect the next step");
  expect(str(out, "messages.0.content.0.text")).toBe("Step 3 completed; continue to step 4.");
  expect(str(out, "messages.0.tool_calls.0.id")).toBe("call_4");
  expect(str(out, "messages.1.tool_call_id")).toBe("call_4");
});

test("DoesNotMergeToolCallsAcrossUserMessage", () => {
  const raw = `{"input": [
    {"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]},
    {"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]},
    {"type":"function_call","call_id":"call_next","name":"exec_command","arguments":"{}"},
    {"type":"function_call_output","call_id":"call_next","output":"ok"}
  ]}`;
  const out = convertReq(raw, "kimi-k3");
  expect(len(out, "messages")).toBe(4);
  expect(has(out, "messages.0.tool_calls")).toBe(false);
  expect(str(out, "messages.1.role")).toBe("user");
  expect(str(out, "messages.2.tool_calls.0.id")).toBe("call_next");
});

test("MergesDistinctReasoningWithinAssistantTurn", () => {
  const raw = `{"input": [
    {"type":"reasoning","summary":[{"type":"summary_text","text":"first"}]},
    {"type":"message","role":"assistant","reasoning_content":"first","content":[{"type":"output_text","text":"working"}]},
    {"type":"reasoning","summary":[{"type":"summary_text","text":"second"}]},
    {"type":"function_call","call_id":"call_reasoning","name":"exec_command","arguments":"{}"}
  ]}`;
  const out = convertReq(raw, "kimi-k3");
  expect(len(out, "messages")).toBe(1);
  expect(str(out, "messages.0.reasoning_content")).toBe("first\n\nsecond");
  expect(str(out, "messages.0.tool_calls.0.id")).toBe("call_reasoning");
});

test("ReplacesUnavailableReasoningWithinAssistantTurn", () => {
  const raw = `{"input": [
    {"type":"reasoning","summary":[]},
    {"type":"message","role":"assistant","reasoning_content":"real reasoning","content":[{"type":"output_text","text":"working"}]},
    {"type":"function_call","call_id":"call_real_reasoning","name":"exec_command","arguments":"{}"}
  ]}`;
  const out = convertReq(raw, "kimi-k3");
  expect(len(out, "messages")).toBe(1);
  expect(str(out, "messages.0.reasoning_content")).toBe("real reasoning");
});

test("AttachesReasoningToToolCallMessage", () => {
  const raw = `{"input": [
    {"type": "reasoning", "id": "rs_tool", "summary": [{"type": "summary_text", "text": "tool reasoning"}]},
    {"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}"},
    {"type":"function_call_output","call_id":"call_1","output":"ok"}
  ]}`;
  const out = convertReq(raw, "deepseek-v4-flash", true);
  expect(len(out, "messages")).toBe(2);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(str(out, "messages.0.reasoning_content")).toBe("tool reasoning");
  expect(str(out, "messages.0.tool_calls.0.id")).toBe("call_1");
  expect(str(out, "messages.1.role")).toBe("tool");
});

test("KeepsReasoningBeforeUserMessage", () => {
  const out = convertReq(`{"input": [{"type": "reasoning", "id": "rs_empty", "summary": []}, {"type": "message", "role": "user", "content": "continue"}]}`, "deepseek-v4-flash");
  expect(len(out, "messages")).toBe(2);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(str(out, "messages.0.reasoning_content")).toBe("[reasoning unavailable]");
  expect(str(out, "messages.1.role")).toBe("user");
});

test("PreservesReasoningOnFollowUpToolTurns", () => {
  const raw = `{
    "model": "deepseek-v4.1-flash",
    "reasoning": {"effort": "high"},
    "input": [
      {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "first plan"}]},
      {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "starting"}]},
      {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\\"cmd\\":\\"ls\\"}"},
      {"type": "function_call_output", "call_id": "call_1", "output": "ok"},
      {"type": "function_call", "call_id": "call_2", "name": "write_stdin", "arguments": "{\\"data\\":\\"x\\"}"},
      {"type": "function_call_output", "call_id": "call_2", "output": "ok"},
      {"type": "reasoning", "id": "rs_2", "summary": [{"type": "summary_text", "text": "second plan"}]},
      {"type": "function_call", "call_id": "call_3", "name": "exec_command", "arguments": "{\\"cmd\\":\\"pwd\\"}"},
      {"type": "function_call_output", "call_id": "call_3", "output": "ok"},
      {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "apply_patch is available"}]},
      {"type": "function_call", "call_id": "call_4", "name": "exec_command", "arguments": "{\\"cmd\\":\\"cat\\"}"},
      {"type": "function_call_output", "call_id": "call_4", "output": "ok"}
    ]
  }`;
  const out = convertReq(raw, "deepseek-v4.1-flash", true);
  const messages = arr(out, "messages");
  expect(messages.length).toBe(8);
  messages.forEach((msg) => {
    if (str(msg, "role") === "assistant" && arr(msg, "tool_calls").length > 0) expect(str(msg, "reasoning_content")).not.toBe("");
  });
  expect(str(messages[2], "tool_calls.0.id")).toBe("call_2");
  expect(str(messages[2], "reasoning_content")).toBe("first plan");
  expect(str(messages[6], "tool_calls.0.id")).toBe("call_4");
  expect(str(messages[6], "reasoning_content")).toBe("second plan");
});

test("FallsBackToPlaceholderWhenNoPriorReasoning", () => {
  const raw = `{"model": "deepseek-v4.1-flash", "reasoning": {"effort": "high"}, "input": [
    {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\\"cmd\\":\\"ls\\"}"},
    {"type": "function_call_output", "call_id": "call_1", "output": "ok"}
  ]}`;
  const out = convertReq(raw, "deepseek-v4.1-flash");
  expect(len(out, "messages")).toBe(2);
  expect(str(out, "messages.0.reasoning_content")).toBe("[reasoning unavailable]");
});

test("EffortNoneDoesNotInjectReasoning", () => {
  const raw = `{"model": "gpt-4o", "reasoning": {"effort": "none"}, "input": [
    {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{}"},
    {"type": "function_call_output", "call_id": "call_1", "output": "ok"}
  ]}`;
  const out = convertReq(raw, "gpt-4o");
  expect(len(out, "messages")).toBe(2);
  expect(has(out, "messages.0.reasoning_content")).toBe(false);
});

test("PreservesReasoningOnCustomToolCallTurns", () => {
  const raw = `{"model": "deepseek-v4.1-flash", "reasoning": {"effort": "high"}, "input": [
    {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "custom plan"}]},
    {"type": "custom_tool_call", "call_id": "cust_1", "name": "do_work", "input": "step1"},
    {"type": "custom_tool_call_output", "call_id": "cust_1", "output": "done"},
    {"type": "custom_tool_call", "call_id": "cust_2", "name": "do_work", "input": "step2"},
    {"type": "custom_tool_call_output", "call_id": "cust_2", "output": "done"}
  ]}`;
  const out = convertReq(raw, "deepseek-v4.1-flash");
  expect(len(out, "messages")).toBe(4);
  expect(str(out, "messages.0.reasoning_content")).toBe("custom plan");
  expect(str(out, "messages.2.reasoning_content")).toBe("custom plan");
});

test("ResetsReasoningAcrossUserMessageBoundary", () => {
  const raw = `{"model": "deepseek-v4.1-flash", "reasoning": {"effort": "high"}, "input": [
    {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "turn 1 plan"}]},
    {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{}"},
    {"type": "function_call_output", "call_id": "call_1", "output": "ok"},
    {"type": "message", "role": "user", "content": "now do step 2"},
    {"type": "function_call", "call_id": "call_2", "name": "exec_command", "arguments": "{}"},
    {"type": "function_call_output", "call_id": "call_2", "output": "ok"}
  ]}`;
  const out = convertReq(raw, "deepseek-v4.1-flash");
  expect(len(out, "messages")).toBe(5);
  expect(str(out, "messages.0.reasoning_content")).toBe("turn 1 plan");
  expect(str(out, "messages.3.reasoning_content")).toBe("[reasoning unavailable]");
});

test("FlattensNamespaceTools", () => {
  const raw = `{
    "input": [{"role":"user","content":"Use add_numbers."}],
    "tools": [{
      "type": "namespace", "name": "mcp__test_mcp__", "description": "Tools in the mcp__test_mcp__ namespace.",
      "tools": [{"type": "function", "name": "add_numbers", "description": "Add two numbers",
        "parameters": {"type": "object", "properties": {"a": { "type": "number" }, "b": { "type": "number" }}, "required": ["a", "b"]}}]
    }],
    "tool_choice": "auto"
  }`;
  const out = convertReq(raw, "deepseek-v4-flash");
  expect(len(out, "tools")).toBe(1);
  expect(str(out, "tools.0.type")).toBe("function");
  expect(str(out, "tools.0.function.name")).toBe("mcp__test_mcp__add_numbers");
  expect(str(out, "tools.0.function.description")).toBe("Add two numbers");
  expect(str(out, "tools.0.function.parameters.required.0")).toBe("a");
});

test("QualifiesNamespaceFunctionCallHistory", () => {
  const raw = `{
    "input": [
      {"type":"function_call","call_id":"call_get_me","name":"get_me","namespace":"mcp__github","arguments":"{}"},
      {"type":"function_call_output","call_id":"call_get_me","output":"ok"}
    ],
    "tools": [{"type":"namespace","name":"mcp__github","tools":[{"type":"function","name":"get_me","parameters":{"type":"object"}}]}]
  }`;
  const out = convertReq(raw, "deepseek-v4-flash");
  expect(str(out, "messages.0.tool_calls.0.function.name")).toBe("mcp__github__get_me");
  expect(str(out, "tools.0.function.name")).toBe("mcp__github__get_me");
});

describe("FlattensNamespaceCustomTools", () => {
  const tests = [
    { name: "top-level tools", raw: `{"tools":[{"type":"namespace","name":"terminal","tools":[{"type":"custom","name":"exec","description":"Run a command"}]}]}` },
    {
      name: "additional tools",
      raw: `{"input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"terminal","tools":[{"type":"custom","name":"exec","description":"Run a command"}]}]}]}`,
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const out = convertReq(tt.raw, "gpt-5.4");
      expect(len(out, "tools")).toBe(1);
      expect(str(out, "tools.0.function.name")).toBe("terminal__exec");
      expect(str(out, "tools.0.function.description")).toBe("Run a command");
      expect(str(out, "tools.0.function.parameters.type")).toBe("object");
      expect(str(out, "tools.0.function.parameters.properties.input.type")).toBe("string");
      expect(str(out, "tools.0.function.parameters.required.0")).toBe("input");
    });
  }
});

test("PreservesStructuredToolChoice", () => {
  const raw = `{"input": [{"role":"user","content":"Run command."}], "tools": [{"type": "function", "name": "run_command", "parameters": {"type": "object"}}], "tool_choice": {"type": "function", "function": {"name": "run_command"}}}`;
  const out = convertReq(raw, "gpt-5.4");
  expect(str(out, "tool_choice.type")).toBe("function");
  expect(str(out, "tool_choice.function.name")).toBe("run_command");
});

test("ConvertsCanonicalResponsesNamedToolChoice", () => {
  const raw = `{
    "model": "gpt-5.4",
    "input": [{"role": "user", "content": "Call gateway_echo with value TOOL_OK."}],
    "tools": [{"type": "function", "name": "gateway_echo", "description": "Returns the given value",
      "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": false}}],
    "tool_choice": {"type": "function", "name": "gateway_echo"},
    "max_output_tokens": 512
  }`;
  const out = convertReq(raw, "gpt-5.4");
  expect(str(out, "tool_choice.type")).toBe("function");
  expect(str(out, "tool_choice.function.name")).toBe("gateway_echo");
  expect(has(out, "tool_choice.name")).toBe(false);
});

test("ConvertsNamespaceAndCustomToolChoice", () => {
  const nsTools = `[{"type": "namespace", "name": "service_tools", "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}]}]`;
  const outNamespace = convertReq(`{"model": "gpt-5.4", "input": "test", "tools": ${nsTools}, "tool_choice": {"type": "function", "name": "lookup"}}`, "gpt-5.4");
  expect(str(outNamespace, "tool_choice.type")).toBe("function");
  expect(str(outNamespace, "tool_choice.function.name")).toBe("service_tools__lookup");
  expect(str(outNamespace, "tools.0.function.name")).toBe(str(outNamespace, "tool_choice.function.name"));
  expect(has(outNamespace, "tool_choice.name")).toBe(false);

  const outExplicit = convertReq(`{"model": "gpt-5.4", "input": "test", "tools": ${nsTools}, "tool_choice": {"type": "function", "name": "lookup", "namespace": "service_tools"}}`, "gpt-5.4");
  expect(str(outExplicit, "tool_choice.function.name")).toBe("service_tools__lookup");
  expect(has(outExplicit, "tool_choice.namespace")).toBe(false);
  expect(has(outExplicit, "tool_choice.name")).toBe(false);

  const outCustom = convertReq(
    `{"model": "gpt-5.4", "input": "test", "tools": [{"type": "custom", "name": "patch_runner", "description": "Applies diff"}], "tool_choice": {"type": "custom", "name": "patch_runner"}}`,
    "gpt-5.4",
  );
  expect(str(outCustom, "tool_choice.type")).toBe("function");
  expect(str(outCustom, "tool_choice.function.name")).toBe("patch_runner");

  for (const scalar of [`"auto"`, `"none"`, `"required"`]) {
    const out = convertReq(`{"model": "gpt-5.4", "input": "test", "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}], "tool_choice": ${scalar}}`, "gpt-5.4");
    expect(get(out, "tool_choice")).toBe(JSON.parse(scalar));
  }
});

describe("OmitsToolSettingsWithoutTools", () => {
  for (const tt of [
    { name: "empty tools", raw: `{"input": [{"role":"user","content":"say ok"}], "tools": [], "tool_choice": "auto", "parallel_tool_calls": false}` },
    { name: "unconvertible tools", raw: `{"tools": [{"type":"unsupported"}], "tool_choice": "auto", "parallel_tool_calls": false}` },
  ]) {
    test(tt.name, () => {
      const out = convertReq(tt.raw, "grok-4.5");
      for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) expect(has(out, field)).toBe(false);
    });
  }
});

test("PreservesParallelToolCallsWithTools", () => {
  const out = convertReq(`{"tools": [{"type": "function", "name": "run_command", "parameters": {"type": "object"}}], "parallel_tool_calls": false}`, "grok-4.5");
  expect(get(out, "parallel_tool_calls")).toBe(false);
});

test("PreservesJSONSchemaTextFormat", () => {
  const raw = `{"text": {"format": {"type": "json_schema", "name": "answer", "description": "Structured answer", "strict": true,
    "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": false}}}}`;
  const out = convertReq(raw, "deepseek-v4-flash");
  expect(str(out, "response_format.type")).toBe("json_schema");
  expect(str(out, "response_format.json_schema.name")).toBe("answer");
  expect(str(out, "response_format.json_schema.description")).toBe("Structured answer");
  expect(get(out, "response_format.json_schema.strict")).toBe(true);
  expect(str(out, "response_format.json_schema.schema.properties.ok.type")).toBe("boolean");
  expect(str(out, "response_format.json_schema.schema.required.0")).toBe("ok");
  expect(get(out, "response_format.json_schema.schema.additionalProperties")).toBe(false);
});

test("PreservesJSONObjectTextFormat", () => {
  const out = convertReq(`{"text":{"format":{"type":"json_object"}}}`, "deepseek-v4-flash");
  expect(str(out, "response_format.type")).toBe("json_object");
  expect(has(out, "response_format.json_schema")).toBe(false);
});

test("OmitsResponseFormatWithoutTextFormat", () => {
  expect(has(convertReq(`{"input":"Return plain text."}`, "deepseek-v4-flash"), "response_format")).toBe(false);
});

describe("NormalizesInputImageDetail", () => {
  for (const tt of [
    { name: "standard high", detailJSON: `"high"`, expectedDetail: "high" },
    { name: "Codex original", detailJSON: `"original"`, expectedDetail: "high" },
    { name: "unsupported value", detailJSON: `"medium"`, expectedDetail: "" },
    { name: "non-string value", detailJSON: `123`, expectedDetail: "" },
  ]) {
    test(tt.name, () => {
      const out = convertReq(`{"input": [{"role": "user", "content": [{"type": "input_image", "image_url": "https://example.com/image.png", "detail": ${tt.detailJSON}}]}]}`, "gpt-5.4");
      expect(str(out, "messages.0.content.0.image_url.url")).toBe("https://example.com/image.png");
      if (tt.expectedDetail === "") expect(has(out, "messages.0.content.0.image_url.detail")).toBe(false);
      else expect(str(out, "messages.0.content.0.image_url.detail")).toBe(tt.expectedDetail);
    });
  }
});

test("DeduplicatesToolsAcrossAdditionalTools", () => {
  const raw = `{
    "input": [
      {"role":"user","content":"What time is it?"},
      {"type":"additional_tools","tools":[{"type":"function","name":"get_time","description":"copy from additional_tools","parameters":{"type":"object","properties":{"tz":{"type":"string"}}}}]}
    ],
    "tools": [{"type":"function","name":"get_time","description":"authoritative top-level definition","parameters":{"type":"object","properties":{"timezone":{"type":"string"}}}}]
  }`;
  const out = convertReq(raw, "deepseek-v4-flash");
  expect(len(out, "tools")).toBe(1);
  expect(str(out, "tools.0.function.name")).toBe("get_time");
  expect(str(out, "tools.0.function.description")).toBe("authoritative top-level definition");
  expect(str(out, "tools.0.function.parameters.properties.timezone.type")).toBe("string");
});

test("DeduplicatesNamespaceQualifiedCollision", () => {
  const raw = `{"input": [{"role":"user","content":"Patch the file."}], "tools": [
    {"type":"function","name":"editor__apply_patch","parameters":{"type":"object"}},
    {"type":"namespace","name":"editor","tools":[{"type":"function","name":"apply_patch","parameters":{"type":"object"}}]}
  ]}`;
  const out = convertReq(raw, "deepseek-v4-flash");
  expect(len(out, "tools")).toBe(1);
  expect(str(out, "tools.0.function.name")).toBe("editor__apply_patch");
});

test("KeepsDistinctToolsFromBothSources", () => {
  const raw = `{
    "input": [
      {"role":"user","content":"Do the thing."},
      {"type":"additional_tools","tools":[{"type":"function","name":"get_date","parameters":{"type":"object"}},{"type":"function","name":"get_time","parameters":{"type":"object"}}]}
    ],
    "tools": [{"type":"function","name":"get_time","parameters":{"type":"object"}},{"type":"function","name":"get_weather","parameters":{"type":"object"}}]
  }`;
  const out = convertReq(raw, "deepseek-v4-flash");
  const want = ["get_time", "get_weather", "get_date"];
  expect(len(out, "tools")).toBe(want.length);
  want.forEach((name, i) => expect(str(out, `tools.${i}.function.name`)).toBe(name));
});

test("ResponsesSingleCustomToolName_CountsDeduplicatedTools", () => {
  const raw = `{"input": [{"role":"user","content":"Patch the file."}, {"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch","description":"copy"}]}],
    "tools": [{"type":"custom","name":"apply_patch","description":"authoritative"}]}`;
  expect(responsesSingleCustomToolName(raw)).toEqual(["apply_patch", true]);
});

describe("SplitResponsesQualifiedFunctionCallFromRequest_FirstDeclarationWins", () => {
  const flatFirst = `{"tools": [{"type":"function","name":"editor__apply_patch","parameters":{"type":"object"}}, {"type":"namespace","name":"editor","tools":[{"type":"function","name":"apply_patch","parameters":{"type":"object"}}]}]}`;
  const namespaceFirst = `{"tools": [{"type":"namespace","name":"editor","tools":[{"type":"function","name":"apply_patch","parameters":{"type":"object"}}]}, {"type":"function","name":"editor__apply_patch","parameters":{"type":"object"}}]}`;
  const namespaceOnly = `{"tools": [{"type":"namespace","name":"mcp__github","tools":[{"type":"function","name":"get_me","parameters":{"type":"object"}}]}]}`;
  for (const [name, raw, qualified, wantName, wantNamespace] of [
    ["flat declared first", flatFirst, "editor__apply_patch", "editor__apply_patch", ""],
    ["namespace declared first", namespaceFirst, "editor__apply_patch", "apply_patch", "editor"],
    ["namespace only", namespaceOnly, "mcp__github__get_me", "get_me", "mcp__github"],
    ["unknown name", flatFirst, "something_else", "something_else", ""],
  ] as const) {
    test(name, () => {
      expect(splitResponsesQualifiedFunctionCallFromRequest(raw, qualified)).toEqual([wantName, wantNamespace]);
    });
  }
});

test("SplitResponsesQualifiedFunctionCallFromRequest_MatchesMergedToolIdentity", () => {
  const raw = `{"tools": [{"type":"function","name":"editor__apply_patch","parameters":{"type":"object"}}, {"type":"namespace","name":"editor","tools":[{"type":"function","name":"apply_patch","parameters":{"type":"object"}}]}]}`;
  const merged = mergeResponsesRequestChatTools(JSON.parse(raw));
  expect(merged.length).toBe(1);
  const emitted = str(merged[0], "function.name");
  expect(splitResponsesQualifiedFunctionCallFromRequest(raw, emitted)).toEqual([emitted, ""]);
});

describe("ResponsesCustomToolNames_FollowsMergedDeclaration", () => {
  const functionFirst = `{"input": [{"type":"additional_tools","tools":[{"type":"custom","name":"exec","description":"copy"}]}], "tools": [{"type":"function","name":"exec","parameters":{"type":"object"}}]}`;
  const customFirst = `{"input": [{"type":"additional_tools","tools":[{"type":"function","name":"exec","parameters":{"type":"object"}}]}], "tools": [{"type":"custom","name":"exec","description":"authoritative"}]}`;
  for (const tt of [
    { name: "function declaration wins", raw: functionFirst, wantCustom: false },
    { name: "custom declaration wins", raw: customFirst, wantCustom: true },
  ]) {
    test(tt.name, () => {
      const merged = mergeResponsesRequestChatTools(JSON.parse(tt.raw));
      expect(merged.length).toBe(1);
      expect(has(merged[0], "function.parameters.properties.input")).toBe(tt.wantCustom);
      expect(responsesCustomToolNames(tt.raw).has("exec")).toBe(tt.wantCustom);
      const [name, ok] = responsesSingleCustomToolName(tt.raw);
      expect(ok).toBe(tt.wantCustom);
      if (ok) expect(name).toBe("exec");
    });
  }
});

test("ResponsesCustomToolNames_OnlyReportsMergedTools", () => {
  const raw = `{"tools": [{"type":"namespace","name":"outer","tools":[
    {"type":"namespace","name":"inner","tools":[{"type":"custom","name":"buried"}]},
    {"type":"custom","name":"reachable"}
  ]}]}`;
  const mergedNames = new Set(mergeResponsesRequestChatTools(JSON.parse(raw)).map((t) => str(t, "function.name")));
  expect(mergedNames.has("outer__reachable")).toBe(true);
  for (const name of responsesCustomToolNames(raw)) expect(mergedNames.has(name)).toBe(true);
});

describe("FunctionCallOutputAlternateIDsAndQueueFallback", () => {
  for (const tc of [
    { name: "call_id standard", outputField: `"call_id":"call_123"` },
    { name: "tool_call_id alternate field", outputField: `"tool_call_id":"call_123"` },
    { name: "callId alternate field", outputField: `"callId":"call_123"` },
    { name: "id alternate field", outputField: `"id":"call_123"` },
    { name: "missing call_id completely fallback to pending queue", outputField: `` },
  ]) {
    test(tc.name, () => {
      let outputJSON = `{"type":"function_call_output","output":"tool_result_ok"`;
      if (tc.outputField !== "") outputJSON += "," + tc.outputField;
      outputJSON += "}";
      const out = convertReq(
        `{"model": "deepseek-v4-flash", "input": [{"type":"function_call","call_id":"call_123","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}, ${outputJSON}]}`,
        "deepseek-v4-flash",
      );
      expect(len(out, "messages")).toBe(2);
      expect(str(out, "messages.0.tool_calls.0.id")).toBe("call_123");
      expect(str(out, "messages.1.role")).toBe("tool");
      expect(str(out, "messages.1.tool_call_id")).toBe("call_123");
      expect(str(out, "messages.1.content")).toBe("tool_result_ok");
    });
  }
});

function toolResults(out: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of arr(out, "messages")) if (str(m, "role") === "tool") result[str(m, "tool_call_id")] = str(m, "content");
  return result;
}

test("MixedMissingAndExplicitParallelOutputs", () => {
  const out = convertReq(
    `{"model": "deepseek-v4-flash", "input": [
      {"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
      {"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},
      {"type":"function_call_output","output":"result_b"},
      {"type":"function_call_output","call_id":"call_a","output":"result_a"}
    ]}`,
    "deepseek-v4-flash",
  );
  expect(len(out, "messages")).toBe(3);
  const results = toolResults(out);
  expect(results.call_a).toBe("result_a");
  expect(results.call_b).toBe("result_b");
});

test("DefersMessageUntilMissingIDToolOutput", () => {
  const out = convertReq(
    `{"model": "deepseek-v4-flash", "input": [
      {"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
      {"type":"message","role":"user","content":"User command while running"},
      {"type":"function_call_output","output":"result_a"}
    ]}`,
    "deepseek-v4-flash",
  );
  expect(len(out, "messages")).toBe(3);
  expect(str(out, "messages.0.role")).toBe("assistant");
  expect(str(out, "messages.1.role")).toBe("tool");
  expect(str(out, "messages.1.tool_call_id")).toBe("call_a");
  expect(str(out, "messages.2.role")).toBe("user");
  expect(str(out, "messages.2.content")).toBe("User command while running");
});

test("MixedMissingAndExplicitParallelOutputsAcrossUserMessage", () => {
  const out = convertReq(
    `{"model": "deepseek-v4-flash", "input": [
      {"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
      {"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},
      {"type":"function_call_output","output":"result_b"},
      {"type":"message","role":"user","content":"status?"},
      {"type":"function_call_output","call_id":"call_a","output":"result_a"}
    ]}`,
    "deepseek-v4-flash",
  );
  const results = toolResults(out);
  expect(results.call_a).toBe("result_a");
  expect(results.call_b).toBe("result_b");
});

test("OrphanFunctionCallOutputBecomesUserMessage", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"role":"user","content":[{"type":"input_text","text":"Task initialization"}]},
      {"type":"function_call_output","id":"fco_01a09fca-8d33-73a1-97fd-4d83ecc02f9d","name":"send_message_to_thread","output":"<codex_delegation>\\n  <source_thread_id>01a022d7-d4d0-72b2-8571-4590484ccaee</source_thread_id>\\n  <input>Execute sub-task</input>\\n</codex_delegation>"},
      {"type":"function_call","call_id":"call_1789387253098037589_85","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"},
      {"type":"function_call_output","call_id":"call_1789387253098037589_85","id":"fco_01a09fca-a5f0-7b40-9943-21fbc923c537","output":"/Users/developer"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  let delegationFound = false;
  let bashToolFound = false;
  for (const message of arr(out, "messages")) {
    const role = str(message, "role");
    if (role === "tool") expect(str(message, "tool_call_id").trim()).not.toBe("");
    if (role === "user" && str(message, "content").includes("<codex_delegation>")) delegationFound = true;
    if (role === "tool" && str(message, "tool_call_id") === "call_1789387253098037589_85") {
      bashToolFound = true;
      expect(str(message, "content")).toBe("/Users/developer");
    }
  }
  expect(delegationFound).toBe(true);
  expect(bashToolFound).toBe(true);
});

test("UnpairedExplicitCallIDBecomesUserMessage", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"role":"user","content":[{"type":"input_text","text":"Task initialization"}]},
      {"type":"function_call_output","call_id":"call_missing","name":"send_message_to_thread","output":"<codex_delegation>Execute sub-task</codex_delegation>"},
      {"type":"function_call","call_id":"call_1789387253098037589_85","name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"},
      {"type":"function_call_output","call_id":"call_1789387253098037589_85","output":"/Users/developer"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  let delegationFound = false;
  let bashToolFound = false;
  for (const message of arr(out, "messages")) {
    const role = str(message, "role");
    expect(role === "tool" && str(message, "tool_call_id") === "call_missing").toBe(false);
    if (role === "user" && str(message, "content").includes("<codex_delegation>")) delegationFound = true;
    if (role === "tool" && str(message, "tool_call_id") === "call_1789387253098037589_85") bashToolFound = true;
  }
  expect(delegationFound).toBe(true);
  expect(bashToolFound).toBe(true);
});

test("CapsLongNamespaceToolNames", () => {
  const raw = `{"input": [{"role":"user","content":"hi"}], "tools": [
    {"type":"function","name":"exec_command","parameters":{"type":"object"}},
    {"type":"namespace","name":"mcp__codex_apps__codex_document_control","tools":[
      {"type":"function","name":"_execute_document_command","parameters":{"type":"object"}},
      {"type":"function","name":"_get_document_tool_schemas","parameters":{"type":"object"}}]},
    {"type":"namespace","name":"mcp__codex_apps__safety_settings","tools":[{"type":"function","name":"_prepare_parental_control_update","parameters":{"type":"object"}}]}
  ]}`;
  const out = convertReq(raw, "z-ai/glm-5.3-free");
  const tools = arr(out, "tools");
  expect(tools.length).toBe(4);
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = str(tool, "function.name");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(seen.has(name)).toBe(false);
    seen.add(name);
  }
});

const glm = "z-ai/glm-5.3-free";
/** The tool_calls.0.function.name of the last assistant message. */
function replayedName(out: string): string {
  let name = "";
  for (const m of arr(out, "messages")) if (str(m, "role") === "assistant") name = str(m, "tool_calls.0.function.name");
  return name;
}
function replayRequest(toolsJSON: string, call: string): string {
  return `{"input": [${call}, {"type":"function_call_output","call_id":"call_1","output":"ok"}], "tools": ${toolsJSON}}`;
}
function hiRequest(toolsJSON: string, toolChoice?: string): string {
  return `{"input": [{"role":"user","content":"hi"}], "tools": ${toolsJSON}${toolChoice ? `, "tool_choice": ${toolChoice}` : ""}}`;
}

test("DisambiguatesTruncationCollisions", () => {
  const filler = "a".repeat(50);
  const toolsJSON = `[
    {"type":"namespace","name":"mcp__server_one__${filler}","tools":[{"type":"function","name":"_same_tail_tool_name","parameters":{"type":"object"}}]},
    {"type":"namespace","name":"mcp__server_two__${filler}","tools":[{"type":"function","name":"_same_tail_tool_name","parameters":{"type":"object"}}]}
  ]`;
  const out = convertReq(hiRequest(toolsJSON), glm);
  const tools = arr(out, "tools");
  expect(tools.length).toBe(2);
  const first = str(tools[0], "function.name");
  const second = str(tools[1], "function.name");
  expect(first).not.toBe(second);
  for (const name of [first, second]) expect(name.length).toBeLessThanOrEqual(64);

  const merged = `{"input": [
    {"type":"custom_tool_call","namespace":"mcp__server_two__${filler}","name":"_same_tail_tool_name","call_id":"call_1","input":"x"},
    {"type":"custom_tool_call_output","call_id":"call_1","output":"y"}
  ], "tools": ${toolsJSON}}`;
  expect(replayedName(convertReq(merged, glm))).toBe(second);
});

test("LongDeclarationDoesNotDisplaceShortOriginal", () => {
  const longNamespace = "mcp__a__" + "b".repeat(60);
  const longChild = "child_tool";
  const qualified = longNamespace + "__" + longChild;
  const flatName = capResponsesChatToolName(qualified);
  expect(qualified.length).toBeGreaterThan(64);
  expect(flatName.length).toBe(64);
  const suffixed = capResponsesChatToolName(flatName + "_1");
  const toolsJSON = `[
    {"type":"namespace","name":"${longNamespace}","tools":[{"type":"function","name":"${longChild}","parameters":{"type":"object"}}]},
    {"type":"function","name":"${flatName}","parameters":{"type":"object"}}
  ]`;
  const out = convertReq(hiRequest(toolsJSON), glm);
  const emitted = arr(out, "tools");
  expect(emitted.length).toBe(2);
  expect(str(emitted[1], "function.name")).toBe(flatName);
  expect(str(emitted[0], "function.name")).toBe(suffixed);
  for (const tool of emitted) expect(str(tool, "function.name").length).toBeLessThanOrEqual(64);

  expect(replayedName(convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","name":"${flatName}","arguments":"{}"}`), glm))).toBe(flatName);
  expect(str(convertReq(hiRequest(toolsJSON, `{"type":"function","function":{"name":"${flatName}"}}`), glm), "tool_choice.function.name")).toBe(flatName);
  expect(replayedName(convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","name":"${qualified}","arguments":"{}"}`), glm))).toBe(suffixed);
});

test("AmbiguousLongLocalNameStaysUnresolved", () => {
  const longLocal = "shared_" + "x".repeat(60);
  const toolsJSON = `[
    {"type":"namespace","name":"mcp__alpha","tools":[{"type":"function","name":"${longLocal}","parameters":{"type":"object"}}]},
    {"type":"namespace","name":"mcp__beta","tools":[{"type":"function","name":"${longLocal}","parameters":{"type":"object"}}]}
  ]`;
  const out = convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","name":"${longLocal}","arguments":"{}"}`), glm);
  const declaredAliases = new Set(arr(out, "tools").map((t) => str(t, "function.name")));
  expect(declaredAliases.size).toBe(2);
  const name = replayedName(out);
  expect(name.length).toBeLessThanOrEqual(64);
  expect(declaredAliases.has(name)).toBe(false);
});

test("LongAliasDoesNotDisplaceNamespacedLocalName", () => {
  const localName = "l" + "m".repeat(63);
  const longFlatName = "n".repeat(11) + localName;
  expect(capResponsesChatToolName(longFlatName)).toBe(localName);
  const toolsJSON = `[
    {"type":"function","name":"${longFlatName}","parameters":{"type":"object"}},
    {"type":"namespace","name":"mcp__beta","tools":[{"type":"function","name":"${localName}","parameters":{"type":"object"}}]}
  ]`;
  const out = convertReq(hiRequest(toolsJSON), glm);
  const emitted = arr(out, "tools");
  expect(emitted.length).toBe(2);
  expect(str(emitted[0], "function.name")).not.toBe(localName);
  const namespacedAlias = str(emitted[1], "function.name");
  for (const tool of emitted) expect(str(tool, "function.name").length).toBeLessThanOrEqual(64);
  expect(replayedName(convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","name":"${localName}","arguments":"{}"}`), glm))).toBe(namespacedAlias);
  expect(str(convertReq(hiRequest(toolsJSON, `{"type":"function","function":{"name":"${localName}"}}`), glm), "tool_choice.function.name")).toBe(namespacedAlias);
});

test("SharedLocalNameIsNeverEmitted", () => {
  const sharedLocal = "s" + "t".repeat(63);
  for (const namespace of ["mcp__alpha", "mcp__beta"]) expect(capResponsesChatToolName(rawResponsesNamespaceQualifiedName(namespace, sharedLocal))).toBe(sharedLocal);
  const toolsJSON = `[
    {"type":"namespace","name":"mcp__alpha","tools":[{"type":"function","name":"${sharedLocal}","parameters":{"type":"object"}}]},
    {"type":"namespace","name":"mcp__beta","tools":[{"type":"function","name":"${sharedLocal}","parameters":{"type":"object"}}]}
  ]`;
  const emitted = arr(convertReq(hiRequest(toolsJSON), glm), "tools");
  expect(emitted.length).toBe(2);
  const aliases = new Set<string>();
  for (const tool of emitted) {
    const name = str(tool, "function.name");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toBe(sharedLocal);
    expect(aliases.has(name)).toBe(false);
    aliases.add(name);
  }
  const alphaAlias = str(emitted[0], "function.name");
  const betaAlias = str(emitted[1], "function.name");
  for (const [namespace, want] of [
    ["mcp__alpha", alphaAlias],
    ["mcp__beta", betaAlias],
  ]) {
    const out = convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","namespace":"${namespace}","name":"${sharedLocal}","arguments":"{}"}`), glm);
    expect(replayedName(out)).toBe(want!);
  }
  const bare = replayedName(convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","name":"${sharedLocal}","arguments":"{}"}`), glm));
  expect(bare.length).toBeLessThanOrEqual(64);
  expect(aliases.has(bare)).toBe(false);
  expect(aliases.has(str(convertReq(hiRequest(toolsJSON, `{"type":"function","function":{"name":"${sharedLocal}"}}`), glm), "tool_choice.function.name"))).toBe(false);
  expect(str(convertReq(hiRequest(toolsJSON, `{"type":"function","namespace":"mcp__beta","function":{"name":"${sharedLocal}"}}`), glm), "tool_choice.function.name")).toBe(betaAlias);
});

test("QualifiedIdentityOutranksForeignLocalName", () => {
  const longChild = "read_" + "f".repeat(60);
  const qualified = rawResponsesNamespaceQualifiedName("alpha_ns", longChild);
  expect(qualified.length).toBeGreaterThan(responsesChatToolNameLimit);
  expect(capResponsesChatToolName(rawResponsesNamespaceQualifiedName("beta_ns", qualified))).toBe(capResponsesChatToolName(qualified));
  const toolsJSON = `[
    {"type":"namespace","name":"alpha_ns","tools":[{"type":"function","name":"${longChild}","parameters":{"type":"object"}}]},
    {"type":"namespace","name":"beta_ns","tools":[{"type":"function","name":"${qualified}","parameters":{"type":"object"}}]}
  ]`;
  const emitted = arr(convertReq(hiRequest(toolsJSON), glm), "tools");
  expect(emitted.length).toBe(2);
  const alphaAlias = str(emitted[0], "function.name");
  const betaAlias = str(emitted[1], "function.name");
  expect(alphaAlias).not.toBe(betaAlias);
  for (const tool of emitted) expect(str(tool, "function.name").length).toBeLessThanOrEqual(64);
  expect(replayedName(convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","name":"${qualified}","arguments":"{}"}`), glm))).toBe(alphaAlias);
  expect(str(convertReq(hiRequest(toolsJSON, `{"type":"function","function":{"name":"${qualified}"}}`), glm), "tool_choice.function.name")).toBe(alphaAlias);
  for (const [namespace, name, want] of [
    ["alpha_ns", longChild, alphaAlias],
    ["beta_ns", qualified, betaAlias],
  ]) {
    const out = convertReq(replayRequest(toolsJSON, `{"type":"function_call","call_id":"call_1","namespace":"${namespace}","name":"${name}","arguments":"{}"}`), glm);
    expect(replayedName(out)).toBe(want!);
  }
});

const roles = (out: string) => arr(out, "messages").map((m) => str(m, "role"));

test("IncompleteToolCallsDoNotDeferMessages", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
      {"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},
      {"role":"user","content":"reminder before results"},
      {"type":"function_call_output","call_id":"call_a","output":"result_a"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out)).toEqual(["assistant", "user", "tool"]);
});

test("CompleteToolCallsDoPairMessages", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"call_a","name":"tool_a","arguments":"{}"},
      {"type":"function_call","call_id":"call_b","name":"tool_b","arguments":"{}"},
      {"role":"user","content":"reminder during execution"},
      {"type":"function_call_output","call_id":"call_b","output":"result_b"},
      {"type":"function_call_output","call_id":"call_a","output":"result_a"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out)).toEqual(["assistant", "tool", "tool", "user"]);
  expect([str(out, "messages.1.tool_call_id"), str(out, "messages.2.tool_call_id")]).toEqual(["call_b", "call_a"]);
  expect([str(out, "messages.1.content"), str(out, "messages.2.content")]).toEqual(["result_b", "result_a"]);
});

test("MixedEmptyIDDoesNotReorder", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"","name":"unknown","arguments":"{}"},
      {"type":"function_call","call_id":"a","name":"known","arguments":"{}"},
      {"role":"user","content":"reminder"},
      {"type":"function_call_output","call_id":"a","output":"ok"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out)).toEqual(["assistant", "user", "tool"]);
});

test("DuplicateCallIDDoesNotReorder", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"dup","name":"tool_1","arguments":"{}"},
      {"type":"function_call","call_id":"dup","name":"tool_2","arguments":"{}"},
      {"role":"user","content":"reminder"},
      {"type":"function_call_output","call_id":"dup","output":"ok"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out)).toEqual(["assistant", "user", "tool"]);
});

test("DuplicateOutputCallIDDoesNotReorder", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"call_dup_out","name":"tool_a","arguments":"{}"},
      {"role":"user","content":"reminder before results"},
      {"type":"function_call_output","call_id":"call_dup_out","output":"first"},
      {"type":"function_call_output","call_id":"call_dup_out","output":"second"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out).length).toBe(4);
  expect(roles(out).slice(0, 2)).toEqual(["assistant", "user"]);
  expect(str(out, "messages.1.content")).toBe("reminder before results");
});

test("DuplicateCustomOutputCallIDDoesNotReorder", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"custom_tool_call","call_id":"custom_dup","name":"custom_a","input":"{}"},
      {"role":"user","content":"reminder before custom results"},
      {"type":"custom_tool_call_output","call_id":"custom_dup","output":"output 1"},
      {"type":"custom_tool_call_output","call_id":"custom_dup","output":"output 2"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out).length).toBe(4);
  expect(roles(out).slice(0, 2)).toEqual(["assistant", "user"]);
  expect(str(out, "messages.1.content")).toBe("reminder before custom results");
});

test("MultipleOutputsWithoutIDDoNotGuessOrReorder", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"a","name":"unknown_a","arguments":"{}"},
      {"type":"function_call","call_id":"b","name":"unknown_b","arguments":"{}"},
      {"role":"user","content":"reminder before results"},
      {"type":"function_call_output","output":"output X"},
      {"type":"function_call_output","output":"output Y"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out)).toEqual(["assistant", "user", "user", "user"]);
  expect(str(out, "messages.1.content")).toBe("reminder before results");
  expect(str(out, "messages.2.content")).toBe("output X");
  expect(str(out, "messages.3.content")).toBe("output Y");
});

test("MultipleOutputsWithoutIDAndOrphanOutputDoNotGuessOrReorder", () => {
  const out = convertReq(
    `{"model": "deepseek-v4.1-flash", "input": [
      {"type":"function_call","call_id":"a","name":"tool_a","arguments":"{}"},
      {"type":"function_call","call_id":"b","name":"tool_b","arguments":"{}"},
      {"role":"user","content":"reminder before results"},
      {"type":"function_call_output","output":"output X"},
      {"type":"function_call_output","output":"output Y"},
      {"type":"function_call_output","call_id":"orphan_id","output":"output Z"}
    ]}`,
    "deepseek-v4.1-flash",
  );
  expect(roles(out).length).toBe(5);
  expect(roles(out).slice(0, 2)).toEqual(["assistant", "user"]);
  expect(str(out, "messages.1.content")).toBe("reminder before results");
  expect(roles(out).includes("tool")).toBe(false);
});

test("MapsMaxOutputTokensToMaxTokens", () => {
  const out = convertReq(`{"model": "gpt-5.4", "input": "hello", "max_output_tokens": 1024}`, "gpt-5.4");
  expect(int(out, "max_tokens")).toBe(1024);
  expect(has(out, "max_completion_tokens")).toBe(false);
  const outWithoutLimit = convertReq(`{"model": "gpt-5.4", "input": "hello"}`, "gpt-5.4");
  expect(has(outWithoutLimit, "max_completion_tokens")).toBe(false);
  expect(has(outWithoutLimit, "max_tokens")).toBe(false);
  const outNull = convertReq(`{"model": "gpt-5.4", "input": "hello", "max_output_tokens": null}`, "gpt-5.4");
  expect(get(outNull, "max_tokens")).toBeNull();
  expect(has(outNull, "max_completion_tokens")).toBe(false);
});

test("NamespaceToolPrefixCollision", () => {
  for (const tt of [
    { namespace: "fs", child: "fs_read", want: "fs__fs_read" },
    { namespace: "collab", child: "collaboration", want: "collab__collaboration" },
    { namespace: "fs", child: "fs__read", want: "fs__read" },
    { namespace: "fs", child: "fs", want: "fs" },
    { namespace: "fs__", child: "read", want: "fs__read" },
    { namespace: "mcp__node_repl", child: "mcp__node_repl__js", want: "mcp__node_repl__js" },
  ]) {
    expect(rawResponsesNamespaceQualifiedName(tt.namespace, tt.child)).toBe(tt.want);
  }
  const raw = `{"model": "gpt-5.4", "tools": [
    {"type": "function", "name": "fs_read", "parameters": {"type": "object"}},
    {"type": "namespace", "name": "fs", "tools": [{"type": "function", "name": "fs_read", "parameters": {"type": "object"}}]}
  ], "input": []}`;
  const out = convertReq(raw, "gpt-5.4");
  expect(arr(out, "tools").map((t) => str(t, "function.name"))).toEqual(["fs_read", "fs__fs_read"]);
  expect(splitResponsesQualifiedFunctionCallFromRequest(raw, "fs__fs_read")).toEqual(["fs_read", "fs"]);
  expect(splitResponsesQualifiedFunctionCallFromRequest(raw, "fs_read")).toEqual(["fs_read", ""]);
});

test("ApplyPatchChatRequestContractAndHistory", () => {
  const request = `{"tools":[{"type":"namespace","name":"editor","tools":[{"type":"custom","name":"apply_patch","description":"Edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.","format":{"type":"grammar","syntax":"lark","definition":"start: patch"},"cache_control":{"type":"ephemeral"}}]}],"input":[{"type":"custom_tool_call","namespace":"editor","name":"apply_patch","call_id":"c1","input":"*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch"},{"type":"custom_tool_call_output","call_id":"c1","output":"done"}]}`;
  const body = convertOpenAIResponsesRequestToOpenAIChatCompletions("test", request, false);
  const tool = get(body, "tools.0.function");
  const description = str(tool, "description");
  for (const instruction of ["*** Begin Patch", "*** End Patch", "*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to:", "*** End of File", "@@", "start: patch", "JSON object"]) {
    expect(description).toContain(instruction);
  }
  expect(description.includes("do not wrap the patch in JSON")).toBe(false);
  expect(get(tool, "parameters.additionalProperties")).toBe(false);
  expect(str(tool, "parameters.required.0")).toBe("input");
  const call = get(body, "messages.0.tool_calls.0");
  expect(str(call, "function.name")).toBe("editor__apply_patch");
  expect(str(JSON.parse(str(call, "function.arguments")), "input")).toBe("*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch");
  expect(str(call, "id")).toBe("c1");
  expect(str(body, "messages.1.tool_call_id")).toBe("c1");
  expect(str(body, "messages.1.content")).toBe("done");
});

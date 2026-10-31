// Ported from: internal/translator/openai/openai/responses/openai_openai-responses_request_test.go
// Skipped cases: none (prettyJSONForTest logging is dropped)
import { describe, expect, test } from "bun:test";
import {
  chatNameForResponsesNamespaceToolCall,
  convertOpenAIResponsesRequestToOpenAIChatCompletions,
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

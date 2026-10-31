// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_reasoning_order_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { claudeResponsesRedactedThinkingPrefix } from "../../../../../src/translator/claude/openai/responses/index.ts";
import {
  convertRequest,
  get,
  responsesFunctionCallItem,
  responsesFunctionCallOutputItem,
  responsesReasoningItem,
  responsesRequestFromItems,
  responsesWebSearchCallItem,
  testClaudeThinkingSignatureForModel,
  useClientToolSearchDefault,
} from "./helpers.ts";

useClientToolSearchDefault();

const types = (content: any[]): string[] => content.map((b) => b.type);

test("keeps latest consecutive reasoning", () => {
  const [firstRaw] = testClaudeThinkingSignatureForModel("claude-opus-5-first");
  const [secondRaw] = testClaudeThinkingSignatureForModel("claude-opus-5-second");
  const [thirdRaw, thirdSignature] = testClaudeThinkingSignatureForModel("claude-opus-5-third");
  const raw = responsesRequestFromItems(
    `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"prefix"}]}`,
    responsesReasoningItem(firstRaw, "first reasoning"),
    responsesReasoningItem(secondRaw, "second reasoning"),
    responsesReasoningItem(thirdRaw, "third reasoning"),
    responsesFunctionCallItem("call_latest", "latest_tool"),
    responsesFunctionCallOutputItem("call_latest", "done"),
  );
  const content = get(convertRequest("claude-test", raw), "messages.0.content");
  expect(types(content)).toEqual(["text", "thinking", "tool_use"]);
  expect(content[0].text).toBe("prefix");
  expect(content[1].thinking).toBe("third reasoning");
  expect(content[1].signature).toBe(thirdSignature);
});

test("tool calls separate reasoning blocks", () => {
  const [firstRaw, firstSignature] = testClaudeThinkingSignatureForModel("claude-opus-5-first");
  const [secondRaw, secondSignature] = testClaudeThinkingSignatureForModel("claude-opus-5-second");
  const raw = responsesRequestFromItems(
    responsesReasoningItem(firstRaw, "first reasoning"),
    responsesFunctionCallItem("call_first", "first_tool"),
    responsesReasoningItem(secondRaw, "second reasoning"),
    responsesFunctionCallItem("call_second", "second_tool"),
    responsesFunctionCallOutputItem("call_first", "first result"),
    responsesFunctionCallOutputItem("call_second", "second result"),
  );
  const content = get(convertRequest("claude-test", raw), "messages.0.content");
  expect(types(content)).toEqual(["thinking", "tool_use", "thinking", "tool_use"]);
  expect(content[0].signature).toBe(firstSignature);
  expect(content[2].signature).toBe(secondSignature);
  expect(content[1].id).toBe("call_first");
  expect(content[3].id).toBe("call_second");
});

test("non-thinking blocks separate reasoning", () => {
  const [firstRaw, firstSignature] = testClaudeThinkingSignatureForModel("claude-opus-5-first");
  const [secondRaw, secondSignature] = testClaudeThinkingSignatureForModel("claude-opus-5-second");
  const redactedData = "opaque-redacted-data";
  const raw = responsesRequestFromItems(
    responsesReasoningItem(firstRaw, "first reasoning"),
    `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"visible separator"}]}`,
    responsesReasoningItem(secondRaw, "second reasoning"),
    `{"type":"reasoning","encrypted_content":"${claudeResponsesRedactedThinkingPrefix}${redactedData}","summary":[]}`,
    responsesReasoningItem(firstRaw, "third reasoning"),
    responsesFunctionCallItem("call_separator", "separator_tool"),
    responsesFunctionCallOutputItem("call_separator", "done"),
  );
  const content = get(convertRequest("claude-test", raw), "messages.0.content");
  expect(types(content)).toEqual(["thinking", "text", "thinking", "redacted_thinking", "thinking", "tool_use"]);
  expect(content[0].signature).toBe(firstSignature);
  expect(content[2].signature).toBe(secondSignature);
  expect(content[3].data).toBe(redactedData);
  expect(content[4].signature).toBe(firstSignature);
  expect(content[5].id).toBe("call_separator");
});

describe("web search separates tool use with thinking", () => {
  const [rawSig, signature] = testClaudeThinkingSignatureForModel("claude-opus-5-test");
  const user = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}`;
  const assistant = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Searching, then running."}]}`;
  const thought = "I should search and then run a command.";

  test("function_call then web_search_call", () => {
    const raw = responsesRequestFromItems(
      user,
      responsesReasoningItem(rawSig, thought),
      assistant,
      responsesFunctionCallItem("call_00_abc", "exec_command"),
      responsesWebSearchCallItem("ws_srvtoolu_12_x", "hello world"),
      responsesFunctionCallOutputItem("call_00_abc", "hi"),
    );
    const content = get(convertRequest("claude-test", raw), "messages.1.content");
    expect(types(content)).toEqual(["thinking", "text", "server_tool_use", "web_search_tool_result", "thinking", "tool_use"]);
    expect(content[0].signature).toBe(signature);
    expect(content[4].signature).toBe(signature);
    expect(content[4].thinking).toBe(thought);
    expect(content[5].id).toBe("call_00_abc");
  });

  test("web_search_call then function_call", () => {
    const raw = responsesRequestFromItems(
      user,
      responsesReasoningItem(rawSig, thought),
      assistant,
      responsesWebSearchCallItem("ws_srvtoolu_12_x", "hello world"),
      responsesFunctionCallItem("call_00_abc", "exec_command"),
      responsesFunctionCallOutputItem("call_00_abc", "hi"),
    );
    const content = get(convertRequest("claude-test", raw), "messages.1.content");
    expect(types(content)).toEqual(["thinking", "text", "server_tool_use", "web_search_tool_result", "thinking", "tool_use"]);
    expect(content[4].signature).toBe(signature);
    expect(content[5].id).toBe("call_00_abc");
  });

  test("no thinking item present", () => {
    const raw = responsesRequestFromItems(
      user,
      assistant,
      responsesWebSearchCallItem("ws_srvtoolu_12_x", "hello world"),
      responsesFunctionCallItem("call_00_abc", "exec_command"),
      responsesFunctionCallOutputItem("call_00_abc", "hi"),
    );
    expect(types(get(convertRequest("claude-test", raw), "messages.1.content"))).toEqual(["text", "server_tool_use", "web_search_tool_result", "tool_use"]);
  });

  test("selects latest thinking block when multiple exist", () => {
    const [firstRaw] = testClaudeThinkingSignatureForModel("claude-opus-5-first");
    const [secondRaw, secondSignature] = testClaudeThinkingSignatureForModel("claude-opus-5-second");
    const raw = responsesRequestFromItems(
      user,
      responsesReasoningItem(firstRaw, "first reasoning"),
      `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"thought once"}]}`,
      responsesReasoningItem(secondRaw, "second reasoning"),
      responsesWebSearchCallItem("ws_srvtoolu_12_x", "hello world"),
      responsesFunctionCallItem("call_00_abc", "exec_command"),
      responsesFunctionCallOutputItem("call_00_abc", "hi"),
    );
    const content = get(convertRequest("claude-test", raw), "messages.1.content");
    expect(types(content)).toEqual(["thinking", "text", "thinking", "server_tool_use", "web_search_tool_result", "thinking", "tool_use"]);
    expect(content[5].signature).toBe(secondSignature);
    expect(content[5].thinking).toBe("second reasoning");
  });
});

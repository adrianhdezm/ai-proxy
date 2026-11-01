// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_interleaved_search_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import {
  type JSONObject,
  claudeAssistantBlockTypes,
  convertRequest,
  terminalEvent,
  testClaudeThinkingSignatureForModel,
  translateStreamThroughRegistry,
  useClientToolSearchDefault,
} from "./helpers.ts";

useClientToolSearchDefault();

// Regression: a Claude turn that interleaved thinking with server-side web searches used to
// lose the search blocks, leaving two adjacent reasoning items Anthropic rejects on replay.
test("interleaved thinking and search survives round trip", () => {
  const [signature] = testClaudeThinkingSignatureForModel();
  const prefix = `data: {"type":"content_block_`;
  const thinking = (index: number, text: string): string[] => [
    `${prefix}start","index":${index},"content_block":{"type":"thinking","thinking":""}}`,
    `${prefix}delta","index":${index},"delta":{"type":"thinking_delta","thinking":"${text}"}}`,
    `${prefix}delta","index":${index},"delta":{"type":"signature_delta","signature":"${signature}"}}`,
    `${prefix}stop","index":${index}}`,
  ];
  const search = (index: number, id: string): string[] => [
    `${prefix}start","index":${index},"content_block":{"type":"server_tool_use","id":"${id}","name":"web_search","input":{}}}`,
    `${prefix}delta","index":${index},"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"lindorm\\"}"}}`,
    `${prefix}stop","index":${index}}`,
    `${prefix}start","index":${index + 1},"content_block":{"type":"web_search_tool_result","tool_use_id":"${id}","content":[{"type":"web_search_result","title":"T","url":"https://example.com/${id}"}]}}`,
    `${prefix}stop","index":${index + 1}}`,
  ];
  const chunks = [
    `data: {"type":"message_start","message":{"id":"msg_x","usage":{"input_tokens":1,"output_tokens":0}}}`,
    ...thinking(0, "first"),
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Researching."}}`,
    `data: {"type":"content_block_stop","index":1}`,
    ...search(2, "srvtoolu_a"),
    ...thinking(6, "second"),
    ...search(7, "srvtoolu_b"),
    ...thinking(11, "third"),
    `data: {"type":"content_block_start","index":12,"content_block":{"type":"tool_use","id":"toolu_1","name":"exec","input":{}}}`,
    `data: {"type":"content_block_delta","index":12,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}`,
    `data: {"type":"content_block_stop","index":12}`,
    `data: {"type":"message_stop"}`,
  ];
  const completed = terminalEvent(translateStreamThroughRegistry(chunks)) as JSONObject;
  const req = JSON.stringify({ model: "claude-test", input: completed.response.output });
  const out = convertRequest("claude-test", req);
  expect(claudeAssistantBlockTypes(out)).toEqual([
    "thinking",
    "text",
    "server_tool_use",
    "web_search_tool_result",
    "thinking",
    "server_tool_use",
    "web_search_tool_result",
    "thinking",
    "tool_use",
  ]);
});

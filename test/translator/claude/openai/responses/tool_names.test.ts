// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_tool_names_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import {
  buildClaudeToolNames,
  convertClaudeResponseToOpenAIResponsesNonStream,
  responsesCustomToolNames,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import { get, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

const pattern = /^[a-zA-Z0-9_-]{1,64}$/;

test("round trip and stability", () => {
  const req = {
    tools: [
      { type: "function", name: "normal_tool" },
      { type: "function", name: "very_long_tool_name_that_exceeds_sixty_four_characters_and_needs_truncation_alpha" },
      { type: "function", name: "very_long_tool_name_that_exceeds_sixty_four_characters_and_needs_truncation_beta" },
      { type: "custom", name: "custom.tool.with.dots" },
      { type: "namespace", name: "mcp__my_server", tools: [{ type: "function", name: "get_something" }] },
    ],
    input: [{ type: "function_call", name: "history_only_tool_name_that_is_also_very_long_exceeding_sixty_four_characters" }],
  };
  const names = buildClaudeToolNames(req, true);
  const seen = new Map<string, string>();
  for (const [id, claudeName] of names.toClaude) {
    expect(pattern.test(claudeName)).toBe(true);
    expect(claudeName.length).toBeLessThanOrEqual(64);
    const existing = seen.get(claudeName);
    if (existing !== undefined) expect(existing).toBe(id);
    seen.set(claudeName, id);
    expect(names.identity(claudeName)).toBe(id);
  }
  expect(names.claudeName("normal_tool")).toBe("normal_tool");
  expect(names.claudeName("mcp__my_server__get_something")).toBe("mcp__my_server__get_something");
  expect(names.claudeName("very_long_tool_name_that_exceeds_sixty_four_characters_and_needs_truncation_alpha")).not.toBe(
    names.claudeName("very_long_tool_name_that_exceeds_sixty_four_characters_and_needs_truncation_beta"),
  );
});

test("declaration order invariance", () => {
  const tool1 = "mcp__example_apps__acme_inventory_service__acme_inventory_service_get_item_prices";
  const tool2 = "mcp__example_apps__acme_inventory_service__acme_inventory_service_get_item_metrics";
  const namesA = buildClaudeToolNames({ tools: [{ type: "function", name: tool1 }, { type: "function", name: tool2 }] }, true);
  const namesB = buildClaudeToolNames({ tools: [{ type: "function", name: tool2 }, { type: "function", name: tool1 }] }, true);
  expect(namesA.claudeName(tool1)).toBe(namesB.claudeName(tool1));
  expect(namesA.claudeName(tool2)).toBe(namesB.claudeName(tool2));
});

test("single long name", () => {
  const longTool = "a_single_very_long_tool_name_that_exceeds_sixty_four_characters_cleanly";
  const names = buildClaudeToolNames({ tools: [{ type: "function", name: longTool }] }, true);
  const claudeName = names.claudeName(longTool);
  expect(claudeName.length).toBeLessThanOrEqual(64);
  expect(pattern.test(claudeName)).toBe(true);
  expect(names.identity(claudeName)).toBe(longTool);
});

test("custom tool collision", () => {
  const tool1 = "custom__long_namespace_path_exceeding_sixty_four_characters_long__operation_query_v1_execute_handler";
  const tool2 = "custom__long_namespace_path_exceeding_sixty_four_characters_long__operation_query_v1_execute_stream";
  const reqJSON = JSON.stringify({ tools: [{ type: "custom", name: tool1 }, { type: "custom", name: tool2 }] });
  const names = buildClaudeToolNames(JSON.parse(reqJSON), true);
  const customMap = responsesCustomToolNames(reqJSON);
  const cName1 = names.claudeName(tool1);
  const cName2 = names.claudeName(tool2);
  expect(cName1).not.toBe(cName2);
  expect(cName1.length).toBeLessThanOrEqual(64);
  expect(cName2.length).toBeLessThanOrEqual(64);
  expect(customMap.has(cName1)).toBe(true);
  expect(customMap.has(cName2)).toBe(true);
  expect(names.identity(cName1)).toBe(tool1);
  expect(names.identity(cName2)).toBe(tool2);

  const claudeResp = [
    `data: {"type":"message_start","message":{"id":"msg_test_custom","usage":{"input_tokens":10,"output_tokens":5}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_custom_0","name":${JSON.stringify(cName1)},"input":{"input":"query_payload"}}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_stop"}`,
  ].join("\n");
  const translated = convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-sonnet-5-5", reqJSON, "", claudeResp, undefined);
  expect(get(translated, "output.0.type")).toBe("custom_tool_call");
  expect(get(translated, "output.0.name")).toBe(tool1);
});

test("declared tools precede history", () => {
  const names = buildClaudeToolNames({ tools: [{ type: "function", name: "tool_x" }], input: [{ type: "function_call", name: "tool.x" }] }, true);
  expect(names.claudeName("tool_x")).toBe("tool_x");
  expect(names.claudeName("tool.x")).not.toBe("tool_x");
  expect(names.claudeName("tool.x").startsWith("tool_x_")).toBe(true);
});

// Ported from: internal/translator/common/claude_messages_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { ClaudeMessageAccumulator, alignClaudeToolResults } from "../../../src/translator/common/claude_messages.ts";
import { garray, getAt, gstr } from "../../../src/util/gpath.ts";

test("ClaudeMessageAccumulator groups and orders assistant parts", () => {
  const acc = new ClaudeMessageAccumulator();
  acc.append('{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"first","input":{}}]}');
  acc.append('{"role":"assistant","content":[{"type":"thinking","thinking":"reason"},{"type":"text","text":"answer"}]}');
  acc.append('{"role":"assistant","content":[{"type":"tool_use","id":"call_2","name":"second","input":{}}]}');

  const messages = acc.messages();
  expect(messages.length).toBe(1);
  const content = garray(messages[0]!.content);
  expect(content.map((c) => gstr(getAt(c, "type")))).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  expect(getAt(content[2], "id")).toBe("call_1");
  expect(getAt(content[3], "id")).toBe("call_2");
});

test("ClaudeMessageAccumulator preserves user order and role boundaries", () => {
  const acc = new ClaudeMessageAccumulator();
  acc.append('{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"ok"}]}');
  acc.append('{"role":"user","content":[{"type":"text","text":"continue"}]}');
  acc.append('{"role":"assistant","content":[{"type":"text","text":"done"}]}');

  const messages = acc.messages();
  expect(messages.length).toBe(2);
  expect(messages[0]!.role).toBe("user");
  expect(getAt(messages[0], "content.0.type")).toBe("tool_result");
  expect(getAt(messages[0], "content.1.text")).toBe("continue");
  expect(messages[1]!.role).toBe("assistant");
});

test("ClaudeMessageAccumulator skips empty messages without breaking turn", () => {
  const acc = new ClaudeMessageAccumulator();
  acc.append('{"role":"assistant","content":[{"type":"text","text":"first"}]}');
  acc.append('{"role":"user"}');
  acc.append('{"role":"user","content":null}');
  acc.append('{"role":"user","content":""}');
  acc.append('{"role":"user","content":[]}');
  acc.append('{"role":"invalid","content":[{"type":"text","text":"ignored"}]}');
  acc.append('{"role":"assistant","content":[{"type":"text","text":"second"}]}');

  const messages = acc.messages();
  expect(messages.length).toBe(1);
  expect(garray(messages[0]!.content).length).toBe(2);
});

test("ClaudeMessageAccumulator flush preserves explicit boundary", () => {
  const acc = new ClaudeMessageAccumulator();
  acc.append('{"role":"user","content":"system reminder"}');
  acc.flush();
  acc.append('{"role":"user","content":[{"type":"text","text":"question"}]}');

  const messages = acc.messages();
  expect(messages.length).toBe(2);
  expect(getAt(messages[0], "content.0.text")).toBe("system reminder");
  expect(getAt(messages[1], "content.0.text")).toBe("question");
});

test("ClaudeMessageAccumulator preserves block cache_control", () => {
  const acc = new ClaudeMessageAccumulator();
  acc.append('{"role":"user","content":[{"type":"text","text":"cached","cache_control":{"type":"ephemeral"}}]}');
  acc.append('{"role":"user","content":[{"type":"text","text":"fresh"}]}');

  const messages = acc.messages();
  expect(getAt(messages[0], "content.0.cache_control.type")).toBe("ephemeral");
  expect(getAt(messages[0], "content.1.cache_control")).toBeUndefined();
});

describe("alignClaudeToolResults", () => {
  test("reorders permuted results while preserving non-result slots", () => {
    const input = JSON.parse(`[
      {"type":"tool_result","tool_use_id":"call_2","content":"two"},
      {"type":"text","text":"extra user text"},
      {"type":"tool_result","tool_use_id":"call_1","content":"one"}
    ]`) as unknown;
    const parts = garray(alignClaudeToolResults(input, ["call_1", "call_2"]));
    expect(parts.length).toBe(3);
    expect(getAt(parts[0], "tool_use_id")).toBe("call_1");
    expect(getAt(parts[1], "type")).toBe("text");
    expect(getAt(parts[1], "text")).toBe("extra user text");
    expect(getAt(parts[2], "tool_use_id")).toBe("call_2");

    const leadingTextInput = JSON.parse(`[
      {"type":"text","text":"leading text"},
      {"type":"tool_result","tool_use_id":"call_2","content":"two"},
      {"type":"tool_result","tool_use_id":"call_1","content":"one"}
    ]`) as unknown;
    const leadingParts = garray(alignClaudeToolResults(leadingTextInput, ["call_1", "call_2"]));
    expect(leadingParts.length).toBe(3);
    expect(getAt(leadingParts[0], "type")).toBe("text");
    expect(getAt(leadingParts[0], "text")).toBe("leading text");
    expect(getAt(leadingParts[1], "tool_use_id")).toBe("call_1");
    expect(getAt(leadingParts[2], "tool_use_id")).toBe("call_2");
  });

  test("returns original content when count mismatches", () => {
    const input = JSON.parse('[{"type":"tool_result","tool_use_id":"call_1","content":"one"}]') as unknown;
    expect(alignClaudeToolResults(input, ["call_1", "call_2"])).toBe(input);
  });

  test("returns original content when id not found", () => {
    const input = JSON.parse('[{"type":"tool_result","tool_use_id":"call_unknown","content":"unknown"},{"type":"tool_result","tool_use_id":"call_1","content":"one"}]') as unknown;
    expect(alignClaudeToolResults(input, ["call_1", "call_2"])).toBe(input);
  });

  test("returns original content for non-array", () => {
    const input: unknown = "text content";
    expect(alignClaudeToolResults(input, ["call_1"])).toBe(input);
  });
});

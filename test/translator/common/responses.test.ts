// Ported from: internal/translator/common/responses_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { extractResponsesCallID, normalizeResponsesToolCallOutputs, setResponsesToolCallIdentity } from "../../../src/translator/common/responses.ts";
import { getAt, gstr } from "../../../src/util/gpath.ts";

const j = (s: string): unknown => JSON.parse(s);

describe("setResponsesToolCallIdentity", () => {
  const cases = [
    { name: "top level", input: '{"name":"functions__exec"}', toolName: "exec", namespace: "functions", itemPath: "", namePath: "name", namespacePath: "namespace", wantName: "exec", wantNamespace: "functions" },
    { name: "nested item", input: '{"item":{"name":"functions__exec"}}', toolName: "exec", namespace: "functions", itemPath: "item", namePath: "item.name", namespacePath: "item.namespace", wantName: "exec", wantNamespace: "functions" },
    { name: "remove stale namespace", input: '{"name":"old","namespace":"stale"}', toolName: "plain", namespace: "", itemPath: "", namePath: "name", namespacePath: "namespace", wantName: "plain", wantNamespace: undefined },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const got = setResponsesToolCallIdentity(j(tc.input), tc.toolName, tc.namespace, tc.itemPath);
      expect(getAt(got, tc.namePath)).toBe(tc.wantName);
      expect(getAt(got, tc.namespacePath)).toBe(tc.wantNamespace);
    });
  }
});

describe("extractResponsesCallID", () => {
  const cases = [
    { name: "call_id standard", input: '{"call_id":"call_1"}', expected: "call_1" },
    { name: "tool_call_id", input: '{"tool_call_id":"call_2"}', expected: "call_2" },
    { name: "callId", input: '{"callId":"call_3"}', expected: "call_3" },
    { name: "id fallback", input: '{"id":"call_4"}', expected: "call_4" },
    { name: "dedicated call_id takes precedence over id", input: '{"id":"item_5","call_id":"call_5"}', expected: "call_5" },
    { name: "tool_call_id takes precedence over id", input: '{"id":"item_6","tool_call_id":"call_6"}', expected: "call_6" },
    { name: "callId takes precedence over id", input: '{"id":"item_7","callId":"call_7"}', expected: "call_7" },
    { name: "empty", input: '{"output":"result"}', expected: "" },
    { name: "fco item id is ignored", input: '{"id":"fco_01a08664-2d16-7a91-8ab2-2eccd49e4c3e"}', expected: "" },
    { name: "fco item id with explicit call_id retains call_id", input: '{"id":"fco_01a08664-2d16-7a91-8ab2-2eccd49e4c3e","call_id":"call_1"}', expected: "call_1" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(extractResponsesCallID(j(tc.input))).toBe(tc.expected);
    });
  }
});

describe("normalizeResponsesToolCallOutputs", () => {
  const callID = (item: unknown): string => gstr(getAt(item, "call_id"));

  test("preserves explicit call_id and fills missing in reverse order", () => {
    const items = j(`[
      {"type":"function_call","call_id":"call_a","name":"tool_a"},
      {"type":"function_call","call_id":"call_b","name":"tool_b"},
      {"type":"function_call_output","output":"result_b"},
      {"type":"function_call_output","tool_call_id":"call_a","output":"result_a"}
    ]`) as unknown[];
    const normalized = normalizeResponsesToolCallOutputs(items);
    expect(normalized.length).toBe(4);
    expect(callID(normalized[2])).toBe("call_b");
    expect(callID(normalized[3])).toBe("call_a");
  });

  test("preserves explicit call_id across intervening user message", () => {
    const items = j(`[
      {"type":"function_call","call_id":"call_a","name":"tool_a"},
      {"type":"function_call","call_id":"call_b","name":"tool_b"},
      {"type":"function_call_output","output":"result_b"},
      {"type":"message","role":"user","content":[{"type":"input_text","text":"intervening"}]},
      {"type":"function_call_output","call_id":"call_a","output":"result_a"}
    ]`) as unknown[];
    const normalized = normalizeResponsesToolCallOutputs(items);
    expect(normalized.length).toBe(5);
    expect(callID(normalized[2])).toBe("call_b");
    expect(callID(normalized[4])).toBe("call_a");
  });

  test("does not steal explicit unmatched call_id", () => {
    const items = j('[{"type":"function_call","call_id":"call_a","name":"tool_a"},{"type":"function_call_output","call_id":"call_other","output":"result_other"}]') as unknown[];
    expect(callID(normalizeResponsesToolCallOutputs(items)[1])).toBe("call_other");
  });

  test("pairs function_call_output with fco item id and no call_id using fallback", () => {
    const items = j('[{"type":"function_call","call_id":"call_1788961125480214178_817","name":"Bash"},{"type":"function_call_output","id":"fco_01a08664-2d16-7a91-8ab2-2eccd49e4c3e","output":"result"}]') as unknown[];
    const normalized = normalizeResponsesToolCallOutputs(items);
    expect(normalized.length).toBe(2);
    expect(callID(normalized[1])).toBe("call_1788961125480214178_817");
  });

  test("preserves explicit call_id while pairing fco item id output via fallback", () => {
    const items = j(`[
      {"type":"function_call","call_id":"call_a","name":"tool_a"},
      {"type":"function_call","call_id":"call_b","name":"tool_b"},
      {"type":"function_call_output","id":"fco_b","output":"result_b"},
      {"type":"function_call_output","call_id":"call_a","output":"result_a"}
    ]`) as unknown[];
    const normalized = normalizeResponsesToolCallOutputs(items);
    expect(normalized.length).toBe(4);
    expect(callID(normalized[2])).toBe("call_b");
    expect(callID(normalized[3])).toBe("call_a");
  });
});

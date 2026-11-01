// Ported from: internal/translator/common/openai_tools_test.go
// Skipped cases: preserves numeric precision and raw byte content (messages are parsed objects, so the raw-byte/large-int check is replaced by an object-identity check)
import { describe, expect, test } from "bun:test";
import { alignOpenAIToolCallMessages } from "../../../src/translator/common/openai_tools.ts";
import { getAt, gstr } from "../../../src/util/gpath.ts";

const j = (s: string): unknown => JSON.parse(s);
const roles = (msgs: unknown[]): string[] => msgs.map((m) => gstr(getAt(m, "role")));

function expectUntouched(got: unknown[], messages: unknown[]): void {
  expect(got.length).toBe(messages.length);
  for (let i = 0; i < messages.length; i++) expect(got[i]).toBe(messages[i]);
}

describe("alignOpenAIToolCallMessages", () => {
  test("empty or single message unchanged", () => {
    const empty: unknown[] = [];
    expect(alignOpenAIToolCallMessages(empty)).toBe(empty);
    const single = [j('{"role":"user","content":"hi"}')];
    expect(alignOpenAIToolCallMessages(single)).toBe(single);
  });

  test("already adjacent messages remain unchanged", () => {
    const messages = [
      j('{"role":"user","content":"start"}'),
      j('{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"f1"}}]}'),
      j('{"role":"tool","tool_call_id":"call_1","content":"res1"}'),
      j('{"role":"assistant","content":"done"}'),
    ];
    expectUntouched(alignOpenAIToolCallMessages(messages), messages);
  });

  test("reorders separated tool results to follow assistant", () => {
    const messages = [
      j('{"role":"user","content":"start"}'),
      j('{"role":"assistant","tool_calls":[{"id":"call_a","type":"function"},{"id":"call_b","type":"function"}]}'),
      j('{"role":"assistant","content":"thinking part","reasoning_content":"step 1"}'),
      j('{"role":"user","content":"system reminder"}'),
      j('{"role":"tool","tool_call_id":"call_b","content":"res_b"}'),
      j('{"role":"tool","tool_call_id":"call_a","content":"res_a"}'),
      j('{"role":"user","content":"final prompt"}'),
    ];
    const got = alignOpenAIToolCallMessages(messages);
    expect(got.length).toBe(7);
    expect(roles(got)).toEqual(["user", "assistant", "tool", "tool", "assistant", "user", "user"]);
    expect(getAt(got[2], "tool_call_id")).toBe("call_b");
    expect(getAt(got[3], "tool_call_id")).toBe("call_a");
    expect(getAt(got[4], "reasoning_content")).toBe("step 1");
    expect(getAt(got[5], "content")).toBe("system reminder");
  });

  test("leaves incomplete tool calls untouched", () => {
    const messages = [
      j('{"role":"assistant","tool_calls":[{"id":"call_1"},{"id":"call_2"}]}'),
      j('{"role":"user","content":"middle"}'),
      j('{"role":"tool","tool_call_id":"call_1","content":"res1"}'),
    ];
    expectUntouched(alignOpenAIToolCallMessages(messages), messages);
  });

  test("leaves orphan tool messages untouched", () => {
    const messages = [j('{"role":"user","content":"start"}'), j('{"role":"tool","tool_call_id":"call_orphan","content":"orphan"}')];
    expectUntouched(alignOpenAIToolCallMessages(messages), messages);
  });

  test("leaves ambiguous duplicate call IDs untouched", () => {
    const messages = [
      j('{"role":"assistant","tool_calls":[{"id":"dup_call"}]}'),
      j('{"role":"assistant","tool_calls":[{"id":"dup_call"}]}'),
      j('{"role":"user","content":"middle"}'),
      j('{"role":"tool","tool_call_id":"dup_call","content":"res"}'),
    ];
    expectUntouched(alignOpenAIToolCallMessages(messages), messages);
  });

  test("leaves assistant with mixed empty ID untouched", () => {
    const messages = [
      j('{"role":"assistant","tool_calls":[{"id":""},{"id":"call_a"}]}'),
      j('{"role":"user","content":"reminder"}'),
      j('{"role":"tool","tool_call_id":"call_a","content":"res_a"}'),
    ];
    expectUntouched(alignOpenAIToolCallMessages(messages), messages);
  });

  test("preserves message identity and content when reordering", () => {
    const assistant = j('{"custom_id":922337203685,"precise_ratio":0.12345678901234567,"role":"assistant","tool_calls":[{"function":{"name":"p"},"id":"call_p","type":"function"}]}');
    const tool = j('{"content":"ok","role":"tool","timestamp_ns":1789703256000,"tool_call_id":"call_p"}');
    const user = j('{"content":"intervening","role":"user"}');
    const got = alignOpenAIToolCallMessages([assistant, user, tool]);
    expect(got.length).toBe(3);
    expect(got[0]).toBe(assistant);
    expect(got[1]).toBe(tool);
    expect(got[2]).toBe(user);
  });

  test("leaves causal violation untouched when result precedes call", () => {
    const messages = [j('{"role":"tool","tool_call_id":"call_future","content":"res"}'), j('{"role":"assistant","tool_calls":[{"id":"call_future"}]}')];
    expectUntouched(alignOpenAIToolCallMessages(messages), messages);
  });

  test("reorders multiple interleaved assistant turns independently", () => {
    const messages = [
      j('{"role":"assistant","tool_calls":[{"id":"call_1"}]}'),
      j('{"role":"user","content":"reminder 1"}'),
      j('{"role":"tool","tool_call_id":"call_1","content":"res 1"}'),
      j('{"role":"assistant","tool_calls":[{"id":"call_2"}]}'),
      j('{"role":"user","content":"reminder 2"}'),
      j('{"role":"tool","tool_call_id":"call_2","content":"res 2"}'),
    ];
    const got = alignOpenAIToolCallMessages(messages);
    expect(got.length).toBe(6);
    expect(roles(got)).toEqual(["assistant", "tool", "user", "assistant", "tool", "user"]);
    expect(getAt(got[1], "tool_call_id")).toBe("call_1");
    expect(getAt(got[4], "tool_call_id")).toBe("call_2");
  });
});

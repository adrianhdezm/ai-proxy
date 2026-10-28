// Ported from: internal/translator/common/claude_user_id_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { deriveClaudeUserID } from "../../../src/translator/common/claude_user_id.ts";

const validID = (id: string): void => {
  expect(id).not.toBe("");
  expect(id).not.toBe("unknown");
};

test("same conversation is stable", () => {
  const raw = '{"model":"claude-test","messages":[{"role":"user","content":"hello"}]}';
  const first = deriveClaudeUserID(raw);
  expect(first).not.toBe("");
  expect(deriveClaudeUserID(raw)).toBe(first);
});

describe("preserves caller-supplied metadata.user_id", () => {
  const cases = [
    { name: "plain string", rawJSON: '{"model":"claude-test","metadata":{"user_id":"caller-123"},"messages":[{"role":"user","content":"hello"}]}', expected: "caller-123" },
    { name: "whitespace preserved", rawJSON: '{"model":"claude-test","metadata":{"user_id":"  caller-spaces  "},"messages":[{"role":"user","content":"hello"}]}', expected: "  caller-spaces  " },
    { name: "special characters", rawJSON: '{"model":"claude-test","metadata":{"user_id":"foo\\"bar\\nbaz\\\\qux"},"messages":[{"role":"user","content":"hello"}]}', expected: 'foo"bar\nbaz\\qux' },
    {
      name: "claude code json string",
      rawJSON: '{"model":"claude-test","metadata":{"user_id":"{\\"device_id\\":\\"dev-1\\",\\"session_id\\":\\"sess-1\\"}"},"messages":[{"role":"user","content":"hello"}]}',
      expected: '{"device_id":"dev-1","session_id":"sess-1"}',
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(deriveClaudeUserID(tc.rawJSON)).toBe(tc.expected);
    });
  }
});

test("preserves OpenAI user field", () => {
  expect(deriveClaudeUserID('{"model":"claude-test","user":"openai-user-456","messages":[{"role":"user","content":"hello"}]}')).toBe("openai-user-456");
});

test("metadata.user_id takes priority over user field", () => {
  expect(deriveClaudeUserID('{"model":"claude-test","metadata":{"user_id":"meta-user-1"},"user":"openai-user-2","messages":[{"role":"user","content":"hello"}]}')).toBe("meta-user-1");
});

test("case-insensitive user role", () => {
  const idA = deriveClaudeUserID('{"model":"claude-test","messages":[{"role":"User","content":"message A"}]}');
  const idB = deriveClaudeUserID('{"model":"claude-test","messages":[{"role":"USER","content":"message B"}]}');
  validID(idA);
  validID(idB);
  expect(idA).not.toBe(idB);
});

test("ignores non-string metadata.user_id or user", () => {
  const got = deriveClaudeUserID('{"model":"claude-test","metadata":{"user_id":12345},"user":true,"messages":[{"role":"user","content":"hello"}]}');
  expect(got).not.toBe("");
  expect(got).not.toBe("12345");
  expect(got).not.toBe("true");
});

test("different sessions are different", () => {
  const idA = deriveClaudeUserID('{"model":"claude-test","prompt_cache_key":"session-a","messages":[{"role":"user","content":"hello"}]}');
  const idB = deriveClaudeUserID('{"model":"claude-test","prompt_cache_key":"session-b","messages":[{"role":"user","content":"hello"}]}');
  expect(idA).not.toBe(idB);
});

test("session_id variants", () => {
  const idA = deriveClaudeUserID('{"model":"claude-test","session_id":"sess-a","messages":[{"role":"user","content":"hello"}]}');
  const idB = deriveClaudeUserID('{"model":"claude-test","sessionId":"sess-b","messages":[{"role":"user","content":"hello"}]}');
  expect(idA).not.toBe("");
  expect(idB).not.toBe("");
  expect(idA).not.toBe(idB);
});

test("conversation id variants", () => {
  const idObj = deriveClaudeUserID('{"model":"claude-test","conversation":{"id":"conv-1"},"messages":[{"role":"user","content":"hello"}]}');
  const idStr = deriveClaudeUserID('{"model":"claude-test","conversation":"conv-2","messages":[{"role":"user","content":"hello"}]}');
  const idFlat = deriveClaudeUserID('{"model":"claude-test","conversation_id":"conv-3","messages":[{"role":"user","content":"hello"}]}');
  for (const id of [idObj, idStr, idFlat]) expect(id).not.toBe("");
  expect(idObj).not.toBe(idStr);
  expect(idObj).not.toBe(idFlat);
  expect(idStr).not.toBe(idFlat);
});

test("turn growth keeps same user_id", () => {
  const first = deriveClaudeUserID('{"model":"claude-test","prompt_cache_key":"session-1","messages":[{"role":"user","content":"hello"}]}');
  const second = deriveClaudeUserID('{"model":"claude-test","prompt_cache_key":"session-1","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":"follow up"}]}');
  expect(first).toBe(second);
});

test("turn growth without session key keeps same user_id", () => {
  const first = deriveClaudeUserID('{"model":"claude-test","messages":[{"role":"user","content":"first prompt"}]}');
  const second = deriveClaudeUserID('{"model":"claude-test","messages":[{"role":"user","content":"first prompt"},{"role":"assistant","content":"hi"},{"role":"user","content":"second prompt"}]}');
  validID(first);
  expect(first).toBe(second);
});

test("gemini turn growth without session key keeps same user_id", () => {
  const first = deriveClaudeUserID('{"contents":[{"role":"user","parts":[{"text":"first gemini prompt"}]}]}');
  const second = deriveClaudeUserID('{"contents":[{"role":"user","parts":[{"text":"first gemini prompt"}]},{"role":"model","parts":[{"text":"answer"}]},{"role":"user","parts":[{"text":"second prompt"}]}]}');
  validID(first);
  expect(first).toBe(second);
});

test("first message fallback", () => {
  const idA = deriveClaudeUserID('{"model":"claude-test","messages":[{"role":"user","content":"message A"}]}');
  const idB = deriveClaudeUserID('{"model":"claude-test","messages":[{"role":"user","content":"message B"}]}');
  validID(idA);
  validID(idB);
  expect(idA).not.toBe(idB);
});

test("responses input string", () => {
  const idA = deriveClaudeUserID('{"model":"claude-test","input":"hello world A"}');
  const idB = deriveClaudeUserID('{"model":"claude-test","input":"hello world B"}');
  validID(idA);
  validID(idB);
  expect(idA).not.toBe(idB);
});

test("responses input array skips system-level items", () => {
  const build = (text: string): string =>
    JSON.stringify({
      model: "claude-test",
      input: [
        { type: "message", role: "system", content: "system prompt" },
        { type: "message", role: "developer", content: "dev prompt" },
        { type: "message", role: "user", content: [{ type: "input_text", text }] },
      ],
    });
  const idA = deriveClaudeUserID(build("user message A"));
  const idB = deriveClaudeUserID(build("user message B"));
  validID(idA);
  validID(idB);
  expect(idA).not.toBe(idB);
});

test("gemini contents default role", () => {
  const idA = deriveClaudeUserID('{"contents":[{"parts":[{"text":"gemini message A"}]}]}');
  const idB = deriveClaudeUserID('{"contents":[{"parts":[{"text":"gemini message B"}]}]}');
  validID(idA);
  validID(idB);
  expect(idA).not.toBe(idB);
});

test("gemini contents multiple text parts", () => {
  const idA = deriveClaudeUserID('{"contents":[{"role":"user","parts":[{"text":"Prefix"},{"text":"Question A"}]}]}');
  const idB = deriveClaudeUserID('{"contents":[{"role":"user","parts":[{"text":"Prefix"},{"text":"Question B"}]}]}');
  validID(idA);
  validID(idB);
  expect(idA).not.toBe(idB);
});

test("gemini contents skips thought parts", () => {
  const id1 = deriveClaudeUserID('{"contents":[{"role":"user","parts":[{"thought":true,"text":"internal thought"},{"text":"visible content"}]}]}');
  const id2 = deriveClaudeUserID('{"contents":[{"role":"user","parts":[{"text":"visible content"}]}]}');
  expect(id1).toBe(id2);
});

test("gemini systemInstruction", () => {
  const idCamel = deriveClaudeUserID('{"systemInstruction":{"parts":[{"text":"system rule A"}]}}');
  const idSnake = deriveClaudeUserID('{"system_instruction":{"parts":[{"text":"system rule B"}]}}');
  validID(idCamel);
  validID(idSnake);
  expect(idCamel).not.toBe(idSnake);
});

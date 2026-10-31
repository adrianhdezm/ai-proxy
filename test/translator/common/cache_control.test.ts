// Ported from: internal/translator/common/cache_control_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { attachCacheControl, attachMessageCacheControl, attachToolMessageCacheControl } from "../../../src/translator/common/cache_control.ts";
import { getAt } from "../../../src/util/gpath.ts";

const parse = (s: string): unknown => JSON.parse(s);

test("AttachCacheControl copies object", () => {
  const src = parse('{"text":"hi","cache_control":{"type":"ephemeral","ttl":"5m"}}');
  const out = attachCacheControl(parse('{"type":"text","text":"hi"}'), src);
  expect(getAt(out, "cache_control.type")).toBe("ephemeral");
  expect(getAt(out, "cache_control.ttl")).toBe("5m");
});

test("AttachCacheControl ignores missing", () => {
  const out = attachCacheControl(parse('{"type":"text","text":"hi"}'), parse('{"text":"hi"}'));
  expect(getAt(out, "cache_control")).toBeUndefined();
});

test("AttachMessageCacheControl promotes string content", () => {
  const src = parse('{"role":"user","content":"hi","cache_control":{"type":"ephemeral"}}');
  const out = attachMessageCacheControl(parse('{"role":"user","content":"hi"}'), src);
  expect(getAt(out, "content.0.type")).toBe("text");
  expect(getAt(out, "content.0.text")).toBe("hi");
  expect(getAt(out, "content.0.cache_control.type")).toBe("ephemeral");
});

test("AttachMessageCacheControl skips when last part has cache_control", () => {
  const src = parse('{"cache_control":{"type":"ephemeral","ttl":"1h"}}');
  const out = attachMessageCacheControl(parse('{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}'), src);
  expect(getAt(out, "content.0.cache_control.ttl")).toBeUndefined();
});

test("AttachToolMessageCacheControl hoists part level", () => {
  const src = parse('{"role":"tool","content":[{"type":"text","text":"4","cache_control":{"type":"ephemeral"}}],"cache_control":{"type":"ephemeral","ttl":"1h"}}');
  const out = attachToolMessageCacheControl(parse('{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"4"}]}]}'), src);
  expect(getAt(out, "content.0.cache_control.type")).toBe("ephemeral");
  expect(getAt(out, "content.0.cache_control.ttl")).toBeUndefined();
});

describe("AttachToolMessageCacheControl invalid part does not block message level", () => {
  const cases = [
    { name: "empty object", partCCJSON: "{}" },
    { name: "invalid type string", partCCJSON: '{"type":"invalid"}' },
    { name: "whitespace padded type", partCCJSON: '{"type":" ephemeral "}' },
    { name: "non-string type", partCCJSON: '{"type":123}' },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const src = parse(`{"role":"tool","content":[{"type":"text","text":"4","cache_control":${tc.partCCJSON}}],"cache_control":{"type":"ephemeral","ttl":"1h"}}`);
      const out = attachToolMessageCacheControl(parse('{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"4"}]}]}'), src);
      expect(getAt(out, "content.0.cache_control.type")).toBe("ephemeral");
      expect(getAt(out, "content.0.cache_control.ttl")).toBe("1h");
    });
  }
});

test("AttachToolMessageCacheControl no tool_result leaves message untouched", () => {
  const src = parse('{"role":"tool","cache_control":{"type":"ephemeral"}}');
  const out = attachToolMessageCacheControl(parse('{"role":"user","content":[{"type":"text","text":"just text"}]}'), src);
  expect(getAt(out, "content.0.cache_control")).toBeUndefined();
});

describe("AttachMessageCacheControl skips empty and whitespace text blocks", () => {
  const src = parse('{"cache_control":{"type":"ephemeral"}}');

  test("picks last non-empty block when trailing blocks are empty", () => {
    const out = attachMessageCacheControl(parse('{"role":"user","content":[{"type":"text","text":"hello"},{"type":"text","text":""},{"type":"text","text":"   "}]}'), src);
    expect(getAt(out, "content.0.cache_control.type")).toBe("ephemeral");
    expect(getAt(out, "content.1.cache_control")).toBeUndefined();
    expect(getAt(out, "content.2.cache_control")).toBeUndefined();
  });

  test("skips when all blocks or string are empty", () => {
    for (const msg of ['{"role":"user","content":""}', '{"role":"user","content":"   "}', '{"role":"user","content":[{"type":"text","text":""},{"type":"text","text":" \\n "}]}']) {
      const out = attachMessageCacheControl(parse(msg), src);
      expect(getAt(out, "content.0.cache_control")).toBeUndefined();
    }
  });
});

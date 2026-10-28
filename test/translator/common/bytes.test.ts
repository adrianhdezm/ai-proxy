// Ported from: internal/translator/common/bytes_test.go
// Skipped cases: TestNewRawArrayItems (Go slice capacity helper has no TS equivalent)
import { describe, expect, test } from "bun:test";
import { getFromJSON, joinRawArray, setRawArrayItems, setStringWithoutHTMLEscape, sseEventData } from "../../../src/translator/common/bytes.ts";

describe("joinRawArray", () => {
  const tests: { name: string; items: string[]; want: string }[] = [
    { name: "empty", items: [], want: "[]" },
    { name: "single", items: ['{"id":1}'], want: '[{"id":1}]' },
    { name: "multiple", items: ['{"id":1}', '{"id":2}'], want: '[{"id":1},{"id":2}]' },
  ];
  for (const tc of tests) {
    test(tc.name, () => {
      expect(joinRawArray(tc.items)).toBe(tc.want);
    });
  }
});

describe("setRawArrayItems", () => {
  const tests: { name: string; data: string; path: string; items: string[]; want: string }[] = [
    { name: "empty", data: '{"items":[]}', path: "items", items: [], want: '{"items":[]}' },
    {
      name: "single nested",
      data: '{"before":1,"request":{"contents":[]},"after":2}',
      path: "request.contents",
      items: ['{"id":1}'],
      want: '{"before":1,"request":{"contents":[{"id":1}]},"after":2}',
    },
    { name: "single fallback", data: '{"items":[{"old":1},{"old":2}]}', path: "items", items: ['{"id":1}'], want: '{"items":[{"id":1}]}' },
    { name: "multiple", data: '{"items":[]}', path: "items", items: ['{"id":1}', '{"id":2}'], want: '{"items":[{"id":1},{"id":2}]}' },
  ];
  for (const tc of tests) {
    test(tc.name, () => {
      expect(setRawArrayItems(tc.data, tc.path, tc.items)).toBe(tc.want);
    });
  }
});

describe("setStringWithoutHTMLEscape", () => {
  const tests: { name: string; data: string; path: string; value: string; want: string }[] = [
    {
      name: "command with redirection and pipe",
      data: '{"arguments":""}',
      path: "arguments",
      value: "gh issue view 5802 --json number,title,body,url,state,labels,assignees 2>&1 | head -100",
      want: '{"arguments":"gh issue view 5802 --json number,title,body,url,state,labels,assignees 2>&1 | head -100"}',
    },
    {
      name: "json string arguments containing redirection",
      data: '{"arguments":""}',
      path: "arguments",
      value: '{"command": "gh issue view 5802 2>&1 | head -100", "timeout": 60}',
      want: '{"arguments":"{\\"command\\": \\"gh issue view 5802 2>&1 | head -100\\", \\"timeout\\": 60}"}',
    },
    {
      name: "html tags preserved without escaping",
      data: '{"type":"function_call","name":"bash","arguments":""}',
      path: "arguments",
      value: '{"html": "<tag>&value</tag>"}',
      want: '{"type":"function_call","name":"bash","arguments":"{\\"html\\": \\"<tag>&value</tag>\\"}"}',
    },
    { name: "nested path", data: '{"item":{"arguments":""}}', path: "item.arguments", value: "2>&1", want: '{"item":{"arguments":"2>&1"}}' },
    { name: "empty string", data: '{"arguments":"old"}', path: "arguments", value: "", want: '{"arguments":""}' },
    {
      name: "newlines tabs and backslashes",
      data: '{"arguments":""}',
      path: "arguments",
      value: "line1\nline2\t\\path\\to\\file",
      want: '{"arguments":"line1\\nline2\\t\\\\path\\\\to\\\\file"}',
    },
    { name: "unicode and emoji", data: '{"arguments":""}', path: "arguments", value: "你好，世界！🚀 <&>", want: '{"arguments":"你好，世界！🚀 <&>"}' },
  ];
  for (const tc of tests) {
    test(tc.name, () => {
      const got = setStringWithoutHTMLEscape(tc.data, tc.path, tc.value);
      expect(got).toBe(tc.want);
      expect(getFromJSON(got, tc.path)).toBe(tc.value);
    });
  }
});

test("SSEEventData self-terminating frame", () => {
  expect(sseEventData("response.completed", '{"id":"resp_1"}')).toBe('event: response.completed\ndata: {"id":"resp_1"}\n\n');
});

test("SSEEventData concatenated frames separable", () => {
  const concatenated = sseEventData("event1", '{"a":1}') + sseEventData("event2", '{"b":2}');
  const frames = concatenated.split("\n\n");
  expect(frames.length).toBe(3);
  expect(frames[2]).toBe("");
  expect(frames[0]).toBe('event: event1\ndata: {"a":1}');
  expect(frames[1]).toBe('event: event2\ndata: {"b":2}');
});

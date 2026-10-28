// Ported from: internal/translator/common/claude_system_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { buildClaudeStructuredOutputInstruction, systemReminderText } from "../../../src/translator/common/claude_system.ts";

describe("buildClaudeStructuredOutputInstruction", () => {
  test("empty or invalid", () => {
    expect(buildClaudeStructuredOutputInstruction(undefined)).toBe("");
    expect(buildClaudeStructuredOutputInstruction(JSON.parse('{"type":"text"}'))).toBe("");
  });

  test("json_object", () => {
    expect(buildClaudeStructuredOutputInstruction(JSON.parse('{"type":"json_object"}'))).toContain("JSON object");
  });

  test("json_schema with inner schema", () => {
    const input = {
      type: "json_schema",
      json_schema: {
        name: "extracted_facts",
        description: "Facts from text",
        schema: { type: "object", properties: { facts: { type: "array" } } },
      },
    };
    const got = buildClaudeStructuredOutputInstruction(input);
    expect(got).toContain("extracted_facts");
    expect(got).toContain("Facts from text");
    expect(got).toContain('"properties"');
  });

  test("json_schema flat schema", () => {
    const got = buildClaudeStructuredOutputInstruction({ type: "json_schema", schema: { type: "object", properties: { key: { type: "string" } } } });
    expect(got).toContain("key");
  });

  test("json_schema without schema falls back to json_object instruction", () => {
    expect(buildClaudeStructuredOutputInstruction({ type: "json_schema" })).toContain("JSON object");
  });
});

test("systemReminderText", () => {
  expect(systemReminderText("Please call a tool now.")).toBe("<system-reminder>\nPlease call a tool now.\n</system-reminder>");
});

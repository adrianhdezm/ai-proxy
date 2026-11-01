// Ported from: internal/translator/codex/claude/noop_optimization_test.go
// Skipped cases: none (ported as a behavioural assertion, not an allocation count)
import { expect, test } from "bun:test";
import { convertClaudeRequestToCodex } from "../../../src/translator/codex/claude/index.ts";
import { get } from "./helpers.ts";

test("ConvertClaudeRequestToCodex normalizes non-string tool name", () => {
  const input = `{"messages":[],"tools":[{"name":123,"input_schema":{"type":"object"}}]}`;
  const output = convertClaudeRequestToCodex("gpt-test", input, false);
  const name = get(output, "tools.0.name");
  expect(typeof name).toBe("string");
  expect(name).toBe("123");
});

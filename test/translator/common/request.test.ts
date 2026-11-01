// Ported from: internal/translator/common/request_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { generateClaudeToolCallID, requestModelName } from "../../../src/translator/common/request.ts";

test("requestModelName prefers original request", () => {
  expect(requestModelName('{"model":"original-model"}', '{"model":"translated-model"}')).toBe("original-model");
});

test("requestModelName supports wrapped request", () => {
  expect(requestModelName(undefined, '{"request":{"model":"wrapped-model"}}')).toBe("wrapped-model");
});

test("generateClaudeToolCallID", () => {
  const id = generateClaudeToolCallID();
  expect(id.length).toBe(30);
  expect(id.slice(0, 6)).toBe("toolu_");
  expect(id.slice(6)).toMatch(/^[a-zA-Z0-9]{24}$/);
});

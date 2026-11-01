// Ported from: sdk/cliproxy/executor/types_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { responseFormatOrSource, type ExecOptions } from "../../src/executor/types.ts";

test("TestResponseFormatOrSourceUsesExplicitResponseFormat", () => {
  const opts = { stream: false, sourceFormat: "openai", responseFormat: "claude" } as ExecOptions;
  expect(responseFormatOrSource(opts)).toBe("claude" as ExecOptions["sourceFormat"]);
});

test("TestResponseFormatOrSourceFallsBackToSourceFormat", () => {
  const opts = { stream: false, sourceFormat: "gemini" } as ExecOptions;
  expect(responseFormatOrSource(opts)).toBe("gemini" as ExecOptions["sourceFormat"]);
});

// Ported from: internal/runtime/executor/helps/codex_terminal_incomplete_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { hasMeaningfulCodexOutputDelta, isCodexTerminalEmptyIncomplete } from "../../../src/executor/codex/index.ts";

test("TestHasMeaningfulCodexOutputDelta", () => {
  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.output_text.delta","delta":""}`)).toBe(false);
  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.output_text.delta","delta":"   "}`)).toBe(false);
  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.reasoning_text.delta","delta":""}`)).toBe(false);
  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.function_call_arguments.delta","delta":""}`)).toBe(false);

  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.output_text.delta","delta":"Hello"}`)).toBe(true);
  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.reasoning_text.delta","delta":"thinking"}`)).toBe(true);
  expect(hasMeaningfulCodexOutputDelta(`{"type":"response.function_call_arguments.delta","delta":"{\\"id\\":1}"}`)).toBe(true);
});

test("TestIsCodexTerminalEmptyIncomplete", () => {
  const trueEmpty = `{"type":"response.incomplete","response":{"id":"r1","output":[],"usage":{"output_tokens":0}}}`;
  expect(isCodexTerminalEmptyIncomplete(trueEmpty, 0, false)).toBe(true);
  expect(isCodexTerminalEmptyIncomplete(trueEmpty, 0, true)).toBe(false);
  expect(isCodexTerminalEmptyIncomplete(trueEmpty, 1, false)).toBe(false);

  const positiveTokens = `{"type":"response.incomplete","response":{"id":"r1","output":[],"usage":{"output_tokens":5}}}`;
  expect(isCodexTerminalEmptyIncomplete(positiveTokens, 0, false)).toBe(false);
  const floatTokens = `{"type":"response.incomplete","response":{"id":"r1","output":[],"usage":{"output_tokens":0.5}}}`;
  expect(isCodexTerminalEmptyIncomplete(floatTokens, 0, false)).toBe(false);
  const missingTokens = `{"type":"response.incomplete","response":{"id":"r1","output":[],"usage":{}}}`;
  expect(isCodexTerminalEmptyIncomplete(missingTokens, 0, false)).toBe(false);
  const nullTokens = `{"type":"response.incomplete","response":{"id":"r1","output":[],"usage":{"output_tokens":null}}}`;
  expect(isCodexTerminalEmptyIncomplete(nullTokens, 0, false)).toBe(false);
  const nonEmptyOutput = `{"type":"response.incomplete","response":{"id":"r1","output":[{"type":"message"}],"usage":{"output_tokens":0}}}`;
  expect(isCodexTerminalEmptyIncomplete(nonEmptyOutput, 0, false)).toBe(false);
  const completedEvent = `{"type":"response.completed","response":{"id":"r1","output":[],"usage":{"output_tokens":0}}}`;
  expect(isCodexTerminalEmptyIncomplete(completedEvent, 0, false)).toBe(false);
});

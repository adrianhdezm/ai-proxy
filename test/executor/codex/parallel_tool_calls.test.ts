// Ported from: internal/runtime/executor/codex_executor_parallel_tool_calls_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { codexResponsesLiteHeader, normalizeCodexParallelToolCalls, normalizeCodexParallelToolCallsForTools } from "../../../src/executor/codex/index.ts";
import { getValue } from "./helpers.ts";

test("TestNormalizeCodexParallelToolCallsForTools_DropsWhenToolsMissing", () => {
  const out = normalizeCodexParallelToolCallsForTools(`{"model":"gpt-5.4","parallel_tool_calls":true,"input":"hi"}`);
  expect(getValue(out, "parallel_tool_calls")).toBeUndefined();
});

test("TestNormalizeCodexParallelToolCallsForTools_DropsWhenToolsEmpty", () => {
  const out = normalizeCodexParallelToolCallsForTools(`{"model":"gpt-5.4","tools":[],"parallel_tool_calls":false,"input":"hi"}`);
  expect(getValue(out, "parallel_tool_calls")).toBeUndefined();
  expect(getValue(out, "tools")).toBeDefined();
});

test("TestNormalizeCodexParallelToolCallsForTools_PreservesWhenToolsPresent", () => {
  const out = normalizeCodexParallelToolCallsForTools(`{"model":"gpt-5.4","tools":[{"type":"function","name":"lookup"}],"parallel_tool_calls":true,"input":"hi"}`);
  expect(getValue(out, "parallel_tool_calls")).toBe(true);
});

test("TestNormalizeCodexParallelToolCalls_ResponsesLiteMetadataForcesFalse", () => {
  const body = `{"model":"gpt-5.6-luna","tools":[{"type":"function","name":"lookup"}],"parallel_tool_calls":true,"client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":"true"},"input":"hi"}`;
  expect(getValue(normalizeCodexParallelToolCalls(body, undefined), "parallel_tool_calls")).toBe(false);
});

test("TestNormalizeCodexParallelToolCalls_ResponsesLiteHeaderForcesFalse", () => {
  const headers = new Headers({ [codexResponsesLiteHeader]: "true" });
  const out = normalizeCodexParallelToolCalls(`{"model":"gpt-5.6-luna","parallel_tool_calls":true,"input":"hi"}`, headers);
  expect(getValue(out, "parallel_tool_calls")).toBe(false);
});

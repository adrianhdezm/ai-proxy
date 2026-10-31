// Ported from: internal/translator/openai/openai/responses/custom_tool_namespace_recovery_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { canonicalResponsesToolName, convertOpenAIResponsesRequestToOpenAIChatCompletions } from "../../../../../src/translator/openai/openai/responses/index.ts";
import { Stream, get, has, nonStream, q, str } from "./helpers.ts";

const namespaceRecoveryRequest = `{"input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"},{"type":"function","name":"wait"}]}]}]}`;

function assertRecoveredCustomCall(item: unknown, withInput: boolean): void {
  for (const [key, want] of Object.entries({ type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "call_fixture" })) {
    expect(str(item, key)).toBe(want);
  }
  if (withInput) expect(str(item, "input")).toBe('text("测试\\n");');
  expect(has(item, "arguments")).toBe(false);
}

describe("CustomToolNamespaceRecoveryPreservesStreamAndNonStream", () => {
  for (const name of ["functions__exec", "exec"]) {
    test(name, () => {
      const args = `{"input":"text(\\"测试\\\\n\\");"}`;
      const call = `{"index":0,"id":"call_fixture","type":"function","function":{"name":${q(name)},"arguments":${q(args)}}}`;
      const raw = `{"id":"fixture","choices":[{"index":0,"message":{"tool_calls":[${call}]},"finish_reason":"tool_calls"}]}`;
      assertRecoveredCustomCall(get(nonStream(namespaceRecoveryRequest, "", raw), "output.0"), true);
      const s = new Stream(namespaceRecoveryRequest, "", "fixture");
      const counts: Record<string, number> = {};
      for (const line of [`data: {"id":"fixture","choices":[{"index":0,"delta":{"tool_calls":[${call}]},"finish_reason":"tool_calls"}]}`, "data: [DONE]"]) {
        for (const { event, data } of s.feed(line)) {
          counts[event] = (counts[event] ?? 0) + 1;
          if (event === "response.output_item.added" || event === "response.output_item.done") assertRecoveredCustomCall(get(data, "item"), event === "response.output_item.done");
          else if (event === "response.completed") assertRecoveredCustomCall(get(data, "response.output.0"), true);
          else expect(event.startsWith("response.function_call_arguments.")).toBe(false);
        }
      }
      for (const event of ["response.output_item.added", "response.output_item.done", "response.completed", "response.custom_tool_call_input.done"]) {
        expect(counts[event], event).toBe(1);
      }
    });
  }
});

test("CustomToolReplayPreservesNamespaceAndResultPair", () => {
  for (const namespace of [`,"namespace":"functions"`, ""]) {
    const request =
      namespaceRecoveryRequest.slice(0, -2) +
      `,{"type":"custom_tool_call","name":"exec"${namespace},"call_id":"call_fixture","input":"text(1);"},{"type":"custom_tool_call_output","call_id":"call_fixture","output":[{"type":"input_text","text":"1"}]}]}`;
    const body = convertOpenAIResponsesRequestToOpenAIChatCompletions("fixture", request, false);
    expect(str(body, "messages.0.tool_calls.0.function.name")).toBe("functions__exec");
    expect(str(body, "messages.1.tool_call_id")).toBe("call_fixture");
  }
});

test("NamespaceRecoveryDoesNotGuessAmbiguousOrOverrideExactNames", () => {
  for (const tt of [
    { request: namespaceRecoveryRequest, name: "wait", want: "functions__wait" },
    { request: namespaceRecoveryRequest, name: "unknown", want: "unknown" },
    { request: `{"tools":[{"type":"function","name":"exec"},{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]}]}`, name: "exec", want: "exec" },
    {
      request: `{"tools":[{"type":"namespace","name":"first","tools":[{"type":"custom","name":"exec"}]},{"type":"namespace","name":"second","tools":[{"type":"custom","name":"exec"}]}]}`,
      name: "exec",
      want: "exec",
    },
  ]) {
    expect(canonicalResponsesToolName(tt.request, tt.name)).toBe(tt.want);
  }
});

// Ported from: internal/util/responses_tools_test.go
// Skipped cases: TestConvertResponsesToolChoiceToGemini, TestBuildGemini* and TestResponsesToolReverseIdentityMap_* (Responses->Gemini declaration builder is not ported), BuildGeminiFunctionDeclarations assertions inside TestCollectResponsesToolDescriptors_PriorityAndNamespace (same reason)
import { expect, test } from "bun:test";
import { collectResponsesToolDescriptors, collectResponsesToolWinners, unwrapResponsesCustomToolInput } from "../../src/util/responses_tools.ts";

test("CollectResponsesToolDescriptors priority and namespace", () => {
  const raw = `{
    "tools": [{"type": "function", "name": "top_fn", "description": "top function"}],
    "input": [{"type": "additional_tools", "tools": [
      {"type": "namespace", "name": "ns1", "tools": [
        {"type": "function", "name": "child_fn", "description": "child function"},
        {"type": "custom", "name": "child_custom", "description": "child custom"}
      ]},
      {"type": "custom", "name": "direct_custom"}
    ]}]
  }`;
  const descriptors = collectResponsesToolDescriptors(JSON.parse(raw));
  expect(descriptors).toHaveLength(4);
  expect(descriptors.map((d) => d.name)).toEqual(["top_fn", "ns1__child_fn", "ns1__child_custom", "direct_custom"]);
  const childCustom = descriptors[2]!;
  expect(childCustom.localName).toBe("child_custom");
  expect(childCustom.namespace).toBe("ns1");
  expect(childCustom.toolType).toBe("custom");
  expect(childCustom.direct).toBe(false);
  expect(childCustom.sourcePriority).toBe(1);
});

test("ResponsesToolWinners top level beats additional tools", () => {
  const raw = `{
    "tools": [{"type": "function", "name": "shared_fn", "description": "top level"}],
    "input": [{"type": "additional_tools", "tools": [{"type": "function", "name": "shared_fn", "description": "additional"}]}]
  }`;
  const winners = collectResponsesToolWinners(JSON.parse(raw));
  const winner = winners.get("shared_fn")!;
  expect(winner.sourcePriority).toBe(0);
  expect((winner.tool as { description: string }).description).toBe("top level");
});

test("ResponsesToolWinners direct beats namespace child", () => {
  const raw = `{"tools": [
    {"type": "namespace", "name": "n", "tools": [{"type": "function", "name": "x", "description": "namespace child"}]},
    {"type": "custom", "name": "n__x", "description": "direct"}
  ]}`;
  const winner = collectResponsesToolWinners(JSON.parse(raw)).get("n__x")!;
  expect(winner.direct).toBe(true);
  expect(winner.toolType).toBe("custom");
});

test("UnwrapResponsesCustomToolInput", () => {
  expect(unwrapResponsesCustomToolInput(`{"input":"echo hi"}`)).toBe("echo hi");
  expect(unwrapResponsesCustomToolInput(`"plain"`)).toBe("plain");
  expect(unwrapResponsesCustomToolInput(`{}`)).toBe("");
  expect(unwrapResponsesCustomToolInput(`not json`)).toBe("not json");
  expect(unwrapResponsesCustomToolInput(`{"input":{"a":1}}`)).toBe(`{"a":1}`);
});

// Ported from: internal/translator/common/apply_patch_identity_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { ApplyPatchResponsesBridge } from "../../../src/translator/common/apply_patch_responses.ts";
import { get, patchEvent, patchItem, patchJSON, patchResponsesRequest, patchSend } from "./apply_patch_helpers.ts";

describe("named late identity", () => {
  for (const first of ["item", "call", "neither", "neither-item-first", "neither-call-first"]) {
    for (const boundary of ["item", "terminal"]) {
      test(`${first}-${boundary}`, () => {
        const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
        let id = first === "item" ? "a" : "";
        let call = first === "call" ? "c" : "";
        const pending = [patchEvent("response.output_item.added", 0, patchItem("function_call", id, call, "apply_patch", ""))];
        for (const fragment of [`{"input":"p`, `q"}`]) pending.push(`{"type":"response.function_call_arguments.delta","output_index":0,"delta":${patchJSON(fragment)}}`);
        pending.push(`{"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"input\\":\\"pq\\"}"}`);
        for (const event of pending) expect(patchSend(b, event)).toEqual([]);
        if (first.startsWith("neither-")) {
          [id, call] = first === "neither-call-first" ? ["", "c"] : ["a", ""];
          expect(patchSend(b, patchEvent("response.output_item.added", 0, patchItem("function_call", id, call, "apply_patch", "")))).toEqual([]);
        }
        const item = patchItem("function_call", "a", "c", "apply_patch", `{"input":"pq"}`);
        const events: string[] = [];
        if (boundary === "item") events.push(...patchSend(b, patchEvent("response.output_item.done", 0, item)));
        events.push(...patchSend(b, `{"type":"response.completed","response":{"output":[${item}]}}`));
        const counts: Record<string, number> = {};
        const fragments: string[] = [];
        for (const event of events) {
          const root = JSON.parse(event);
          const kind = root.type as string;
          counts[kind] = (counts[kind] ?? 0) + 1;
          let identity = root;
          let idKey = "item_id";
          switch (kind) {
            case "response.output_item.added":
            case "response.output_item.done":
              identity = root.item;
              idKey = "id";
              expect(identity.input ?? "").toBe(kind === "response.output_item.done" ? "pq" : "");
              break;
            case "response.completed":
              identity = root.response.output[0];
              idKey = "id";
              expect(identity.input).toBe("pq");
              break;
            case "response.custom_tool_call_input.done":
              expect(root.input).toBe("pq");
              break;
          }
          if (kind !== "response.completed") expect(root.output_index).toBe(0);
          expect(identity[idKey]).toBe("a");
          expect(identity.call_id).toBe("c");
          if (kind === "response.custom_tool_call_input.delta") fragments.push(root.delta);
        }
        expect(fragments.join("|")).toBe("p|q");
        for (const kind of ["response.output_item.added", "response.custom_tool_call_input.done", "response.output_item.done", "response.completed"]) expect(counts[kind]).toBe(1);
      });
    }
  }
});

describe("named late identity evidence", () => {
  const cases: [string, string, string][] = [
    [
      "seen-item-change",
      patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "", "apply_patch", "")),
      patchEvent("response.output_item.done", 0, patchItem("function_call", "changed", "c", "apply_patch", `{"input":"pq"}`)),
    ],
    [
      "seen-call-change",
      patchEvent("response.output_item.added", 0, patchItem("function_call", "", "c", "apply_patch", "")),
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "changed", "apply_patch", `{"input":"pq"}`)),
    ],
    [
      "partial-snapshot",
      patchEvent("response.output_item.added", 0, patchItem("function_call", "", "", "apply_patch", `{"input":"p`)),
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "c", "apply_patch", `{"input":"pq"}`)),
    ],
    [
      "invalid-snapshot",
      patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "", "apply_patch", `{"input":"pq","extra":1}`)),
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "c", "apply_patch", `{"input":"pq"}`)),
    ],
    [
      "unresolved-terminal",
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "", "apply_patch", `{"input":"pq"}`)),
      `{"type":"response.completed","response":{"output":[]}}`,
    ],
  ];
  for (const [name, before, after] of cases) {
    test(name, () => {
      const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
      let [out, err] = b.transform(before);
      if (!err) {
        expect(out).toEqual([]);
        [out, err] = b.transform(after);
      }
      expect(err).toBeDefined();
      expect(out.length).toBe(1);
      expect(get(out[0]!, "type")).toBe("response.failed");
      expect(b.transform(after)).toEqual([[], undefined]);
    });
  }
});

test("named late identity interleaved", () => {
  const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  const items = [patchItem("function_call", "a0", "", "apply_patch", ""), patchItem("function_call", "", "c1", "apply_patch", "")];
  items.forEach((item, i) => {
    expect(patchSend(b, patchEvent("response.output_item.added", i, item))).toEqual([]);
    expect(patchSend(b, `{"type":"response.function_call_arguments.delta","output_index":${i},"delta":${patchJSON(`{"input":"${i}"}`)}}`)).toEqual([]);
  });
  const events: string[] = [];
  for (const i of [1, 0]) {
    events.push(...patchSend(b, patchEvent("response.output_item.done", i, patchItem("function_call", `a${i}`, `c${i}`, "apply_patch", `{"input":"${i}"}`))));
  }
  events.push(...patchSend(b, `{"type":"response.completed","response":{"output":[]}}`));
  for (const event of events) {
    const root = JSON.parse(event);
    if (root.type === "response.completed") {
      (root.response.output as Record<string, unknown>[]).forEach((item, i) => {
        expect([item.id, item.call_id, item.input]).toEqual([`a${i}`, `c${i}`, `${i}`]);
      });
      continue;
    }
    const i = root.output_index as number;
    const [identity, key] = root.item !== undefined ? [root.item, "id"] : [root, "item_id"];
    expect(identity[key]).toBe(`a${i}`);
    expect(identity.call_id).toBe(`c${i}`);
  }
});

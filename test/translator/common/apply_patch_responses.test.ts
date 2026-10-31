// Ported from: internal/translator/common/apply_patch_responses_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { ApplyPatchResponsesBridge, normalizeApplyPatchResponsesRequest } from "../../../src/translator/common/apply_patch_responses.ts";
import { unwrapApplyPatchInput, wrapApplyPatchInput } from "../../../src/translator/common/apply_patch_tool.ts";
import { get, patchEvent, patchItem, patchJSON, patchResponsesRequest, patchSend } from "./apply_patch_helpers.ts";

const deltaEvent = (index: number, delta: string): string =>
  `{"type":"response.function_call_arguments.delta","output_index":${index},"delta":${patchJSON(delta)}}`;

describe("bridge delta and four completions", () => {
  for (const late of [false, true]) {
    test(`late=${late}`, () => {
      const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
      const name = late ? "" : "apply_patch";
      const events: string[] = [];
      events.push(...patchSend(b, patchEvent("response.output_item.added", 0, patchItem("function_call", "", "", name, ""))));
      const args = `{"input":"*** Begin Patch\\n+中文\\uD83D\\uDE00 \\"\\\\\\n*** End Patch\\n"}`;
      for (const part of [args.slice(0, 18), args.slice(18, 35), args.slice(35, 41), args.slice(41)]) events.push(...patchSend(b, deltaEvent(0, part)));
      const item = patchItem("function_call", "fc1", "c1", "apply_patch", args);
      events.push(...patchSend(b, patchEvent("response.output_item.done", 0, item)));
      events.push(...patchSend(b, `{"type":"response.completed","response":{"id":"r1","output":[${item}]}}`));
      const [want] = unwrapApplyPatchInput(args);
      let delta = "";
      const counts: Record<string, number> = {};
      let lastSequence = -1;
      for (const event of events) {
        const kind = get(event, "type") as string;
        counts[kind] = (counts[kind] ?? 0) + 1;
        const seq = Number(get(event, "sequence_number") ?? 0);
        expect(seq).toBeGreaterThan(lastSequence);
        lastSequence = seq;
        switch (kind) {
          case "response.custom_tool_call_input.delta":
            delta += get(event, "delta") as string;
            break;
          case "response.custom_tool_call_input.done":
            expect([get(event, "input"), get(event, "item_id"), get(event, "call_id")]).toEqual([want, "fc1", "c1"]);
            break;
          case "response.output_item.done":
            expect(get(event, "item.input")).toBe(want);
            expect(get(event, "item.arguments")).toBeUndefined();
            break;
          case "response.completed":
            expect(get(event, "response.output.0.input")).toBe(want);
            break;
        }
      }
      expect(delta).toBe(want);
      expect([counts["response.custom_tool_call_input.done"], counts["response.output_item.done"], counts["response.completed"]]).toEqual([1, 1, 1]);
      expect(b.finish()).toBeUndefined();
      expect(patchSend(b, `{"type":"response.completed","response":{"output":[]}}`)).toEqual([]);
    });
  }
});

test("bridge passthrough", () => {
  for (const req of [patchResponsesRequest, `{"tools":[{"type":"function","name":"apply_patch"}]}`, `{}`]) {
    const b = new ApplyPatchResponsesBridge(req);
    for (const event of [
      `{ "type":"response.output_item.added", "output_index":0,"item":{"type":"custom_tool_call","id":"native","name":"apply_patch","input":""}}`,
      `{ "type":"response.custom_tool_call_input.delta", "item_id":"native","delta":"raw patch"}`,
      patchEvent("response.output_item.done", 1, patchItem("function_call", "ordinary", "ordinary", "lookup", `{"x":1}`)),
    ]) {
      expect(patchSend(b, event)).toEqual([event]);
    }
  }
});

describe("bridge identity and snapshot evidence", () => {
  const cases: [string, string[], string][] = [
    [
      "index-item",
      [patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "apply_patch", "")), patchEvent("response.output_item.added", 1, patchItem("function_call", "b", "cb", "lookup", ""))],
      `{"type":"response.function_call_arguments.delta","output_index":1,"item_id":"a","delta":"{}"}`,
    ],
    [
      "call-item",
      [patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "apply_patch", ""))],
      `{"type":"response.function_call_arguments.done","output_index":0,"item_id":"a","call_id":"other","arguments":"{\\"input\\":\\"p\\"}"}`,
    ],
    [
      "type-before-name",
      [patchEvent("response.output_item.added", 0, patchItem("message", "a", "ca", "", ""))],
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "ca", "apply_patch", `{"input":"p"}`)),
    ],
    [
      "invalid-before-name",
      [patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "", `{"input":"p","extra":1}`))],
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "ca", "apply_patch", `{"input":"p"}`)),
    ],
    ["partial-snapshot", [], patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "apply_patch", `{"input":"p`))],
    ["invalid-final-only", [], `{"type":"response.completed","response":{"output":[{"type":"function_call","name":"apply_patch","arguments":"{}"}]}}`],
    [
      "old-patch-new-type",
      [patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "apply_patch", ""))],
      `{"type":"response.completed","response":{"output":[{"type":"message","id":"a","content":[]}]}}`,
    ],
    [
      "pending-id-evidence",
      [patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "", ""))],
      patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "changed", "apply_patch", `{"input":"p"}`)),
    ],
  ];
  for (const [name, before, after] of cases) {
    test(name, () => {
      const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
      for (const e of before) patchSend(b, e);
      const [out, err] = b.transform(after);
      expect(err).toBeDefined();
      expect(out.length).toBe(1);
      expect(get(out[0]!, "type")).toBe("response.failed");
      expect(b.toolInputError()).toBeDefined();
      expect(b.transform(`{"type":"response.completed","response":{"output":[]}}`)).toEqual([[], undefined]);
    });
  }
});

test("bridge stages and finish", () => {
  let b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  patchSend(b, patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "apply_patch", "")));
  expect(b.finish()).toBeDefined();
  b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  for (let i = 0; i < 2; i++) {
    patchSend(b, patchEvent("response.output_item.added", i, patchItem("function_call", `a${i}`, `c${i}`, "apply_patch", "")));
    const args = wrapApplyPatchInput(`patch${i}`);
    let out = patchSend(b, `{"type":"response.function_call_arguments.done","output_index":${i},"arguments":${patchJSON(args)}}`);
    expect(out.length).toBe(1);
    out = patchSend(b, patchEvent("response.output_item.done", i, patchItem("function_call", `a${i}`, `c${i}`, "apply_patch", args)));
    expect(out.length).toBe(1);
    expect(get(out[0]!, "item.input")).toBe(`patch${i}`);
    expect(patchSend(b, patchEvent("response.output_item.done", i, patchItem("function_call", `a${i}`, `c${i}`, "apply_patch", args)))).toEqual([]);
  }
  expect(b.finish()).toBeUndefined();
});

test("request history and winners", () => {
  for (const req of [`{"tools":[{"type":"custom","name":"apply_patch"}],"input":[]}`, `{"tools":[{"type":"function","name":"apply_patch"}],"input":[]}`, `{"input":[]}`]) {
    const raw = req.replace(
      `"input":[]`,
      `"input":[{"type":"custom_tool_call","call_id":"old","name":"apply_patch","input":"{\\"input\\":\\"raw\\"}"},{"type":"custom_tool_call_output","call_id":"old","output":"ok"},{"type":"function_call","call_id":"fn","name":"apply_patch","arguments":"{\\"input\\":\\"existing\\"}"}]`,
    );
    const [out, err] = normalizeApplyPatchResponsesRequest(raw);
    expect(err).toBeUndefined();
    expect(get(out, "input.0.arguments")).toBe(wrapApplyPatchInput(`{"input":"raw"}`));
    expect(get(out, "input.1.type")).toBe("function_call_output");
    expect(get(out, "input.2.arguments")).toBe(`{"input":"existing"}`);
    if (req.includes(`"type":"function"`)) expect(get(out, "tools.0.parameters")).toBeUndefined();
  }
  for (const req of [
    `{"tools":[{"type":"function","name":"apply_patch","description":"ordinary"}],"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]}]}`,
    `{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"}]},{"type":"function","name":"n__apply_patch","description":"ordinary"}]}`,
  ]) {
    const [, err] = normalizeApplyPatchResponsesRequest(req);
    expect(err).toBeUndefined();
    const winners = new ApplyPatchResponsesBridge(req);
    const item = req.includes(`"namespace"`) ? patchItem("function_call", "a", "c", "n__apply_patch", `{"x":1}`) : patchItem("function_call", "a", "c", "apply_patch", `{"x":1}`);
    const got = patchSend(winners, patchEvent("response.output_item.done", 0, item));
    expect(got.length).toBe(1);
    expect(get(got[0]!, "item.type")).toBe("function_call");
  }
});

test("namespace mixed non-stream", () => {
  const req = `{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"}]}]}`;
  const b = new ApplyPatchResponsesBridge(req);
  const raw = `{"id":"r","output":[${patchItem("function_call", "a", "c", "n__apply_patch", wrapApplyPatchInput("p"))},${patchItem("function_call", "b", "d", "n__lookup", `{"x":1}`)}]}`;
  const [out, err] = b.transformNonStream(raw);
  expect(err).toBeUndefined();
  expect(get(out, "output.0.type")).toBe("custom_tool_call");
  expect(get(out, "output.0.name")).toBe("apply_patch");
  expect(get(out, "output.0.namespace")).toBe("n");
  expect(get(out, "output.1.name")).toBe("lookup");
  expect(get(out, "output.1.namespace")).toBe("n");
  expect(get(out, "output.1.arguments")).toBe(`{"x":1}`);
});

describe("continuation missing snapshots", () => {
  for (const source of ["deltas", "arguments.done"]) {
    test(source, () => {
      const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
      patchSend(b, patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "c", "apply_patch", "")));
      const [kind, field] = source === "deltas" ? ["response.function_call_arguments.delta", "delta"] : ["response.function_call_arguments.done", "arguments"];
      patchSend(b, `{"type":${patchJSON(kind)},"item_id":"a",${patchJSON(field)}:${patchJSON(wrapApplyPatchInput("p"))}}`);
      let out = patchSend(b, `{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"apply_patch"}}`);
      expect(get(out[out.length - 1]!, "item.input")).toBe("p");
      out = patchSend(b, `{"type":"response.completed","response":{"output":[]}}`);
      expect(get(out[out.length - 1]!, "response.output.0.input")).toBe("p");
    });
  }
});

test("continuation native terminal bytes", () => {
  const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  for (const e of [
    `{ "type":"response.output_item.done", "output_index":0, "item":{"type":"custom_tool_call","id":"n","name":"apply_patch","input":"raw"}}`,
    `{ "type":"response.completed", "sequence_number":71, "response": {"output":[{"type":"custom_tool_call","id":"n","name":"apply_patch","input":"raw"}]}}`,
  ]) {
    expect(patchSend(b, e)).toEqual([e]);
  }
});

test("continuation root late name", () => {
  const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  patchSend(b, `{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a"}}`);
  const out = patchSend(b, `{"type":"response.function_call_arguments.done","output_index":0,"item_id":"a","call_id":"c","name":"apply_patch","arguments":"{\\"input\\":\\"p\\"}"}`);
  expect(out.length).toBeGreaterThan(0);
  expect(get(out[out.length - 1]!, "type")).toBe("response.custom_tool_call_input.done");
  expect(b.finish()).toBeUndefined();
});

test("continuation no invented preview", () => {
  const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  const out = patchSend(b, patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "c", "apply_patch", wrapApplyPatchInput("p"))));
  for (const e of out) expect(get(e, "type")).not.toBe("response.custom_tool_call_input.delta");
});

describe("continuation all matched provenance", () => {
  const keys = ["output_index", "item_id", "call_id"];
  for (const patchKey of keys) {
    for (const firstKey of keys) {
      if (firstKey === patchKey) continue;
      test(`${patchKey}-${firstKey}`, () => {
        const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
        patchSend(b, patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "lookup", "")));
        patchSend(b, patchEvent("response.output_item.added", 1, patchItem("function_call", "b", "cb", "apply_patch", "")));
        const vals: Record<string, string> = { output_index: "0", item_id: `"a"`, call_id: `"ca"` };
        vals[patchKey] = ({ output_index: "1", item_id: `"b"`, call_id: `"cb"` } as Record<string, string>)[patchKey]!;
        const [out, err] = b.transform(
          `{"type":"response.function_call_arguments.delta","output_index":${vals.output_index},"item_id":${vals.item_id},"call_id":${vals.call_id},"delta":"{}"}`,
        );
        expect(err).toBeDefined();
        expect(out.length).toBe(1);
        expect(get(out[0]!, "type")).toBe("response.failed");
      });
    }
  }
  for (const discover of [0, 1, 2]) {
    test(`pending-${discover}`, () => {
      const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
      for (let i = 0; i < 3; i++) patchSend(b, patchEvent("response.output_item.added", i, patchItem("function_call", `i${i}`, `c${i}`, "", "")));
      patchSend(b, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"i1","call_id":"c2","delta":""}`);
      const [out, err] = b.transform(
        patchEvent("response.output_item.done", discover, patchItem("function_call", `i${discover}`, `c${discover}`, "apply_patch", wrapApplyPatchInput("p"))),
      );
      expect(err).toBeDefined();
      expect(out.length).toBe(1);
    });
  }
});

describe("continuation completed window", () => {
  for (const terminal of [false, true]) {
    test(String(terminal), () => {
      const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
      const item = patchItem("function_call", "a", "c", "apply_patch", wrapApplyPatchInput("p"));
      patchSend(b, patchEvent("response.output_item.done", 0, item));
      if (terminal) patchSend(b, `{"type":"response.completed","response":{"output":[${item}]}}`);
      const [out, err] = b.transform(patchEvent("response.output_item.done", 0, patchItem("function_call", "a", "c", "apply_patch", wrapApplyPatchInput("different"))));
      if (terminal) {
        expect(out).toEqual([]);
        expect(err).toBeUndefined();
      } else {
        expect(err).toBeDefined();
      }
    });
  }
});

test("continuation omitted mixed completed items", () => {
  let b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  patchSend(b, patchEvent("response.output_item.done", 0, patchItem("function_call", "p", "cp", "apply_patch", wrapApplyPatchInput("p"))));
  const ordinary = `{"type":"message","id":"m","content":[{"type":"output_text","text":"ok"}]}`;
  patchSend(b, patchEvent("response.output_item.done", 1, ordinary));
  let out = patchSend(b, `{"type":"response.completed","response":{"output":[]}}`);
  expect(get(out[out.length - 1]!, "response.output.0.input")).toBe("p");
  expect(get(out[out.length - 1]!, "response.output.1.id")).toBe("m");
  b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  patchSend(b, patchEvent("response.output_item.done", 0, patchItem("function_call", "p", "cp", "apply_patch", wrapApplyPatchInput("p"))));
  out = patchSend(b, `{"type":"response.completed","response":{"output":[${ordinary}]}}`);
  expect(get(out[out.length - 1]!, "response.output.0.input")).toBe("p");
  expect(get(out[out.length - 1]!, "response.output.1.id")).toBe("m");
});

describe("continuation unmatched identity evidence", () => {
  for (const known of [false, true]) {
    for (const key of [`"item_id":"b"`, `"call_id":"cb"`, `"output_index":1`]) {
      test(`known=${known}/${key}`, () => {
        const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
        if (known) patchSend(b, patchEvent("response.output_item.added", 0, patchItem("function_call", "a", "ca", "lookup", "")));
        patchSend(b, `{"type":"response.output_item.added","output_index":1,"item_id":"a","call_id":"ca","item":{"type":"function_call","id":"b","call_id":"cb","name":""}}`);
        const [out, err] = b.transform(`{"type":"response.function_call_arguments.done",${key},"name":"apply_patch","arguments":"{\\"input\\":\\"p\\"}"}`);
        expect(err).toBeDefined();
        expect(out.length).toBe(1);
        expect(get(out[0]!, "type")).toBe("response.failed");
      });
    }
  }
});

test("continuation mixed sequence", () => {
  const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  const events: string[] = [];
  for (const raw of [
    `{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"apply_patch","arguments":""}}`,
    `{"type":"response.output_item.added","sequence_number":2,"output_index":1,"item":{"type":"function_call","id":"b","name":"lookup","arguments":""}}`,
    `{"type":"response.function_call_arguments.done","sequence_number":3,"output_index":0,"item_id":"a","arguments":"{\\"input\\":\\"p\\"}"}`,
    `{"type":"response.output_item.done","sequence_number":4,"output_index":1,"item":{"type":"function_call","id":"b","name":"lookup","arguments":"{\\"x\\":1}"}}`,
    `{"type":"response.completed","sequence_number":5,"response":{"output":[]}}`,
  ]) {
    events.push(...patchSend(b, raw));
  }
  let last = -1;
  for (const event of events) {
    const seq = Number(get(event, "sequence_number") ?? 0);
    expect(seq).toBeGreaterThan(last);
    last = seq;
  }
});

test("continuation ordinary root name passthrough", () => {
  const b = new ApplyPatchResponsesBridge(`{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"}]}]}`);
  const raw = `{ "type":"response.function_call_arguments.done", "output_index":0,"name":"lookup","namespace":"n","arguments":"{}"}`;
  expect(patchSend(b, raw)).toEqual([raw]);
});

test("continuation mixed native bytes", () => {
  const b = new ApplyPatchResponsesBridge(patchResponsesRequest);
  patchSend(b, `{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"function_call","id":"a","name":"apply_patch","arguments":""}}`);
  const native = `  { "type":"response.output_item.added", "sequence_number":2, "output_index":1,"item":{"type":"custom_tool_call","id":"n","name":"apply_patch","input":""}}  `;
  expect(patchSend(b, native)).toEqual([native]);
});

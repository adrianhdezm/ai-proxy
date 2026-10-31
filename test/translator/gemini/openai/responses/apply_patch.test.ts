// Ported from: internal/translator/gemini/openai/responses/apply_patch_test.go
// Ported from: internal/translator/gemini/openai/responses/apply_patch_review_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { GeminiToResponsesState } from "../../../../../src/translator/gemini/openai/responses/response.ts";
import { toolInputFailed, type TranslatorState } from "../../../../../src/translator/types.ts";
import { g, J, nonStream, parseSSEEvent, streamChunk, toGemini } from "./helpers.ts";

const geminiPatchRequest = `{"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","definition":"start: patch"}}]}]}`;

function send(request: string, raw: string, state: TranslatorState, model = "gemini"): { event: string; data: J }[] {
  return streamChunk(model, request, "", raw, state).map(parseSSEEvent);
}

describe("apply_patch_test.go", () => {
  test("TestGeminiApplyPatchCompleteArgumentsLifecycle", () => {
    const state: TranslatorState = {};
    const raw = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"functions__apply_patch","args":{"input":"  *** Begin Patch\\n*** End Patch\\n "}}}]}}]}`;
    expect(streamChunk("gemini-3.1-pro", geminiPatchRequest, "", `{"responseId":"r"}`, state).length).toBe(2);
    const out = [...send(geminiPatchRequest, raw, state, "gemini-3.1-pro"), ...send(geminiPatchRequest, "[DONE]", state, "gemini-3.1-pro")];
    let delta = "";
    let done = new J(undefined);
    let item = new J(undefined);
    let final = new J(undefined);
    for (const { event, data } of out) {
      if (event === "response.custom_tool_call_input.delta") delta += data.str("delta");
      if (event === "response.custom_tool_call_input.done") done = data;
      if (event === "response.output_item.done") item = data.get("item");
      if (event === "response.completed") final = data.get("response.output.0");
    }
    const want = "  *** Begin Patch\n*** End Patch\n ";
    expect([delta, done.str("input"), item.str("input"), final.str("input")]).toEqual([want, want, want, want]);
    expect(done.str("call_id")).toBe(item.str("call_id"));
    expect(done.str("item_id")).toBe(item.str("id"));
    expect(item.str("namespace")).toBe("functions");
    expect(final.str("id")).toBe(item.str("id"));
  });

  test("TestGeminiApplyPatchRejectInvalidCompleteArguments", () => {
    for (const args of [`{}`, `{"input":1}`, `{"input":"a","input":"b"}`, `{"input":"secret"`, `{"input":"x","extra":1}`, `{"input":"\\ud800"}`]) {
      const raw = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"functions__apply_patch","args":${args}}}]},"finishReason":"STOP"}]}`;
      const nsState: TranslatorState = {};
      expect(nonStream("gemini", geminiPatchRequest, "", raw, nsState)).toBe("");
      expect(toolInputFailed(nsState)).toBe(true);
      const state: TranslatorState = {};
      let failures = 0;
      for (const { event, data } of send(geminiPatchRequest, raw, state)) {
        if (event === "response.failed") {
          failures++;
          expect(data.str("response.error.code")).toBe("invalid_tool_arguments");
        }
        expect(["response.completed", "response.custom_tool_call_input.done"]).not.toContain(event);
      }
      expect([args, failures]).toEqual([args, 1]);
      expect(streamChunk("gemini", geminiPatchRequest, "", "[DONE]", state).length).toBe(0);
    }
  });

  describe("TestGeminiApplyPatchCompleteSnapshotMatrix", () => {
    const frame = (name: string, id: string, args: string): string =>
      `{"candidates":[{"content":{"parts":[{"partIndex":2,"functionCall":{"id":"${id}","name":"${name}","args":${args}}}]}}]}`;
    const cases: { name: string; inputs: string[]; fail: boolean }[] = [
      { name: "equivalent encoding after item done", inputs: [frame("functions__apply_patch", "c1", `{"input":"a"}`), frame("functions__apply_patch", "c1", `{ "input" : "\\u0061" }`)], fail: false },
      { name: "complete input cannot extend", inputs: [frame("functions__apply_patch", "c1", `{"input":"a"}`), frame("functions__apply_patch", "c1", `{"input":"ab"}`)], fail: true },
      { name: "ID conflict after item done", inputs: [frame("functions__apply_patch", "c1", `{"input":"a"}`), frame("functions__apply_patch", "c2", `{"input":"a"}`)], fail: true },
      { name: "illegal snapshot before name", inputs: [frame("", "c1", `{"input":1}`), frame("functions__apply_patch", "c1", `{"input":"a"}`)], fail: true },
      { name: "truncated snapshot before name", inputs: [frame("", "c1", `{"input":"a`), frame("functions__apply_patch", "c1", `{"input":"a"}`)], fail: true },
      { name: "ID conflict before name", inputs: [frame("", "c1", `{"input":"a"}`), frame("", "c2", `{"input":"a"}`), frame("functions__apply_patch", "c1", `{"input":"a"}`)], fail: true },
      { name: "full snapshots before name cannot extend", inputs: [frame("", "c1", `{"input":"a"}`), frame("functions__apply_patch", "c1", `{"input":"ab"}`)], fail: true },
      { name: "valid name arrives later", inputs: [frame("", "c1", `{"input":"a"}`), frame("functions__apply_patch", "c1", `{"input":"a"}`)], fail: false },
    ];
    for (const c of cases) {
      test(c.name, () => {
        const state: TranslatorState = {};
        const events = c.inputs.flatMap((input) => send(geminiPatchRequest, input, state)).map((e) => e.data);
        const failures = events.filter((e) => e.str("type") === "response.failed").length;
        const done = events.filter((e) => e.str("type") === "response.custom_tool_call_input.done").length;
        if (c.fail) {
          expect(failures).toBe(1);
        } else {
          expect([failures, done]).toEqual([0, 1]);
          const chunks = streamChunk("gemini", geminiPatchRequest, "", "[DONE]", state);
          const last = parseSSEEvent(chunks[chunks.length - 1]!).data;
          expect(last.arr("response.output").length).toBe(1);
          expect(last.str("response.output.0.input")).toBe("a");
        }
        for (const input of [c.inputs[0]!, "[DONE]"]) expect(streamChunk("gemini", geminiPatchRequest, "", input, state).length).toBe(0);
      });
    }
  });

  describe("TestGeminiApplyPatchWinningDeclarationAndNegativeCompatibility", () => {
    const cases = [
      { name: "function wins", request: `{"tools":[{"type":"function","name":"apply_patch"}],"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]}]}`, upstream: "apply_patch", args: `{"n":1}`, wantType: "function_call", wantInput: "" },
      { name: "direct function wins namespace", request: `{"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"apply_patch"}]},{"type":"function","name":"functions__apply_patch"}]}`, upstream: "functions__apply_patch", args: `{"n":1}`, wantType: "function_call", wantInput: "" },
      { name: "other custom", request: `{"tools":[{"type":"custom","name":"exec"}]}`, upstream: "exec", args: `{"command":"ls"}`, wantType: "custom_tool_call", wantInput: `{"command":"ls"}` },
    ];
    for (const c of cases) {
      test(c.name, () => {
        const raw = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"${c.upstream}","args":${c.args}}}]},"finishReason":"STOP"}]}`;
        const out = nonStream("gemini", c.request, "", raw);
        expect(g(out, "output.0.type").str()).toBe(c.wantType);
        expect(g(out, "output.0.input").str()).toBe(c.wantInput);
        const state: TranslatorState = {};
        for (const { event, data } of [...send(c.request, raw, state), ...send(c.request, "[DONE]", state)]) {
          expect(["response.custom_tool_call_input.delta", "response.failed"]).not.toContain(event);
          if (event === "response.completed") expect(data.str("response.output.0.type")).toBe(c.wantType);
        }
      });
    }
  });

  test("TestGeminiApplyPatchConflictingNameAndPartIdentity", () => {
    for (const second of [
      `{"partIndex":3,"functionCall":{"id":"c1","name":"functions__apply_patch","args":{"input":"a"}}}`,
      `{"partIndex":2,"functionCall":{"id":"c1","name":"other","args":{"input":"a"}}}`,
    ]) {
      const state: TranslatorState = {};
      send(geminiPatchRequest, `{"candidates":[{"content":{"parts":[{"partIndex":2,"functionCall":{"id":"c1","name":"functions__apply_patch","args":{"input":"a"}}}]}}]}`, state);
      const chunks = send(geminiPatchRequest, `{"candidates":[{"content":{"parts":[${second}]}}]}`, state);
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.event).toBe("response.failed");
    }
  });

  test("TestGeminiApplyPatchNonStreamConflictingCompleteCalls", () => {
    const state: TranslatorState = {};
    const raw = `{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"functions__apply_patch","args":{"input":"a"}}},{"functionCall":{"id":"c1","name":"functions__apply_patch","args":{"input":"ab"}}}]}}]}`;
    expect(nonStream("gemini", geminiPatchRequest, "", raw, state)).toBe("");
    expect(toolInputFailed(state)).toBe(true);
  });

  test("TestGeminiApplyPatchHistoryPreservesWhitespaceAndToolPair", () => {
    const request = `{"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"apply_patch"}]}],"input":[{"type":"custom_tool_call","call_id":"c1","namespace":"functions","name":"apply_patch","input":"  *** Begin Patch\\n*** Add File: 中.txt\\n+😀\\n*** End Patch\\n "},{"type":"custom_tool_call_output","call_id":"c1","output":"ok"},{"role":"user","type":"message","content":"continue"}]}`;
    const out = toGemini("gemini-3.1-pro-preview", request);
    const want = "  *** Begin Patch\n*** Add File: 中.txt\n+😀\n*** End Patch\n ";
    let call = new J(undefined);
    let result = new J(undefined);
    for (const content of g(out, "contents").arr()) {
      for (const part of content.arr("parts")) {
        if (part.exists("functionCall")) call = part.get("functionCall");
        if (part.exists("functionResponse")) result = part.get("functionResponse");
      }
    }
    expect(call.str("args.input")).toBe(want);
    expect(call.str("name")).toBe("functions__apply_patch");
    expect(result.str("name")).toBe("functions__apply_patch");
  });

  test("TestGeminiApplyPatchDoesNotRebindOrdinaryFunctionCalls", () => {
    const state: TranslatorState = {};
    const request = `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"first"},{"type":"function","name":"second"}]}`;
    for (const name of ["first", "second"]) {
      let item = new J(undefined);
      for (const { event, data } of send(request, `{"candidates":[{"content":{"parts":[{"functionCall":{"id":"reused","name":"${name}","args":{"n":1}}}]}}]}`, state)) {
        if (event === "response.output_item.done") item = data.get("item");
      }
      expect(item.str("name")).toBe(name);
      expect(item.str("type")).toBe("function_call");
    }
  });

  test("TestGeminiApplyPatchDistinctUnkeyedCompleteCalls", () => {
    const state: TranslatorState = {};
    const raw = `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"functions__apply_patch","args":{"input":"a"}}},{"functionCall":{"name":"functions__apply_patch","args":{"input":"b"}}}]},"finishReason":"STOP"}]}`;
    const inputs = new Map<string, string>();
    let final = new J(undefined);
    for (const { event, data } of [...send(geminiPatchRequest, raw, state), ...send(geminiPatchRequest, "[DONE]", state)]) {
      if (event === "response.custom_tool_call_input.delta") inputs.set(data.str("item_id"), (inputs.get(data.str("item_id")) ?? "") + data.str("delta"));
      if (event === "response.custom_tool_call_input.done") expect(inputs.get(data.str("item_id")) ?? "").toBe(data.str("input"));
      if (event === "response.completed") final = data.get("response");
    }
    expect(final.arr("output").length).toBe(2);
    expect(final.str("output.0.input")).toBe("a");
    expect(final.str("output.1.input")).toBe("b");
    expect(final.str("output.0.id")).not.toBe(final.str("output.1.id"));
  });

  test("TestGeminiApplyPatchUnresolvableCallIdentityFailsClosed", () => {
    for (const part of [`{"functionCall":{"args":{"input":"secret"}}}`, `{"partIndex":2,"functionCall":{"id":"c1","args":{"input":"secret"}}}`]) {
      const state: TranslatorState = {};
      const raw = `{"candidates":[{"content":{"parts":[${part}]},"finishReason":"STOP"}]}`;
      let failures = 0;
      for (const { event } of send(geminiPatchRequest, raw, state)) {
        if (event === "response.failed") failures++;
        expect(["response.completed", "response.function_call_arguments.delta"]).not.toContain(event);
      }
      expect(failures).toBe(1);
      expect(nonStream("gemini", geminiPatchRequest, "", raw, {})).toBe("");
    }
  });
});

const geminiMixedPatchReviewRequest = `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"}]}`;

function reviewPart(indexKey: string, index: number, id: string, name: string, args: string): string {
  return `{"${indexKey}":${index},"functionCall":{"id":${JSON.stringify(id)},"name":${JSON.stringify(name)},"args":${args}}}`;
}

function reviewFrame(parts: string[], terminal: boolean): string {
  return `{"candidates":[{"content":{"parts":[${parts.join(",")}]}${terminal ? `,"finishReason":"STOP"` : ""}}]}`;
}

describe("apply_patch_review_test.go", () => {
  describe("TestGeminiApplyPatchCrossKeyEvidenceConflict", () => {
    for (const indexKey of ["partIndex", "index"]) {
      for (const order of ["ordinary first", "patch first"]) {
        for (const direction of ["ordinary index patch ID", "patch index ordinary ID"]) {
          for (const name of ["lookup", "apply_patch", ""]) {
            for (const mode of ["stream separate frames", "stream single frame", "non-stream"]) {
              test([indexKey, order, direction, name, mode].join("/"), () => {
                const ordinary = reviewPart(indexKey, 3, "ordinary", "lookup", `{"x":1}`);
                const patch = reviewPart(indexKey, 2, "patch", "apply_patch", `{"input":"p"}`);
                const parts = order === "patch first" ? [patch, ordinary] : [ordinary, patch];
                const [index, id] = direction === "patch index ordinary ID" ? [2, "ordinary"] : [3, "patch"];
                const args = name === "apply_patch" ? `{"input":"secret"}` : `{"x":1}`;
                const conflict = reviewPart(indexKey, index, id, name, args);
                parts.push(conflict);
                const state: TranslatorState = {};
                if (mode === "non-stream") {
                  expect(nonStream("gemini", geminiMixedPatchReviewRequest, "", reviewFrame(parts, true), state)).toBe("");
                  expect(toolInputFailed(state)).toBe(true);
                  return;
                }
                const sendRaw = (raw: string): J[] => send(geminiMixedPatchReviewRequest, raw, state).map((e) => e.data);
                let events: J[] = [];
                if (mode === "stream single frame") events = sendRaw(reviewFrame(parts, true));
                else {
                  for (const part of parts.slice(0, 2)) events.push(...sendRaw(reviewFrame([part], false)));
                  events.push(...sendRaw(reviewFrame([conflict], true)));
                }
                const counts = new Map<string, number>();
                for (const event of events) {
                  const kind = event.str("type");
                  counts.set(kind, (counts.get(kind) ?? 0) + 1);
                  if (kind === "response.failed") {
                    expect(event.str("response.error.code")).toBe("invalid_tool_arguments");
                    expect(event.raw).not.toContain("secret");
                    expect(event.raw).not.toContain(`\\"input\\"`);
                  }
                  if (kind === "response.custom_tool_call_input.delta") expect(event.str("delta")).toBe("p");
                  if (kind === "response.custom_tool_call_input.done") expect(event.str("input")).toBe("p");
                }
                const c = (k: string): number => counts.get(k) ?? 0;
                expect([
                  c("response.failed"),
                  c("response.completed"),
                  c("response.output_item.added"),
                  c("response.output_item.done"),
                  c("response.custom_tool_call_input.delta"),
                  c("response.custom_tool_call_input.done"),
                  c("response.function_call_arguments.done"),
                ]).toEqual([1, 0, 2, 2, 1, 1, 1]);
                const st = state.value as GeminiToResponsesState;
                const patchEvidence = st.functionEvidence.get("part:2");
                const ordinaryEvidence = st.functionEvidence.get("part:3");
                expect(st.nextIndex).toBe(2);
                expect(st.functionEvidence.size).toBe(4);
                expect(patchEvidence).not.toBe(ordinaryEvidence);
                expect(st.functionEvidence.get("id:patch")).toBe(patchEvidence);
                expect(st.functionEvidence.get("id:ordinary")).toBe(ordinaryEvidence);
                expect(patchEvidence!.applyPatch).toBe(true);
                expect(patchEvidence!.patchCall).toBeDefined();
                expect(patchEvidence!.rawName).toBe("apply_patch");
                expect(ordinaryEvidence!.applyPatch).toBe(false);
                expect(ordinaryEvidence!.rawName).toBe("lookup");
                const errInput = st.toolInputError();
                expect(errInput?.message ?? "").toContain("indexes");
                for (const raw of ["[DONE]", reviewFrame([], true), reviewFrame(parts, true), reviewFrame([patch], false)]) {
                  expect(sendRaw(raw).length).toBe(0);
                  expect(st.toolInputError()).toBe(errInput);
                }
              });
            }
          }
        }
      }
    }
  });

  describe("TestGeminiApplyPatchCrossKeyOrdinaryLegacy", () => {
    const requests = [
      { name: "ordinary only in patch-enabled request", request: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"},{"type":"function","name":"second"}]}`, second: "second" },
      {
        name: "same-name function winner",
        request: `{"tools":[{"type":"function","name":"apply_patch"},{"type":"function","name":"lookup"},{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"apply_patch"}]}],"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]}]}`,
        second: "apply_patch",
      },
    ];
    for (const request of requests) {
      for (const indexKey of ["partIndex", "index"]) {
        for (const order of ["first second", "second first"]) {
          for (const direction of ["first index second ID", "second index first ID"]) {
            test([request.name, indexKey, order, direction].join("/"), () => {
              const parts = [reviewPart(indexKey, 3, "first", "lookup", `{"x":1}`), reviewPart(indexKey, 2, "second", request.second, `{"x":2}`)];
              const names = ["lookup", request.second];
              const args = [`{"x":1}`, `{"x":2}`];
              if (order === "second first") {
                parts.reverse();
                names.reverse();
                args.reverse();
              }
              const [index, id, name] = direction === "second index first ID" ? [2, "first", request.second] : [3, "second", "lookup"];
              parts.push(reviewPart(indexKey, index, id, name, `{"x":3}`));
              names.push(name);
              args.push(`{"x":3}`);
              const state: TranslatorState = {};
              const events: J[] = [];
              parts.forEach((part, i) => events.push(...send(request.request, reviewFrame([part], i === parts.length - 1), state).map((e) => e.data)));
              events.push(...send(request.request, "[DONE]", state).map((e) => e.data));
              const count = (k: string): number => events.filter((e) => e.str("type") === k).length;
              const final = events.find((e) => e.str("type") === "response.completed")?.get("response") ?? new J(undefined);
              expect([count("response.failed"), count("response.completed"), count("response.output_item.done"), count("response.custom_tool_call_input.done")]).toEqual([0, 1, 3, 0]);
              expect(toolInputFailed(state)).toBe(false);
              const nsState: TranslatorState = {};
              const out = nonStream("gemini", request.request, "", reviewFrame(parts, true), nsState);
              for (const output of [final, J.parse(out)]) {
                expect(output.arr("output").length).toBe(3);
                output.arr("output").forEach((item, i) => {
                  expect([item.str("type"), item.str("name"), item.str("arguments")]).toEqual(["function_call", names[i]!, args[i]!]);
                });
              }
              expect(toolInputFailed(nsState)).toBe(false);
            });
          }
        }
      }
    }
  });
});

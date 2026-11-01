// Ported from: internal/translator/common/apply_patch_events_test.go
// Skipped cases: TestApplyPatchCallStateConcurrentIndependentCalls runs its 16 calls sequentially
// (no goroutines in JS); the interleaved test splits a surrogate pair instead of raw UTF-8 bytes.
import { expect, test } from "bun:test";
import {
  ApplyPatchCallState,
  ApplyPatchErrorState,
  applyPatchFailure,
  applyPatchInputDelta,
  applyPatchInputDone,
} from "../../../src/translator/common/apply_patch_events.ts";
import { wrapApplyPatchInput } from "../../../src/translator/common/apply_patch_tool.ts";

test("call state interleaved calls", () => {
  const first = new ApplyPatchCallState({ itemID: "item_1", callID: "call_1", name: "apply_patch", namespace: "tools", outputIndex: 2 });
  const second = new ApplyPatchCallState({ itemID: "item_2", callID: "call_2", name: "apply_patch", outputIndex: 4 });
  expect(first.pushArguments(`{"input":"first\\uD83D`)).toEqual(["first", undefined]);
  expect(second.pushArguments('{"input":"second\ud83d')).toEqual(["second", undefined]);
  expect(first.pushArguments(`\\uDE00\\n`)).toEqual(["😀\n", undefined]);
  expect(second.pushArguments("\ude00")).toEqual(["😀", undefined]);
  expect(first.finishArguments(wrapApplyPatchInput("first😀\nlast"))).toEqual(["last", "first😀\nlast", undefined]);
  expect(second.finishArguments(wrapApplyPatchInput("second😀"))).toEqual(["", "second😀", undefined]);
  expect([first.itemID, first.callID, first.namespace, first.outputIndex]).toEqual(["item_1", "call_1", "tools", 2]);
});

test("call state failure isolation", () => {
  const bad = new ApplyPatchCallState();
  const good = new ApplyPatchCallState();
  expect(bad.pushArguments(`{"input":null`)[1]).toBeDefined();
  expect(good.pushArguments(`{"input":"good`)).toEqual(["good", undefined]);
  const [tail, input, err] = bad.finishArguments(`{"input":"bad"}`);
  expect(err).toBeDefined();
  expect([tail, input]).toEqual(["", ""]);
  expect(good.finishArguments(`{"input":"good tail"}`)).toEqual([" tail", "good tail", undefined]);
  expect(good.finishArguments(`{"input":"good tail"}`)).toEqual(["", "good tail", undefined]);
});

test("call state independent calls", () => {
  for (let index = 0; index < 16; index++) {
    const state = new ApplyPatchCallState({ itemID: `item_${index}`, callID: `call_${index}`, outputIndex: index });
    const want = `*** Begin Patch\n+  call ${index} 中文😀  \n*** End Patch\n`;
    const args = wrapApplyPatchInput(want);
    let output = "";
    for (let j = 0; j < args.length; j++) {
      const [delta, err] = state.pushArguments(args.slice(j, j + 1));
      expect(err).toBeUndefined();
      output += delta;
    }
    const [tail, input, err] = state.finishArguments(args);
    expect(err).toBeUndefined();
    output += tail;
    expect(output).toBe(want);
    expect(input).toBe(want);
    expect(JSON.parse(applyPatchInputDone(state, input, index)).call_id).toBe(state.callID);
  }
});

test("events payloads", () => {
  const state = new ApplyPatchCallState({ itemID: 'item_"中', callID: "call_\\1", name: "apply_patch", namespace: "tools", outputIndex: 3 });
  const text = '*** Begin Patch\n+  中文 \\"  \n*** End Patch\n';
  for (const tc of [
    { payload: applyPatchInputDelta(state, text, 11), kind: "response.custom_tool_call_input.delta", textKey: "delta", sequence: 11 },
    { payload: applyPatchInputDone(state, text, 12), kind: "response.custom_tool_call_input.done", textKey: "input", sequence: 12 },
  ]) {
    const root = JSON.parse(tc.payload);
    expect(root.type).toBe(tc.kind);
    expect(root.item_id).toBe(state.itemID);
    expect(root.call_id).toBe(state.callID);
    expect(root[tc.textKey]).toBe(text);
    expect(root.output_index).toBe(3);
    expect(root.sequence_number).toBe(tc.sequence);
  }
  const zero = JSON.parse(applyPatchInputDelta(new ApplyPatchCallState(), "", 0));
  for (const key of ["item_id", "call_id", "output_index", "sequence_number", "delta"]) expect(key in zero).toBe(true);
});

test("failure sanitizes client error", () => {
  const secret = "*** Begin Patch\n+secret-token-value\n*** End Patch\n";
  const original = new Error("invalid input: " + secret);
  const state = new ApplyPatchErrorState();
  expect(state.toolInputError()).toBeUndefined();
  state.setToolInputError(undefined);
  state.setToolInputError(original);
  expect(state.toolInputError()).toBe(original);
  const payload = applyPatchFailure('resp_"1', 17);
  expect(payload).not.toContain("secret-token-value");
  expect(payload).not.toContain("Begin Patch");
  const root = JSON.parse(payload);
  expect(root.type).toBe("response.failed");
  expect(root.response.id).toBe('resp_"1');
  expect(root.response.object).toBe("response");
  expect(root.response.status).toBe("failed");
  expect(root.response.error.code).toBe("invalid_tool_arguments");
  expect(root.response.error.message).toBe("Invalid apply_patch tool arguments received from upstream.");
  expect(root.sequence_number).toBe(17);
});

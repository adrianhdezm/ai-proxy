// Shared helpers for the apply_patch Responses bridge tests (Go: apply_patch_responses_test.go helpers).
import { expect } from "bun:test";
import type { ApplyPatchResponsesBridge } from "../../../src/translator/common/apply_patch_responses.ts";

export const patchResponsesRequest = `{"tools":[{"type":"custom","name":"apply_patch"}]}`;

export function patchJSON(value: unknown): string {
  return JSON.stringify(value);
}

export function patchItem(kind: string, id: string, call: string, name: string, args: string): string {
  return `{"type":${patchJSON(kind)},"id":${patchJSON(id)},"call_id":${patchJSON(call)},"name":${patchJSON(name)},"arguments":${patchJSON(args)}}`;
}

export function patchEvent(kind: string, index: number, item: string): string {
  return `{"type":${patchJSON(kind)},"output_index":${index},"item":${item}}`;
}

export function patchSend(b: ApplyPatchResponsesBridge, event: string): string[] {
  const [out, err] = b.transform(event);
  expect(err).toBeUndefined();
  return out;
}

export function get(json: string, path: string): unknown {
  let cur: unknown = JSON.parse(json);
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

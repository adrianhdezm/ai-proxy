// Port of internal/client/codex/apply-patch/tool.go.
//
// The custom (freeform) Codex apply_patch tool is declared to upstreams without
// freeform tools as a function taking {"input": <patch text>}. These helpers
// recognise the declaration, describe the wrapper and encode/decode the input.
import { getAt, gstr } from "../../util/gpath.ts";
import { ApplyPatchInputDecoder } from "./apply_patch_input.ts";

const parametersJSON = `{"type":"object","properties":{"input":{"type":"string","description":"The complete apply_patch patch text."}},"required":["input"],"additionalProperties":false}`;

const patchInstructions = `Call this function with a JSON object whose input field contains the complete patch text.
Use the Codex apply_patch format, not a conventional git unified diff.
Start with *** Begin Patch and end with *** End Patch.
Use *** Add File: path, *** Delete File: path, or *** Update File: path.
Every added-file content line starts with +.
For updates, use @@; context lines start with one space, removed lines with -, and added lines with +.
Use *** Move to: path for a rename and *** End of File when required by the patch grammar.
Example input:
*** Begin Patch
*** Update File: src/main.go
@@
-old
+new
*** End Patch`;

/** Reports whether the (parsed) declaration is the custom apply_patch tool. */
export function isApplyPatchCustomTool(tool: unknown): boolean {
  return getAt(tool, "type") === "custom" && typeof getAt(tool, "name") === "string" && gstr(getAt(tool, "name")).trim() === "apply_patch";
}

/** Returns an independent copy of the patch input schema (JSON string). */
export function applyPatchParameters(): string {
  return parametersJSON;
}

/** Explains the JSON wrapper and preserves the original patch grammar. */
export function applyPatchDescription(tool: unknown): string {
  const original = gstr(getAt(tool, "description")).replaceAll("This is a FREEFORM tool, so do not wrap the patch in JSON.", "");
  let description = "";
  if (original.trim() !== "") description += original + "\n\n";
  description += patchInstructions;
  const grammar = gstr(getAt(tool, "format.definition"));
  if (grammar !== "") {
    if (grammar.includes("*** Environment ID:")) description += "\n\nUse *** Environment ID: as specified by the patch grammar.";
    description += "\n\nOriginal patch grammar:\n" + grammar;
  }
  return description;
}

/** Encodes a string the way Go's encoding/json does (HTML-sensitive characters and U+2028/2029 escaped). */
export function goJSONString(value: string): string {
  return JSON.stringify(value).replace(/[<>&  ]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Encodes the complete patch text as function arguments. */
export function wrapApplyPatchInput(input: string): string {
  return `{"input":${goJSONString(input)}}`;
}

/**
 * Accepts only a JSON object containing one string field named input.
 * Returns [input, error]. Validation uses the strict streaming decoder, so
 * unpaired surrogate escapes are rejected (Go's encoding/json replaced them).
 */
export function unwrapApplyPatchInput(args: string): [string, Error | undefined] {
  const decoder = new ApplyPatchInputDecoder();
  const [, errPush] = decoder.push(args);
  if (errPush) return ["", errPush];
  if (!decoder.complete()) {
    if (args.trim() === "") return ["", new Error("decode apply_patch arguments object: EOF")];
    return ["", new Error("decode apply_patch arguments: unexpected end of JSON input")];
  }
  return [decoder.input(), undefined];
}

/** Encodes patch text for use inside a JSON string without quotes. */
export function escapeApplyPatchInputFragment(fragment: string): string {
  const encoded = goJSONString(fragment);
  return encoded.slice(1, encoded.length - 1);
}

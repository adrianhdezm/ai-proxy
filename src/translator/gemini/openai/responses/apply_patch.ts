// Local minimal port of the apply_patch helpers this translator needs:
// - internal/client/codex/apply-patch/tool.go (IsCustomTool, Parameters, Description, UnwrapInput)
// - internal/translator/common/apply_patch_input.go (ApplyPatchInputDecoder)
// - internal/translator/common/apply_patch_events.go (call state, events, error state)
//
// The shared src/translator/common/apply_patch_*.ts port did not exist when this
// translator was written, so the subset used here lives next to it.
import { getAt, gstr } from "../../../../util/gpath.ts";

// ---- tool.go ----

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

/** Reports whether the declaration is the custom apply_patch tool. */
export function isApplyPatchCustomTool(tool: unknown): boolean {
  return gstr(getAt(tool, "type")) === "custom" && gstr(getAt(tool, "name")).trim() === "apply_patch";
}

/** An independent copy of the patch input schema. */
export function applyPatchParameters(): unknown {
  return JSON.parse(parametersJSON) as unknown;
}

/** Explains the JSON wrapper and preserves the original patch grammar. */
export function applyPatchDescription(tool: unknown): string {
  const original = gstr(getAt(tool, "description")).split("This is a FREEFORM tool, so do not wrap the patch in JSON.").join("");
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

/** Encodes the complete patch text as function arguments. */
export function wrapApplyPatchInput(input: string): string {
  return JSON.stringify({ input });
}

/** Accepts only a JSON object containing one string field named input. */
export function unwrapApplyPatchInput(args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch (err) {
    throw new Error(`decode apply_patch arguments object: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("apply_patch arguments must be a JSON object");
  const keys = Object.keys(parsed);
  if (keys.length === 0 || keys[0] !== "input") throw new Error("apply_patch arguments must contain the input field");
  const input = (parsed as Record<string, unknown>).input;
  if (typeof input !== "string") throw new Error("apply_patch input must be a string");
  if (keys.length !== 1) throw new Error("apply_patch arguments must contain only one input field");
  return input;
}

// ---- apply_patch_input.go ----

const enum Phase {
  BeforeObject,
  BeforeKey,
  InKey,
  BeforeColon,
  BeforeValue,
  InValue,
  AfterValue,
  Complete,
}

function jsonSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

function hexValue(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 97 + 10;
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 65 + 10;
  return -1;
}

/** Decodes the input string from streamed function arguments. One decoder belongs to one call. */
export class ApplyPatchInputDecoder {
  private phase = Phase.BeforeObject;
  private keyRaw = "";
  private escapeRaw = "";
  private highSurrogate = 0;
  private input = "";
  private finished = false;
  private error: Error | undefined;

  /** Scans each fragment once, emitting only complete, validated characters. */
  push(fragment: string): string {
    if (this.error) throw this.error;
    if (this.finished) {
      if (fragment === "") return "";
      this.fail("apply_patch arguments received after completion");
    }
    const start = this.input.length;
    for (let i = 0; i < fragment.length; i++) {
      const c = fragment[i]!;
      switch (this.phase) {
        case Phase.BeforeObject:
          if (jsonSpace(c)) continue;
          if (c !== "{") this.fail("apply_patch arguments must be a JSON object");
          this.phase = Phase.BeforeKey;
          break;
        case Phase.BeforeKey:
          if (jsonSpace(c)) continue;
          if (c !== '"') this.fail("apply_patch arguments must contain the input field");
          this.keyRaw += c;
          this.phase = Phase.InKey;
          break;
        case Phase.InKey: {
          this.keyRaw += c;
          if (this.escapeRaw !== "") {
            this.escapeRaw = "";
            continue;
          }
          if (c === "\\") {
            this.escapeRaw = c;
            continue;
          }
          if (c.charCodeAt(0) < 0x20) this.fail("invalid control character in apply_patch input key");
          if (c === '"') {
            let key: unknown;
            try {
              key = JSON.parse(this.keyRaw);
            } catch (err) {
              this.fail(`decode apply_patch input key: ${(err as Error).message}`);
            }
            if (key !== "input") this.fail("apply_patch arguments must contain the input field");
            this.keyRaw = "";
            this.phase = Phase.BeforeColon;
          }
          break;
        }
        case Phase.BeforeColon:
          if (jsonSpace(c)) continue;
          if (c !== ":") this.fail("apply_patch input key must be followed by a colon");
          this.phase = Phase.BeforeValue;
          break;
        case Phase.BeforeValue:
          if (jsonSpace(c)) continue;
          if (c !== '"') this.fail("apply_patch input must be a string");
          this.phase = Phase.InValue;
          break;
        case Phase.InValue: {
          const err = this.consumeValue(c);
          if (err) this.fail(err);
          break;
        }
        case Phase.AfterValue:
          if (jsonSpace(c)) continue;
          if (c !== "}") this.fail("apply_patch arguments must contain only one input field");
          this.phase = Phase.Complete;
          break;
        case Phase.Complete:
          if (!jsonSpace(c)) this.fail("apply_patch arguments must not contain trailing JSON");
          break;
      }
    }
    return this.input.slice(start);
  }

  private consumeValue(c: string): string | undefined {
    const code = c.charCodeAt(0);
    if (code >= 0x80) {
      if (this.escapeRaw !== "" || this.highSurrogate !== 0) return "invalid Unicode escape in apply_patch input";
      this.input += c;
      return undefined;
    }
    if (this.escapeRaw !== "") {
      this.escapeRaw += c;
      if (this.escapeRaw.length === 2) {
        if (this.highSurrogate !== 0 && c !== "u") return "apply_patch input high surrogate requires a low surrogate";
        let decoded: string;
        switch (c) {
          case "u":
            return undefined;
          case '"':
          case "\\":
          case "/":
            decoded = c;
            break;
          case "b":
            decoded = "\b";
            break;
          case "f":
            decoded = "\f";
            break;
          case "n":
            decoded = "\n";
            break;
          case "r":
            decoded = "\r";
            break;
          case "t":
            decoded = "\t";
            break;
          default:
            return "invalid escape in apply_patch input";
        }
        this.input += decoded;
        this.escapeRaw = "";
        return undefined;
      }
      if (hexValue(c) < 0) return "invalid Unicode escape in apply_patch input";
      if (this.escapeRaw.length < 6) return undefined;
      let value = 0;
      for (const digit of this.escapeRaw.slice(2)) value = (value << 4) | hexValue(digit);
      this.escapeRaw = "";
      if (this.highSurrogate !== 0) {
        if (value < 0xdc00 || value > 0xdfff) return "apply_patch input high surrogate requires a low surrogate";
        this.input += String.fromCharCode(this.highSurrogate, value);
        this.highSurrogate = 0;
      } else if (value >= 0xd800 && value <= 0xdbff) {
        this.highSurrogate = value;
      } else if (value >= 0xdc00 && value <= 0xdfff) {
        return "unpaired low surrogate in apply_patch input";
      } else {
        this.input += String.fromCharCode(value);
      }
      return undefined;
    }
    if (this.highSurrogate !== 0 && c !== "\\") return "apply_patch input high surrogate requires a low surrogate";
    if (c === "\\") this.escapeRaw = c;
    else if (c === '"') this.phase = Phase.AfterValue;
    else if (code < 0x20) return "invalid control character in apply_patch input";
    else this.input += c;
    return undefined;
  }

  /** Validates the final wrapper and returns only the previously unsent suffix. */
  finish(args: string): string {
    if (this.error) throw this.error;
    let input: string;
    try {
      input = unwrapApplyPatchInput(args);
    } catch (err) {
      this.error = err as Error;
      throw err;
    }
    const final = new ApplyPatchInputDecoder();
    try {
      final.push(args);
    } catch (err) {
      this.error = err as Error;
      throw err;
    }
    if (this.finished) {
      if (input !== this.input) this.fail("conflicting apply_patch arguments completion");
      return "";
    }
    if (!input.startsWith(this.input)) this.fail("final apply_patch input conflicts with streamed input");
    const tail = input.slice(this.input.length);
    this.input += tail;
    this.finished = true;
    this.phase = Phase.Complete;
    this.keyRaw = "";
    this.escapeRaw = "";
    this.highSurrogate = 0;
    return tail;
  }

  /** The decoded input, preserving its original whitespace. */
  decodedInput(): string {
    return this.input;
  }

  private fail(message: string): never {
    this.error = new Error(message);
    throw this.error;
  }
}

// ---- apply_patch_events.go ----

/** Owns the input decoder and identity of one tool call. */
export class ApplyPatchCallState {
  itemID = "";
  callID = "";
  name = "";
  namespace = "";
  outputIndex = 0;
  readonly decoder = new ApplyPatchInputDecoder();

  constructor(init: Partial<Pick<ApplyPatchCallState, "itemID" | "callID" | "name" | "namespace" | "outputIndex">> = {}) {
    Object.assign(this, init);
  }

  /** Decodes the next arguments fragment for this call; throws on invalid input. */
  pushArguments(fragment: string): string {
    return this.decoder.push(fragment);
  }

  /** Returns any unsent suffix and the complete decoded input; throws on invalid input. */
  finishArguments(args: string): { tail: string; input: string } {
    const tail = this.decoder.finish(args);
    return { tail, input: this.decoder.decodedInput() };
  }
}

function applyPatchEventIdentity(payload: Record<string, unknown>, s: ApplyPatchCallState, sequence: number): Record<string, unknown> {
  payload.item_id = s.itemID;
  payload.call_id = s.callID;
  payload.output_index = s.outputIndex;
  payload.sequence_number = sequence;
  return payload;
}

/** A Responses custom-tool input delta without SSE framing. */
export function applyPatchInputDelta(s: ApplyPatchCallState, delta: string, sequence: number): string {
  const payload = applyPatchEventIdentity({ type: "response.custom_tool_call_input.delta", item_id: "", call_id: "", output_index: 0, sequence_number: 0, delta: "" }, s, sequence);
  payload.delta = delta;
  return JSON.stringify(payload);
}

/** A Responses custom-tool input completion without SSE framing. */
export function applyPatchInputDone(s: ApplyPatchCallState, input: string, sequence: number): string {
  const payload = applyPatchEventIdentity({ type: "response.custom_tool_call_input.done", item_id: "", call_id: "", output_index: 0, sequence_number: 0, input: "" }, s, sequence);
  payload.input = input;
  return JSON.stringify(payload);
}

/** A terminal Responses failure that does not expose upstream arguments. */
export function applyPatchFailure(responseID: string, sequence: number): string {
  return JSON.stringify({
    type: "response.failed",
    sequence_number: sequence,
    response: {
      id: responseID,
      object: "response",
      status: "failed",
      error: { type: "server_error", code: "invalid_tool_arguments", message: "Invalid apply_patch tool arguments received from upstream.", param: null },
    },
  });
}

/** Retains a conversion error for the caller (Go: ApplyPatchErrorState). Implements ToolInputErrorState. */
export class ApplyPatchErrorState {
  private err: Error | undefined;

  setToolInputError(err: Error): void {
    this.err = err;
  }

  toolInputError(): Error | undefined {
    return this.err;
  }
}

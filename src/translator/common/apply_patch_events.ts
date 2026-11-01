// Port of internal/translator/common/apply_patch_events.go.
//
// Event payload builders (JSON strings without SSE framing) and per-call state
// for apply_patch custom-tool input carried through function-call arguments.
import { ApplyPatchInputDecoder } from "./apply_patch_input.ts";

/** Owns the input decoder and identity of one tool call. */
export class ApplyPatchCallState {
  itemID: string;
  callID: string;
  name: string;
  namespace: string;
  outputIndex: number;
  decoder = new ApplyPatchInputDecoder();

  constructor(init: { itemID?: string; callID?: string; name?: string; namespace?: string; outputIndex?: number } = {}) {
    this.itemID = init.itemID ?? "";
    this.callID = init.callID ?? "";
    this.name = init.name ?? "";
    this.namespace = init.namespace ?? "";
    this.outputIndex = init.outputIndex ?? 0;
  }

  /** Decodes the next arguments fragment for this call. */
  pushArguments(fragment: string): [string, Error | undefined] {
    return this.decoder.push(fragment);
  }

  /** Returns [unsent suffix, complete decoded input, error]. */
  finishArguments(args: string): [string, string, Error | undefined] {
    const [tail, errFinish] = this.decoder.finish(args);
    if (errFinish) return ["", "", errFinish];
    return [tail, this.decoder.input(), undefined];
  }
}

function eventIdentity(payload: Record<string, unknown>, s: ApplyPatchCallState, sequence: number): Record<string, unknown> {
  payload.item_id = s.itemID;
  payload.call_id = s.callID;
  payload.output_index = s.outputIndex;
  payload.sequence_number = sequence;
  return payload;
}

/** Builds a Responses custom-tool input delta payload. */
export function applyPatchInputDelta(s: ApplyPatchCallState, delta: string, sequence: number): string {
  const payload = eventIdentity({ type: "response.custom_tool_call_input.delta" }, s, sequence);
  payload.delta = delta;
  return JSON.stringify(payload);
}

/** Builds a Responses custom-tool input completion payload. */
export function applyPatchInputDone(s: ApplyPatchCallState, input: string, sequence: number): string {
  const payload = eventIdentity({ type: "response.custom_tool_call_input.done" }, s, sequence);
  payload.input = input;
  return JSON.stringify(payload);
}

/** Builds a terminal Responses failure without exposing upstream arguments. */
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

/** Retains a conversion error for the caller (implements the ToolInputErrorState contract). */
export class ApplyPatchErrorState {
  private toolInputErr: Error | undefined;

  setToolInputError(err: Error | undefined): void {
    this.toolInputErr = err;
  }

  toolInputError(): Error | undefined {
    return this.toolInputErr;
  }
}

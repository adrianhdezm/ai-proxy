// Port of internal/translator/openai/openai/responses/shell_tool.go.
//
// The Responses local shell tool ({"type":"shell","environment":{"type":"local"}})
// is offered to Chat Completions upstreams as a synthetic function; replayed
// shell_call / shell_call_output history becomes function_call / _output items
// and upstream calls of the synthetic function become shell_call items again.
import { getAt, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { applyPatchFailure } from "../../../common/apply_patch_events.ts";
import type { ResponsesToolIndex } from "./tools.ts";

/** Base name of the synthetic local shell function. */
export const localShellBaseName = "__cpa_local_shell";

export const errInvalidShellActionMessage = "invalid shell action: expected nonempty commands strings and optional positive integer limits";

/** Raised when an upstream shell call carries an invalid action. */
export class InvalidShellActionError extends Error {
  constructor() {
    super(errInvalidShellActionMessage);
    this.name = "InvalidShellActionError";
  }
}

export function convertResponsesShellToolToOpenAIChat(_tool: unknown, name: string): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      description:
        "Request commands to execute in the client-provided local shell environment. Each commands entry is a complete shell command, not an argv element.",
      parameters: {
        type: "object",
        properties: {
          commands: { type: "array", items: { type: "string" }, minItems: 1 },
          timeout_ms: { type: "integer", minimum: 1 },
          max_output_length: { type: "integer", minimum: 1 },
        },
        required: ["commands"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Normalises shell history before call grouping and output pairing; the whole
 * output envelope is kept as JSON text (Go: responsesToolIndex.shellHistory).
 */
export function shellHistory(idx: ResponsesToolIndex, items: unknown[]): unknown[] {
  let name = idx.shellName();
  if (name === "") {
    // Historical calls remain meaningful after the client withdraws the tool:
    // reserve a replay-only name without adding an available declaration.
    const reserved = new Set<string>([...idx.byChat.keys(), ...idx.byRaw.keys(), ...idx.byLocal.keys()]);
    for (const item of items) {
      const kind = gstr(getAt(item, "type"));
      if (kind === "function_call" || kind === "custom_tool_call") reserved.add(idx.canonicalName(gstr(getAt(item, "name"))));
    }
    name = localShellBaseName;
    for (let suffix = 1; reserved.has(name); suffix++) name = `${localShellBaseName}_${suffix}`;
  }
  return items.map((item) => {
    switch (gstr(getAt(item, "type"))) {
      case "shell_call": {
        const environment = getAt(item, "environment.type");
        if (environment !== undefined && gstr(environment) !== "local") return item;
        const action = getAt(item, "action");
        return { ...(isObj(item) ? item : {}), type: "function_call", name, arguments: action === undefined ? "" : JSON.stringify(action) };
      }
      case "shell_call_output":
        return { ...(isObj(item) ? item : {}), type: "function_call_output", output: JSON.stringify(item) };
      default:
        return item;
    }
  });
}

/** Builds a shell_call item from validated upstream arguments, or throws InvalidShellActionError. */
export function shellCallItem(callID: string, args: string, status: string): Record<string, unknown> {
  let action: unknown;
  try {
    action = JSON.parse(args);
  } catch {
    throw new InvalidShellActionError();
  }
  if (!isObj(action)) throw new InvalidShellActionError();
  const commands = action.commands;
  if (!isArr(commands) || commands.length === 0) throw new InvalidShellActionError();
  for (const command of commands) {
    if (typeof command !== "string" || command.trim() === "") throw new InvalidShellActionError();
  }
  for (const [key, value] of Object.entries(action)) {
    switch (key) {
      case "commands":
        break;
      case "timeout_ms":
      case "max_output_length":
        if (value !== null && (typeof value !== "number" || value <= 0 || Math.trunc(value) !== value)) throw new InvalidShellActionError();
        break;
      default:
        throw new InvalidShellActionError();
    }
  }
  const item = shellCallPlaceholder(callID);
  item.status = status;
  item.action = action;
  return item;
}

export function shellCallPlaceholder(callID: string): Record<string, unknown> {
  return { id: "sh_" + callID, type: "shell_call", status: "in_progress", call_id: callID, action: { commands: [] } };
}

/** The terminal response.failed payload for invalid tool input (Go: responsesToolInputFailure). */
export function responsesToolInputFailure(responseID: string, sequence: number, err: Error | undefined): Record<string, unknown> {
  const failure = JSON.parse(applyPatchFailure(responseID, sequence)) as Record<string, unknown>;
  if (err instanceof InvalidShellActionError) {
    ((failure.response as Record<string, unknown>).error as Record<string, unknown>).message = errInvalidShellActionMessage;
  }
  return failure;
}

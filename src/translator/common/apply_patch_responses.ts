// Port of internal/translator/common/apply_patch_responses.go.
//
// NormalizeApplyPatchResponsesRequest rewrites a Responses request whose
// custom apply_patch tool must reach an upstream without freeform tools, and
// ApplyPatchResponsesBridge converts that upstream's function-call events back
// into custom_tool_call events. Payloads are JSON strings without SSE framing.
import {
  type ResponsesToolDescriptor,
  collectResponsesToolDescriptors,
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
} from "../../util/responses_tools.ts";
import { deepCopy, deleteAt, exists, garray, getAt, gint, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { ApplyPatchCallState, ApplyPatchErrorState, applyPatchFailure, applyPatchInputDelta, applyPatchInputDone } from "./apply_patch_events.ts";
import { ApplyPatchInputDecoder } from "./apply_patch_input.ts";
import { applyPatchDescription, applyPatchParameters, isApplyPatchCustomTool, wrapApplyPatchInput } from "./apply_patch_tool.ts";

type JSONObject = Record<string, unknown>;

/**
 * Adapts declarations and explicit custom patch history. Winners are collected
 * before rewriting: normalization must not change declaration precedence.
 * Returns [normalized request, error].
 */
export function normalizeApplyPatchResponsesRequest(raw: string): [string, Error | undefined] {
  const root = tryParse<unknown>(raw);
  if (root === undefined) return [raw, new Error("invalid Responses request JSON")];
  if (!isObj(root)) return [raw, undefined];
  const winners = collectResponsesToolWinners(root);
  const affected = new Set<string>();
  for (const d of collectResponsesToolDescriptors(root)) if (isApplyPatchCustomTool(d.tool)) affected.add(d.name);

  const normalizeTools = (tools: unknown[], namespace: string): unknown[] => {
    const items: unknown[] = [];
    for (const tool of tools) {
      let item = deepCopy(tool);
      if (getAt(tool, "type") === "namespace") {
        for (const key of ["tools", "children"]) {
          const children = getAt(tool, key);
          if (isArr(children)) {
            if (isObj(item)) item[key] = normalizeTools(children, gstr(getAt(tool, "name")));
            break;
          }
        }
      } else {
        let name = gstr(getAt(tool, "name"));
        if (name === "") name = gstr(getAt(tool, "function.name"));
        const qualified = qualifyResponsesNamespaceToolName(namespace, name);
        const winner = winners.get(qualified);
        if (winner && affected.has(qualified)) {
          if (winner.tool !== tool) continue;
          if (isApplyPatchCustomTool(tool) && isObj(item)) {
            item.type = "function";
            item.description = applyPatchDescription(tool);
            item.parameters = JSON.parse(applyPatchParameters());
            delete item.format;
            item = { ...item };
          }
        }
      }
      items.push(item);
    }
    return items;
  };

  const out = deepCopy(root);
  if (isArr(root.tools)) out.tools = normalizeTools(root.tools, "");
  const input = garray(root.input);
  const patchHistory = new Set<string>();
  for (const item of input) {
    if (getAt(item, "type") === "custom_tool_call" && gstr(getAt(item, "name")).trim() === "apply_patch") patchHistory.add(gstr(getAt(item, "call_id")));
  }
  const outInput = garray(out.input);
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const target = outInput[i];
    if (!isObj(target)) continue;
    switch (gstr(getAt(item, "type"))) {
      case "additional_tools": {
        const tools = getAt(item, "tools");
        if (isArr(tools)) target.tools = normalizeTools(tools, "");
        break;
      }
      case "custom_tool_call": {
        if (gstr(getAt(item, "name")).trim() !== "apply_patch") continue;
        const value = getAt(item, "input");
        if (typeof value !== "string") return ["", new Error("apply_patch history input must be a string")];
        target.type = "function_call";
        target.arguments = wrapApplyPatchInput(value);
        delete target.input;
        break;
      }
      case "custom_tool_call_output":
        if (patchHistory.has(gstr(getAt(item, "call_id")))) target.type = "function_call_output";
        break;
    }
  }
  const normalizeChoice = (choice: unknown): unknown => {
    const result = deepCopy(choice);
    const name = gstr(getAt(choice, "name"));
    const namespace = gstr(getAt(choice, "namespace"));
    const d = winners.get(qualifyResponsesNamespaceToolName(namespace, name));
    if (d && isApplyPatchCustomTool(d.tool) && getAt(choice, "type") === "custom" && isObj(result)) result.type = "function";
    const children = garray(getAt(choice, "tools"));
    if (isObj(result) && isArr(result.tools)) {
      for (let i = 0; i < children.length; i++) result.tools[i] = normalizeChoice(children[i]);
    }
    return result;
  };
  if (isObj(root.tool_choice)) out.tool_choice = normalizeChoice(root.tool_choice);
  return [JSON.stringify(out), undefined];
}

class PatchRecord {
  state = new ApplyPatchCallState({ outputIndex: -1 });
  kind = "";
  qualified = "";
  source = "";
  patch = false;
  named = false;
  added = false;
  inputDone = false;
  itemDone = false;
  snapshot = "";
  completedItem = "";
  hasSnapshot = false;
  pending: string[] = [];
  evidence: Error | undefined;

  identityReady(): boolean {
    return this.state.itemID !== "" && this.state.callID !== "" && this.state.outputIndex >= 0;
  }
}

/**
 * Handles Responses JSON event payloads, without SSE framing. Identity evidence
 * is retained even before a call receives its name. A bridge is local to one response.
 */
export class ApplyPatchResponsesBridge extends ApplyPatchErrorState {
  private readonly tools: Map<string, ResponsesToolDescriptor>;
  private readonly records: PatchRecord[] = [];
  private readonly byItemID = new Map<string, PatchRecord>();
  private readonly byCallID = new Map<string, PatchRecord>();
  private readonly byOutputIndex = new Map<number, PatchRecord>();
  private sequence = 0;
  private lastSequence = 0;
  private responseID = "";
  private failed = false;
  private terminal = false;
  private readonly active: boolean = false;
  private converted = false;

  /** Resolves original declarations before any normalization. */
  constructor(originalRequest: string) {
    super();
    this.tools = collectResponsesToolWinners(tryParse<unknown>(originalRequest));
    for (const d of this.tools.values()) if (isApplyPatchCustomTool(d.tool)) this.active = true;
  }

  private next(): number {
    this.sequence++;
    return this.sequence;
  }

  private failure(err: Error): [string[], Error | undefined] {
    if (this.failed || this.terminal) return [[], undefined];
    this.failed = true;
    this.setToolInputError(err);
    return [[applyPatchFailure(this.responseID, this.next())], err];
  }

  /** Terminates an executor-owned bridge with the same one-shot failure contract. */
  fail(err: Error): [string[], Error | undefined] {
    return this.failure(err);
  }

  private descriptor(item: unknown): ResponsesToolDescriptor | undefined {
    const name = qualifyResponsesNamespaceToolName(gstr(getAt(item, "namespace")), gstr(getAt(item, "name")));
    return this.tools.get(name);
  }

  // resolve checks every supplied identity, not just the first usable key. Conflicting
  // unmatched keys and multiple matched records retain evidence until patch provenance is known.
  private resolve(event: unknown, item: unknown): [PatchRecord | undefined, Error | undefined] {
    const ids = [gstr(getAt(event, "item_id")), gstr(getAt(item, "id"))];
    const calls = [gstr(getAt(event, "call_id")), gstr(getAt(item, "call_id"))];
    const indexValue = getAt(event, "output_index");
    const hasIndex = exists(indexValue);
    const index = gint(indexValue);
    const matched = new Set<PatchRecord>();
    for (const id of ids) {
      const r = this.byItemID.get(id);
      if (id !== "" && r) matched.add(r);
    }
    for (const id of calls) {
      const r = this.byCallID.get(id);
      if (id !== "" && r) matched.add(r);
    }
    if (hasIndex) {
      const r = this.byOutputIndex.get(index);
      if (r) matched.add(r);
    }
    let r: PatchRecord | undefined;
    for (const candidate of this.records) {
      if (matched.has(candidate)) {
        r = candidate;
        break;
      }
    }
    if (!r) {
      r = new PatchRecord();
      this.records.push(r);
    }
    let bad = matched.size > 1;
    for (const id of ids) if (id !== "" && r.state.itemID !== "" && r.state.itemID !== id) bad = true;
    for (const id of calls) if (id !== "" && r.state.callID !== "" && r.state.callID !== id) bad = true;
    if (ids[0] !== "" && ids[1] !== "" && ids[0] !== ids[1]) bad = true;
    if (calls[0] !== "" && calls[1] !== "" && calls[0] !== calls[1]) bad = true;
    if (hasIndex && r.state.outputIndex >= 0 && r.state.outputIndex !== index) bad = true;
    const d = this.descriptor(item);
    const known = d !== undefined;
    let incomingPatch = known && isApplyPatchCustomTool(d.tool) && gstr(getAt(item, "type")) !== "custom_tool_call";
    if (bad) {
      const errIdentity = new Error("conflicting apply_patch call identity");
      r.evidence = errIdentity;
      for (const candidate of matched) {
        candidate.evidence = errIdentity;
        if (candidate.patch) incomingPatch = true;
      }
      // Keep aliases for unmatched conflicting keys, too. Their later patch provenance
      // must not create a fresh record and erase the earlier contradiction.
      for (const id of ids) if (id !== "" && !this.byItemID.has(id)) this.byItemID.set(id, r);
      for (const id of calls) if (id !== "" && !this.byCallID.has(id)) this.byCallID.set(id, r);
      if (hasIndex && !this.byOutputIndex.has(index)) this.byOutputIndex.set(index, r);
      if (r.patch || incomingPatch) return [undefined, errIdentity];
    } else {
      for (const id of ids) {
        if (id !== "") {
          r.state.itemID = id;
          this.byItemID.set(id, r);
        }
      }
      for (const id of calls) {
        if (id !== "") {
          r.state.callID = id;
          this.byCallID.set(id, r);
        }
      }
      if (hasIndex) {
        r.state.outputIndex = index;
        this.byOutputIndex.set(index, r);
      }
    }
    const kind = gstr(getAt(item, "type"));
    if (kind !== "") {
      if (r.kind !== "" && r.kind !== kind) r.evidence = new Error("conflicting apply_patch call type");
      if (r.kind === "") r.kind = kind;
    }
    const name = gstr(getAt(item, "name"));
    if (name !== "") {
      let qualified = qualifyResponsesNamespaceToolName(gstr(getAt(item, "namespace")), name);
      if (d) qualified = d.name;
      if (r.named && r.qualified !== qualified) r.evidence = new Error("conflicting apply_patch call name");
      r.named = true;
      r.qualified = qualified;
      r.state.name = name;
      r.state.namespace = gstr(getAt(item, "namespace"));
      if (d) {
        r.state.name = d.localName;
        r.state.namespace = d.namespace;
      }
    }
    if (incomingPatch) r.patch = true;
    if (r.patch && r.evidence) return [undefined, r.evidence];
    return [r, undefined];
  }

  /**
   * Retains every supplied key before a folded dispatcher reveals its child.
   * Names are deliberately withheld: a dispatcher name is not the selected child name.
   */
  checkIdentity(event: string): Error | undefined {
    const root = tryParse<unknown>(event);
    let item = getAt(root, "item");
    if (exists(item)) {
      item = deepCopy(item);
      deleteAt(item, "name");
      deleteAt(item, "namespace");
    }
    return this.resolve(root, item)[1];
  }

  private restoreItem(item: unknown, r: PatchRecord, input: string, added: boolean): JSONObject {
    const out: JSONObject = isObj(item) ? item : {};
    if (r.patch) {
      out.type = "custom_tool_call";
      delete out.arguments;
      out.input = input;
    }
    const d = this.tools.get(r.qualified);
    if (d && d.namespace !== "") {
      out.name = d.localName;
      out.namespace = d.namespace;
    }
    if (r.patch && !added) {
      if (r.state.itemID !== "") out.id = r.state.itemID;
      if (r.state.callID !== "") out.call_id = r.state.callID;
      out.name = r.state.name;
    }
    return out;
  }

  private itemEvent(kind: string, item: unknown, r: PatchRecord): string {
    return JSON.stringify({ type: kind, output_index: r.state.outputIndex, sequence_number: this.next(), item });
  }

  private takeSnapshot(r: PatchRecord, args: unknown, final: boolean): Error | undefined {
    if (!exists(args)) return undefined;
    if (typeof args !== "string") return new Error("apply_patch arguments snapshot must be a string");
    if (args === "" && !final) return undefined;
    const decoder = new ApplyPatchInputDecoder();
    const [, errFinish] = decoder.finish(args);
    if (errFinish) return errFinish;
    if (r.hasSnapshot) {
      const previous = new ApplyPatchInputDecoder();
      previous.finish(r.snapshot);
      if (previous.input() !== decoder.input()) return new Error("conflicting apply_patch arguments snapshot");
    }
    if (!decoder.input().startsWith(r.state.decoder.input())) return new Error("apply_patch snapshot conflicts with streamed input");
    r.snapshot = args;
    r.hasSnapshot = true;
    return undefined;
  }

  private patchEvent(raw: string, r: PatchRecord): [string[], Error | undefined] {
    if (!r.identityReady()) return [[], new Error("unresolved apply_patch call identity")];
    const root = tryParse<unknown>(raw);
    const kind = gstr(getAt(root, "type"));
    const item = getAt(root, "item");
    this.converted = true;
    const out: string[] = [];
    if (exists(item)) {
      if (gstr(getAt(item, "type")) !== "function_call") return [[], new Error("conflicting apply_patch call type")];
      const errSnapshot = this.takeSnapshot(r, getAt(item, "arguments"), kind === "response.output_item.done");
      if (errSnapshot) return [[], errSnapshot];
    }
    if (!r.added) {
      const added: JSONObject = exists(item) && isObj(item) ? deepCopy(item) : { type: "function_call", name: "", arguments: "" };
      added.name = r.state.name;
      if (r.state.itemID !== "") added.id = r.state.itemID;
      if (r.state.callID !== "") added.call_id = r.state.callID;
      if (r.state.namespace !== "") added.namespace = r.state.namespace;
      out.push(this.itemEvent("response.output_item.added", this.restoreItem(added, r, "", true), r));
      r.added = true;
    }
    switch (kind) {
      case "response.function_call_arguments.delta": {
        const fragment = gstr(getAt(root, "delta"));
        if (r.inputDone) {
          if (fragment !== "") return [[], new Error("apply_patch arguments received after completion")];
          return [out, undefined];
        }
        r.source += fragment;
        const [delta, errPush] = r.state.pushArguments(fragment);
        if (errPush) return [[], errPush];
        if (r.hasSnapshot) {
          const snapshot = new ApplyPatchInputDecoder();
          snapshot.finish(r.snapshot);
          if (!snapshot.input().startsWith(r.state.decoder.input())) return [[], new Error("apply_patch stream conflicts with snapshot")];
        }
        if (delta !== "") out.push(applyPatchInputDelta(r.state, delta, this.next()));
        break;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const args = exists(item) ? getAt(item, "arguments") : getAt(root, "arguments");
        if (exists(args)) {
          const errSnapshot = this.takeSnapshot(r, args, true);
          if (errSnapshot) return [[], errSnapshot];
        }
        const final = r.hasSnapshot ? r.snapshot : r.source;
        const [tail, input, errFinish] = r.state.finishArguments(final);
        if (errFinish) return [[], errFinish];
        if (!r.inputDone) {
          if (tail !== "" && r.source !== "") out.push(applyPatchInputDelta(r.state, tail, this.next()));
          out.push(applyPatchInputDone(r.state, input, this.next()));
          r.inputDone = true;
        }
        if (kind === "response.output_item.done" && !r.itemDone) {
          r.completedItem = JSON.stringify(this.restoreItem(deepCopy(item), r, input, false));
          out.push(this.itemEvent(kind, JSON.parse(r.completedItem), r));
          r.itemDone = true;
        }
        break;
      }
    }
    return [out, undefined];
  }

  private transformItemEvent(raw: string): [string[], Error | undefined] {
    const root = tryParse<unknown>(raw);
    let item = getAt(root, "item");
    const hasRootItem = exists(item);
    if (!hasRootItem && exists(getAt(root, "name"))) {
      // Arguments events can supply late names and identities at the root.
      const identity: JSONObject = { type: "function_call" };
      for (const key of ["name", "namespace", "call_id"]) {
        const value = getAt(root, key);
        if (exists(value)) identity[key] = value;
      }
      item = identity;
    }
    const [r, errResolve] = this.resolve(root, item);
    if (errResolve || !r) return [[], errResolve];
    // A known name is provenance, not readiness. Retain the real source events
    // until both upstream IDs and the output index can identify every emitted event.
    if ((!r.named && (r.kind === "" || r.kind === "function_call")) || (r.patch && !r.identityReady())) {
      if (r.patch) {
        const args = hasRootItem ? getAt(item, "arguments") : getAt(root, "arguments");
        const kind = gstr(getAt(root, "type"));
        const errSnapshot = this.takeSnapshot(r, args, kind === "response.output_item.done" || kind === "response.function_call_arguments.done");
        if (errSnapshot) return [[], errSnapshot];
      }
      r.pending.push(raw);
      return [[], undefined];
    }
    const out: string[] = [];
    const pending = r.pending;
    r.pending = [];
    if (r.patch) {
      for (const event of [...pending, raw]) {
        const [converted, errEvent] = this.patchEvent(event, r);
        if (errEvent) return [[], errEvent];
        out.push(...converted);
      }
      return [out, undefined];
    }
    out.push(...pending);
    let result = raw;
    let resultItem = item;
    if (hasRootItem && r.kind === "function_call" && (this.tools.get(r.qualified)?.namespace ?? "") !== "") {
      const restored = this.restoreItem(deepCopy(item), r, "", false);
      (root as JSONObject).item = restored;
      resultItem = restored;
      result = JSON.stringify(root);
    }
    if (gstr(getAt(root, "type")) === "response.output_item.done" && exists(item)) {
      r.itemDone = true;
      r.completedItem = JSON.stringify(resultItem);
    }
    out.push(result);
    return [out, undefined];
  }

  private envelope(raw: string, stream: boolean): [string, string[], Error | undefined] {
    const root = tryParse<unknown>(raw) as JSONObject;
    let modified = false;
    const response = isObj(root) && exists(root.response) ? root.response : root;
    const outputPath = isObj(root) && exists(root.response) ? "response.output" : "output";
    const output = garray(getAt(response, "output"));
    const originalLength = output.length;
    const preceding: string[] = [];
    const seen = new Set<PatchRecord>();
    let items: unknown[] = [];
    for (let i = 0; i < output.length; i++) {
      const item = output[i];
      let index = i;
      // A terminal snapshot may omit earlier completed items: array position is not identity.
      let knownRecord = this.byItemID.get(gstr(getAt(item, "id")));
      if (!knownRecord) knownRecord = this.byCallID.get(gstr(getAt(item, "call_id")));
      if (knownRecord && knownRecord.state.outputIndex >= 0) {
        index = knownRecord.state.outputIndex;
      } else if (!knownRecord && (gstr(getAt(item, "id")) !== "" || gstr(getAt(item, "call_id")) !== "")) {
        const previous = this.byOutputIndex.get(index);
        if (previous && (previous.state.itemID !== "" || previous.state.callID !== "")) {
          for (const r of this.records) if (r.state.outputIndex >= index) index = r.state.outputIndex + 1;
        }
      }
      const event = { type: "response.output_item.done", output_index: index, item: deepCopy(item) };
      const [r, errResolve] = this.resolve(event, item);
      if (errResolve || !r) return ["", [], errResolve];
      seen.add(r);
      if (r.patch) {
        const pending = r.pending;
        r.pending = [];
        for (const source of pending) {
          const [events, errEvent] = this.patchEvent(source, r);
          if (errEvent) return ["", [], errEvent];
          preceding.push(...events);
        }
        const [events, errEvent] = this.patchEvent(JSON.stringify(event), r);
        if (errEvent) return ["", [], errEvent];
        preceding.push(...events);
        output[i] = this.restoreItem(deepCopy(item), r, r.state.decoder.input(), false);
        modified = true;
      } else if (gstr(getAt(item, "type")) === "function_call" && (this.tools.get(r.qualified)?.namespace ?? "") !== "") {
        output[i] = this.restoreItem(deepCopy(item), r, "", false);
        modified = true;
      }
      items.push(output[i]);
    }
    for (const r of this.records) {
      if (seen.has(r) || (!r.patch && !this.converted)) continue;
      if (r.inputDone && !r.itemDone) {
        const item = { type: "function_call", status: "completed" };
        r.completedItem = JSON.stringify(this.restoreItem(item, r, r.state.decoder.input(), false));
        preceding.push(this.itemEvent("response.output_item.done", JSON.parse(r.completedItem), r));
        r.itemDone = true;
      }
      if (r.itemDone) {
        let index = r.state.outputIndex;
        if (index < 0 || index > items.length) index = items.length;
        items = [...items.slice(0, index), JSON.parse(r.completedItem), ...items.slice(index)];
      }
    }
    if (items.length !== originalLength) {
      if (isObj(response) && response !== root) response.output = items;
      else if (isObj(root)) root.output = items;
      void outputPath;
      modified = true;
    }
    if (stream) {
      const errFinish = this.finish();
      if (errFinish) return ["", [], errFinish];
      for (const r of this.records) {
        preceding.push(...r.pending);
        r.pending = [];
      }
      if (this.converted && isObj(root)) {
        root.sequence_number = this.next();
        modified = true;
      }
    }
    return [modified ? JSON.stringify(root) : raw, preceding, undefined];
  }

  /** Converts one payload. A failure is terminal and is emitted only once. */
  transform(event: string): [string[], Error | undefined] {
    if (this.failed || this.terminal) return [[], undefined];
    if (!this.active) return [[event], undefined];
    const root = tryParse<unknown>(event);
    const id = gstr(getAt(root, "response.id"));
    if (id !== "") this.responseID = id;
    const seqIn = gint(getAt(root, "sequence_number"));
    if (seqIn > this.sequence) this.sequence = seqIn;
    const kind = gstr(getAt(root, "type"));
    let out: string[] = [];
    let errTransform: Error | undefined;
    switch (kind) {
      case "response.output_item.added":
      case "response.output_item.done":
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        [out, errTransform] = this.transformItemEvent(event);
        break;
      case "response.completed":
      case "response.incomplete":
      case "response.done": {
        const [final, preceding, errEnvelope] = this.envelope(event, true);
        errTransform = errEnvelope;
        if (!errEnvelope) {
          out = [...preceding, final];
          this.terminal = true;
        }
        break;
      }
      case "response.failed":
        this.terminal = true;
        out = [event];
        break;
      default:
        out = [event];
    }
    if (errTransform) return this.failure(errTransform);
    // Native custom payloads are opaque. Only a stream that acquired a function
    // patch call needs resequencing of its other compatibility events.
    const nativeCustom = kind.startsWith("response.custom_tool_call_input.") || gstr(getAt(root, "item.type")) === "custom_tool_call";
    for (let i = 0; i < out.length; i++) {
      const parsed = tryParse<unknown>(out[i]);
      let seq = gint(getAt(parsed, "sequence_number"));
      if (this.converted && !nativeCustom && seq <= this.lastSequence && isObj(parsed)) {
        seq = this.next();
        parsed.sequence_number = seq;
        out[i] = JSON.stringify(parsed);
      }
      if (seq > this.lastSequence) this.lastSequence = seq;
    }
    return [out, undefined];
  }

  /** Accepts either a bare response or a terminal event envelope. */
  transformNonStream(response: string): [string, Error | undefined] {
    if (!this.active) return [response, undefined];
    const [out, , errEnvelope] = this.envelope(response, false);
    if (errEnvelope) {
      this.failed = true;
      this.setToolInputError(errEnvelope);
      return ["", errEnvelope];
    }
    return [out, undefined];
  }

  /** Rejects acquired calls whose final arguments have not been validated. */
  finish(): Error | undefined {
    const err = this.toolInputError();
    if (err) return err;
    if (this.terminal) return undefined;
    for (const r of this.records) if (r.patch && !r.inputDone) return new Error("incomplete apply_patch tool arguments received from upstream");
    return undefined;
  }
}

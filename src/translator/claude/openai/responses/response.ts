// Port of internal/translator/claude/openai/responses/claude_openai-responses_response.go.
//
// Claude Messages SSE -> OpenAI Responses SSE (stream) and Claude Messages
// (SSE or native JSON) -> one Responses object (non-stream).
//
// Stream input contract: one upstream line per call. Only lines starting with
// "data:" are consumed; "event: ..." lines, blank lines and anything else yield
// no output. Each returned string is one complete Responses SSE frame
// ("event: <type>\ndata: <json>\n\n").
import { log } from "../../../../log.ts";
import type { TranslateContext, TranslatorState } from "../../../types.ts";
import { sseEventData } from "../../../common/bytes.ts";
import { claudeMessagesJSONToSSE } from "../../../common/claude_native_response.ts";
import { requestModelName } from "../../../common/request.ts";
import { setResponsesToolCallIdentity } from "../../../common/responses.ts";
import { ApplyPatchCallState, ApplyPatchErrorState, applyPatchFailure, applyPatchInputDelta, applyPatchInputDone } from "../../../common/apply_patch_events.ts";
import { isApplyPatchCustomTool } from "../../../common/apply_patch_tool.ts";
import { deepCopy, exists, getAt, gint, gstr, isObj } from "../../../../util/gpath.ts";
import { tryParse } from "../../../../util/json.ts";
import { type ClaudeToolNames, type ResponsesToolDescriptor, buildClaudeToolNamesWithWinners, responsesToolWinners } from "./tools.ts";
import {
  buildResponsesToolSearchCallItem,
  clientToolSearchEnabledFor,
  responsesToolSearchIDPrefix,
  toolSearchCallEvent,
  toolSearchCallStatus,
} from "./tool_search.ts";
import {
  buildResponsesWebSearchCallItem,
  claudeWebSearchQuery,
  claudeWebSearchResultsToResponses,
  claudeWebSearchToolName,
  responsesWebSearchCallID,
} from "./web_search.ts";
import { claudeResponsesRedactedThinkingPrefix, unwrapCustomToolInput } from "./request.ts";

type JSONObject = Record<string, unknown>;

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

interface WebSearchItem {
  toolUseID: string;
  outputIndex: number;
  inputBuf: string;
  results: unknown;
  emitted: boolean;
  status: string;
}

function renderWebSearch(item: WebSearchItem): JSONObject {
  return buildResponsesWebSearchCallItem(item.toolUseID, claudeWebSearchQuery(item.inputBuf), item.results);
}

interface MessageItem {
  id: string;
  outputIndex: number;
  text: string;
  annotations: unknown[];
  status: string;
}

interface ReasoningItem {
  id: string;
  outputIndex: number;
  text: string;
  signature: string;
  status: string;
}

class UsageTokens {
  inputTokens = 0;
  outputTokens = 0;
  cacheCreationInputTokens = 0;
  cacheReadInputTokens = 0;
  hasUsage = false;

  merge(usage: unknown): void {
    if (!exists(usage)) return;
    this.hasUsage = true;
    const read = (key: string): number | undefined => {
      const v = getAt(usage, key);
      return exists(v) ? gint(v) : undefined;
    };
    this.inputTokens = read("input_tokens") ?? this.inputTokens;
    this.outputTokens = read("output_tokens") ?? this.outputTokens;
    this.cacheCreationInputTokens = read("cache_creation_input_tokens") ?? this.cacheCreationInputTokens;
    this.cacheReadInputTokens = read("cache_read_input_tokens") ?? this.cacheReadInputTokens;
  }

  openAIResponsesUsage(): { inputTokens: number; outputTokens: number; totalTokens: number; cachedTokens: number } {
    const cachedTokens = this.cacheReadInputTokens;
    const inputTokens = this.inputTokens + this.cacheCreationInputTokens + cachedTokens;
    const outputTokens = this.outputTokens;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens };
  }
}

/** The encrypted_content carrier for the reasoning item mirroring a thinking or redacted_thinking block. */
export function claudeReasoningCarrier(contentBlock: unknown): string {
  if (gstr(getAt(contentBlock, "type")) === "redacted_thinking") {
    const data = gstr(getAt(contentBlock, "data"));
    return data !== "" ? claudeResponsesRedactedThinkingPrefix + data : "";
  }
  return gstr(getAt(contentBlock, "signature"));
}

function claudeResponsesIncompleteDetails(stopReason: string): JSONObject | undefined {
  switch (stopReason.trim().toLowerCase()) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return { reason: "max_output_tokens" };
    case "refusal":
      // Responses clients treat content_filter as a retryable refusal instead of a finished answer.
      return { reason: "content_filter" };
  }
  return undefined;
}

/** Anthropic's server-tool iteration pause: completed with end_turn=false. */
function claudeStopReasonPauseTurn(stopReason: string): boolean {
  return stopReason.trim().toLowerCase() === "pause_turn";
}

/** Keeps a paused or tool_use-deferred search without results in_progress. */
function claudeResponsesWebSearchStatus(stopReason: string, status: string, hasResults: boolean): string {
  if (!hasResults && (claudeStopReasonPauseTurn(stopReason) || stopReason.trim().toLowerCase() === "tool_use")) return "in_progress";
  return status;
}

function claudeResponsesOutputStatus(stopReason: string): string {
  return claudeResponsesIncompleteDetails(stopReason) ? "incomplete" : "completed";
}

function claudeResponsesTerminalState(stopReason: string): { eventType: string; status: string; incompleteDetails: JSONObject | undefined } {
  const incompleteDetails = claudeResponsesIncompleteDetails(stopReason);
  if (incompleteDetails) return { eventType: "response.incomplete", status: "incomplete", incompleteDetails };
  return { eventType: "response.completed", status: "completed", incompleteDetails: undefined };
}

function pickRequestJSON(originalRequestRawJSON: string, requestRawJSON: string): unknown {
  for (const raw of [originalRequestRawJSON, requestRawJSON]) {
    if (!raw) continue;
    const parsed = tryParse<unknown>(raw);
    if (parsed !== undefined || raw.trim() === "null") return parsed;
  }
  return undefined;
}

const gfloat = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};
const gboolean = (v: unknown): boolean => v === true || (typeof v === "string" && ["1", "t", "true"].includes(v.trim().toLowerCase())) || (typeof v === "number" && v !== 0);

const echoFields: [string, (v: unknown) => unknown][] = [
  ["instructions", gstr],
  ["max_output_tokens", gint],
  ["max_tool_calls", gint],
  ["model", gstr],
  ["parallel_tool_calls", gboolean],
  ["previous_response_id", gstr],
  ["prompt_cache_key", gstr],
  ["reasoning", deepCopy],
  ["safety_identifier", gstr],
  ["service_tier", gstr],
  ["store", gboolean],
  ["temperature", gfloat],
  ["text", deepCopy],
  ["tool_choice", deepCopy],
  ["tools", deepCopy],
  ["top_logprobs", gint],
  ["top_p", gfloat],
  ["truncation", gstr],
  ["user", deepCopy],
  ["metadata", deepCopy],
];

/** The typed request fields echoed into response objects, extracted once. */
class ResponsesRequestEcho {
  private readonly values = new Map<string, unknown>();

  constructor(root: unknown) {
    if (!isObj(root)) return;
    for (const [key, convert] of echoFields) if (key in root) this.values.set(key, convert(root[key]));
  }

  apply(dst: JSONObject): JSONObject {
    for (const [key] of echoFields) if (this.values.has(key)) dst[key] = deepCopy(this.values.get(key));
    return dst;
  }
}

function emitEvent(event: string, payload: unknown): string {
  return sseEventData(event, typeof payload === "string" ? payload : JSON.stringify(payload));
}

/** Per-response state of the Claude -> Responses translator (stored in TranslatorState.value). */
export class ClaudeToResponsesState extends ApplyPatchErrorState {
  applyPatchCalls = new Map<number, ApplyPatchCallState>();
  /** upstream.claude.tool-search as pinned for this response. */
  readonly toolSearch: boolean;
  readonly requestEcho: ResponsesRequestEcho;
  readonly toolWinners: Map<string, ResponsesToolDescriptor>;
  readonly toolNames: ClaudeToolNames;
  funcItemAdded = new Map<number, boolean>();
  funcArgsSent = new Map<number, number>();
  funcBlockStopped = new Map<number, boolean>();
  funcInputSnapshot = new Map<number, string>();
  funcInputSnapshotErrors = new Map<number, Error>();
  funcIdentityConflicts = new Map<number, boolean>();
  completedEmitted = false;
  seq = 0;
  responseID = "";
  createdAt = 0;
  nextOutputIndex = 0;
  currentMsgID = "";
  currentFCID = "";
  inTextBlock = false;
  inFuncBlock = false;
  messageOpen = false;
  contentPartOpen = false;
  messageOutputIndex = -1;
  funcArgsBuf = new Map<number, string>();
  funcArgsDone = new Map<number, boolean>();
  funcItemDone = new Map<number, boolean>();
  funcItemStatus = new Map<number, string>();
  funcNames = new Map<number, string>();
  funcCallIDs = new Map<number, string>();
  funcCustom = new Map<number, boolean>();
  funcOutputIndices = new Map<number, number>();
  textBuf = "";
  currentTextBuf = "";
  messageAnnotations: unknown[] = [];
  messageItems: MessageItem[] = [];
  reasoningActive = false;
  reasoningDeltasDone = false;
  reasoningItemID = "";
  reasoningBuf = "";
  reasoningSignature = "";
  reasoningIndex = -1;
  reasoningItems: ReasoningItem[] = [];
  webSearchByBlock = new Map<number, WebSearchItem>();
  webSearchByToolID = new Map<string, WebSearchItem>();
  webSearchItems: WebSearchItem[] = [];
  stopReason = "";
  usage = new UsageTokens();

  constructor(requestJSON: unknown, toolSearch: boolean) {
    super();
    this.toolSearch = toolSearch;
    this.requestEcho = new ResponsesRequestEcho(requestJSON);
    this.toolWinners = responsesToolWinners(requestJSON, toolSearch);
    this.toolNames = buildClaudeToolNamesWithWinners(requestJSON, this.toolWinners, toolSearch);
  }

  /** Resolves a function call's (name, namespace) from the winners built once for this stream. */
  applyFunctionCallNamespaceFields<T>(item: T, qualifiedName: string, itemPath: string): T {
    qualifiedName = qualifiedName.trim();
    let name = qualifiedName;
    let namespace = "";
    if (qualifiedName !== "") {
      const identity = this.toolNames.identity(qualifiedName);
      name = identity;
      const descriptor = this.toolWinners.get(identity);
      if (descriptor && !descriptor.direct) {
        name = descriptor.childName;
        namespace = descriptor.namespace;
      }
    }
    return setResponsesToolCallIdentity(item, name, namespace, itemPath);
  }

  nextSeq = (): number => ++this.seq;

  allocateOutputIndex(): number {
    return this.nextOutputIndex++;
  }

  messageOutputIdx(): number {
    if (this.messageOutputIndex < 0) this.messageOutputIndex = this.allocateOutputIndex();
    return this.messageOutputIndex;
  }

  functionOutputIndex(blockIndex: number): number {
    const existing = this.funcOutputIndices.get(blockIndex);
    if (existing !== undefined) return existing;
    const index = this.allocateOutputIndex();
    this.funcOutputIndices.set(blockIndex, index);
    return index;
  }

  startWebSearch(blockIndex: number, toolUseID: string): WebSearchItem {
    const item: WebSearchItem = { toolUseID, outputIndex: this.allocateOutputIndex(), inputBuf: "", results: undefined, emitted: false, status: "" };
    this.webSearchByBlock.set(blockIndex, item);
    this.webSearchByToolID.set(toolUseID, item);
    this.webSearchItems.push(item);
    return item;
  }

  finalizeWebSearchWithStatus(item: WebSearchItem | undefined, status: string): string[] {
    if (!item || item.emitted) return [];
    item.emitted = true;
    item.status = status;
    const rendered = renderWebSearch(item);
    rendered.status = status;
    return [emitEvent("response.output_item.done", { type: "response.output_item.done", sequence_number: this.nextSeq(), output_index: item.outputIndex, item: rendered })];
  }

  /** Consults the original request's winning declaration, not the sanitized upstream name. */
  isApplyPatch(name: string): boolean {
    const d = this.toolWinners.get(this.toolNames.identity(name));
    return !!d && d.toolType === "custom" && isApplyPatchCustomTool(d.tool);
  }

  /** Reports whether a Claude tool name maps to the client tool_search declaration. */
  isToolSearch(name: string): boolean {
    return this.toolWinners.get(this.toolNames.identity(name))?.clientSearch === true;
  }

  failToolInput(err: Error): string[] {
    if (this.toolInputError()) return [];
    this.setToolInputError(err);
    return [emitEvent("response.failed", applyPatchFailure(this.responseID, this.nextSeq()))];
  }

  emitFuncItem(idx: number, force: boolean): string[] {
    if (this.funcItemAdded.get(idx) || this.toolInputError()) return [];
    let name = this.funcNames.get(idx) ?? "";
    let callID = this.funcCallIDs.get(idx) ?? "";
    if (force && name === "" && this.toolWinners.size === 1) {
      for (const identity of this.toolWinners.keys()) {
        if (this.isApplyPatch(identity)) {
          name = this.toolNames.claudeName(identity);
          this.funcNames.set(idx, name);
        }
      }
    }
    if (this.isApplyPatch(name)) {
      if (this.funcIdentityConflicts.get(idx)) return this.failToolInput(new Error("conflicting apply_patch call identity"));
      const errSnapshot = this.funcInputSnapshotErrors.get(idx);
      if (errSnapshot) return this.failToolInput(errSnapshot);
    }
    if (!force && (name === "" || callID === "")) return [];
    if (callID === "") {
      callID = `call_${this.responseID}_${idx}`;
      this.funcCallIDs.set(idx, callID);
    }
    const d = this.toolWinners.get(this.toolNames.identity(name));
    this.funcCustom.set(idx, d?.toolType === "custom");
    const outputIndex = this.functionOutputIndex(idx);
    if (this.isToolSearch(name)) {
      this.funcItemAdded.set(idx, true);
      return [toolSearchCallEvent("response.output_item.added", this.nextSeq(), outputIndex, buildResponsesToolSearchCallItem(callID, "in_progress", ""))];
    }
    let event: JSONObject;
    let itemID: string;
    if (this.funcCustom.get(idx)) {
      itemID = `ctc_${callID}`;
      event = { type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { id: "", type: "custom_tool_call", status: "in_progress", input: "", call_id: "", name: "" } };
      if (this.isApplyPatch(name) && d) {
        this.applyPatchCalls.set(idx, new ApplyPatchCallState({ itemID, callID, name: d.direct ? d.name : d.childName, namespace: d.namespace, outputIndex }));
      }
    } else {
      itemID = `fc_${callID}`;
      event = { type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { id: "", type: "function_call", status: "in_progress", arguments: "", call_id: "", name: "" } };
    }
    const item = event.item as JSONObject;
    item.id = itemID;
    item.call_id = callID;
    this.applyFunctionCallNamespaceFields(event, name, "item");
    event.sequence_number = this.nextSeq();
    event.output_index = outputIndex;
    this.funcItemAdded.set(idx, true);
    return [emitEvent("response.output_item.added", event)];
  }

  emitPendingFuncArgs(idx: number): string[] {
    if (!this.funcItemAdded.get(idx) || this.toolInputError() || this.isToolSearch(this.funcNames.get(idx) ?? "")) return [];
    const buf = this.funcArgsBuf.get(idx);
    const sent = this.funcArgsSent.get(idx) ?? 0;
    if (buf === undefined || buf.length <= sent) return [];
    const fragment = buf.slice(sent);
    this.funcArgsSent.set(idx, buf.length);
    if (this.funcCustom.get(idx)) {
      const patchCall = this.applyPatchCalls.get(idx);
      if (patchCall) {
        const [delta, errPush] = patchCall.pushArguments(fragment);
        if (errPush) return this.failToolInput(errPush);
        if (delta !== "") return [emitEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(patchCall, delta, this.nextSeq()))];
      }
      return [];
    }
    return [
      emitEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: this.nextSeq(),
        item_id: `fc_${this.funcCallIDs.get(idx) ?? ""}`,
        output_index: this.functionOutputIndex(idx),
        delta: fragment,
      }),
    ];
  }

  finalizeFuncItem(idx: number, status: string): string[] {
    if (this.funcItemDone.get(idx) || this.toolInputError()) return [];
    const out = this.emitFuncItem(idx, true);
    out.push(...this.emitPendingFuncArgs(idx));
    if (this.toolInputError()) return out;
    this.funcItemDone.set(idx, true);
    this.funcItemStatus.set(idx, status);
    const outputIndex = this.functionOutputIndex(idx);
    let args = this.funcArgsBuf.get(idx) ?? "";
    let callID = this.funcCallIDs.get(idx) ?? "";
    if (callID === "") callID = this.currentFCID;
    const name = this.funcNames.get(idx) ?? "";

    if (this.isToolSearch(name)) {
      status = toolSearchCallStatus(status, args);
      this.funcItemStatus.set(idx, status);
      out.push(toolSearchCallEvent("response.output_item.done", this.nextSeq(), outputIndex, buildResponsesToolSearchCallItem(callID, status, args)));
      this.inFuncBlock = false;
      return out;
    }
    if (!this.funcCustom.get(idx) && args === "" && status === "completed") args = "{}";

    if (this.funcCustom.get(idx)) {
      let input: string;
      const patchCall = this.applyPatchCalls.get(idx);
      if (patchCall) {
        const [tail, fullInput, errFinish] = finishClaudeApplyPatchArguments(patchCall, args, this.funcInputSnapshot.get(idx) ?? "");
        if (errFinish) return [...out, ...this.failToolInput(errFinish)];
        input = fullInput;
        if (tail !== "") out.push(emitEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(patchCall, tail, this.nextSeq())));
      } else {
        input = unwrapCustomToolInput(args);
      }
      if (!this.funcArgsDone.get(idx)) {
        this.funcArgsDone.set(idx, true);
        if (patchCall) {
          out.push(emitEvent("response.custom_tool_call_input.done", applyPatchInputDone(patchCall, input, this.nextSeq())));
        } else {
          out.push(
            emitEvent("response.custom_tool_call_input.done", {
              type: "response.custom_tool_call_input.done",
              sequence_number: this.nextSeq(),
              item_id: `ctc_${callID}`,
              output_index: outputIndex,
              input,
            }),
          );
        }
      }
      const itemDone: JSONObject = {
        type: "response.output_item.done",
        sequence_number: this.nextSeq(),
        output_index: outputIndex,
        item: { id: `ctc_${callID}`, type: "custom_tool_call", status, input, call_id: callID, name: "" },
      };
      this.applyFunctionCallNamespaceFields(itemDone, name, "item");
      out.push(emitEvent("response.output_item.done", itemDone));
    } else {
      if (!this.funcArgsDone.get(idx)) {
        this.funcArgsDone.set(idx, true);
        out.push(
          emitEvent("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            sequence_number: this.nextSeq(),
            item_id: `fc_${callID}`,
            output_index: outputIndex,
            arguments: args,
          }),
        );
      }
      const itemDone: JSONObject = {
        type: "response.output_item.done",
        sequence_number: this.nextSeq(),
        output_index: outputIndex,
        item: { id: `fc_${callID}`, type: "function_call", status, arguments: args, call_id: callID, name: "" },
      };
      this.applyFunctionCallNamespaceFields(itemDone, name, "item");
      out.push(emitEvent("response.output_item.done", itemDone));
    }
    this.inFuncBlock = false;
    return out;
  }

  finalizeReasoningDeltas(): string[] {
    if (!this.reasoningActive || this.reasoningDeltasDone) return [];
    this.reasoningDeltasDone = true;
    const full = this.reasoningBuf;
    return [
      emitEvent("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        sequence_number: this.nextSeq(),
        item_id: this.reasoningItemID,
        output_index: this.reasoningIndex,
        summary_index: 0,
        text: full,
      }),
      emitEvent("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        sequence_number: this.nextSeq(),
        item_id: this.reasoningItemID,
        output_index: this.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: full },
      }),
    ];
  }

  finalizeReasoningItem(status: string): string[] {
    if (!this.reasoningActive && this.reasoningItemID === "") return [];
    const out = this.finalizeReasoningDeltas();
    const full = this.reasoningBuf;
    out.push(
      emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: this.nextSeq(),
        output_index: this.reasoningIndex,
        item: { id: this.reasoningItemID, type: "reasoning", status, encrypted_content: this.reasoningSignature, summary: [{ type: "summary_text", text: full }] },
      }),
    );
    this.reasoningItems.push({ id: this.reasoningItemID, outputIndex: this.reasoningIndex, text: full, signature: this.reasoningSignature, status });
    this.reasoningActive = false;
    this.reasoningItemID = "";
    this.reasoningBuf = "";
    this.reasoningSignature = "";
    this.reasoningIndex = -1;
    return out;
  }

  finalizeAssistantMessage(): string[] {
    if (!this.messageOpen) return [];
    const fullText = this.textBuf;
    const outputIndex = this.messageOutputIdx();
    const status = claudeResponsesOutputStatus(this.stopReason);
    const annotations = this.messageAnnotations.length > 0 ? deepCopy(this.messageAnnotations) : [];
    const out = [
      emitEvent("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: this.nextSeq(),
        item_id: this.currentMsgID,
        output_index: outputIndex,
        content_index: 0,
        text: fullText,
        logprobs: [],
      }),
      emitEvent("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: this.nextSeq(),
        item_id: this.currentMsgID,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", annotations, logprobs: [], text: fullText },
      }),
      emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: this.nextSeq(),
        output_index: outputIndex,
        item: {
          id: this.currentMsgID,
          type: "message",
          status,
          content: [{ type: "output_text", annotations: deepCopy(annotations), logprobs: [], text: fullText }],
          role: "assistant",
        },
      }),
    ];
    this.messageItems.push({ id: this.currentMsgID, outputIndex, text: fullText, annotations: [...this.messageAnnotations], status });
    this.inTextBlock = false;
    this.messageOpen = false;
    this.contentPartOpen = false;
    this.currentMsgID = "";
    this.messageOutputIndex = -1;
    this.textBuf = "";
    this.currentTextBuf = "";
    this.messageAnnotations = [];
    return out;
  }

  /** Rejects a patch-enabled stream lacking its source terminator (Go: FinalizeToolInput). */
  finalizeToolInput(): string[] {
    if (this.toolInputError() || this.completedEmitted) return [];
    let enabled = false;
    for (const name of this.toolWinners.keys()) {
      if (this.isApplyPatch(name)) {
        enabled = true;
        break;
      }
    }
    if (!enabled) return [];
    this.setToolInputError(new Error("upstream apply_patch stream ended before protocol completion"));
    this.seq++;
    return [emitEvent("response.failed", applyPatchFailure(this.responseID, this.seq))];
  }

  resetForMessage(): void {
    this.textBuf = "";
    this.currentTextBuf = "";
    this.messageAnnotations = [];
    this.messageItems = [];
    this.reasoningBuf = "";
    this.reasoningActive = false;
    this.reasoningDeltasDone = false;
    this.nextOutputIndex = 0;
    this.inTextBlock = false;
    this.inFuncBlock = false;
    this.messageOpen = false;
    this.contentPartOpen = false;
    this.currentMsgID = "";
    this.currentFCID = "";
    this.messageOutputIndex = -1;
    this.reasoningItemID = "";
    this.reasoningSignature = "";
    this.reasoningIndex = -1;
    this.reasoningItems = [];
    this.stopReason = "";
    this.applyPatchCalls = new Map();
    this.funcItemAdded = new Map();
    this.funcArgsSent = new Map();
    this.funcBlockStopped = new Map();
    this.funcInputSnapshot = new Map();
    this.funcInputSnapshotErrors = new Map();
    this.funcIdentityConflicts = new Map();
    this.funcArgsBuf = new Map();
    this.funcArgsDone = new Map();
    this.funcItemDone = new Map();
    this.funcItemStatus = new Map();
    this.funcNames = new Map();
    this.funcCallIDs = new Map();
    this.funcCustom = new Map();
    this.funcOutputIndices = new Map();
    this.usage = new UsageTokens();
  }
}

/** Permits equivalent JSON spellings but never silently replaces one complete patch input with another. */
function validateApplyPatchSnapshots(previous: string, current: string): Error | undefined {
  const call = new ApplyPatchCallState();
  if (previous !== "") {
    const [, , errPrevious] = call.finishArguments(previous);
    if (errPrevious) return errPrevious;
  }
  return call.finishArguments(current)[2];
}

/**
 * Treats complete streamed JSON as a complete snapshot, not a prefix that a
 * later snapshot may silently extend.
 */
function finishClaudeApplyPatchArguments(call: ApplyPatchCallState, args: string, snapshot: string): [string, string, Error | undefined] {
  if (snapshot === "") return call.finishArguments(args);
  if (tryParse(args) !== undefined) {
    const [, , errFinish] = call.finishArguments(args);
    if (errFinish) return ["", "", errFinish];
  }
  return call.finishArguments(snapshot);
}

/** Whether a content_block_start input carries real snapshot evidence (not the empty {} placeholder). */
function populatedInput(input: unknown): boolean {
  return exists(input) && (!isObj(input) || Object.keys(input).length > 0);
}

const nowUnix = (): number => Math.floor(Date.now() / 1000);

/** Converts one Claude SSE line to zero or more Responses SSE frames. */
export function convertClaudeResponseToOpenAIResponses(
  ctx: TranslateContext,
  modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  param: TranslatorState,
): string[] {
  if (param.value === undefined) {
    param.value = new ClaudeToResponsesState(pickRequestJSON(originalRequestRawJSON, requestRawJSON), clientToolSearchEnabledFor(ctx));
  }
  const st = param.value as ClaudeToResponsesState;
  if (st.toolInputError() || st.completedEmitted) return [];

  // Expect `data: {..}` from Claude upstreams.
  if (!rawJSON.startsWith("data:")) return [];
  const root = tryParse<unknown>(rawJSON.slice(5).trim());
  const ev = gstr(getAt(root, "type"));
  const out: string[] = [];

  switch (ev) {
    case "message_start": {
      const msg = getAt(root, "message");
      if (!exists(msg)) break;
      st.responseID = gstr(getAt(msg, "id"));
      st.createdAt = nowUnix();
      st.resetForMessage();
      st.usage.merge(getAt(msg, "usage"));
      let requestModel = requestModelName(originalRequestRawJSON, requestRawJSON);
      if (requestModel === "") requestModel = modelName;
      const created: JSONObject = {
        type: "response.created",
        sequence_number: st.nextSeq(),
        response: { id: st.responseID, object: "response", created_at: st.createdAt, status: "in_progress", background: false, error: null, output: [] },
      };
      if (requestModel !== "") (created.response as JSONObject).model = requestModel;
      out.push(emitEvent("response.created", created));
      const inprog: JSONObject = {
        type: "response.in_progress",
        sequence_number: st.nextSeq(),
        response: { id: st.responseID, object: "response", created_at: st.createdAt, status: "in_progress", output: [] },
      };
      if (requestModel !== "") (inprog.response as JSONObject).model = requestModel;
      out.push(emitEvent("response.in_progress", inprog));
      break;
    }
    case "content_block_start": {
      const cb = getAt(root, "content_block");
      if (!exists(cb)) return out;
      const idx = gint(getAt(root, "index"));
      const typ = gstr(getAt(cb, "type"));
      // Keep adjacent text blocks in the same assistant message.
      if (typ !== "text") out.push(...st.finalizeAssistantMessage());
      if (st.reasoningActive || st.reasoningItemID !== "") out.push(...st.finalizeReasoningItem("completed"));
      // Finalize any previous completed function calls.
      for (const prevIdx of [...st.funcCallIDs.keys()]) {
        if (st.funcItemDone.get(prevIdx) || prevIdx === idx) continue;
        // Patch calls may interleave; a new block is not a completion snapshot for a still-open (or unnamed) call.
        const prevName = st.funcNames.get(prevIdx) ?? "";
        if ((st.isApplyPatch(prevName) || prevName === "") && !st.funcBlockStopped.get(prevIdx)) continue;
        out.push(...st.finalizeFuncItem(prevIdx, "completed"));
        if (st.toolInputError()) return out;
      }
      for (const item of st.webSearchItems) {
        if (!item.emitted && item.results !== undefined) out.push(...st.finalizeWebSearchWithStatus(item, "completed"));
      }

      if (typ === "text") {
        st.inTextBlock = true;
        const outputIndex = st.messageOutputIdx();
        if (st.currentMsgID === "") st.currentMsgID = `msg_${st.responseID}_${st.messageItems.length}`;
        if (!st.messageOpen) {
          out.push(
            emitEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: st.nextSeq(),
              output_index: outputIndex,
              item: { id: st.currentMsgID, type: "message", status: "in_progress", content: [], role: "assistant" },
            }),
          );
          st.messageOpen = true;
        }
        if (!st.contentPartOpen) {
          out.push(
            emitEvent("response.content_part.added", {
              type: "response.content_part.added",
              sequence_number: st.nextSeq(),
              item_id: st.currentMsgID,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", annotations: [], logprobs: [], text: "" },
            }),
          );
          st.contentPartOpen = true;
        }
      } else if (typ === "tool_use") {
        st.inFuncBlock = true;
        const callID = gstr(getAt(cb, "id"));
        const name = gstr(getAt(cb, "name"));
        const oldID = st.funcCallIDs.get(idx) ?? "";
        const oldName = st.funcNames.get(idx) ?? "";
        // Pending identity evidence must survive later matching updates.
        if (callID !== "" && oldID !== "" && callID !== oldID) st.funcIdentityConflicts.set(idx, true);
        if (st.isApplyPatch(oldName) || st.isApplyPatch(name)) {
          if (st.funcIdentityConflicts.get(idx) || (name !== "" && oldName !== "" && st.toolNames.identity(name) !== st.toolNames.identity(oldName))) {
            return [...out, ...st.failToolInput(new Error("conflicting apply_patch call identity"))];
          }
        }
        if (!st.funcItemAdded.get(idx)) {
          // Keep the block key even before its ID arrives so terminal validation cannot overlook it.
          if (callID !== "" || oldID === "") st.funcCallIDs.set(idx, callID);
        }
        if (name !== "" && !st.funcItemAdded.get(idx)) st.funcNames.set(idx, name);
        st.currentFCID = st.funcCallIDs.get(idx) ?? "";
        st.functionOutputIndex(idx);
        if (!st.funcArgsBuf.has(idx)) st.funcArgsBuf.set(idx, "");
        // Empty start input is a Claude placeholder, not an arguments fragment.
        const input = getAt(cb, "input");
        if (populatedInput(input)) {
          const inputRaw = JSON.stringify(input);
          const errValidate = validateApplyPatchSnapshots(st.funcInputSnapshot.get(idx) ?? "", inputRaw);
          if (errValidate && !st.funcInputSnapshotErrors.has(idx)) st.funcInputSnapshotErrors.set(idx, errValidate);
          // Compare late snapshots against this call's finished decoder without emitting more input.
          if (st.funcItemDone.get(idx)) {
            const patchCall = st.applyPatchCalls.get(idx);
            if (patchCall) {
              const [, , errFinish] = patchCall.finishArguments(inputRaw);
              if (errFinish) return [...out, ...st.failToolInput(errFinish)];
            }
          }
          st.funcInputSnapshot.set(idx, inputRaw);
        }
        if (st.isApplyPatch(st.funcNames.get(idx) ?? "")) {
          const errSnapshot = st.funcInputSnapshotErrors.get(idx);
          if (errSnapshot) return [...out, ...st.failToolInput(errSnapshot)];
        }
        out.push(...st.emitFuncItem(idx, false));
        out.push(...st.emitPendingFuncArgs(idx));
      } else if (typ === "server_tool_use") {
        const name = gstr(getAt(cb, "name"));
        if (name !== claudeWebSearchToolName) {
          // Reachability guard: only web_search can be enabled on Claude by this translator.
          log.debug(`claude->responses: unmapped server_tool_use ${JSON.stringify(name)} at block ${idx}`);
        } else {
          const item = st.startWebSearch(idx, gstr(getAt(cb, "id")));
          out.push(webSearchAddedEvent(st, item));
        }
      } else if (typ === "web_search_tool_result") {
        // A result block carries its full content up front; the item closes when the
        // next block starts or at message_stop so the final stop_reason is respected.
        const toolUseID = gstr(getAt(cb, "tool_use_id"));
        const existing = st.webSearchByToolID.get(toolUseID);
        if (existing) {
          existing.results = claudeWebSearchResultsToResponses(getAt(cb, "content"));
        } else if (toolUseID !== "") {
          // A continuation after pause_turn delivers the result of a search whose
          // server_tool_use arrived in the previous response.
          const item = st.startWebSearch(idx, toolUseID);
          item.results = claudeWebSearchResultsToResponses(getAt(cb, "content"));
          out.push(webSearchAddedEvent(st, item));
        } else {
          log.debug(`claude->responses: web_search_tool_result without matching server_tool_use at block ${idx}`);
        }
      } else if (typ === "thinking" || typ === "redacted_thinking") {
        st.reasoningActive = true;
        st.reasoningDeltasDone = false;
        st.reasoningIndex = st.allocateOutputIndex();
        st.reasoningBuf = "";
        st.reasoningSignature = claudeReasoningCarrier(cb);
        st.reasoningItemID = `rs_${st.responseID}_${idx}`;
        out.push(
          emitEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: st.nextSeq(),
            output_index: st.reasoningIndex,
            item: { id: st.reasoningItemID, type: "reasoning", status: "in_progress", encrypted_content: st.reasoningSignature, summary: [] },
          }),
        );
        out.push(
          emitEvent("response.reasoning_summary_part.added", {
            type: "response.reasoning_summary_part.added",
            sequence_number: st.nextSeq(),
            item_id: st.reasoningItemID,
            output_index: st.reasoningIndex,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }),
        );
      }
      break;
    }
    case "content_block_delta": {
      const d = getAt(root, "delta");
      if (!exists(d)) return out;
      const dt = gstr(getAt(d, "type"));
      if (dt === "text_delta") {
        const t = getAt(d, "text");
        if (exists(t)) {
          const text = gstr(t);
          out.push(
            emitEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: st.nextSeq(),
              item_id: st.currentMsgID,
              output_index: st.messageOutputIdx(),
              content_index: 0,
              delta: text,
              logprobs: [],
            }),
          );
          st.textBuf += text;
          st.currentTextBuf += text;
        }
      } else if (dt === "input_json_delta") {
        const idx = gint(getAt(root, "index"));
        const pj = getAt(d, "partial_json");
        const ws = st.webSearchByBlock.get(idx);
        if (ws) {
          if (exists(pj)) ws.inputBuf += gstr(pj);
          return [];
        }
        if (exists(pj)) {
          st.funcArgsBuf.set(idx, (st.funcArgsBuf.get(idx) ?? "") + gstr(pj));
          out.push(...st.emitPendingFuncArgs(idx));
        }
      } else if (dt === "thinking_delta") {
        const t = getAt(d, "thinking");
        if (st.reasoningActive && exists(t)) {
          st.reasoningBuf += gstr(t);
          out.push(
            emitEvent("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              sequence_number: st.nextSeq(),
              item_id: st.reasoningItemID,
              output_index: st.reasoningIndex,
              summary_index: 0,
              delta: gstr(t),
            }),
          );
        }
      } else if (dt === "signature_delta") {
        const signature = gstr(getAt(d, "signature"));
        if (st.reasoningActive && signature !== "") st.reasoningSignature = signature;
        return [];
      } else if (dt === "citations_delta") {
        const citation = getAt(d, "citation");
        if (exists(citation) && citation !== null) st.messageAnnotations.push(deepCopy(citation));
        return [];
      }
      break;
    }
    case "content_block_stop":
      st.funcBlockStopped.set(gint(getAt(root, "index")), true);
      if (st.inTextBlock) st.inTextBlock = false;
      else if (st.inFuncBlock) st.inFuncBlock = false;
      else if (st.reasoningActive) out.push(...st.finalizeReasoningDeltas());
      return out;
    case "message_delta": {
      st.usage.merge(getAt(root, "usage"));
      const stopReason = getAt(root, "delta.stop_reason");
      if (exists(stopReason)) st.stopReason = gstr(stopReason);
      return [];
    }
    case "message_stop": {
      const toolStatus = claudeResponsesOutputStatus(st.stopReason);
      if (st.reasoningActive || st.reasoningItemID !== "") out.push(...st.finalizeReasoningItem(toolStatus));
      out.push(...st.finalizeAssistantMessage());
      for (const idx of [...st.funcCallIDs.keys()]) {
        if (st.funcItemDone.get(idx)) continue;
        out.push(...st.finalizeFuncItem(idx, toolStatus));
        if (st.toolInputError()) return out;
      }
      for (const item of st.webSearchItems) {
        if (!item.emitted) out.push(...st.finalizeWebSearchWithStatus(item, claudeResponsesWebSearchStatus(st.stopReason, toolStatus, hasResults(item.results))));
      }

      const { eventType, status: responseStatus, incompleteDetails } = claudeResponsesTerminalState(st.stopReason);
      const response: JSONObject = { id: st.responseID, object: "response", created_at: st.createdAt, status: responseStatus, background: false, error: null };
      if (incompleteDetails) response.incomplete_details = incompleteDetails;
      if (claudeStopReasonPauseTurn(st.stopReason)) response.end_turn = false;
      st.requestEcho.apply(response);

      const outputs: unknown[] = [];
      for (const reasoning of st.reasoningItems) {
        outputs[reasoning.outputIndex] = {
          id: reasoning.id,
          type: "reasoning",
          status: reasoning.status || "completed",
          encrypted_content: reasoning.signature,
          summary: [{ type: "summary_text", text: reasoning.text }],
        };
      }
      for (const message of st.messageItems) {
        outputs[message.outputIndex] = {
          id: message.id,
          type: "message",
          status: message.status,
          content: [{ type: "output_text", annotations: message.annotations.length > 0 ? deepCopy(message.annotations) : [], logprobs: [], text: message.text }],
          role: "assistant",
        };
      }
      for (const item of st.webSearchItems) {
        const rendered = renderWebSearch(item);
        rendered.status = item.status || "completed";
        outputs[item.outputIndex] = rendered;
      }
      const idxs = [...st.funcArgsBuf.keys()].sort((a, b) => a - b);
      for (const idx of idxs) {
        const status = st.funcItemStatus.get(idx) || "completed";
        let args = !st.funcCustom.get(idx) && status === "completed" ? "{}" : "";
        const buf = st.funcArgsBuf.get(idx) ?? "";
        if (buf.length > 0) args = buf;
        let callID = st.funcCallIDs.get(idx) ?? "";
        const name = st.funcNames.get(idx) ?? "";
        if (callID === "" && st.currentFCID !== "") callID = st.currentFCID;
        const outputIndex = st.funcOutputIndices.get(idx) ?? 0;
        if (st.isToolSearch(name)) {
          outputs[outputIndex] = buildResponsesToolSearchCallItem(callID, status, args);
        } else if (st.funcCustom.get(idx)) {
          const patchCall = st.applyPatchCalls.get(idx);
          const input = patchCall ? patchCall.decoder.input() : unwrapCustomToolInput(args);
          const item: JSONObject = { id: `ctc_${callID}`, type: "custom_tool_call", status, input, call_id: callID, name: "" };
          outputs[outputIndex] = st.applyFunctionCallNamespaceFields(item, name, "");
        } else {
          const item: JSONObject = { id: `fc_${callID}`, type: "function_call", status, arguments: args, call_id: callID, name: "" };
          outputs[outputIndex] = st.applyFunctionCallNamespaceFields(item, name, "");
        }
      }
      if (outputs.length > 0) response.output = Array.from(outputs, (v) => (v === undefined ? null : v));

      let reasoningLength = 0;
      for (const reasoning of st.reasoningItems) reasoningLength += byteLength(reasoning.text);
      const reasoningTokens = Math.floor(reasoningLength / 4);
      if (st.usage.hasUsage || reasoningTokens > 0) {
        const usage = st.usage.openAIResponsesUsage();
        const u: JSONObject = {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: usage.cachedTokens },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        };
        if (usage.totalTokens > 0 || st.usage.hasUsage) u.total_tokens = usage.totalTokens;
        response.usage = u;
      }
      st.completedEmitted = true;
      out.push(emitEvent(eventType, { type: eventType, sequence_number: st.nextSeq(), response }));
      break;
    }
  }
  return out;
}

function hasResults(results: unknown): boolean {
  return results !== undefined;
}

function webSearchAddedEvent(st: ClaudeToResponsesState, item: WebSearchItem): string {
  return emitEvent("response.output_item.added", {
    type: "response.output_item.added",
    sequence_number: st.nextSeq(),
    output_index: item.outputIndex,
    item: { id: responsesWebSearchCallID(item.toolUseID), type: "web_search_call", status: "in_progress", action: { type: "search", query: "" } },
  });
}

interface NonStreamOutputItem {
  outputIndex: number;
  itemType: string;
  id: string;
  callID: string;
  name: string;
  text: string;
  signature: string;
  annotations: unknown[];
  args: string;
  inputSnapshot: string;
  results: unknown;
}

/** Aggregates a Claude response (SSE or native JSON) into a single Responses JSON object. */
export function convertClaudeResponseToOpenAIResponsesNonStream(
  ctx: TranslateContext,
  _modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  param: TranslatorState | undefined,
): string {
  const { payload, model: nativeModel } = claudeMessagesJSONToSSE(rawJSON);
  const chunks: string[] = [];
  for (let line of payload.split("\n")) {
    line = line.replace(/\r+$/, "");
    if (line.startsWith("data:")) chunks.push(line.slice(5));
  }

  const st = new ClaudeToResponsesState(pickRequestJSON(originalRequestRawJSON, requestRawJSON), clientToolSearchEnabledFor(ctx));
  if (param) param.value = st;

  const out: JSONObject = {
    id: "",
    object: "response",
    created_at: 0,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    output: [],
    usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: {}, total_tokens: 0 },
  };

  let responseID = "";
  let createdAt = 0;
  let stopReason = "";
  const usageTokens = new UsageTokens();
  const blockToItem = new Map<number, NonStreamOutputItem>();
  const webSearchByToolID = new Map<string, NonStreamOutputItem>();
  const outputItems: NonStreamOutputItem[] = [];
  let nextOutputIndex = 0;
  let messageCount = 0;
  let activeMessageItem: NonStreamOutputItem | undefined;
  let pendingAnnotations: unknown[] = [];
  const failure = (err: Error): string => {
    st.setToolInputError(err);
    return JSON.stringify(JSON.parse(applyPatchFailure(responseID, 0)).response);
  };
  const newOutputItem = (itemType: string, blockIndex: number): NonStreamOutputItem => {
    const item: NonStreamOutputItem = {
      outputIndex: nextOutputIndex++,
      itemType,
      id: "",
      callID: "",
      name: "",
      text: "",
      signature: "",
      annotations: [],
      args: "",
      inputSnapshot: "",
      results: undefined,
    };
    outputItems.push(item);
    blockToItem.set(blockIndex, item);
    return item;
  };

  for (const ch of chunks) {
    const root = tryParse<unknown>(ch);
    const ev = gstr(getAt(root, "type"));
    // Match the streaming path: no input after the protocol terminator.
    if (ev === "message_stop") break;
    switch (ev) {
      case "message_start": {
        const msg = getAt(root, "message");
        if (exists(msg)) {
          responseID = gstr(getAt(msg, "id"));
          createdAt = nowUnix();
          usageTokens.merge(getAt(msg, "usage"));
        }
        break;
      }
      case "content_block_start": {
        const cb = getAt(root, "content_block");
        if (!exists(cb)) continue;
        const idx = gint(getAt(root, "index"));
        const typ = gstr(getAt(cb, "type"));
        if (typ !== "text") activeMessageItem = undefined;
        switch (typ) {
          case "text": {
            let item = activeMessageItem;
            if (!item) {
              item = newOutputItem("message", idx);
              item.id = `msg_${responseID}_${messageCount}`;
              messageCount++;
            } else {
              blockToItem.set(idx, item);
            }
            if (pendingAnnotations.length > 0) {
              item.annotations.push(...pendingAnnotations);
              pendingAnnotations = [];
            }
            activeMessageItem = item;
            break;
          }
          case "tool_use": {
            const name = gstr(getAt(cb, "name"));
            const callID = gstr(getAt(cb, "id"));
            let itemType = "function_call";
            if (st.isToolSearch(name)) itemType = "tool_search_call";
            else if (st.toolWinners.get(st.toolNames.identity(name))?.toolType === "custom") itemType = "custom_tool_call";
            let item = blockToItem.get(idx);
            if (!item) item = newOutputItem(itemType, idx);
            if (callID !== "" && item.callID !== "" && callID !== item.callID) st.funcIdentityConflicts.set(idx, true);
            if (st.isApplyPatch(item.name) || st.isApplyPatch(name)) {
              if (st.funcIdentityConflicts.get(idx) || (name !== "" && item.name !== "" && st.toolNames.identity(name) !== st.toolNames.identity(item.name))) {
                return failure(new Error("conflicting apply_patch call identity"));
              }
            }
            if (name !== "") {
              item.name = name;
              item.itemType = itemType;
            }
            if (callID !== "") item.callID = callID;
            const input = getAt(cb, "input");
            if (populatedInput(input)) {
              const inputRaw = JSON.stringify(input);
              const errValidate = validateApplyPatchSnapshots(item.inputSnapshot, inputRaw);
              if (errValidate && !st.funcInputSnapshotErrors.has(idx)) st.funcInputSnapshotErrors.set(idx, errValidate);
              item.inputSnapshot = inputRaw;
            }
            if (st.isApplyPatch(item.name)) {
              const errSnapshot = st.funcInputSnapshotErrors.get(idx);
              if (errSnapshot) return failure(errSnapshot);
            }
            if (item.itemType === "custom_tool_call") item.id = `ctc_${item.callID}`;
            else if (item.itemType === "tool_search_call") item.id = responsesToolSearchIDPrefix + item.callID;
            else item.id = `fc_${item.callID}`;
            break;
          }
          case "server_tool_use": {
            const name = gstr(getAt(cb, "name"));
            if (name !== claudeWebSearchToolName) {
              log.debug(`claude->responses: unmapped server_tool_use ${JSON.stringify(name)} at block ${idx}`);
              continue;
            }
            const toolUseID = gstr(getAt(cb, "id"));
            const item = newOutputItem("web_search_call", idx);
            item.id = responsesWebSearchCallID(toolUseID);
            item.callID = toolUseID;
            webSearchByToolID.set(toolUseID, item);
            // Streaming announces an empty input; only seed when the query is already present.
            const input = getAt(cb, "input");
            if (isObj(input) && claudeWebSearchQuery(JSON.stringify(input)) !== "") item.args += JSON.stringify(input);
            break;
          }
          case "web_search_tool_result": {
            const toolUseID = gstr(getAt(cb, "tool_use_id"));
            const existing = webSearchByToolID.get(toolUseID);
            if (existing) {
              existing.results = claudeWebSearchResultsToResponses(getAt(cb, "content"));
            } else if (toolUseID !== "") {
              // Continuation after pause_turn: keep its result under the same id.
              const item = newOutputItem("web_search_call", idx);
              item.id = responsesWebSearchCallID(toolUseID);
              item.callID = toolUseID;
              item.results = claudeWebSearchResultsToResponses(getAt(cb, "content"));
              webSearchByToolID.set(toolUseID, item);
            } else {
              log.debug(`claude->responses: web_search_tool_result without matching server_tool_use at block ${idx}`);
            }
            break;
          }
          case "thinking":
          case "redacted_thinking": {
            const item = newOutputItem("reasoning", idx);
            item.id = `rs_${responseID}_${idx}`;
            item.signature = claudeReasoningCarrier(cb);
            break;
          }
        }
        break;
      }
      case "content_block_delta": {
        const d = getAt(root, "delta");
        if (!exists(d)) continue;
        const item = blockToItem.get(gint(getAt(root, "index")));
        switch (gstr(getAt(d, "type"))) {
          case "text_delta": {
            const t = getAt(d, "text");
            if (item && item.itemType === "message" && exists(t)) item.text += gstr(t);
            break;
          }
          case "input_json_delta": {
            const pj = getAt(d, "partial_json");
            if (item && ["function_call", "custom_tool_call", "tool_search_call", "web_search_call"].includes(item.itemType) && exists(pj)) item.args += gstr(pj);
            break;
          }
          case "thinking_delta": {
            const t = getAt(d, "thinking");
            if (item && item.itemType === "reasoning" && exists(t)) item.text += gstr(t);
            break;
          }
          case "signature_delta": {
            const signature = gstr(getAt(d, "signature"));
            if (item && item.itemType === "reasoning" && signature !== "") item.signature = signature;
            break;
          }
          case "citations_delta": {
            const citation = getAt(d, "citation");
            if (exists(citation) && citation !== null) {
              if (item && item.itemType === "message") item.annotations.push(deepCopy(citation));
              else if (activeMessageItem) activeMessageItem.annotations.push(deepCopy(citation));
              else pendingAnnotations.push(deepCopy(citation));
            }
            break;
          }
        }
        break;
      }
      case "message_delta": {
        usageTokens.merge(getAt(root, "usage"));
        const value = getAt(root, "delta.stop_reason");
        if (exists(value)) stopReason = gstr(value);
        break;
      }
    }
  }

  const { status: responseStatus, incompleteDetails } = claudeResponsesTerminalState(stopReason);
  out.id = responseID;
  out.created_at = createdAt;
  out.status = responseStatus;
  if (incompleteDetails) out.incomplete_details = incompleteDetails;
  if (claudeStopReasonPauseTurn(stopReason)) out.end_turn = false;
  st.requestEcho.apply(out);
  // A native response's model is authoritative.
  if (nativeModel !== "") out.model = nativeModel;

  const outputs: JSONObject[] = [];
  for (let i = 0; i < outputItems.length; i++) {
    const outputItem = outputItems[i]!;
    const itemStatus = responseStatus === "incomplete" && i === outputItems.length - 1 ? "incomplete" : "completed";
    let item: JSONObject | undefined;
    switch (outputItem.itemType) {
      case "reasoning":
        item = { id: outputItem.id, type: "reasoning", status: itemStatus, encrypted_content: outputItem.signature, summary: [{ type: "summary_text", text: outputItem.text }] };
        break;
      case "web_search_call":
        item = buildResponsesWebSearchCallItem(outputItem.callID, claudeWebSearchQuery(outputItem.args), outputItem.results);
        item.status = claudeResponsesWebSearchStatus(stopReason, itemStatus, hasResults(outputItem.results));
        break;
      case "message":
        item = {
          id: outputItem.id,
          type: "message",
          status: itemStatus,
          content: [{ type: "output_text", annotations: outputItem.annotations.length > 0 ? outputItem.annotations : [], logprobs: [], text: outputItem.text }],
          role: "assistant",
        };
        break;
      case "tool_search_call":
        item = buildResponsesToolSearchCallItem(outputItem.callID, toolSearchCallStatus(itemStatus, outputItem.args), outputItem.args);
        break;
      case "custom_tool_call": {
        let input: string;
        if (st.isApplyPatch(outputItem.name)) {
          const patchCall = new ApplyPatchCallState();
          const [, errPush] = patchCall.pushArguments(outputItem.args);
          if (errPush) return failure(errPush);
          const [, fullInput, errFinish] = finishClaudeApplyPatchArguments(patchCall, outputItem.args, outputItem.inputSnapshot);
          if (errFinish) return failure(errFinish);
          input = fullInput;
        } else {
          input = unwrapCustomToolInput(outputItem.args);
        }
        item = st.applyFunctionCallNamespaceFields({ id: outputItem.id, type: "custom_tool_call", status: itemStatus, input, call_id: outputItem.callID, name: "" }, outputItem.name, "");
        break;
      }
      case "function_call": {
        let args = outputItem.args;
        if (args === "" && itemStatus === "completed") args = "{}";
        item = st.applyFunctionCallNamespaceFields({ id: outputItem.id, type: "function_call", status: itemStatus, arguments: args, call_id: outputItem.callID, name: "" }, outputItem.name, "");
        break;
      }
    }
    if (item) outputs.push(item);
  }
  if (outputs.length > 0) out.output = outputs;

  const usage = usageTokens.openAIResponsesUsage();
  const u = out.usage as JSONObject;
  if (usage.inputTokens !== 0) u.input_tokens = usage.inputTokens;
  if (usage.cachedTokens !== 0) (u.input_tokens_details as JSONObject).cached_tokens = usage.cachedTokens;
  if (usage.outputTokens !== 0) u.output_tokens = usage.outputTokens;
  if (usage.totalTokens !== 0) u.total_tokens = usage.totalTokens;
  let reasoningLength = 0;
  for (const outputItem of outputItems) if (outputItem.itemType === "reasoning") reasoningLength += byteLength(outputItem.text);
  const reasoningTokens = Math.floor(reasoningLength / 4);
  if (reasoningTokens > 0) (u.output_tokens_details as JSONObject).reasoning_tokens = reasoningTokens;
  return JSON.stringify(out);
}

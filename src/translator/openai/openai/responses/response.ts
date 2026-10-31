// Port of internal/translator/openai/openai/responses/openai_openai-responses_response.go.
//
// OpenAI Chat Completions responses -> OpenAI Responses.
//
// Stream input contract: one upstream SSE line per call ("data: " + a
// chat.completion.chunk JSON, or "data: [DONE]"; a bare JSON payload is accepted
// too). Output: complete, self-terminated SSE frames
// ("event: <type>\ndata: <json>\n\n") carrying monotonically increasing
// sequence_number values. Item-level finalisation happens on finish_reason; the
// terminal response.completed / response.incomplete is deferred until [DONE] so
// late usage-only chunks still reach response.usage. An executor that sees EOF
// without [DONE] should call state.canFinalizeResponseStream() and, when true,
// feed "data: [DONE]"; otherwise call state.finalizeToolInput() and forward its
// frames (an apply_patch-enabled stream then fails instead of ending silently).
// Per-stream state lives in TranslatorState.value as an OAIToResponsesState; a
// retained tool-input failure is exposed through toolInputError().
import type { TranslateContext, TranslatorState } from "../../../types.ts";
import { getAt, gint, gbool, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { sseEventData } from "../../../common/bytes.ts";
import { requestModelName } from "../../../common/request.ts";
import { ApplyPatchCallState, ApplyPatchErrorState, applyPatchFailure, applyPatchInputDelta, applyPatchInputDone } from "../../../common/apply_patch_events.ts";
import { gfloat, goValue } from "./go_json.ts";
import { ResponsesToolIndex, newResponsesToolIndex, pickRequestJSON, unwrapCustomToolInput } from "./tools.ts";
import { responsesToolInputFailure, shellCallItem, shellCallPlaceholder } from "./shell_tool.ts";

type JSONObject = Record<string, unknown>;

interface ReasoningRecord {
  reasoningID: string;
  reasoningData: string;
  outputIndex: number;
}

/** Request fields echoed into response objects, extracted once (Go: responsesRequestEcho). */
export class ResponsesRequestEcho {
  readonly fields = new Map<string, unknown>();

  static extract(root: unknown): ResponsesRequestEcho {
    const e = new ResponsesRequestEcho();
    if (!isObj(root)) return e;
    for (const [key, value] of Object.entries(root)) {
      switch (key) {
        case "instructions":
        case "model":
        case "previous_response_id":
        case "prompt_cache_key":
        case "safety_identifier":
        case "service_tier":
        case "truncation":
          e.fields.set(key, gstr(value));
          break;
        case "max_output_tokens":
        case "max_tokens":
        case "max_tool_calls":
        case "top_logprobs":
          e.fields.set(key, gint(value));
          break;
        case "parallel_tool_calls":
        case "store":
          e.fields.set(key, gbool(value));
          break;
        case "temperature":
        case "top_p":
          e.fields.set(key, gfloat(value));
          break;
        case "reasoning":
        case "text":
        case "tool_choice":
        case "tools":
        case "user":
        case "metadata":
          // Go stored gjson Value()s, which encoding/json writes with sorted keys.
          e.fields.set(key, goValue(value));
          break;
      }
    }
    return e;
  }

  has(key: string): boolean {
    return this.fields.has(key);
  }

  /** Writes the echoed fields onto dst in Go's fixed order. */
  apply(dst: JSONObject): JSONObject {
    for (const key of echoOrder) {
      if (this.fields.has(key)) dst[key] = this.fields.get(key);
    }
    return dst;
  }
}

const echoOrder = [
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "metadata",
];

/** Per-stream conversion state (Go: oaiToResponsesState). */
export class OAIToResponsesState extends ApplyPatchErrorState {
  applyPatchCalls = new Map<string, ApplyPatchCallState>();
  requestEcho = new ResponsesRequestEcho();
  toolIndex: ResponsesToolIndex = newResponsesToolIndex(undefined);
  requestInitialized = false;
  seq = 0;
  responseID = "";
  created = 0;
  started = false;
  completedEmitted = false;
  completionPending = false;
  reasoningID = "";
  reasoningIndex = 0;
  msgTextBuf = new Map<number, string>();
  reasoningBuf = "";
  reasonings: ReasoningRecord[] = [];
  funcArgsBuf = new Map<string, string>();
  funcNames = new Map<string, string>();
  funcCallIDs = new Map<string, string>();
  funcIdentityConflicts = new Map<string, boolean>();
  funcOutputIx = new Map<string, number>();
  funcArgsSent = new Map<string, number>();
  msgOutputIx = new Map<number, number>();
  nextOutputIx = 0;
  msgItemAdded = new Map<number, boolean>();
  msgContentAdded = new Map<number, boolean>();
  msgItemDone = new Map<number, boolean>();
  funcItemAdded = new Map<string, boolean>();
  funcItemCustom = new Map<string, boolean>();
  funcArgsDone = new Map<string, boolean>();
  funcItemDone = new Map<string, boolean>();
  customToolNames = new Set<string>();
  finishReason = "";
  promptTokens = 0;
  cachedTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  reasoningTokens = 0;
  usageSeen = false;

  canFinalizeResponse(): boolean {
    if (this.toolInputError() !== undefined || this.finishReason === "" || (this.msgItemAdded.size === 0 && this.funcItemAdded.size === 0)) return false;
    for (const idx of this.msgItemAdded.keys()) if (!this.msgItemDone.get(idx)) return false;
    for (const key of this.funcItemAdded.keys()) if (!this.funcItemDone.get(key)) return false;
    return this.reasoningID === "";
  }

  /** Whether EOF can safely synthesize the missing [DONE] (Go: CanFinalizeResponseStream). */
  canFinalizeResponseStream(): boolean {
    return this.toolInputError() === undefined && !this.completedEmitted && this.completionPending;
  }

  /** Rejects an apply_patch-enabled stream that ended without its terminator (Go: FinalizeToolInput). */
  finalizeToolInput(): string[] {
    if (this.toolInputError() !== undefined || this.completedEmitted) return [];
    if (this.canFinalizeResponseStream()) return [];
    let enabled = false;
    for (const name of this.toolIndex.byChat.keys()) {
      if (this.toolIndex.isApplyPatch(name)) {
        enabled = true;
        break;
      }
    }
    if (!enabled) return [];
    this.setToolInputError(new Error("upstream apply_patch stream ended before protocol completion"));
    this.seq++;
    return [emitRespEvent("response.failed", applyPatchFailure(this.responseID, this.seq))];
  }
}

function emitRespEvent(event: string, payload: string | JSONObject): string {
  return sseEventData(event, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function incompleteByFinishReason(reason: string): JSONObject | undefined {
  switch (reason) {
    case "length":
    case "max_tokens":
      return { reason: "max_output_tokens" };
    case "content_filter":
      return { reason: "content_filter" };
    default:
      return undefined;
  }
}

function buildResponsesCompletedEvent(st: OAIToResponsesState, nextSeq: () => number): string {
  let eventType = "response.completed";
  let status = "completed";
  const incompleteDetails = incompleteByFinishReason(st.finishReason);
  if (incompleteDetails) {
    eventType = "response.incomplete";
    status = "incomplete";
  }
  const response: JSONObject = { id: st.responseID, object: "response", created_at: st.created, status, background: false, error: null };
  const completed: JSONObject = { type: eventType, sequence_number: nextSeq(), response };
  if (incompleteDetails) response.incomplete_details = incompleteDetails;
  st.requestEcho.apply(response);

  const itemStatus = incompleteDetails ? "incomplete" : "completed";
  const outputItems: { index: number; item: JSONObject }[] = [];
  for (const r of st.reasonings) {
    outputItems.push({ index: r.outputIndex, item: { id: r.reasoningID, type: "reasoning", summary: [{ type: "summary_text", text: r.reasoningData }] } });
  }
  for (const i of st.msgItemAdded.keys()) {
    outputItems.push({ index: st.msgOutputIx.get(i) ?? 0, item: messageItem(`msg_${st.responseID}_${i}`, itemStatus, st.msgTextBuf.get(i) ?? "") });
  }
  for (const key of st.funcArgsBuf.keys()) {
    if (!st.funcItemDone.get(key)) continue;
    const args = st.funcArgsBuf.get(key) ?? "";
    const callID = st.funcCallIDs.get(key) ?? "";
    const name = st.funcNames.get(key) ?? "";
    const index = st.funcOutputIx.get(key) ?? 0;
    if (st.toolIndex.isShell(name)) {
      try {
        outputItems.push({ index, item: shellCallItem(callID, args, itemStatus) });
      } catch {
        // An invalid action was already reported when the item finished.
      }
      continue;
    }
    if (st.funcItemCustom.get(key)) {
      const patchCall = st.applyPatchCalls.get(key);
      const input = patchCall ? patchCall.decoder.input() : unwrapCustomToolInput(args);
      const item = st.toolIndex.applyIdentity({ id: `ctc_${callID}`, type: "custom_tool_call", status: itemStatus, input, call_id: callID, name: "" }, name, "");
      outputItems.push({ index, item });
      continue;
    }
    const item = st.toolIndex.applyIdentity({ id: `fc_${callID}`, type: "function_call", status: itemStatus, arguments: args, call_id: callID, name: "" }, name, "");
    outputItems.push({ index, item });
  }
  outputItems.sort((a, b) => a.index - b.index);
  if (outputItems.length > 0) response.output = outputItems.map((o) => o.item);
  if (st.usageSeen) {
    const usage: JSONObject = {
      input_tokens: st.promptTokens,
      input_tokens_details: { cached_tokens: st.cachedTokens },
      output_tokens: st.completionTokens,
    };
    if (st.reasoningTokens > 0) usage.output_tokens_details = { reasoning_tokens: st.reasoningTokens };
    usage.total_tokens = st.totalTokens !== 0 ? st.totalTokens : st.promptTokens + st.completionTokens;
    response.usage = usage;
  }
  return emitRespEvent(eventType, completed);
}

function messageItem(id: string, status: string, text: string): JSONObject {
  return { id, type: "message", status, content: [{ type: "output_text", annotations: [], logprobs: [], text }], role: "assistant" };
}

function stripData(rawJSON: string): string {
  if (rawJSON.startsWith("data:")) rawJSON = rawJSON.slice(5);
  return rawJSON.trim();
}

/** Streams Chat Completions chunks as Responses SSE events (Go: ConvertOpenAIChatCompletionsResponseToOpenAIResponses). */
export function convertOpenAIChatCompletionsResponseToOpenAIResponses(
  _ctx: TranslateContext,
  modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
): string[] {
  if (!(state.value instanceof OAIToResponsesState)) state.value = new OAIToResponsesState();
  const st = state.value as OAIToResponsesState;
  if (st.toolInputError() !== undefined || st.completedEmitted) return [];

  rawJSON = stripData(rawJSON);
  if (!st.requestInitialized) {
    const requestRoot = pickRequestJSON(originalRequestRawJSON, requestRawJSON);
    st.toolIndex = newResponsesToolIndex(requestRoot);
    st.requestEcho = ResponsesRequestEcho.extract(requestRoot);
    st.requestInitialized = true;
  }
  if (rawJSON === "") return [];
  const isDone = rawJSON === "[DONE]";
  if (isDone && (!st.started || st.completedEmitted)) return [];

  let root: unknown;
  if (!isDone) {
    try {
      root = JSON.parse(rawJSON);
    } catch {
      return [];
    }
    const obj = getAt(root, "object");
    if (obj !== undefined && gstr(obj) !== "" && gstr(obj) !== "chat.completion.chunk") return [];
    if (!isArr(getAt(root, "choices"))) return [];
  }

  const usage = getAt(root, "usage");
  if (usage !== undefined) {
    const read = (path: string): number | undefined => {
      const v = getAt(usage, path);
      return v === undefined ? undefined : gint(v);
    };
    const prompt = read("prompt_tokens");
    if (prompt !== undefined) {
      st.promptTokens = prompt;
      st.usageSeen = true;
    }
    const cached = read("prompt_tokens_details.cached_tokens");
    if (cached !== undefined) {
      st.cachedTokens = cached;
      st.usageSeen = true;
    }
    const completion = read("completion_tokens") ?? read("output_tokens");
    if (completion !== undefined) {
      st.completionTokens = completion;
      st.usageSeen = true;
    }
    const reasoning = read("output_tokens_details.reasoning_tokens") ?? read("completion_tokens_details.reasoning_tokens");
    if (reasoning !== undefined) {
      st.reasoningTokens = reasoning;
      st.usageSeen = true;
    }
    const total = read("total_tokens");
    if (total !== undefined) {
      st.totalTokens = total;
      st.usageSeen = true;
    }
  }

  const nextSeq = (): number => ++st.seq;
  const allocOutputIndex = (): number => st.nextOutputIx++;
  const toolStateKey = (outputIndex: number, toolIndex: number): string => `${outputIndex}:${toolIndex}`;
  const out: string[] = [];
  const failToolInput = (err: Error): void => {
    if (st.toolInputError() === undefined) {
      st.setToolInputError(err);
      out.push(emitRespEvent("response.failed", responsesToolInputFailure(st.responseID, nextSeq(), err)));
    }
  };

  const emitToolItem = (key: string, force: boolean): void => {
    if (st.funcItemAdded.get(key)) return;
    let callID = st.funcCallIDs.get(key) ?? "";
    let name = st.toolIndex.canonicalName(st.funcNames.get(key) ?? "");
    st.funcNames.set(key, name);
    if (!force && (callID === "" || name === "")) return;
    if (name === "") {
      const [customToolName, ok] = st.toolIndex.singleCustomName();
      if (ok) {
        name = customToolName;
        st.funcNames.set(key, customToolName);
      }
    }
    if (st.toolIndex.isApplyPatch(name) && st.funcIdentityConflicts.get(key)) {
      failToolInput(new Error("conflicting apply_patch call identity"));
      return;
    }
    if (callID === "") {
      callID = `call_${st.responseID}_${key.replaceAll(":", "_")}`;
      st.funcCallIDs.set(key, callID);
    }
    const outputIndex = st.funcOutputIx.get(key) ?? 0;
    const isCustomTool = st.customToolNames.has(name);
    st.funcItemCustom.set(key, isCustomTool);
    if (st.toolIndex.isShell(name)) {
      out.push(emitRespEvent("response.output_item.added", { type: "response.output_item.added", sequence_number: nextSeq(), output_index: outputIndex, item: shellCallPlaceholder(callID) }));
    } else if (isCustomTool) {
      if (st.toolIndex.isApplyPatch(name)) {
        const d = st.toolIndex.byChat.get(name)!;
        st.applyPatchCalls.set(key, new ApplyPatchCallState({ itemID: `ctc_${callID}`, callID, name: d.localName, namespace: d.namespace, outputIndex }));
      }
      const o = {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: { id: `ctc_${callID}`, type: "custom_tool_call", status: "in_progress", input: "", call_id: callID, name: "" },
      };
      out.push(emitRespEvent("response.output_item.added", st.toolIndex.applyIdentity(o, name, "item")));
    } else {
      const o = {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: { id: `fc_${callID}`, type: "function_call", status: "in_progress", arguments: "", call_id: callID, name: "" },
      };
      out.push(emitRespEvent("response.output_item.added", st.toolIndex.applyIdentity(o, name, "item")));
    }
    st.funcItemAdded.set(key, true);
  };

  const emitPendingFunctionArgs = (key: string): void => {
    if (!st.funcItemAdded.get(key) || st.toolInputError() !== undefined || st.toolIndex.isShell(st.funcNames.get(key) ?? "")) return;
    const args = st.funcArgsBuf.get(key);
    const sent = st.funcArgsSent.get(key) ?? 0;
    if (args === undefined || args.length <= sent) return;
    const delta = args.slice(sent);
    if (st.funcItemCustom.get(key)) {
      const patchCall = st.applyPatchCalls.get(key);
      if (patchCall) {
        const [patchDelta, errPush] = patchCall.pushArguments(delta);
        if (errPush) failToolInput(errPush);
        else if (patchDelta !== "") out.push(emitRespEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(patchCall, patchDelta, nextSeq())));
        st.funcArgsSent.set(key, args.length);
      }
      return;
    }
    const callID = st.funcCallIDs.get(key) ?? "";
    out.push(
      emitRespEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: nextSeq(),
        item_id: `fc_${callID}`,
        output_index: st.funcOutputIx.get(key) ?? 0,
        delta,
      }),
    );
    st.funcArgsSent.set(key, args.length);
  };

  if (!st.started) {
    st.responseID = gstr(getAt(root, "id"));
    st.created = gint(getAt(root, "created"));
    // reset aggregation state for a new streaming response
    st.msgTextBuf = new Map();
    st.reasoningBuf = "";
    st.reasoningID = "";
    st.reasoningIndex = 0;
    st.applyPatchCalls = new Map();
    st.funcArgsBuf = new Map();
    st.funcNames = new Map();
    st.funcCallIDs = new Map();
    st.funcIdentityConflicts = new Map();
    st.funcOutputIx = new Map();
    st.funcArgsSent = new Map();
    st.msgOutputIx = new Map();
    st.nextOutputIx = 0;
    st.msgItemAdded = new Map();
    st.msgContentAdded = new Map();
    st.msgItemDone = new Map();
    st.funcItemAdded = new Map();
    st.funcItemCustom = new Map();
    st.funcArgsDone = new Map();
    st.funcItemDone = new Map();
    st.customToolNames = st.toolIndex.custom;
    st.promptTokens = 0;
    st.cachedTokens = 0;
    st.completionTokens = 0;
    st.totalTokens = 0;
    st.reasoningTokens = 0;
    st.finishReason = "";
    st.usageSeen = false;
    st.completedEmitted = false;
    st.completionPending = false;

    let model = requestModelName(originalRequestRawJSON, requestRawJSON);
    if (model === "") model = modelName;
    const createdResponse: JSONObject = { id: st.responseID, object: "response", created_at: st.created, status: "in_progress", background: false, error: null, output: [] };
    if (model !== "") createdResponse.model = model;
    out.push(emitRespEvent("response.created", { type: "response.created", sequence_number: nextSeq(), response: createdResponse }));
    const inProgressResponse: JSONObject = { id: st.responseID, object: "response", created_at: st.created, status: "in_progress", output: [] };
    if (model !== "") inProgressResponse.model = model;
    out.push(emitRespEvent("response.in_progress", { type: "response.in_progress", sequence_number: nextSeq(), response: inProgressResponse }));
    st.started = true;
  }

  const stopReasoning = (text: string): void => {
    out.push(
      emitRespEvent("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        sequence_number: nextSeq(),
        item_id: st.reasoningID,
        output_index: st.reasoningIndex,
        summary_index: 0,
        text,
      }),
    );
    out.push(
      emitRespEvent("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        sequence_number: nextSeq(),
        item_id: st.reasoningID,
        output_index: st.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text },
      }),
    );
    const outputItemDone = {
      type: "response.output_item.done",
      item: { id: st.reasoningID, type: "reasoning", encrypted_content: "", summary: [{ type: "summary_text", text }] },
      output_index: st.reasoningIndex,
      sequence_number: nextSeq(),
    };
    out.push(emitRespEvent("response.output_item.done", outputItemDone));
    st.reasonings.push({ reasoningID: st.reasoningID, reasoningData: text, outputIndex: st.reasoningIndex });
    st.reasoningID = "";
  };

  const emitMessageItemDone = (idx: number): void => {
    if (!st.msgItemAdded.get(idx) || st.msgItemDone.get(idx)) return;
    const msgOutputIndex = st.msgOutputIx.get(idx) ?? 0;
    const fullText = st.msgTextBuf.get(idx) ?? "";
    const itemID = `msg_${st.responseID}_${idx}`;
    out.push(
      emitRespEvent("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: nextSeq(),
        item_id: itemID,
        output_index: msgOutputIndex,
        content_index: 0,
        text: fullText,
        logprobs: [],
      }),
    );
    out.push(
      emitRespEvent("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        item_id: itemID,
        output_index: msgOutputIndex,
        content_index: 0,
        part: { type: "output_text", annotations: [], logprobs: [], text: fullText },
      }),
    );
    const msgStatus = incompleteByFinishReason(st.finishReason) ? "incomplete" : "completed";
    out.push(
      emitRespEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: msgOutputIndex,
        item: messageItem(itemID, msgStatus, fullText),
      }),
    );
    st.msgItemDone.set(idx, true);
  };

  const finalizeOpenItems = (): void => {
    if (st.toolInputError() !== undefined) return;
    if (st.msgItemAdded.size > 0) {
      const idxs = [...st.msgItemAdded.keys()].sort((a, b) => (st.msgOutputIx.get(a) ?? 0) - (st.msgOutputIx.get(b) ?? 0));
      for (const idx of idxs) emitMessageItemDone(idx);
    }
    if (st.reasoningID !== "") {
      stopReasoning(st.reasoningBuf);
      st.reasoningBuf = "";
    }
    if (st.funcArgsBuf.size === 0) return;
    const keys = [...st.funcArgsBuf.keys()].sort((a, b) => {
      const left = st.funcOutputIx.get(a) ?? 0;
      const right = st.funcOutputIx.get(b) ?? 0;
      if (left !== right) return left - right;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const key of keys) {
      if (st.funcItemDone.get(key)) continue;
      const buf = st.funcArgsBuf.get(key) ?? "";
      const hasArgs = buf.length > 0;
      const isIncomplete = incompleteByFinishReason(st.finishReason) !== undefined;
      const isExplicitToolFinish = st.finishReason === "tool_calls" || st.finishReason === "stop";

      // A stream that ended without finish_reason must not synthesize empty or
      // partial arguments, nor complete the in-flight call as successful.
      let name = st.toolIndex.canonicalName(st.funcNames.get(key) ?? "");
      if (name === "") name = st.toolIndex.singleCustomName()[0];
      if (!st.toolIndex.isApplyPatch(name) && st.finishReason === "" && (!hasArgs || !isValidJSONText(buf))) continue;

      emitToolItem(key, true);
      emitPendingFunctionArgs(key);
      if (st.toolInputError() !== undefined) return;
      const callID = st.funcCallIDs.get(key) ?? "";
      if (callID === "" || st.funcItemDone.get(key)) continue;

      const outputIndex = st.funcOutputIx.get(key) ?? 0;
      let toolStatus = "completed";
      let args = "{}";
      if (hasArgs) args = buf;
      else if (isIncomplete || !isExplicitToolFinish) args = "";
      if (isIncomplete) toolStatus = "incomplete";

      if (st.toolIndex.isShell(name)) {
        let item: JSONObject;
        try {
          item = shellCallItem(callID, args, toolStatus);
        } catch (err) {
          failToolInput(err as Error);
          return;
        }
        out.push(emitRespEvent("response.output_item.done", { type: "response.output_item.done", sequence_number: nextSeq(), output_index: outputIndex, item }));
        st.funcItemDone.set(key, true);
        st.funcArgsDone.set(key, true);
        continue;
      }

      if (st.funcItemCustom.get(key)) {
        let input: string;
        const patchCall = st.applyPatchCalls.get(key);
        if (patchCall) {
          const [tail, fullInput, errFinish] = patchCall.finishArguments(args);
          if (errFinish) {
            failToolInput(errFinish);
            return;
          }
          input = fullInput;
          if (tail !== "") out.push(emitRespEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(patchCall, tail, nextSeq())));
          out.push(emitRespEvent("response.custom_tool_call_input.done", applyPatchInputDone(patchCall, input, nextSeq())));
        } else {
          input = unwrapCustomToolInput(args);
          out.push(
            emitRespEvent("response.custom_tool_call_input.done", {
              type: "response.custom_tool_call_input.done",
              sequence_number: nextSeq(),
              item_id: `ctc_${callID}`,
              output_index: outputIndex,
              input,
            }),
          );
        }
        const itemDone = {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: outputIndex,
          item: { id: `ctc_${callID}`, type: "custom_tool_call", status: toolStatus, input, call_id: callID, name: "" },
        };
        out.push(emitRespEvent("response.output_item.done", st.toolIndex.applyIdentity(itemDone, st.funcNames.get(key) ?? "", "item")));
        st.funcItemDone.set(key, true);
        st.funcArgsDone.set(key, true);
        continue;
      }
      out.push(
        emitRespEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: `fc_${callID}`,
          output_index: outputIndex,
          arguments: args,
        }),
      );
      const itemDone = {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: { id: `fc_${callID}`, type: "function_call", status: toolStatus, arguments: args, call_id: callID, name: "" },
      };
      out.push(emitRespEvent("response.output_item.done", st.toolIndex.applyIdentity(itemDone, st.funcNames.get(key) ?? "", "item")));
      st.funcItemDone.set(key, true);
      st.funcArgsDone.set(key, true);
    }
  };

  if (isDone) {
    finalizeOpenItems();
    if (st.toolInputError() !== undefined) return out;
    for (const key of st.funcItemAdded.keys()) {
      if (!st.funcItemDone.get(key)) return out;
    }
    if (st.msgItemAdded.size === 0 && st.funcItemAdded.size === 0) return out;
    st.completedEmitted = true;
    out.push(buildResponsesCompletedEvent(st, nextSeq));
    return out;
  }

  // choices[].delta content / tool_calls / reasoning_content
  const choices = getAt(root, "choices");
  if (isArr(choices)) {
    for (const choice of choices) {
      const idx = gint(getAt(choice, "index"));
      const delta = getAt(choice, "delta");
      if (delta !== undefined) {
        let rc = getAt(delta, "reasoning_content");
        if (rc === undefined || gstr(rc) === "") rc = getAt(delta, "reasoning");
        if (rc !== undefined && gstr(rc) !== "") {
          const rcText = gstr(rc);
          if (st.reasoningID === "") {
            st.reasoningID = `rs_${st.responseID}_${idx}`;
            st.reasoningIndex = allocOutputIndex();
            out.push(
              emitRespEvent("response.output_item.added", {
                type: "response.output_item.added",
                sequence_number: nextSeq(),
                output_index: st.reasoningIndex,
                item: { id: st.reasoningID, type: "reasoning", status: "in_progress", summary: [] },
              }),
            );
            out.push(
              emitRespEvent("response.reasoning_summary_part.added", {
                type: "response.reasoning_summary_part.added",
                sequence_number: nextSeq(),
                item_id: st.reasoningID,
                output_index: st.reasoningIndex,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
              }),
            );
          }
          st.reasoningBuf += rcText;
          out.push(
            emitRespEvent("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              sequence_number: nextSeq(),
              item_id: st.reasoningID,
              output_index: st.reasoningIndex,
              summary_index: 0,
              delta: rcText,
            }),
          );
        }

        const c = getAt(delta, "content");
        if (c !== undefined && gstr(c) !== "") {
          const text = gstr(c);
          if (st.reasoningID !== "") {
            stopReasoning(st.reasoningBuf);
            st.reasoningBuf = "";
          }
          if (!st.msgOutputIx.has(idx)) st.msgOutputIx.set(idx, allocOutputIndex());
          const msgOutputIndex = st.msgOutputIx.get(idx)!;
          const itemID = `msg_${st.responseID}_${idx}`;
          if (!st.msgItemAdded.get(idx)) {
            out.push(
              emitRespEvent("response.output_item.added", {
                type: "response.output_item.added",
                sequence_number: nextSeq(),
                output_index: msgOutputIndex,
                item: { id: itemID, type: "message", status: "in_progress", content: [], role: "assistant" },
              }),
            );
            st.msgItemAdded.set(idx, true);
          }
          if (!st.msgContentAdded.get(idx)) {
            out.push(
              emitRespEvent("response.content_part.added", {
                type: "response.content_part.added",
                sequence_number: nextSeq(),
                item_id: itemID,
                output_index: msgOutputIndex,
                content_index: 0,
                part: { type: "output_text", annotations: [], logprobs: [], text: "" },
              }),
            );
            st.msgContentAdded.set(idx, true);
          }
          out.push(
            emitRespEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: nextSeq(),
              item_id: itemID,
              output_index: msgOutputIndex,
              content_index: 0,
              delta: text,
              logprobs: [],
            }),
          );
          st.msgTextBuf.set(idx, (st.msgTextBuf.get(idx) ?? "") + text);
        }

        const tcs = getAt(delta, "tool_calls");
        if (isArr(tcs) && tcs.length > 0) {
          if (st.reasoningID !== "") {
            stopReasoning(st.reasoningBuf);
            st.reasoningBuf = "";
          }
          // Close an open message for this index before any function events.
          emitMessageItemDone(idx);

          for (const tc of tcs) {
            const toolIndex = gint(getAt(tc, "index"));
            const key = toolStateKey(idx, toolIndex);
            if (!st.funcArgsBuf.has(key)) {
              st.funcArgsBuf.set(key, "");
              st.funcOutputIx.set(key, allocOutputIndex());
            }
            const newID = gstr(getAt(tc, "id"));
            const newName = st.toolIndex.canonicalName(gstr(getAt(tc, "function.name")));
            const oldID = st.funcCallIDs.get(key) ?? "";
            const oldName = st.toolIndex.canonicalName(st.funcNames.get(key) ?? "");
            // Retain conflicting nonempty IDs until the winning tool is known.
            if (newID !== "" && oldID !== "" && newID !== oldID) st.funcIdentityConflicts.set(key, true);
            if (st.toolIndex.isApplyPatch(oldName) || st.toolIndex.isApplyPatch(newName)) {
              if (st.funcIdentityConflicts.get(key) || (newName !== "" && oldName !== "" && newName !== oldName)) {
                failToolInput(new Error("conflicting apply_patch call identity"));
                break;
              }
            }
            if (newID !== "" && oldID === "") st.funcCallIDs.set(key, newID);
            const nameChunk = gstr(getAt(tc, "function.name"));
            if (nameChunk !== "" && !st.funcItemAdded.get(key)) st.funcNames.set(key, nameChunk);
            const args = gstr(getAt(tc, "function.arguments"));
            if (args !== "") st.funcArgsBuf.set(key, st.funcArgsBuf.get(key)! + args);
            emitToolItem(key, false);
            emitPendingFunctionArgs(key);
            if (st.toolInputError() !== undefined) break;
          }
        }
      }

      if (st.toolInputError() !== undefined) break;

      // finish_reason triggers item-level finalization; the terminal event is
      // deferred until [DONE] so late usage-only chunks still populate usage.
      const fr = gstr(getAt(choice, "finish_reason"));
      if (fr !== "") {
        st.finishReason = fr;
        finalizeOpenItems();
        st.completionPending = st.canFinalizeResponse();
      }
      if (st.toolInputError() !== undefined) break;
    }
  }
  return out;
}

function isValidJSONText(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

let responseIDCounter = 0;

/** Builds one Responses object from a non-streaming Chat Completions response (Go: ConvertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream). */
export function convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(
  _ctx: TranslateContext,
  _modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState | undefined,
): string {
  let root: unknown;
  try {
    root = JSON.parse(rawJSON);
  } catch {
    root = undefined;
  }
  const toolIndex = newResponsesToolIndex(pickRequestJSON(originalRequestRawJSON, requestRawJSON));
  const st = new OAIToResponsesState();
  if (state) state.value = st;

  const finishReason = gstr(getAt(root, "choices.0.finish_reason"));
  const incompleteDetails = incompleteByFinishReason(finishReason);
  const isIncomplete = incompleteDetails !== undefined;
  const itemStatus = isIncomplete ? "incomplete" : "completed";

  const resp: JSONObject = { id: "", object: "response", created_at: 0, status: itemStatus, background: false, error: null, incomplete_details: null };
  if (incompleteDetails) resp.incomplete_details = incompleteDetails;

  // id: provider id if present, otherwise synthesized
  let id = gstr(getAt(root, "id"));
  if (id === "") id = `resp_${(BigInt(Date.now()) * 1000000n).toString(16)}_${++responseIDCounter}`;
  resp.id = id;
  let created = gint(getAt(root, "created"));
  if (created === 0) created = Math.floor(Date.now() / 1000);
  resp.created_at = created;

  // Echo request fields when available (aligns with the streaming path).
  let echo = new ResponsesRequestEcho();
  if (requestRawJSON && requestRawJSON.length > 0) {
    let requestRoot: unknown;
    try {
      requestRoot = JSON.parse(requestRawJSON);
    } catch {
      requestRoot = undefined;
    }
    echo = ResponsesRequestEcho.extract(requestRoot);
    // Also support max_tokens from chat completion style.
    if (!echo.has("max_output_tokens") && echo.has("max_tokens")) echo.fields.set("max_output_tokens", echo.fields.get("max_tokens"));
  }
  if (!echo.has("model")) {
    const v = getAt(root, "model");
    if (v !== undefined) echo.fields.set("model", gstr(v));
  }
  echo.apply(resp);

  const outputItems: JSONObject[] = [];
  let rc = getAt(root, "choices.0.message.reasoning_content");
  if (rc === undefined || gstr(rc) === "") rc = getAt(root, "choices.0.message.reasoning");
  const rcText = gstr(rc);
  const includeReasoning = rcText !== "" || echo.has("reasoning");
  if (includeReasoning) {
    const rid = id.startsWith("resp_") ? id.slice("resp_".length) : id;
    const reasoningItem: JSONObject = { id: `rs_${rid}`, type: "reasoning", encrypted_content: "", summary: [] };
    if (rcText !== "") reasoningItem.summary = [{ type: "summary_text", text: rcText }];
    outputItems.push(reasoningItem);
  }

  const choices = getAt(root, "choices");
  if (isArr(choices)) {
    choiceLoop: for (const choice of choices) {
      const msg = getAt(choice, "message");
      if (msg === undefined) continue;
      const choiceIndex = gint(getAt(choice, "index"));
      const c = getAt(msg, "content");
      if (c !== undefined && gstr(c) !== "") outputItems.push(messageItem(`msg_${id}_${choiceIndex}`, itemStatus, gstr(c)));

      const tcs = getAt(msg, "tool_calls");
      if (!isArr(tcs)) continue;
      for (let tcIndex = 0; tcIndex < tcs.length; tcIndex++) {
        const tc = tcs[tcIndex];
        let callID = gstr(getAt(tc, "id"));
        // Providers may omit tool_call ids; synthesize one so the item stays usable.
        if (callID === "") callID = `call_${id}_${choiceIndex}_${tcIndex}`;
        const name = toolIndex.canonicalName(gstr(getAt(tc, "function.name")));
        const args = gstr(getAt(tc, "function.arguments"));
        if (toolIndex.isShell(name)) {
          try {
            outputItems.push(shellCallItem(callID, args, itemStatus));
          } catch (err) {
            st.setToolInputError(err as Error);
            break choiceLoop;
          }
          continue;
        }
        if (toolIndex.custom.has(name)) {
          let input: string;
          if (toolIndex.isApplyPatch(name)) {
            const patchCall = new ApplyPatchCallState();
            const [, fullInput, errFinish] = patchCall.finishArguments(args);
            if (errFinish) {
              st.setToolInputError(errFinish);
              break choiceLoop;
            }
            input = fullInput;
          } else {
            input = unwrapCustomToolInput(args);
          }
          outputItems.push(toolIndex.applyIdentity({ id: `ctc_${callID}`, type: "custom_tool_call", status: itemStatus, input, call_id: callID, name: "" }, name, ""));
          continue;
        }
        outputItems.push(toolIndex.applyIdentity({ id: `fc_${callID}`, type: "function_call", status: itemStatus, arguments: args, call_id: callID, name: "" }, name, ""));
      }
    }
  }
  if (st.toolInputError() !== undefined) {
    return JSON.stringify(responsesToolInputFailure(id, 0, st.toolInputError()).response);
  }
  if (outputItems.length > 0) resp.output = outputItems;

  const usage = getAt(root, "usage");
  if (usage !== undefined) {
    if (getAt(usage, "prompt_tokens") !== undefined || getAt(usage, "completion_tokens") !== undefined || getAt(usage, "total_tokens") !== undefined) {
      const u: JSONObject = { input_tokens: gint(getAt(usage, "prompt_tokens")) };
      const cached = getAt(usage, "prompt_tokens_details.cached_tokens");
      if (cached !== undefined) u.input_tokens_details = { cached_tokens: gint(cached) };
      u.output_tokens = gint(getAt(usage, "completion_tokens"));
      // Chat Completions upstreams report reasoning under completion_tokens_details;
      // Responses-native upstreams under output_tokens_details. Accept both.
      const reasoning = getAt(usage, "output_tokens_details.reasoning_tokens") ?? getAt(usage, "completion_tokens_details.reasoning_tokens");
      if (reasoning !== undefined) u.output_tokens_details = { reasoning_tokens: gint(reasoning) };
      u.total_tokens = gint(getAt(usage, "total_tokens"));
      resp.usage = u;
    } else {
      // Fallback to the raw usage object if the structure differs.
      resp.usage = goValue(usage);
    }
  }
  return JSON.stringify(resp);
}

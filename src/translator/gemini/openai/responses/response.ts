// Port of internal/translator/gemini/openai/responses/gemini_openai-responses_response.go.
//
// Stream contract: the translator receives one upstream Gemini chunk per call
// (a JSON object, optionally prefixed with "data:"), then a literal "[DONE]".
// AI Studio chunks are bare GenerateContentResponse objects; Gemini CLI (Code
// Assist) chunks wrap them as {"response": {...}}; both are unwrapped. It returns
// complete Responses SSE frames ("event: <type>\ndata: <json>\n\n") with
// monotonically increasing sequence_number values. The terminal event
// (response.completed / response.incomplete) is emitted once a finishReason has
// been seen and either a usage frame arrives or "[DONE]" is received.
import { getAt, gbool, gint, gstr, isArr } from "../../../../util/gpath.ts";
import type { ResponsesToolIdentity } from "../../../../util/responses_tools.ts";
import { unwrapResponsesCustomToolInput } from "../../../../util/responses_tools.ts";
import { restoreSanitizedToolName, sanitizedToolNameMap } from "../../../../util/translator.ts";
import { ApplyPatchCallState, ApplyPatchErrorState, applyPatchFailure, applyPatchInputDelta, applyPatchInputDone } from "../../../common/apply_patch_events.ts";
import { sseEventData } from "../../../common/bytes.ts";
import { requestModelName as commonRequestModelName } from "../../../common/request.ts";
import { setResponsesToolCallIdentity } from "../../../common/responses.ts";
import type { TranslateContext, TranslatorState } from "../../../types.ts";
import { isVertexStreamingFunctionCall, type VertexStreamingToolCall, newVertexStreamingToolCall } from "../../common/vertex_partial_args.ts";
import { gfloat, gjsonRaw, has, parseGJSON, runeCount, str, unixNano, validJSON } from "./helpers.ts";
import { geminiResponsesThoughtSignature } from "./request.ts";
import {
  encodeGeminiResponsesCarrier,
  geminiResponsesCarrierAny,
  geminiResponsesCarrierFunction,
  geminiResponsesCarrierNext,
  geminiResponsesCarrierPrevious,
  geminiResponsesCarrierStandalone,
  geminiResponsesCarrierText,
} from "./signature_carrier.ts";
import { buildOpenAIResponsesToolSearchCallItem, openAIResponsesToolSearchCallItemID } from "./tool_search.ts";
import { responsesToolReverseIdentityMap } from "./tools.ts";
import { cacheGeminiResponsesTextSignatures } from "./trailing_signature.ts";
import {
  allowsResponsesWebSearchToolChoice,
  buildResponsesURLCitationsForMessages,
  buildResponsesWebSearchCallItem,
  extractGroundingMetadata,
  extractGroundingQueries,
  extractGroundingSources,
  extractResponsesWebSearchQuery,
  type GeminiPartMapping,
  hasResponsesWebSearchTool,
  hasValidWebGrounding,
  mergeCitationAnnotations,
  mergeGroundingMetadata,
  modelSupportsWebSearch,
} from "./web_search.ts";

type Obj = Record<string, unknown>;

interface DetachedReasoningItem {
  index: number;
  id: string;
  signature: string;
}

interface CompletedMessageItem {
  id: string;
  text: string;
  status: string;
  annotations: Obj[];
}

interface CompletedReasoningItem {
  id: string;
  signature: string;
  text: string;
}

interface FunctionCallEvidence {
  partIndex: number;
  hasPartIndex: boolean;
  applyPatch: boolean;
  rawName: string;
  upstreamID: string;
  input: string;
  hasInput: boolean;
  err: Error | undefined;
  patchCall: ApplyPatchCallState | undefined;
}

function newEvidence(init: Partial<FunctionCallEvidence> = {}): FunctionCallEvidence {
  return { partIndex: 0, hasPartIndex: false, applyPatch: false, rawName: "", upstreamID: "", input: "", hasInput: false, err: undefined, patchCall: undefined, ...init };
}

/** Gemini usage frames are cumulative snapshots, not additive deltas. */
class GeminiResponsesUsage {
  present = false;
  prompt = 0;
  candidates = 0;
  thoughts = 0;
  total = 0;
  cached = 0;

  merge(root: unknown): boolean {
    let metadata = getAt(root, "usageMetadata");
    if (metadata === undefined) metadata = getAt(root, "cpaUsageMetadata");
    if (metadata === undefined) return false;
    this.present = true;
    const fields: [string, keyof GeminiResponsesUsage][] = [
      ["promptTokenCount", "prompt"],
      ["candidatesTokenCount", "candidates"],
      ["thoughtsTokenCount", "thoughts"],
      ["totalTokenCount", "total"],
      ["cachedContentTokenCount", "cached"],
    ];
    for (const [name, key] of fields) {
      const value = getAt(metadata, name);
      if (value !== undefined) (this as unknown as Record<string, number>)[key] = gint(value);
    }
    return true;
  }

  json(): Obj {
    return {
      input_tokens: this.prompt,
      input_tokens_details: { cached_tokens: this.cached },
      output_tokens: this.candidates + this.thoughts,
      output_tokens_details: { reasoning_tokens: this.thoughts },
      total_tokens: this.total,
    };
  }
}

interface TerminalState {
  eventType: string;
  status: string;
  incompleteDetails: Obj | undefined;
}

export function geminiResponsesTerminalState(finishReason: string): TerminalState {
  switch (finishReason.trim().toUpperCase()) {
    case "MAX_TOKENS":
      return { eventType: "response.incomplete", status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } };
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
    case "MALFORMED_RESPONSE":
    case "MALFORMED_FUNCTION_CALL":
      return { eventType: "response.incomplete", status: "incomplete", incompleteDetails: { reason: "content_filter" } };
    default:
      return { eventType: "response.completed", status: "completed", incompleteDetails: undefined };
  }
}

interface BufferedPart {
  partIndex: number;
  text: string;
}

/** Per-stream state (Go: geminiToResponsesState). Implements the ToolInputErrorState contract. */
export class GeminiToResponsesState extends ApplyPatchErrorState {
  seq = 0;
  responseID = "";
  createdAt = 0;
  started = false;
  completed = false;
  finishReason = "";
  usage = new GeminiResponsesUsage();

  msgOpened = false;
  msgClosed = false;
  msgIndex = 0;
  currentMsgID = "";
  itemTextBuf = "";

  reasoningOpened = false;
  reasoningIndex = 0;
  reasoningItemID = "";
  reasoningEnc = "";
  reasoningDirection = "";
  reasoningTargetKind = "";
  reasoningBuf = "";
  reasoningPendingDeltas: string[] = [];
  reasoningClosed = false;
  pendingReasoningSignature = "";
  detachedReasoning = new Map<number, DetachedReasoningItem>();
  completedMessages = new Map<number, CompletedMessageItem>();
  completedReasoning = new Map<number, CompletedReasoningItem>();
  seenReasoningSignatures = new Set<string>();
  lastSemanticKind = "";
  hiddenTextSignatures = new Map<string, string[]>();

  nextIndex = 0;
  funcArgsBuf = new Map<number, string>();
  funcInputBuf = new Map<number, string>();
  funcCustom = new Map<number, boolean>();
  funcToolSearch = new Map<number, boolean>();
  funcNames = new Map<number, string>();
  funcNamespaces = new Map<number, string>();
  funcCallIDs = new Map<number, string>();
  funcDone = new Map<number, boolean>();
  sanitizedNameMap: Map<string, string> | undefined;
  toolIdentityMap: Map<string, ResponsesToolIdentity> | undefined;
  requestJSON: string | undefined;
  functionEvidence = new Map<string, FunctionCallEvidence>();
  activeStreamingFunc: VertexStreamingToolCall | undefined;
  activeStreamingPatch: ApplyPatchCallState | undefined;
  hasFailedStreamingFunc = false;

  webSearchStreamMode = false;
  webSearchOpened = false;
  webSearchDone = false;
  webSearchIndex = 0;
  webSearchItemID = "";
  webSearchDoneItem: Obj | undefined;
  webSearchQuery = "";
  webSearchQueries: string[] = [];
  webSearchSources: Obj[] = [];
  webSearchAnnotations: Obj[] = [];
  webSearchAnnotationsAttached = false;
  webSearchBufferedDeltas: string[] = [];
  webSearchBufferedParts: BufferedPart[] = [];
  rawGroundingMetadata: unknown = undefined;
  partMappings: GeminiPartMapping[] = [];
  streamPartIndex = 0;
  currentLogicalPartIndex = 0;
  currentPartKind = "";
  hasSeenFirstPart = false;
  textPartRunActive = false;
  currentMsgRuneOffset = 0;
  emittedAnnotationCount = new Map<number, number>();

  /** Rejects a patch-enabled stream lacking its source terminator (Go: FinalizeToolInput). */
  finalizeToolInput(): string[] {
    if (this.toolInputError() || this.completed) return [];
    if (this.finishReason !== "") {
      const errIdentity = geminiPendingIdentityError(this);
      if (!errIdentity) return [];
      this.setToolInputError(errIdentity);
    }
    if (!patchEnabled(this.toolIdentityMap)) return [];
    if (!this.toolInputError()) this.setToolInputError(new Error("upstream apply_patch stream ended before protocol completion"));
    this.completed = true;
    this.seq++;
    return [emitEvent("response.failed", applyPatchFailure(this.responseID, this.seq))];
  }
}

function patchEnabled(map: Map<string, ResponsesToolIdentity> | undefined): boolean {
  if (!map) return false;
  for (const identity of map.values()) if (identity.applyPatch) return true;
  return false;
}

let responseIDCounter = 0;
let funcCallIDCounter = 0;

function nextResponseID(): string {
  responseIDCounter++;
  return `resp_${unixNano().toString(16)}_${responseIDCounter}`;
}

function pickRequestJSON(originalRequestRawJSON: string | undefined, requestRawJSON: string | undefined): string | undefined {
  if (originalRequestRawJSON && validJSON(originalRequestRawJSON)) return originalRequestRawJSON;
  if (requestRawJSON && validJSON(requestRawJSON)) return requestRawJSON;
  return undefined;
}

function parse(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapRequestRoot(root: unknown): unknown {
  const req = getAt(root, "request");
  if (req === undefined) return root;
  if (has(req, "model") || has(req, "input") || has(req, "instructions")) return req;
  return root;
}

/** Unwraps the Gemini CLI / Vertex {"response": {...}} envelope. */
export function unwrapGeminiResponseRoot(root: unknown): unknown {
  const resp = getAt(root, "response");
  if (resp === undefined) return root;
  if (has(resp, "candidates") || has(resp, "responseId") || has(resp, "usageMetadata") || has(resp, "cpaUsageMetadata")) return resp;
  return root;
}

function emitEvent(event: string, payload: string | Obj): string {
  return sseEventData(event, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function hasEffectiveGoogleSearchTool(rawJSON: string | undefined): boolean {
  const root = parse(rawJSON);
  if (root === undefined) return false;
  if (str(root, "requestType") === "web_search") return true;
  for (const path of ["request.tools", "tools"]) {
    const tools = getAt(root, path);
    if (!isArr(tools)) continue;
    if (tools.some((tool) => has(tool, "googleSearch"))) return true;
  }
  return false;
}

function isUpstreamGeminiRequest(rawJSON: string | undefined): boolean {
  const root = parse(rawJSON);
  if (root === undefined) return false;
  if (has(root, "requestType")) return true;
  return has(root, "contents") || has(root, "request.contents");
}

function determineWebSearchStreamMode(
  modelName: string,
  requestModelName: string,
  originalRequestRawJSON: string | undefined,
  requestRawJSON: string | undefined,
  reqJSON: string | undefined,
): boolean {
  if (originalRequestRawJSON) {
    const origRoot = unwrapRequestRoot(parse(originalRequestRawJSON));
    if (!allowsResponsesWebSearchToolChoice(origRoot)) return false;
  }
  if (requestRawJSON) {
    const reqRoot = unwrapRequestRoot(parse(requestRawJSON));
    if (has(reqRoot, "tool_choice") && !allowsResponsesWebSearchToolChoice(reqRoot)) return false;
    if (isUpstreamGeminiRequest(requestRawJSON) || hasEffectiveGoogleSearchTool(requestRawJSON)) return hasEffectiveGoogleSearchTool(requestRawJSON);
  }
  if (!reqJSON) reqJSON = pickRequestJSON(originalRequestRawJSON, requestRawJSON);
  if (reqJSON) {
    const reqRoot = unwrapRequestRoot(parse(reqJSON));
    return hasResponsesWebSearchTool(reqRoot) && allowsResponsesWebSearchToolChoice(reqRoot) && (modelSupportsWebSearch(modelName) || modelSupportsWebSearch(requestModelName));
  }
  return false;
}

function newCallID(): string {
  funcCallIDCounter++;
  return `call_${unixNano()}_${funcCallIDCounter}`;
}

/** Echoes request fields onto a Responses response object. */
function echoRequestFields(target: Obj, req: unknown, modelFallback?: () => unknown): void {
  const v = (path: string): unknown => getAt(req, path);
  if (v("instructions") !== undefined) target.instructions = gstr(v("instructions"));
  if (v("max_output_tokens") !== undefined) target.max_output_tokens = gint(v("max_output_tokens"));
  if (v("max_tool_calls") !== undefined) target.max_tool_calls = gint(v("max_tool_calls"));
  if (v("model") !== undefined) target.model = gstr(v("model"));
  else if (modelFallback) {
    const m = modelFallback();
    if (m !== undefined) target.model = gstr(m);
  }
  if (v("parallel_tool_calls") !== undefined) target.parallel_tool_calls = gbool(v("parallel_tool_calls"));
  if (v("previous_response_id") !== undefined) target.previous_response_id = gstr(v("previous_response_id"));
  if (v("prompt_cache_key") !== undefined) target.prompt_cache_key = gstr(v("prompt_cache_key"));
  if (v("reasoning") !== undefined) target.reasoning = v("reasoning");
  if (v("safety_identifier") !== undefined) target.safety_identifier = gstr(v("safety_identifier"));
  if (v("service_tier") !== undefined) target.service_tier = gstr(v("service_tier"));
  if (v("store") !== undefined) target.store = gbool(v("store"));
  if (v("temperature") !== undefined) target.temperature = gfloat(v("temperature"));
  if (v("text") !== undefined) target.text = v("text");
  if (v("tool_choice") !== undefined) target.tool_choice = v("tool_choice");
  if (v("tools") !== undefined) target.tools = v("tools");
  if (v("top_logprobs") !== undefined) target.top_logprobs = gint(v("top_logprobs"));
  if (v("top_p") !== undefined) target.top_p = gfloat(v("top_p"));
  if (v("truncation") !== undefined) target.truncation = gstr(v("truncation"));
  if (v("user") !== undefined) target.user = v("user");
  if (v("metadata") !== undefined) target.metadata = v("metadata");
}

function parseCreateTime(v: unknown): number {
  if (typeof v !== "string") return 0;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function functionItem(type: "function_call" | "custom_tool_call", id: string, status: string, value: string, callID: string, name: string, namespace: string): Obj {
  const item: Obj = type === "function_call" ? { id, type, status, arguments: value, call_id: callID, name: "" } : { id, type, status, input: value, call_id: callID, name: "" };
  return setResponsesToolCallIdentity(item, name, namespace, "");
}

/** Converts Gemini SSE chunks into OpenAI Responses SSE events. */
export function convertGeminiResponseToOpenAIResponses(
  _ctx: TranslateContext,
  modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  param: TranslatorState,
): string[] {
  if (!(param.value instanceof GeminiToResponsesState)) {
    const st = new GeminiToResponsesState();
    const reqJSON = pickRequestJSON(originalRequestRawJSON, requestRawJSON);
    st.sanitizedNameMap = sanitizedToolNameMap(originalRequestRawJSON);
    st.toolIdentityMap = responsesToolReverseIdentityMap(reqJSON);
    st.requestJSON = reqJSON;
    param.value = st;
  }
  const st = param.value as GeminiToResponsesState;
  const reqJSON = st.requestJSON;

  let chunk = rawJSON;
  if (chunk.startsWith("data:")) chunk = chunk.slice(5).trim();
  chunk = chunk.trim();
  if (chunk.length === 0 || st.completed) return [];
  const done = chunk === "[DONE]";
  if (done) {
    if (!st.started || st.activeStreamingFunc || st.hasFailedStreamingFunc) return [];
    if (st.finishReason === "") st.finishReason = "STOP";
    chunk = "{}";
  }
  const parsedChunk = parseGJSON(chunk);
  const chunkValid = parsedChunk.valid;
  let root = parsedChunk.value;
  if (root === undefined) return [];
  root = unwrapGeminiResponseRoot(root);
  const hasUsage = st.usage.merge(root);
  let messageStatus = "completed";

  const out: string[] = [];
  const nextSeq = (): number => ++st.seq;

  const reasoningEncryptedContent = (): string => {
    if (st.reasoningEnc === "" || st.reasoningDirection === "") return st.reasoningEnc;
    return encodeGeminiResponsesCarrier(st.reasoningEnc, st.reasoningDirection, st.reasoningTargetKind);
  };

  const finalizeWebSearch = (): void => {
    if (!st.webSearchOpened || st.webSearchDone) return;
    if (st.webSearchQuery === "" && st.webSearchQueries.length > 0) st.webSearchQuery = st.webSearchQueries[0]!;
    if (st.webSearchQuery === "" && reqJSON) st.webSearchQuery = extractResponsesWebSearchQuery(unwrapRequestRoot(parse(reqJSON)));
    out.push(emitEvent("response.web_search_call.completed", { type: "response.web_search_call.completed", sequence_number: nextSeq(), output_index: st.webSearchIndex, item_id: st.webSearchItemID }));
    const doneItem = buildResponsesWebSearchCallItem(st.webSearchItemID, st.webSearchQuery, st.webSearchQueries, st.webSearchSources);
    st.webSearchDoneItem = doneItem;
    out.push(emitEvent("response.output_item.done", { type: "response.output_item.done", sequence_number: nextSeq(), output_index: st.webSearchIndex, item: doneItem }));
    st.webSearchDone = true;
  };

  const reasoningDelta = (delta: string): void => {
    out.push(
      emitEvent("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        sequence_number: nextSeq(),
        item_id: st.reasoningItemID,
        output_index: st.reasoningIndex,
        summary_index: 0,
        delta,
      }),
    );
  };

  const openReasoning = (): void => {
    if (st.reasoningOpened || st.reasoningClosed || (st.reasoningBuf.length === 0 && st.reasoningEnc === "")) return;
    finalizeWebSearch();
    st.reasoningOpened = true;
    st.reasoningIndex = st.nextIndex++;
    st.reasoningItemID = `rs_${st.responseID}_${st.reasoningIndex}`;
    out.push(
      emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: st.reasoningIndex,
        item: { id: st.reasoningItemID, type: "reasoning", status: "in_progress", encrypted_content: reasoningEncryptedContent(), summary: [] },
      }),
    );
    out.push(
      emitEvent("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        sequence_number: nextSeq(),
        item_id: st.reasoningItemID,
        output_index: st.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    );
    for (const delta of st.reasoningPendingDeltas) reasoningDelta(delta);
    st.reasoningPendingDeltas = [];
  };

  const finalizeReasoning = (): void => {
    openReasoning();
    if (!st.reasoningOpened || st.reasoningClosed) return;
    const full = st.reasoningBuf;
    out.push(
      emitEvent("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        sequence_number: nextSeq(),
        item_id: st.reasoningItemID,
        output_index: st.reasoningIndex,
        summary_index: 0,
        text: full,
      }),
    );
    out.push(
      emitEvent("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        sequence_number: nextSeq(),
        item_id: st.reasoningItemID,
        output_index: st.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: full },
      }),
    );
    out.push(
      emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: st.reasoningIndex,
        item: { id: st.reasoningItemID, type: "reasoning", encrypted_content: reasoningEncryptedContent(), summary: [{ type: "summary_text", text: full }] },
      }),
    );
    st.completedReasoning.set(st.reasoningIndex, { id: st.reasoningItemID, signature: reasoningEncryptedContent(), text: full });
    st.reasoningClosed = true;
  };

  const resetReasoning = (): void => {
    st.reasoningOpened = false;
    st.reasoningClosed = false;
    st.reasoningIndex = 0;
    st.reasoningItemID = "";
    st.reasoningEnc = "";
    st.reasoningDirection = "";
    st.reasoningTargetKind = "";
    st.reasoningBuf = "";
    st.reasoningPendingDeltas = [];
  };

  const openWebSearch = (): void => {
    if (st.webSearchOpened) return;
    finalizeReasoning();
    st.webSearchOpened = true;
    st.webSearchIndex = st.nextIndex++;
    st.webSearchItemID = `ws_${st.responseID.startsWith("resp_") ? st.responseID.slice(5) : st.responseID}`;
    if (st.webSearchQuery === "" && st.webSearchQueries.length > 0) st.webSearchQuery = st.webSearchQueries[0]!;
    if (st.webSearchQuery === "" && reqJSON) st.webSearchQuery = extractResponsesWebSearchQuery(unwrapRequestRoot(parse(reqJSON)));
    out.push(
      emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: st.webSearchIndex,
        item: { id: st.webSearchItemID, type: "web_search_call", status: "in_progress", action: { type: "search", query: st.webSearchQuery } },
      }),
    );
    out.push(
      emitEvent("response.web_search_call.searching", { type: "response.web_search_call.searching", sequence_number: nextSeq(), output_index: st.webSearchIndex, item_id: st.webSearchItemID }),
    );
  };

  const openMessage = (): void => {
    st.msgOpened = true;
    st.msgIndex = st.nextIndex++;
    st.currentMsgID = `msg_${st.responseID}_${st.msgIndex}`;
    out.push(
      emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: st.msgIndex,
        item: { id: st.currentMsgID, type: "message", status: "in_progress", content: [], role: "assistant" },
      }),
    );
    out.push(
      emitEvent("response.content_part.added", {
        type: "response.content_part.added",
        sequence_number: nextSeq(),
        item_id: st.currentMsgID,
        output_index: st.msgIndex,
        content_index: 0,
        part: { type: "output_text", annotations: [], logprobs: [], text: "" },
      }),
    );
    st.itemTextBuf = "";
    st.currentMsgRuneOffset = 0;
  };

  const textDelta = (delta: string): void => {
    out.push(
      emitEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: nextSeq(),
        item_id: st.currentMsgID,
        output_index: st.msgIndex,
        content_index: 0,
        delta,
        logprobs: [],
      }),
    );
  };

  const recordPartMapping = (partIndex: number, text: string): void => {
    const last = st.partMappings[st.partMappings.length - 1];
    if (last && last.partIndex === partIndex && last.messageIndex === st.msgIndex) last.partText += text;
    else st.partMappings.push({ partIndex, messageIndex: st.msgIndex, startRuneInMsg: st.currentMsgRuneOffset, partText: text });
    st.currentMsgRuneOffset += runeCount(text);
  };

  const flushWebSearchBufferedText = (): void => {
    finalizeWebSearch();
    if (st.webSearchBufferedDeltas.length === 0) return;
    if (st.msgClosed) {
      st.msgOpened = false;
      st.msgClosed = false;
      st.itemTextBuf = "";
      st.currentMsgRuneOffset = 0;
    }
    if (!st.msgOpened) openMessage();
    for (const delta of st.webSearchBufferedDeltas) {
      st.itemTextBuf += delta;
      textDelta(delta);
    }
    for (const bp of st.webSearchBufferedParts) recordPartMapping(bp.partIndex, bp.text);
    st.webSearchBufferedDeltas = [];
    st.webSearchBufferedParts = [];
  };

  const emitNewCitationAnnotations = (msgIndex: number, itemID: string, annotations: Obj[]): void => {
    const emitted = st.emittedAnnotationCount.get(msgIndex) ?? 0;
    for (let annIdx = emitted; annIdx < annotations.length; annIdx++) {
      out.push(
        emitEvent("response.output_text.annotation.added", {
          type: "response.output_text.annotation.added",
          sequence_number: nextSeq(),
          response_id: st.responseID,
          item_id: itemID,
          output_index: msgIndex,
          content_index: 0,
          annotation_index: annIdx,
          annotation: annotations[annIdx],
        }),
      );
    }
    if (annotations.length > emitted) st.emittedAnnotationCount.set(msgIndex, annotations.length);
  };

  const finalizeMessage = (): void => {
    finalizeWebSearch();
    if (st.webSearchBufferedDeltas.length > 0) flushWebSearchBufferedText();
    if (!st.msgOpened || st.msgClosed) return;
    const fullText = st.itemTextBuf;
    let msgCitations: Obj[] = [];
    if (st.rawGroundingMetadata !== undefined) {
      const cMap = buildResponsesURLCitationsForMessages(st.rawGroundingMetadata, st.partMappings, [fullText]);
      msgCitations = cMap?.get(st.msgIndex) ?? [];
      const first = cMap?.get(0) ?? [];
      if (msgCitations.length === 0 && st.completedMessages.size === 0 && first.length > 0) msgCitations = first;
      st.webSearchAnnotations = msgCitations;
    }
    emitNewCitationAnnotations(st.msgIndex, st.currentMsgID, msgCitations);
    out.push(
      emitEvent("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: nextSeq(),
        item_id: st.currentMsgID,
        output_index: st.msgIndex,
        content_index: 0,
        text: fullText,
        logprobs: [],
      }),
    );
    out.push(
      emitEvent("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        item_id: st.currentMsgID,
        output_index: st.msgIndex,
        content_index: 0,
        part: { type: "output_text", annotations: msgCitations.length > 0 ? msgCitations : [], logprobs: [], text: fullText },
      }),
    );
    if (msgCitations.length > 0) st.webSearchAnnotationsAttached = true;
    out.push(
      emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: st.msgIndex,
        item: {
          id: st.currentMsgID,
          type: "message",
          status: messageStatus,
          content: [{ type: "output_text", annotations: msgCitations.length > 0 ? msgCitations : [], logprobs: [], text: fullText }],
          role: "assistant",
        },
      }),
    );
    st.completedMessages.set(st.msgIndex, { id: st.currentMsgID, text: fullText, status: messageStatus, annotations: msgCitations });
    st.msgClosed = true;
    st.currentMsgRuneOffset = 0;
  };

  const emitLateCitations = (): void => {
    if (st.rawGroundingMetadata === undefined || st.completedMessages.size === 0) return;
    const msgTexts: string[] = [];
    for (let idx = 0; idx < st.nextIndex; idx++) {
      const msg = st.completedMessages.get(idx);
      if (msg) msgTexts.push(msg.text);
    }
    const lateCitationsMap = buildResponsesURLCitationsForMessages(st.rawGroundingMetadata, st.partMappings, msgTexts);
    if (!lateCitationsMap) return;
    for (let idx = 0; idx < st.nextIndex; idx++) {
      const completedMessage = st.completedMessages.get(idx);
      if (!completedMessage) continue;
      let lateCites = lateCitationsMap.get(idx) ?? [];
      const first = lateCitationsMap.get(0) ?? [];
      if (lateCites.length === 0 && st.completedMessages.size === 1 && first.length > 0) lateCites = first;
      const annotations = mergeCitationAnnotations(completedMessage.annotations, lateCites);
      emitNewCitationAnnotations(idx, completedMessage.id, annotations);
      if (annotations.length > 0) completedMessage.annotations = annotations;
    }
  };

  const emitDetachedReasoning = (signature: string, direction: string, targetKind: string): void => {
    signature = signature.trim();
    if (signature === "" || st.seenReasoningSignatures.has(signature)) return;
    finalizeReasoning();
    finalizeMessage();
    const idx = st.nextIndex++;
    const placement = direction === geminiResponsesCarrierPrevious ? "after" : "before";
    const itemID = `rs_${st.responseID}_detached_${placement}_${idx}`;
    const carrierSignature = encodeGeminiResponsesCarrier(signature, direction, targetKind);
    out.push(
      emitEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: nextSeq(),
        output_index: idx,
        item: { id: itemID, type: "reasoning", status: "in_progress", encrypted_content: carrierSignature, summary: [] },
      }),
    );
    out.push(
      emitEvent("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item: { id: itemID, type: "reasoning", encrypted_content: carrierSignature, summary: [] },
      }),
    );
    st.detachedReasoning.set(idx, { index: idx, id: itemID, signature: carrierSignature });
    st.seenReasoningSignatures.add(signature);
  };

  const emitTrailingDetachedReasoning = (signature: string): void => {
    switch (st.lastSemanticKind) {
      case geminiResponsesCarrierText: {
        signature = signature.trim();
        if (signature === "" || st.seenReasoningSignatures.has(signature)) return;
        finalizeReasoning();
        finalizeMessage();
        // Never bind a later thought signature to a visible message from before that thought.
        if (!st.msgOpened || (st.reasoningOpened && st.reasoningIndex > st.msgIndex)) {
          emitDetachedReasoning(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierText);
          return;
        }
        const signatures = [...(st.hiddenTextSignatures.get(st.currentMsgID) ?? []), signature];
        // Keep failed writes in the prefix so a later successful write cannot reorder carriers.
        st.hiddenTextSignatures.set(st.currentMsgID, signatures);
        if (cacheGeminiResponsesTextSignatures(modelName, st.currentMsgID, st.itemTextBuf, signatures)) {
          st.seenReasoningSignatures.add(signature);
          return;
        }
        emitDetachedReasoning(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierText);
        break;
      }
      case geminiResponsesCarrierFunction:
        emitDetachedReasoning(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierFunction);
        break;
      default:
        emitDetachedReasoning(signature, geminiResponsesCarrierStandalone, geminiResponsesCarrierAny);
    }
  };

  const failPatch = (err: Error): void => {
    st.setToolInputError(err);
    st.completed = true;
    out.push(emitEvent("response.failed", applyPatchFailure(st.responseID, nextSeq())));
  };

  if (!st.started) {
    st.responseID = str(root, "responseId");
    if (st.responseID === "") st.responseID = nextResponseID();
    if (!st.responseID.startsWith("resp_")) st.responseID = `resp_${st.responseID}`;
    if (has(root, "createTime")) st.createdAt = parseCreateTime(getAt(root, "createTime"));
    if (st.createdAt === 0) st.createdAt = Math.floor(Date.now() / 1000);

    const created: Obj = { type: "response.created", sequence_number: nextSeq(), response: { id: st.responseID, object: "response", created_at: st.createdAt, status: "in_progress", background: false, error: null, output: [] } };
    let requestModelName = commonRequestModelName(originalRequestRawJSON, requestRawJSON);
    if (requestModelName === "" && reqJSON) requestModelName = commonRequestModelName(reqJSON, undefined);
    if (requestModelName === "") requestModelName = modelName;
    if (requestModelName !== "") (created.response as Obj).model = requestModelName;
    out.push(emitEvent("response.created", created));
    const inprog: Obj = { type: "response.in_progress", sequence_number: nextSeq(), response: { id: st.responseID, object: "response", created_at: st.createdAt, status: "in_progress", output: [] } };
    if (requestModelName !== "") (inprog.response as Obj).model = requestModelName;
    out.push(emitEvent("response.in_progress", inprog));
    st.started = true;
    st.nextIndex = 0;
    st.webSearchStreamMode = determineWebSearchStreamMode(modelName, requestModelName, originalRequestRawJSON, requestRawJSON, reqJSON);
  }

  const gm = extractGroundingMetadata(root);
  if (gm !== undefined) {
    st.rawGroundingMetadata = mergeGroundingMetadata(st.rawGroundingMetadata, gm);
    const mergedGM = st.rawGroundingMetadata;
    const queries = extractGroundingQueries(mergedGM);
    if (queries.length > 0) {
      st.webSearchQueries = queries;
      if (st.webSearchQuery === "") st.webSearchQuery = queries[0]!;
    }
    const sources = extractGroundingSources(mergedGM);
    if (sources.length > 0) st.webSearchSources = sources;
    // Keep the cached completed item aligned with the latest queries and sources.
    if (st.webSearchDone) st.webSearchDoneItem = buildResponsesWebSearchCallItem(st.webSearchItemID, st.webSearchQuery, st.webSearchQueries, st.webSearchSources);
    if (!st.webSearchOpened && hasValidWebGrounding(mergedGM)) openWebSearch();
    emitLateCitations();
  }

  const parts = getAt(root, "candidates.0.content.parts");
  if (isArr(parts)) {
    for (let partIdxInChunk = 0; partIdxInChunk < parts.length; partIdxInChunk++) {
      const part = parts[partIdxInChunk];
      let explicitPartIndex = -1;
      if (has(part, "partIndex")) explicitPartIndex = gint(getAt(part, "partIndex"));
      else if (has(part, "index")) explicitPartIndex = gint(getAt(part, "index"));

      let signature = str(part, "thoughtSignature").trim();
      if (signature === "") signature = str(part, "thought_signature").trim();
      const functionCall = getAt(part, "functionCall");
      const text = getAt(part, "text");
      const textStr = gstr(text);
      const isThought = gbool(getAt(part, "thought"));

      let partKind: string;
      if (isThought) partKind = "thought";
      else if (functionCall !== undefined) partKind = "function";
      else if (text !== undefined) partKind = "text";
      else partKind = "unknown";

      let currentPartIndex: number;
      if (explicitPartIndex >= 0) {
        currentPartIndex = explicitPartIndex;
        st.currentLogicalPartIndex = explicitPartIndex;
        st.currentPartKind = partKind;
        st.hasSeenFirstPart = true;
        st.textPartRunActive = partKind === "text";
      } else {
        if (!st.hasSeenFirstPart) {
          st.hasSeenFirstPart = true;
          st.currentLogicalPartIndex = 0;
          st.currentPartKind = partKind;
          if (partKind === "text") st.textPartRunActive = true;
        } else if (partIdxInChunk > 0 || partKind !== st.currentPartKind) {
          st.currentLogicalPartIndex++;
          st.currentPartKind = partKind;
          st.textPartRunActive = partKind === "text";
        } else if (partKind === "function") {
          st.currentLogicalPartIndex++;
          st.currentPartKind = partKind;
          st.textPartRunActive = false;
        } else if (partKind === "text" && !st.textPartRunActive) {
          st.currentLogicalPartIndex++;
          st.currentPartKind = partKind;
          st.textPartRunActive = true;
        }
        currentPartIndex = st.currentLogicalPartIndex;
      }
      st.streamPartIndex = currentPartIndex;
      const isStreamingFuncContinuation = functionCall !== undefined && !!st.activeStreamingFunc && st.activeStreamingFunc.canContinueWith(functionCall);
      if (functionCall !== undefined && !isStreamingFuncContinuation && st.pendingReasoningSignature !== "") {
        if (signature === "") emitDetachedReasoning(st.pendingReasoningSignature, geminiResponsesCarrierNext, geminiResponsesCarrierFunction);
        else emitTrailingDetachedReasoning(st.pendingReasoningSignature);
        st.pendingReasoningSignature = "";
      }
      const reasoningActive = (st.reasoningOpened && !st.reasoningClosed) || (!st.reasoningOpened && (st.reasoningBuf.length > 0 || st.reasoningEnc !== ""));
      if (signature !== "" && !isThought) {
        if (isStreamingFuncContinuation) {
          if (!st.seenReasoningSignatures.has(signature)) {
            if (st.pendingReasoningSignature !== "" && st.pendingReasoningSignature !== signature) emitTrailingDetachedReasoning(st.pendingReasoningSignature);
            st.pendingReasoningSignature = signature;
          }
        } else if (reasoningActive) {
          if (st.reasoningEnc === "" || st.reasoningEnc === signature) {
            st.reasoningEnc = signature;
            if (functionCall !== undefined) {
              st.reasoningDirection = geminiResponsesCarrierNext;
              st.reasoningTargetKind = geminiResponsesCarrierFunction;
            } else if (text !== undefined && textStr !== "") {
              st.reasoningDirection = geminiResponsesCarrierNext;
              st.reasoningTargetKind = geminiResponsesCarrierText;
            } else {
              st.reasoningDirection = geminiResponsesCarrierStandalone;
              st.reasoningTargetKind = geminiResponsesCarrierText;
            }
            st.seenReasoningSignatures.add(signature);
          } else {
            finalizeReasoning();
            if (functionCall !== undefined) emitDetachedReasoning(signature, geminiResponsesCarrierNext, geminiResponsesCarrierFunction);
            else if (!st.seenReasoningSignatures.has(signature)) st.pendingReasoningSignature = signature;
          }
          if (text !== undefined && textStr === "" && functionCall === undefined) {
            finalizeReasoning();
            continue;
          }
        } else if (functionCall !== undefined) {
          emitDetachedReasoning(signature, geminiResponsesCarrierNext, geminiResponsesCarrierFunction);
        } else if (text !== undefined && textStr !== "") {
          if (st.pendingReasoningSignature !== "" && st.pendingReasoningSignature !== signature) {
            emitTrailingDetachedReasoning(st.pendingReasoningSignature);
            st.pendingReasoningSignature = "";
          }
          if (!st.seenReasoningSignatures.has(signature)) st.pendingReasoningSignature = signature;
        } else if (text !== undefined && textStr === "") {
          if (st.pendingReasoningSignature !== "") {
            const pendingSignature = st.pendingReasoningSignature;
            st.pendingReasoningSignature = "";
            if (pendingSignature !== signature) emitTrailingDetachedReasoning(pendingSignature);
          }
          if (st.msgOpened || st.funcDone.size > 0 || st.webSearchBufferedDeltas.length > 0) emitTrailingDetachedReasoning(signature);
          else if (!st.seenReasoningSignatures.has(signature)) st.pendingReasoningSignature = signature;
          continue;
        }
      }

      // Reasoning text
      if (isThought) {
        if (st.webSearchBufferedDeltas.length > 0) finalizeMessage();
        if (st.pendingReasoningSignature !== "" && st.msgOpened && !st.msgClosed) {
          emitTrailingDetachedReasoning(st.pendingReasoningSignature);
          st.pendingReasoningSignature = "";
        }
        let incomingSignature = "";
        if (signature !== "" && signature !== geminiResponsesThoughtSignature) {
          if (st.pendingReasoningSignature !== "") {
            if (st.pendingReasoningSignature !== signature) emitDetachedReasoning(st.pendingReasoningSignature, geminiResponsesCarrierStandalone, geminiResponsesCarrierAny);
            st.pendingReasoningSignature = "";
          }
          incomingSignature = signature;
        } else if (st.pendingReasoningSignature !== "") {
          incomingSignature = st.pendingReasoningSignature;
          st.pendingReasoningSignature = "";
        }
        if (st.reasoningOpened && !st.reasoningClosed && incomingSignature !== "" && st.reasoningEnc !== "" && incomingSignature !== st.reasoningEnc) {
          finalizeReasoning();
          resetReasoning();
        }
        if (st.reasoningClosed) {
          finalizeMessage();
          resetReasoning();
        } else if (!st.reasoningOpened && st.reasoningBuf.length === 0 && st.msgOpened && !st.msgClosed) {
          finalizeMessage();
        }
        if (incomingSignature !== "") {
          st.reasoningEnc = incomingSignature;
          st.reasoningDirection = geminiResponsesCarrierStandalone;
          st.reasoningTargetKind = geminiResponsesCarrierText;
          st.seenReasoningSignatures.add(incomingSignature);
        }
        if (text !== undefined && textStr !== "") {
          st.lastSemanticKind = geminiResponsesCarrierText;
          st.reasoningBuf += textStr;
          if (st.reasoningOpened) reasoningDelta(textStr);
          else st.reasoningPendingDeltas.push(textStr);
        }
        if (!st.reasoningOpened && st.reasoningEnc !== "") openReasoning();
        continue;
      }

      // Assistant visible text
      if (text !== undefined && textStr !== "") {
        if (signature === "" && st.pendingReasoningSignature !== "" && ((st.msgOpened && !st.msgClosed) || st.webSearchBufferedDeltas.length > 0)) {
          emitTrailingDetachedReasoning(st.pendingReasoningSignature);
          st.pendingReasoningSignature = "";
        }
        // Responses output items are sequential: finish reasoning before opening the message.
        finalizeReasoning();
        if (st.msgClosed) {
          st.msgOpened = false;
          st.msgClosed = false;
          st.itemTextBuf = "";
          st.currentMsgRuneOffset = 0;
        }
        // In web search stream mode, buffer deltas until web_search_call is finalized.
        if (st.webSearchStreamMode && !st.webSearchDone) {
          st.lastSemanticKind = geminiResponsesCarrierText;
          st.webSearchBufferedDeltas.push(textStr);
          const last = st.webSearchBufferedParts[st.webSearchBufferedParts.length - 1];
          if (last && last.partIndex === currentPartIndex) last.text += textStr;
          else st.webSearchBufferedParts.push({ partIndex: currentPartIndex, text: textStr });
          st.textPartRunActive = true;
          continue;
        }
        if (!st.msgOpened) openMessage();
        st.lastSemanticKind = geminiResponsesCarrierText;
        st.itemTextBuf += textStr;
        recordPartMapping(currentPartIndex, textStr);
        textDelta(textStr);
        st.textPartRunActive = true;
        continue;
      }

      // Function call
      if (functionCall !== undefined) {
        const fc = functionCall;
        finalizeReasoning();
        finalizeWebSearch();
        if (st.webSearchBufferedDeltas.length > 0) flushWebSearchBufferedText();
        finalizeMessage();
        st.lastSemanticKind = geminiResponsesCarrierFunction;

        if (isStreamingFuncContinuation || isVertexStreamingFunctionCall(fc)) {
          if (!isStreamingFuncContinuation) {
            if (st.activeStreamingFunc) {
              st.hasFailedStreamingFunc = true;
              st.activeStreamingFunc = undefined;
              st.activeStreamingPatch = undefined;
            }
            const rawName = str(fc, "name").trim();
            if (rawName === "") {
              st.hasFailedStreamingFunc = true;
              continue;
            }
            const identity = st.toolIdentityMap?.get(rawName) ?? identityFor(restoreSanitizedToolName(st.sanitizedNameMap, rawName));
            const { name, namespace, custom: isCustom, toolSearch: isToolSearch } = identity;
            const idx = st.nextIndex++;
            if (!st.funcArgsBuf.has(idx)) st.funcArgsBuf.set(idx, "");
            const upstreamID = str(fc, "id").trim();
            const callID = upstreamID !== "" ? upstreamID : newCallID();
            st.funcCallIDs.set(idx, callID);
            st.funcNames.set(idx, name);
            st.funcNamespaces.set(idx, namespace);
            st.funcCustom.set(idx, isCustom);
            st.funcToolSearch.set(idx, isToolSearch);
            st.activeStreamingFunc = newVertexStreamingToolCall(rawName, name, upstreamID, callID, idx);
            if (isToolSearch) {
              out.push(
                emitEvent("response.output_item.added", {
                  type: "response.output_item.added",
                  sequence_number: nextSeq(),
                  output_index: idx,
                  item: buildOpenAIResponsesToolSearchCallItem(openAIResponsesToolSearchCallItemID(callID), callID, "in_progress", "{}"),
                }),
              );
            } else if (isCustom) {
              if (identity.applyPatch) st.activeStreamingPatch = new ApplyPatchCallState({ itemID: `ctc_${callID}`, callID, name, namespace, outputIndex: idx });
              out.push(
                emitEvent("response.output_item.added", {
                  type: "response.output_item.added",
                  sequence_number: nextSeq(),
                  output_index: idx,
                  item: functionItem("custom_tool_call", `ctc_${callID}`, "in_progress", "", callID, name, namespace),
                }),
              );
            } else {
              out.push(
                emitEvent("response.output_item.added", {
                  type: "response.output_item.added",
                  sequence_number: nextSeq(),
                  output_index: idx,
                  item: functionItem("function_call", `fc_${callID}`, "in_progress", "", callID, name, namespace),
                }),
              );
            }
          }

          const active = st.activeStreamingFunc!;
          const idx = active.index;
          const [delta, fcDone] = active.assembler.pushFunctionCall(fc);
          const assemblerErr = active.assembler.err();
          if (assemblerErr) {
            st.hasFailedStreamingFunc = true;
            st.activeStreamingFunc = undefined;
            if (st.activeStreamingPatch) {
              st.activeStreamingPatch = undefined;
              failPatch(assemblerErr);
              break;
            }
            continue;
          }
          if (delta !== "") {
            st.funcArgsBuf.set(idx, (st.funcArgsBuf.get(idx) ?? "") + delta);
            if (st.funcCustom.get(idx)) {
              if (st.activeStreamingPatch) {
                const [inputDelta, errPush] = st.activeStreamingPatch.pushArguments(delta);
                if (errPush) {
                  failPatch(errPush);
                  break;
                }
                if (inputDelta !== "") out.push(emitEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(st.activeStreamingPatch, inputDelta, nextSeq())));
              }
            } else if (!st.funcToolSearch.get(idx)) {
              out.push(
                emitEvent("response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  sequence_number: nextSeq(),
                  item_id: `fc_${st.funcCallIDs.get(idx)}`,
                  output_index: idx,
                  delta,
                }),
              );
            }
          }

          if (fcDone) {
            const fullArgs = active.assembler.fullArguments();
            st.activeStreamingFunc = undefined;
            const callID = st.funcCallIDs.get(idx) ?? "";
            if (st.funcToolSearch.get(idx)) {
              let itemStatus = "completed";
              const fr = str(root, "candidates.0.finishReason");
              if (fr !== "") itemStatus = geminiResponsesTerminalState(fr).status;
              else if (st.finishReason !== "") itemStatus = geminiResponsesTerminalState(st.finishReason).status;
              out.push(
                emitEvent("response.output_item.done", {
                  type: "response.output_item.done",
                  sequence_number: nextSeq(),
                  output_index: idx,
                  item: buildOpenAIResponsesToolSearchCallItem(openAIResponsesToolSearchCallItemID(callID), callID, itemStatus, fullArgs),
                }),
              );
            } else if (st.funcCustom.get(idx)) {
              let inputStr: string;
              if (st.activeStreamingPatch) {
                const [tail, fullInput, errFinish] = st.activeStreamingPatch.finishArguments("");
                if (errFinish) {
                  failPatch(errFinish);
                  break;
                }
                if (tail !== "") out.push(emitEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(st.activeStreamingPatch, tail, nextSeq())));
                inputStr = fullInput;
              } else {
                inputStr = unwrapResponsesCustomToolInput(fullArgs);
              }
              st.funcInputBuf.set(idx, inputStr);
              let inputDone: string = JSON.stringify({ type: "response.custom_tool_call_input.done", sequence_number: nextSeq(), item_id: `ctc_${callID}`, output_index: idx, input: inputStr });
              if (st.activeStreamingPatch) {
                inputDone = applyPatchInputDone(st.activeStreamingPatch, inputStr, st.seq);
                st.activeStreamingPatch = undefined;
              }
              out.push(emitEvent("response.custom_tool_call_input.done", inputDone));
              out.push(
                emitEvent("response.output_item.done", {
                  type: "response.output_item.done",
                  sequence_number: nextSeq(),
                  output_index: idx,
                  item: functionItem("custom_tool_call", `ctc_${callID}`, "completed", inputStr, callID, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? ""),
                }),
              );
            } else {
              out.push(
                emitEvent("response.function_call_arguments.done", {
                  type: "response.function_call_arguments.done",
                  sequence_number: nextSeq(),
                  item_id: `fc_${callID}`,
                  output_index: idx,
                  arguments: fullArgs,
                }),
              );
              out.push(
                emitEvent("response.output_item.done", {
                  type: "response.output_item.done",
                  sequence_number: nextSeq(),
                  output_index: idx,
                  item: functionItem("function_call", `fc_${callID}`, "completed", fullArgs, callID, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? ""),
                }),
              );
            }
            st.funcDone.set(idx, true);
            if (st.pendingReasoningSignature !== "") {
              emitTrailingDetachedReasoning(st.pendingReasoningSignature);
              st.pendingReasoningSignature = "";
            }
          }
          continue;
        }

        if (st.activeStreamingFunc) {
          st.hasFailedStreamingFunc = true;
          st.activeStreamingFunc = undefined;
          st.activeStreamingPatch = undefined;
        }

        const evidence = geminiRecordFunctionEvidence(st, fc, explicitPartIndex, chunkValid);
        if (evidence.applyPatch && evidence.err) {
          failPatch(evidence.err);
          break;
        }
        if (evidence.rawName === "") continue;
        const rawName = evidence.applyPatch ? evidence.rawName : str(fc, "name");
        const identity = st.toolIdentityMap?.get(rawName) ?? identityFor(restoreSanitizedToolName(st.sanitizedNameMap, rawName));
        const { name, namespace, custom: isCustom, toolSearch: isToolSearch } = identity;
        if (evidence.applyPatch && evidence.patchCall) {
          const [, , errFinish] = evidence.patchCall.finishArguments(rawOfArgs(fc));
          if (errFinish) {
            failPatch(errFinish);
            break;
          }
          continue;
        }

        const idx = st.nextIndex++;
        if (!st.funcArgsBuf.has(idx)) st.funcArgsBuf.set(idx, "");
        if (identity.applyPatch || isToolSearch) st.funcCallIDs.set(idx, evidence.upstreamID);
        if ((st.funcCallIDs.get(idx) ?? "") === "") st.funcCallIDs.set(idx, newCallID());
        const callID = st.funcCallIDs.get(idx)!;
        st.funcNames.set(idx, name);
        st.funcNamespaces.set(idx, namespace);
        st.funcCustom.set(idx, isCustom);
        st.funcToolSearch.set(idx, isToolSearch);

        const argsJSON = has(fc, "args") ? rawOfArgs(fc) : "{}";
        if ((st.funcArgsBuf.get(idx) ?? "") === "" && argsJSON !== "") st.funcArgsBuf.set(idx, argsJSON);

        if (isToolSearch) {
          let itemStatus = "completed";
          const fr = str(root, "candidates.0.finishReason");
          if (fr !== "") itemStatus = geminiResponsesTerminalState(fr).status;
          else if (st.finishReason !== "") itemStatus = geminiResponsesTerminalState(st.finishReason).status;
          const itemID = openAIResponsesToolSearchCallItemID(callID);
          out.push(
            emitEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: idx,
              item: buildOpenAIResponsesToolSearchCallItem(itemID, callID, "in_progress", argsJSON),
            }),
          );
          if (!st.funcDone.get(idx)) {
            out.push(
              emitEvent("response.output_item.done", {
                type: "response.output_item.done",
                sequence_number: nextSeq(),
                output_index: idx,
                item: buildOpenAIResponsesToolSearchCallItem(itemID, callID, itemStatus, argsJSON),
              }),
            );
            st.funcDone.set(idx, true);
          }
        } else if (isCustom) {
          let inputStr = unwrapResponsesCustomToolInput(argsJSON);
          let patchCall: ApplyPatchCallState | undefined;
          if (identity.applyPatch) {
            patchCall = new ApplyPatchCallState({ itemID: `ctc_${callID}`, callID, name, namespace, outputIndex: idx });
            const [, input, errFinishRaw] = patchCall.finishArguments(argsJSON);
            let errFinish = errFinishRaw;
            if (!chunkValid) errFinish = new Error("invalid Gemini apply_patch response JSON");
            if (errFinish) {
              failPatch(errFinish);
              break;
            }
            inputStr = input;
            evidence.patchCall = patchCall;
          }
          st.funcInputBuf.set(idx, inputStr);
          out.push(
            emitEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: idx,
              item: functionItem("custom_tool_call", `ctc_${callID}`, "in_progress", "", callID, name, namespace),
            }),
          );
          // Gemini delivers complete arguments; this delta is not an early preview.
          if (patchCall && inputStr !== "") out.push(emitEvent("response.custom_tool_call_input.delta", applyPatchInputDelta(patchCall, inputStr, nextSeq())));
          if (!st.funcDone.get(idx)) {
            let inputDone: string = JSON.stringify({ type: "response.custom_tool_call_input.done", sequence_number: nextSeq(), item_id: `ctc_${callID}`, output_index: idx, input: inputStr });
            if (patchCall) inputDone = applyPatchInputDone(patchCall, inputStr, st.seq);
            out.push(emitEvent("response.custom_tool_call_input.done", inputDone));
            out.push(
              emitEvent("response.output_item.done", {
                type: "response.output_item.done",
                sequence_number: nextSeq(),
                output_index: idx,
                item: functionItem("custom_tool_call", `ctc_${callID}`, "completed", inputStr, callID, name, namespace),
              }),
            );
            st.funcDone.set(idx, true);
          }
        } else {
          out.push(
            emitEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: idx,
              item: functionItem("function_call", `fc_${callID}`, "in_progress", "", callID, name, namespace),
            }),
          );
          // When Gemini omits args, emit "{}" to keep Responses streaming event order consistent.
          if (argsJSON !== "") {
            out.push(
              emitEvent("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                sequence_number: nextSeq(),
                item_id: `fc_${callID}`,
                output_index: idx,
                delta: argsJSON,
              }),
            );
          }
          if (!st.funcDone.get(idx)) {
            out.push(
              emitEvent("response.function_call_arguments.done", {
                type: "response.function_call_arguments.done",
                sequence_number: nextSeq(),
                item_id: `fc_${callID}`,
                output_index: idx,
                arguments: argsJSON,
              }),
            );
            out.push(
              emitEvent("response.output_item.done", {
                type: "response.output_item.done",
                sequence_number: nextSeq(),
                output_index: idx,
                item: functionItem("function_call", `fc_${callID}`, "completed", argsJSON, callID, name, namespace),
              }),
            );
            st.funcDone.set(idx, true);
          }
        }
        continue;
      }
    }
  }

  if (st.completed) return out;

  // Preserve the first source finish, including across a usage-only tail or [DONE].
  const fr = str(root, "candidates.0.finishReason");
  if (fr !== "" && st.finishReason === "") st.finishReason = fr;
  if (st.finishReason !== "" && !st.activeStreamingFunc && !st.hasFailedStreamingFunc) {
    const errIdentity = geminiPendingIdentityError(st);
    if (errIdentity) {
      failPatch(errIdentity);
      return out;
    }
    if (!done && !hasUsage) return out;
    const { eventType, status, incompleteDetails } = geminiResponsesTerminalState(st.finishReason);
    messageStatus = status;
    if (st.pendingReasoningSignature !== "") {
      emitTrailingDetachedReasoning(st.pendingReasoningSignature);
      st.pendingReasoningSignature = "";
    }
    // Finalize web search, then reasoning, then the message so web_search_call precedes later items.
    finalizeWebSearch();
    finalizeReasoning();
    finalizeMessage();

    const idxs = [...st.funcArgsBuf.keys()].sort((a, b) => a - b);
    for (const idx of idxs) {
      if (st.funcDone.get(idx)) continue;
      const callID = st.funcCallIDs.get(idx) ?? "";
      const argsBuf = st.funcArgsBuf.get(idx) ?? "";
      const args = argsBuf.length > 0 ? argsBuf : "{}";
      if (st.funcToolSearch.get(idx)) {
        out.push(
          emitEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: nextSeq(),
            output_index: idx,
            item: buildOpenAIResponsesToolSearchCallItem(openAIResponsesToolSearchCallItemID(callID), callID, status, args),
          }),
        );
      } else if (st.funcCustom.get(idx)) {
        const inputStr = st.funcInputBuf.get(idx) ?? "";
        out.push(
          emitEvent("response.custom_tool_call_input.done", {
            type: "response.custom_tool_call_input.done",
            sequence_number: nextSeq(),
            item_id: `ctc_${callID}`,
            output_index: idx,
            input: inputStr,
          }),
        );
        out.push(
          emitEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: nextSeq(),
            output_index: idx,
            item: functionItem("custom_tool_call", `ctc_${callID}`, "completed", inputStr, callID, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? ""),
          }),
        );
      } else {
        out.push(
          emitEvent("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            sequence_number: nextSeq(),
            item_id: `fc_${callID}`,
            output_index: idx,
            arguments: args,
          }),
        );
        out.push(
          emitEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: nextSeq(),
            output_index: idx,
            item: functionItem("function_call", `fc_${callID}`, "completed", args, callID, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? ""),
          }),
        );
      }
      st.funcDone.set(idx, true);
    }

    const response: Obj = { id: "", object: "response", created_at: 0, status: "completed", background: false, error: null };
    const completed: Obj = { type: eventType, sequence_number: 0, response };
    response.status = status;
    if (incompleteDetails) response.incomplete_details = incompleteDetails;
    completed.sequence_number = nextSeq();
    response.id = st.responseID;
    response.created_at = st.createdAt;
    if (reqJSON) echoRequestFields(response, unwrapRequestRoot(parse(reqJSON)));

    emitLateCitations();

    const outputs: Obj[] = [];
    for (let idx = 0; idx < st.nextIndex; idx++) {
      if (st.webSearchDone && idx === st.webSearchIndex) {
        outputs.push(buildResponsesWebSearchCallItem(st.webSearchItemID, st.webSearchQuery, st.webSearchQueries, st.webSearchSources));
        continue;
      }
      const completedReasoning = st.completedReasoning.get(idx);
      if (completedReasoning) {
        outputs.push({ id: completedReasoning.id, type: "reasoning", encrypted_content: completedReasoning.signature, summary: [{ type: "summary_text", text: completedReasoning.text }] });
        continue;
      }
      const completedMessage = st.completedMessages.get(idx);
      if (completedMessage) {
        outputs.push({
          id: completedMessage.id,
          type: "message",
          status: completedMessage.status,
          content: [{ type: "output_text", annotations: completedMessage.annotations.length > 0 ? completedMessage.annotations : [], logprobs: [], text: completedMessage.text }],
          role: "assistant",
        });
        continue;
      }
      const detached = st.detachedReasoning.get(idx);
      if (detached) {
        outputs.push({ id: detached.id, type: "reasoning", encrypted_content: detached.signature, summary: [] });
        continue;
      }
      const callID = st.funcCallIDs.get(idx) ?? "";
      if (callID !== "") {
        const argsBuf = st.funcArgsBuf.get(idx) ?? "";
        const args = argsBuf.length > 0 ? argsBuf : "{}";
        if (st.funcToolSearch.get(idx)) outputs.push(buildOpenAIResponsesToolSearchCallItem(openAIResponsesToolSearchCallItemID(callID), callID, status, args));
        else if (st.funcCustom.get(idx))
          outputs.push(functionItem("custom_tool_call", `ctc_${callID}`, "completed", st.funcInputBuf.get(idx) ?? "", callID, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? ""));
        else outputs.push(functionItem("function_call", `fc_${callID}`, "completed", args, callID, st.funcNames.get(idx) ?? "", st.funcNamespaces.get(idx) ?? ""));
      }
    }
    if (outputs.length > 0) response.output = outputs;
    if (st.webSearchDone) response.tool_usage = { web_search: { num_requests: 1 } };
    if (st.usage.present) response.usage = st.usage.json();
    out.push(emitEvent(eventType, completed));
    st.completed = true;
  }
  return out;
}

function identityFor(name: string): ResponsesToolIdentity {
  return { name, namespace: "", custom: false, applyPatch: false, toolSearch: false };
}

/** gjson fc.Get("args").Raw. */
function rawOfArgs(fc: unknown): string {
  return gjsonRaw(getAt(fc, "args"));
}

interface NonStreamReasoningOutput {
  text: string;
  signature: string;
  direction: string;
  targetKind: string;
}

/** Aggregates a Gemini response JSON into a single OpenAI Responses JSON object. */
export function convertGeminiResponseToOpenAIResponsesNonStream(
  _ctx: TranslateContext,
  _modelName: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  param: TranslatorState | undefined,
): string {
  const parsedRaw = parseGJSON(rawJSON);
  const rawValid = parsedRaw.valid;
  const root = unwrapGeminiResponseRoot(parsedRaw.value);
  const reqJSON = pickRequestJSON(originalRequestRawJSON, requestRawJSON);
  const sanitizedNameMap = sanitizedToolNameMap(originalRequestRawJSON);
  const toolIdentityMap = responsesToolReverseIdentityMap(reqJSON);

  const resp: Obj = { id: "", object: "response", created_at: 0, status: "completed", background: false, error: null, incomplete_details: null };
  const { status, incompleteDetails } = geminiResponsesTerminalState(str(root, "candidates.0.finishReason"));
  resp.status = status;
  if (incompleteDetails) resp.incomplete_details = incompleteDetails;

  let id = str(root, "responseId");
  if (id === "") id = nextResponseID();
  if (!id.startsWith("resp_")) id = `resp_${id}`;
  resp.id = id;
  const bareID = id.slice(5);

  let createdAt = Math.floor(Date.now() / 1000);
  if (has(root, "createTime")) {
    const t = parseCreateTime(getAt(root, "createTime"));
    if (t !== 0) createdAt = t;
  }
  resp.created_at = createdAt;

  if (reqJSON) echoRequestFields(resp, unwrapRequestRoot(parse(reqJSON)), () => getAt(root, "modelVersion"));
  else if (has(root, "modelVersion")) resp.model = str(root, "modelVersion");

  let reasoningText = "";
  let reasoningEncrypted = "";
  let reasoningDirection = "";
  let reasoningTargetKind = "";
  const reasoningOutputs: NonStreamReasoningOutput[] = [];
  const functionOutputs: { item: Obj; signature: string }[] = [];
  const messageOutputs: { text: string; signatures: string[] }[] = [];
  const outputOrder: { kind: string; index: number }[] = [];
  const reasoningOutputSignatures = new Set<string>();
  const flushReasoningOutput = (): void => {
    if (reasoningText.length === 0 && reasoningEncrypted === "") return;
    outputOrder.push({ kind: "reasoning", index: reasoningOutputs.length });
    reasoningOutputs.push({ text: reasoningText, signature: reasoningEncrypted, direction: reasoningDirection, targetKind: reasoningTargetKind });
    if (reasoningEncrypted !== "") reasoningOutputSignatures.add(reasoningEncrypted);
    reasoningText = "";
    reasoningEncrypted = "";
    reasoningDirection = "";
    reasoningTargetKind = "";
  };
  const detachedReasoningOutputs: { signature: string; direction: string; targetKind: string }[] = [];
  let currentMessageText = "";
  let currentMessageSignatures: string[] = [];
  const partMappings: GeminiPartMapping[] = [];
  let currentMsgRuneOffset = 0;
  const flushMessageOutput = (): void => {
    if (currentMessageText.length === 0) return;
    outputOrder.push({ kind: "message", index: messageOutputs.length });
    messageOutputs.push({ text: currentMessageText, signatures: [...currentMessageSignatures] });
    currentMessageText = "";
    currentMessageSignatures = [];
    currentMsgRuneOffset = 0;
  };
  const addDetached = (signature: string, direction: string, targetKind: string): void => {
    outputOrder.push({ kind: "detached", index: detachedReasoningOutputs.length });
    detachedReasoningOutputs.push({ signature, direction, targetKind });
  };

  let toolInputError: Error | undefined;
  const evidenceState = new GeminiToResponsesState();
  evidenceState.toolIdentityMap = toolIdentityMap;
  const outputs: Obj[] = [];
  let detachedOutputIndex = 0;
  const seenDetachedOutputs = new Set<string>();
  const appendDetachedOutput = (signature: string, direction: string, targetKind: string): void => {
    if (signature === "" || seenDetachedOutputs.has(signature)) return;
    seenDetachedOutputs.add(signature);
    const placement = direction === geminiResponsesCarrierPrevious ? "after" : "before";
    outputs.push({
      id: `rs_${bareID}_detached_${placement}_${detachedOutputIndex}`,
      type: "reasoning",
      encrypted_content: encodeGeminiResponsesCarrier(signature, direction, targetKind),
      summary: [],
    });
    detachedOutputIndex++;
  };

  const parts = getAt(root, "candidates.0.content.parts");
  if (isArr(parts)) {
    for (let key = 0; key < parts.length; key++) {
      const p = parts[key];
      let partIdx = key;
      if (has(p, "partIndex")) partIdx = gint(getAt(p, "partIndex"));
      else if (has(p, "index")) partIdx = gint(getAt(p, "index"));
      let signature = str(p, "thoughtSignature").trim();
      if (signature === "") signature = str(p, "thought_signature").trim();
      if (gbool(getAt(p, "thought"))) {
        flushMessageOutput();
        currentMsgRuneOffset = 0;
        if (signature !== "" && reasoningEncrypted !== "" && signature !== reasoningEncrypted) flushReasoningOutput();
        if (has(p, "text")) reasoningText += str(p, "text");
        if (signature !== "") {
          reasoningEncrypted = signature;
          reasoningDirection = geminiResponsesCarrierStandalone;
          reasoningTargetKind = geminiResponsesCarrierText;
        }
        continue;
      }
      const t = str(p, "text");
      if (has(p, "text") && t !== "") {
        let messageSignature = "";
        if (signature !== "") {
          if (reasoningText.length > 0 && reasoningEncrypted === "") {
            reasoningEncrypted = signature;
            reasoningDirection = geminiResponsesCarrierNext;
            reasoningTargetKind = geminiResponsesCarrierText;
          } else {
            messageSignature = signature;
          }
        }
        flushReasoningOutput();
        const lastSig = currentMessageSignatures[currentMessageSignatures.length - 1];
        if (currentMessageSignatures.length > 0 && (messageSignature === "" || lastSig !== messageSignature)) {
          flushMessageOutput();
          currentMsgRuneOffset = 0;
        }
        partMappings.push({ partIndex: partIdx, messageIndex: messageOutputs.length, startRuneInMsg: currentMsgRuneOffset, partText: t });
        currentMsgRuneOffset += runeCount(t);
        currentMessageText += t;
        if (messageSignature !== "" && (currentMessageSignatures.length === 0 || currentMessageSignatures[currentMessageSignatures.length - 1] !== messageSignature)) {
          currentMessageSignatures.push(messageSignature);
        }
        continue;
      }
      const fc = getAt(p, "functionCall");
      if (fc !== undefined) {
        if (reasoningText.length > 0 && reasoningEncrypted === "" && signature !== "") {
          reasoningEncrypted = signature;
          reasoningDirection = geminiResponsesCarrierNext;
          reasoningTargetKind = geminiResponsesCarrierFunction;
          signature = "";
        }
        flushReasoningOutput();
        flushMessageOutput();
        currentMsgRuneOffset = 0;

        let explicitIndex = -1;
        if (has(p, "partIndex")) explicitIndex = gint(getAt(p, "partIndex"));
        else if (has(p, "index")) explicitIndex = gint(getAt(p, "index"));
        const evidence = geminiRecordFunctionEvidence(evidenceState, fc, explicitIndex, rawValid);
        if (evidence.applyPatch && evidence.err) {
          toolInputError = evidence.err;
          break;
        }
        if (evidence.rawName === "") continue;
        const rawName = evidence.applyPatch ? evidence.rawName : str(fc, "name");
        const identity = toolIdentityMap?.get(rawName) ?? identityFor(restoreSanitizedToolName(sanitizedNameMap, rawName));
        const { name, namespace, custom: isCustom } = identity;
        if (identity.applyPatch && evidence.patchCall) {
          const [, , errFinish] = evidence.patchCall.finishArguments(rawOfArgs(fc));
          if (errFinish) {
            toolInputError = errFinish;
            break;
          }
          continue;
        }
        const argsStr = rawOfArgs(fc);
        let callID = newCallIDHex();
        if ((identity.applyPatch || identity.toolSearch) && evidence.upstreamID !== "") callID = evidence.upstreamID;
        let itemJSON: Obj;
        if (identity.toolSearch) {
          itemJSON = buildOpenAIResponsesToolSearchCallItem(openAIResponsesToolSearchCallItemID(callID), callID, status, argsStr);
        } else if (isCustom) {
          let inputStr = unwrapResponsesCustomToolInput(argsStr);
          if (identity.applyPatch) {
            const patchCall = new ApplyPatchCallState();
            const [, input, errFinishRaw] = patchCall.finishArguments(argsStr);
            let errFinish = errFinishRaw;
            if (!rawValid) errFinish = new Error("invalid Gemini apply_patch response JSON");
            if (errFinish) {
              toolInputError = errFinish;
              break;
            }
            inputStr = input;
            evidence.patchCall = patchCall;
          }
          itemJSON = setResponsesToolCallIdentity({ id: `ctc_${callID}`, type: "custom_tool_call", status: "completed", input: inputStr, call_id: callID, name: "" }, name, namespace, "");
        } else {
          itemJSON = setResponsesToolCallIdentity({ id: `fc_${callID}`, type: "function_call", status: "completed", arguments: argsStr, call_id: callID, name: "" }, name, namespace, "");
        }
        outputOrder.push({ kind: "function", index: functionOutputs.length });
        functionOutputs.push({ item: itemJSON, signature });
        continue;
      }
      if (signature !== "") {
        if (reasoningText.length > 0) {
          if (reasoningEncrypted === "") {
            reasoningEncrypted = signature;
            reasoningDirection = geminiResponsesCarrierStandalone;
            reasoningTargetKind = geminiResponsesCarrierText;
          } else if (reasoningEncrypted !== signature) {
            flushReasoningOutput();
            addDetached(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierText);
          }
        } else if (currentMessageText.length > 0) {
          if (currentMessageSignatures.length === 0) currentMessageSignatures.push(signature);
          else if (currentMessageSignatures[currentMessageSignatures.length - 1] !== signature) {
            flushMessageOutput();
            currentMsgRuneOffset = 0;
            addDetached(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierText);
          }
        } else if (functionOutputs.length > 0) {
          addDetached(signature, geminiResponsesCarrierPrevious, geminiResponsesCarrierFunction);
        } else {
          addDetached(signature, geminiResponsesCarrierNext, geminiResponsesCarrierAny);
        }
      }
    }
  }

  if (!toolInputError) toolInputError = geminiPendingIdentityError(evidenceState);
  if (toolInputError) {
    if (param) {
      const state = new ApplyPatchErrorState();
      state.setToolInputError(toolInputError);
      param.value = state;
    }
    return "";
  }
  const activeMessageIndex = currentMessageText.length > 0 ? messageOutputs.length : -1;
  flushReasoningOutput();
  flushMessageOutput();

  const groundingMetadata = extractGroundingMetadata(root);
  const hasGrounding = hasValidWebGrounding(groundingMetadata);
  let wsItem: Obj | undefined;
  let messageCitations: Map<number, Obj[]> | undefined;
  if (hasGrounding) {
    const queries = extractGroundingQueries(groundingMetadata);
    let query = queries[0] ?? "";
    if (query === "" && reqJSON) query = extractResponsesWebSearchQuery(unwrapRequestRoot(parse(reqJSON)));
    const sources = extractGroundingSources(groundingMetadata);
    wsItem = buildResponsesWebSearchCallItem(`ws_${bareID}`, query, queries, sources);
    messageCitations = buildResponsesURLCitationsForMessages(
      groundingMetadata,
      partMappings,
      messageOutputs.map((mo) => mo.text),
    );
  }

  let wsAppended = false;
  for (const outputItem of outputOrder) {
    switch (outputItem.kind) {
      case "detached": {
        const detached = detachedReasoningOutputs[outputItem.index];
        if (!detached) continue;
        if (!reasoningOutputSignatures.has(detached.signature)) appendDetachedOutput(detached.signature, detached.direction, detached.targetKind);
        break;
      }
      case "reasoning": {
        const reasoningOutput = reasoningOutputs[outputItem.index];
        if (!reasoningOutput) continue;
        const reasoningID = reasoningOutputs.length > 1 ? `rs_${bareID}_${outputItem.index}` : `rs_${bareID}`;
        let encryptedContent = reasoningOutput.signature;
        if (encryptedContent !== "" && reasoningOutput.direction !== "") encryptedContent = encodeGeminiResponsesCarrier(encryptedContent, reasoningOutput.direction, reasoningOutput.targetKind);
        const itemJSON: Obj = { id: reasoningID, type: "reasoning", encrypted_content: encryptedContent };
        if (reasoningOutput.text !== "") itemJSON.summary = [{ type: "summary_text", text: reasoningOutput.text }];
        outputs.push(itemJSON);
        break;
      }
      case "message": {
        if (hasGrounding && !wsAppended) {
          outputs.push(wsItem!);
          wsAppended = true;
        }
        const messageOutput = messageOutputs[outputItem.index];
        if (!messageOutput) continue;
        for (const signature of messageOutput.signatures) {
          if (!reasoningOutputSignatures.has(signature)) appendDetachedOutput(signature, geminiResponsesCarrierNext, geminiResponsesCarrierText);
        }
        const itemJSON: Obj = {
          id: `msg_${bareID}_${outputItem.index}`,
          type: "message",
          status: "completed",
          content: [{ type: "output_text", annotations: [], logprobs: [], text: messageOutput.text }],
          role: "assistant",
        };
        if (outputItem.index === activeMessageIndex) itemJSON.status = status;
        const c = messageCitations?.get(outputItem.index) ?? [];
        if (c.length > 0) ((itemJSON.content as Obj[])[0] as Obj).annotations = c;
        outputs.push(itemJSON);
        break;
      }
      case "function": {
        const functionOutput = functionOutputs[outputItem.index];
        if (!functionOutput) continue;
        appendDetachedOutput(functionOutput.signature, geminiResponsesCarrierNext, geminiResponsesCarrierFunction);
        outputs.push(functionOutput.item);
        break;
      }
    }
  }
  if (hasGrounding && !wsAppended) {
    outputs.push(wsItem!);
    wsAppended = true;
  }
  if (outputs.length > 0) resp.output = outputs;
  if (hasGrounding) resp.tool_usage = { web_search: { num_requests: 1 } };
  const usage = new GeminiResponsesUsage();
  if (usage.merge(root)) resp.usage = usage.json();
  return JSON.stringify(resp);
}

function newCallIDHex(): string {
  funcCallIDCounter++;
  return `call_${unixNano().toString(16)}_${funcCallIDCounter}`;
}

/**
 * Full snapshots are evidence, never source prefixes. Stable IDs and explicit part
 * indexes identify repeated snapshots without merging distinct unkeyed calls.
 */
function geminiRecordFunctionEvidence(st: GeminiToResponsesState, fc: unknown, partIndex: number, validJSONChunk: boolean): FunctionCallEvidence {
  const keys: string[] = [];
  if (partIndex >= 0) keys.push(`part:${partIndex}`);
  const fcID = str(fc, "id");
  const fcName = str(fc, "name");
  if (fcID !== "") keys.push("id:" + fcID);
  // Never guess which later named call owns an unkeyed nameless snapshot.
  if (keys.length === 0 && fcName === "") keys.push(`unknown:${st.functionEvidence.size}`);
  let evidence: FunctionCallEvidence | undefined;
  let conflict = false;
  let patchRelated = !!st.toolIdentityMap?.get(fcName)?.applyPatch;
  for (const key of keys) {
    const prior = st.functionEvidence.get(key);
    if (!prior) continue;
    patchRelated = patchRelated || prior.applyPatch;
    if (!evidence) evidence = prior;
    else if (evidence !== prior) conflict = true;
  }
  if (conflict) {
    const errIdentity = new Error("conflicting apply_patch call indexes");
    // Reject before rebinding either established call's aliases or provenance.
    if (patchRelated) return newEvidence({ applyPatch: true, err: errIdentity });
    evidence!.err = errIdentity;
  }
  if (!evidence) evidence = newEvidence();
  const ev = evidence;
  const recordError = (err: Error): void => {
    if (!ev.err) ev.err = err;
  };
  if (partIndex >= 0) {
    if (ev.hasPartIndex && ev.partIndex !== partIndex) recordError(new Error("conflicting apply_patch part index"));
    else {
      ev.partIndex = partIndex;
      ev.hasPartIndex = true;
    }
  }
  if (st.toolIdentityMap?.get(fcName)?.applyPatch) ev.applyPatch = true;
  for (const key of keys) st.functionEvidence.set(key, ev);
  if (fcName !== "") {
    if (ev.rawName !== "" && ev.rawName !== fcName) recordError(new Error("conflicting apply_patch call name"));
    else ev.rawName = fcName;
  }
  if (fcID !== "") {
    if (ev.upstreamID !== "" && ev.upstreamID !== fcID) recordError(new Error("conflicting apply_patch call ID"));
    else ev.upstreamID = fcID;
  }
  const snapshot = new ApplyPatchCallState();
  const [, input, errFinish] = snapshot.finishArguments(rawOfArgs(fc));
  if (!validJSONChunk) recordError(new Error("invalid Gemini apply_patch response JSON"));
  if (errFinish) recordError(errFinish);
  else {
    if (ev.hasInput && ev.input !== input) recordError(new Error("conflicting apply_patch complete snapshots"));
    ev.hasInput = true;
    ev.input = input;
  }
  return ev;
}

function geminiPendingIdentityError(st: GeminiToResponsesState): Error | undefined {
  if (!patchEnabled(st.toolIdentityMap)) return undefined;
  for (const evidence of st.functionEvidence.values()) {
    if (evidence.rawName === "") return evidence.err ?? new Error("unresolved Gemini apply_patch call identity");
  }
  return undefined;
}



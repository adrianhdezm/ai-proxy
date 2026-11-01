// Port of internal/translator/codex/claude/codex_claude_response.go.
//
// Codex Responses API stream/non-stream -> Claude Messages. The stream translator
// receives one upstream SSE line at a time (a string starting with "data:"
// followed by the JSON event; anything else is ignored) and returns zero or more
// complete Claude SSE frames ("event: <type>\ndata: <json>\n\n"). Per-stream
// state lives in TranslatorState.value as a ConvertCodexResponseToClaudeParams.
import { codexCommentarySignatureMarker } from "../../../signature/index.ts";
import { appendSSEEventString, claudeInputTokensJSON } from "../../common/index.ts";
import { type TranslateContext, type TranslatorState, emptyContext } from "../../types.ts";
import { getAt, gint, gstr, isObj } from "../../../util/gpath.ts";
import { sanitizeClaudeToolID } from "../../../util/claude_tool_id.ts";
import { tryParse } from "../../../util/json.ts";
import { buildReverseMapFromClaudeOriginalShortToOriginal, shortenCodexCallIDIfNeeded } from "./request.ts";
import { appendCodexWebSearchNonStreamBlocks, appendCodexWebSearchToolResult } from "./web_search.ts";

type JSONObject = Record<string, unknown>;

const dataTag = "data:";

/** Joins consecutive reasoning summary parts inside the single thinking block that represents one Codex reasoning item. */
export const codexThinkingSummaryPartSeparator = "\n\n";

/** Re-export of the shared CLIProxyAPI-internal commentary marker carried in a relayed commentary thinking block. */
export { codexCommentarySignatureMarker };

/** One function call tracked across a Codex stream. */
export class CodexFunctionCallStream {
  callID = "";
  name = "";
  blockIndex = -1;
  arguments = "";
  emittedArgumentsLength = 0;
  hasReceivedArgumentsDelta = false;
  emitInitialEmptyDelta = false;
  started = false;
  done = false;
  closed = false;
}

/** Per-stream state for convertCodexResponseToClaude (Go: ConvertCodexResponseToClaudeParams). */
export class ConvertCodexResponseToClaudeParams {
  /**
   * Maps shortened upstream tool names back to the client-declared names. It is
   * resolved once per stream on first tool use; callers pass the same request
   * bytes for the stream's lifetime.
   */
  shortToOriginalToolNames = new Map<string, string>();
  toolNamesResolved = false;
  hasEmittedToolUse = false;
  blockIndex = 0;
  hasTextDelta = false;
  textBlockOpen = false;
  /**
   * Set while the current `message` output item carries phase "commentary": a
   * preamble GPT-5.x emits before its final_answer item. Its text goes into a
   * thinking block, so clients that render or speak text blocks get the answer
   * once instead of the preamble followed by the answer.
   */
  commentaryMessageOpen = false;
  thinkingBlockOpen = false;
  thinkingSignature = "";
  thinkingSummarySeen = false;
  webSearchToolUseIDs = new Set<string>();
  webSearchToolResultIDs = new Set<string>();
  lastWebSearchToolUseID = "";
  functionCalls = new Map<string, CodexFunctionCallStream>();
  functionCallQueue: CodexFunctionCallStream[] = [];
  activeFunctionCall: CodexFunctionCallStream | undefined = undefined;
  lastFunctionCall: CodexFunctionCallStream | undefined = undefined;
  deferredStreamEvents: string[] = [];

  /** Restores the client-declared tool name using the reverse map cached on first use for this stream. */
  resolveToolUseName(originalRequestRawJSON: string, name: string): string {
    if (!this.toolNamesResolved) {
      this.shortToOriginalToolNames = buildReverseMapFromClaudeOriginalShortToOriginal(originalRequestRawJSON);
      this.toolNamesResolved = true;
    }
    const orig = this.shortToOriginalToolNames.get(name);
    return orig !== undefined ? orig : name;
  }
}

function paramsFor(state: TranslatorState): ConvertCodexResponseToClaudeParams {
  const existing = state.value;
  if (existing instanceof ConvertCodexResponseToClaudeParams) return existing;
  const params = new ConvertCodexResponseToClaudeParams();
  state.value = params;
  return params;
}

function sse(output: string, event: string, payload: unknown): string {
  return appendSSEEventString(output, event, JSON.stringify(payload), 2);
}

/**
 * Streaming Codex -> Claude conversion. A state machine that turns one Codex SSE
 * line into zero or more Claude SSE frames, keeping block indexes, thinking
 * signatures, commentary phases and (parallel) function calls consistent across calls.
 */
export function convertCodexResponseToClaude(
  _ctx: TranslateContext,
  _model: string,
  originalRequestRawJSON: string,
  _requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
): string[] {
  const params = paramsFor(state);

  if (!rawJSON.startsWith(dataTag)) return [];
  const streamEventRawJSON = rawJSON;
  const payload = rawJSON.slice(dataTag.length).trim();

  let output = "";
  const rootResult = tryParse<unknown>(payload);

  const typeStr = gstr(getAt(rootResult, "type"));
  if (params.activeFunctionCall !== undefined && shouldDeferCodexStreamEvent(typeStr, rootResult)) {
    params.deferredStreamEvents.push(streamEventRawJSON);
    return [];
  }

  let early = false;
  let resetMessageState = false;

  switch (typeStr) {
    case "error":
      output += codexStreamErrorToClaudeError(rootResult);
      break;
    case "response.created": {
      const template = {
        type: "message_start",
        message: {
          id: gstr(getAt(rootResult, "response.id")),
          type: "message",
          role: "assistant",
          model: gstr(getAt(rootResult, "response.model")),
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [],
          stop_reason: null,
        },
      };
      output = sse(output, "message_start", template);
      break;
    }
    case "response.reasoning_summary_part.added":
      output += stopCodexTextBlock(params);
      output += finalizeCodexCommentaryBlock(params);
      params.commentaryMessageOpen = false;
      // Codex splits a single reasoning item into several summary parts, but only
      // output_item.done carries that item's final encrypted_content. Keep one
      // thinking block open for the whole item and separate the parts with a blank
      // line, so the only signature ever emitted is the final one.
      if (params.thinkingBlockOpen) output += appendCodexThinkingDelta(params, codexThinkingSummaryPartSeparator);
      else output += startCodexThinkingBlock(params);
      params.thinkingSummarySeen = true;
      break;
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      output += stopCodexTextBlock(params);
      output += finalizeCodexCommentaryBlock(params);
      params.commentaryMessageOpen = false;
      output += startCodexThinkingBlock(params);
      output += appendCodexThinkingDelta(params, gstr(getAt(rootResult, "delta")));
      params.thinkingSummarySeen = true;
      break;
    case "response.reasoning_summary_part.done":
      // Intentionally does not close the thinking block: it stays open until
      // output_item.done delivers the reasoning item's final encrypted_content.
      break;
    case "response.content_part.added":
      if (gstr(getAt(rootResult, "part.type")) === "output_text") {
        if (params.commentaryMessageOpen) {
          output += startCodexThinkingBlock(params);
        } else {
          output += finalizeCodexThinkingBlock(params);
          output += startCodexTextBlock(params);
        }
      } else {
        output += finalizeCodexThinkingBlock(params);
      }
      break;
    case "response.output_text.delta": {
      params.hasTextDelta = true;
      if (params.commentaryMessageOpen) {
        output += startCodexThinkingBlock(params);
        output += appendCodexThinkingDelta(params, gstr(getAt(rootResult, "delta")));
        break;
      }
      output += finalizeCodexThinkingBlock(params);
      output += startCodexTextBlock(params);
      const template = {
        type: "content_block_delta",
        index: params.blockIndex,
        delta: { type: "text_delta", text: gstr(getAt(rootResult, "delta")) },
      };
      output = sse(output, "content_block_delta", template);
      break;
    }
    case "response.content_part.done":
      if (gstr(getAt(rootResult, "part.type")) === "output_text") {
        if (params.commentaryMessageOpen) output += finalizeCodexCommentaryBlock(params);
        else output += stopCodexTextBlock(params);
      }
      break;
    case "response.web_search_call.searching":
    case "response.web_search_call.completed":
    case "response.web_search_call.in_progress":
      // Wait for populated web_search_call items on output_item.done.
      break;
    case "response.completed":
    case "response.incomplete": {
      const responseData = getAt(rootResult, "response");
      output += finalizeCodexThinkingBlock(params);
      output += stopCodexTextBlock(params);
      output = appendCodexFunctionCallsFromTerminal(output, params, originalRequestRawJSON, responseData);
      output = appendDeferredCodexStreamEvents(output, originalRequestRawJSON, state);
      output += finalizeCodexThinkingBlock(params);
      output += stopCodexTextBlock(params);
      const usage = getAt(responseData, "usage");
      const [inputTokens, outputTokens, cachedTokens, cacheWriteTokens] = extractResponsesUsage(usage);
      const usageOut: JSONObject = { input_tokens: inputTokens, output_tokens: outputTokens };
      if (cachedTokens > 0) usageOut.cache_read_input_tokens = cachedTokens;
      if (cacheWriteTokens > 0) usageOut.cache_creation_input_tokens = cacheWriteTokens;
      const delta: JSONObject = {
        stop_reason: mapCodexStopReasonToClaude(codexStopReason(responseData), params.hasEmittedToolUse),
        stop_sequence: null,
      };
      setClaudeStopSequence(delta, "stop_sequence", responseData);
      const template: JSONObject = { type: "message_delta", delta, usage: usageOut };
      setClaudeReasoningUsage(template, usage);
      output = sse(output, "message_delta", template);
      output = sse(output, "message_stop", { type: "message_stop" });
      break;
    }
    case "response.output_item.added": {
      const itemResult = getAt(rootResult, "item");
      switch (gstr(getAt(itemResult, "type"))) {
        case "message":
          // Each message item streams its own text; a later item's done fallback
          // must not be skipped because an earlier item had deltas.
          output += finalizeCodexThinkingBlock(params);
          output += stopCodexTextBlock(params);
          params.hasTextDelta = false;
          params.commentaryMessageOpen = gstr(getAt(itemResult, "phase")) === "commentary";
          break;
        case "function_call": {
          output += finalizeCodexThinkingBlock(params);
          output += stopCodexTextBlock(params);
          params.commentaryMessageOpen = false;

          const call = recordCodexFunctionCall(params, rootResult, itemResult);
          updateCodexFunctionCallIdentity(params, call, rootResult, itemResult);
          if (call.name !== "") call.emitInitialEmptyDelta = true;
          output = appendCodexFunctionCallQueue(output, params, originalRequestRawJSON);
          break;
        }
        case "reasoning":
          output += stopCodexTextBlock(params);
          // A previous reasoning item that never reported output_item.done must not
          // leak its still-open block into this one.
          output += finalizeCodexThinkingBlock(params);
          params.commentaryMessageOpen = false;
          params.thinkingSummarySeen = false;
          // Kept only as a fallback for streams whose output_item.done omits
          // encrypted_content; it is a pre-content snapshot, never the final value.
          params.thinkingSignature = gstr(getAt(itemResult, "encrypted_content"));
          break;
        case "web_search_call":
          // Defer server_tool_use until output_item.done carries action/query.
          break;
      }
      break;
    }
    case "response.output_item.done": {
      const itemResult = getAt(rootResult, "item");
      switch (gstr(getAt(itemResult, "type"))) {
        case "message": {
          resetMessageState = true;
          const result = handleCodexMessageItemDone(output, params, itemResult);
          output = result.output;
          early = result.early;
          break;
        }
        case "function_call": {
          output += finalizeCodexThinkingBlock(params);
          output += stopCodexTextBlock(params);
          let call = codexFunctionCallForEvent(params, rootResult, itemResult);
          if (call === undefined) call = recordCodexFunctionCall(params, rootResult, itemResult);
          updateCodexFunctionCallIdentity(params, call, rootResult, itemResult);
          updateCodexFunctionCallArguments(call, gstr(getAt(itemResult, "arguments")), false);
          call.done = true;
          output = appendCodexFunctionCallQueue(output, params, originalRequestRawJSON);
          break;
        }
        case "reasoning": {
          output += stopCodexTextBlock(params);
          output += finalizeCodexCommentaryBlock(params);
          params.commentaryMessageOpen = false;
          const signature = gstr(getAt(itemResult, "encrypted_content"));
          if (signature !== "") params.thinkingSignature = signature;
          if (!params.thinkingSummarySeen) {
            const doneText = extractCodexReasoningItemText(itemResult);
            if (doneText !== "") {
              output += startCodexThinkingBlock(params);
              output += appendCodexThinkingDelta(params, doneText);
              params.thinkingSummarySeen = true;
            }
          }
          if (params.thinkingSummarySeen) output += finalizeCodexThinkingBlock(params);
          else output += finalizeCodexSignatureOnlyThinkingBlock(params);
          params.thinkingSignature = "";
          params.thinkingSummarySeen = false;
          break;
        }
        case "web_search_call":
          output = appendCodexWebSearchToolResult(output, params, rootResult, itemResult);
          break;
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      let call = codexFunctionCallForEvent(params, rootResult, undefined);
      if (call === undefined) call = recordCodexFunctionCall(params, rootResult, undefined);
      updateCodexFunctionCallArguments(call, gstr(getAt(rootResult, "delta")), true);
      output = appendCodexFunctionCallBufferedArguments(output, params, call);
      break;
    }
    case "response.function_call_arguments.done": {
      let call = codexFunctionCallForEvent(params, rootResult, undefined);
      if (call === undefined) call = recordCodexFunctionCall(params, rootResult, undefined);
      updateCodexFunctionCallArguments(call, gstr(getAt(rootResult, "arguments")), false);
      output = appendCodexFunctionCallBufferedArguments(output, params, call);
      break;
    }
  }

  if (!early && params.functionCallQueue.length === 0) {
    output = appendDeferredCodexStreamEvents(output, originalRequestRawJSON, state);
  }
  if (resetMessageState) {
    // Go: deferred reset of the message item flags after the done event is handled.
    params.commentaryMessageOpen = false;
    params.hasTextDelta = false;
  }
  return [output];
}

/** The "message" branch of response.output_item.done; `early` mirrors Go's direct returns that skip the deferred-event flush. */
function handleCodexMessageItemDone(output: string, params: ConvertCodexResponseToClaudeParams, itemResult: unknown): { output: string; early: boolean } {
  const commentary = params.commentaryMessageOpen || gstr(getAt(itemResult, "phase")) === "commentary";
  if (params.hasTextDelta) {
    if (commentary) output += finalizeCodexCommentaryBlock(params);
    return { output, early: true };
  }
  const contentResult = getAt(itemResult, "content");
  if (!Array.isArray(contentResult)) return { output, early: true };
  let text = "";
  for (const part of contentResult) {
    if (gstr(getAt(part, "type")) !== "output_text") continue;
    const txt = gstr(getAt(part, "text"));
    if (txt !== "") text += txt;
  }
  if (text === "") return { output, early: true };
  if (commentary) {
    // Whole on done, nothing streamed: emit it as thinking.
    output += finalizeCodexThinkingBlock(params);
    output += stopCodexTextBlock(params);
    params.commentaryMessageOpen = true;
    output += startCodexThinkingBlock(params);
    output += appendCodexThinkingDelta(params, text);
    output += finalizeCodexCommentaryBlock(params);
    return { output, early: true };
  }

  output += finalizeCodexThinkingBlock(params);
  output += startCodexTextBlock(params);
  const template = { type: "content_block_delta", index: params.blockIndex, delta: { type: "text_delta", text } };
  output = sse(output, "content_block_delta", template);
  output += stopCodexTextBlock(params);
  return { output, early: false };
}

export function shouldDeferCodexStreamEvent(typeStr: string, rootResult: unknown): boolean {
  switch (typeStr) {
    case "error":
    case "response.completed":
    case "response.incomplete":
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done":
      return false;
    case "response.output_item.added":
    case "response.output_item.done":
      return gstr(getAt(rootResult, "item.type")) !== "function_call";
    default:
      return true;
  }
}

function appendDeferredCodexStreamEvents(output: string, originalRequestRawJSON: string, state: TranslatorState): string {
  const params = state.value;
  if (!(params instanceof ConvertCodexResponseToClaudeParams)) return output;
  if (params.deferredStreamEvents.length === 0) return output;

  const events = params.deferredStreamEvents;
  params.deferredStreamEvents = [];
  for (const event of events) {
    const translated = convertCodexResponseToClaude(emptyContext, "", originalRequestRawJSON, "", event, state);
    for (const chunk of translated) output += chunk;
  }
  return output;
}

function codexStreamErrorToClaudeError(rootResult: unknown): string {
  const errorResult = getAt(rootResult, "error");
  let errType = gstr(getAt(errorResult, "type")).trim();
  if (errType === "") errType = gstr(getAt(rootResult, "error_type")).trim();
  if (errType === "") errType = "api_error";

  const code = gstr(getAt(errorResult, "code")).trim();
  let message = gstr(getAt(errorResult, "message")).trim();
  if (message === "") message = gstr(getAt(rootResult, "message")).trim();
  if (message === "") message = code;
  if (message === "") message = errType;

  if (code === "cyber_policy" || errType === "invalid_request") errType = "invalid_request_error";

  const out = { type: "error", error: { type: errType, message } };
  return sse("", "error", out);
}

/**
 * Converts a complete (non-streaming) Codex response.completed/incomplete event
 * into a single Claude Messages JSON response. Returns "" for any other event type.
 */
export function convertCodexResponseToClaudeNonStream(
  _ctx: TranslateContext,
  _model: string,
  originalRequestRawJSON: string,
  _requestRawJSON: string,
  rawJSON: string,
  _state: TranslatorState,
): string {
  const revNames = buildReverseMapFromClaudeOriginalShortToOriginal(originalRequestRawJSON);

  const rootResult = tryParse<unknown>(rawJSON);
  const typeStr = gstr(getAt(rootResult, "type"));
  if (typeStr !== "response.completed" && typeStr !== "response.incomplete") return "";

  const responseData = getAt(rootResult, "response");
  if (responseData === undefined) return "";

  const usage = getAt(responseData, "usage");
  const [inputTokens, outputTokens, cachedTokens, cacheWriteTokens] = extractResponsesUsage(usage);
  const usageOut: JSONObject = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (cachedTokens > 0) usageOut.cache_read_input_tokens = cachedTokens;
  if (cacheWriteTokens > 0) usageOut.cache_creation_input_tokens = cacheWriteTokens;
  const out: JSONObject = {
    id: gstr(getAt(responseData, "id")),
    type: "message",
    role: "assistant",
    model: gstr(getAt(responseData, "model")),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: usageOut,
  };
  setClaudeReasoningUsage(out, usage);

  let hasToolCall = false;
  const webSearchSeen = new Set<string>();
  let contentBlocks: unknown[] = [];

  const outputItems = getAt(responseData, "output");
  if (Array.isArray(outputItems)) {
    for (const item of outputItems) {
      switch (gstr(getAt(item, "type"))) {
        case "reasoning": {
          const thinkingText = extractCodexReasoningItemText(item);
          const signature = gstr(getAt(item, "encrypted_content"));
          if (thinkingText !== "" || signature !== "") {
            const block: JSONObject = { type: "thinking", thinking: thinkingText };
            if (signature !== "") block.signature = signature;
            contentBlocks.push(block);
          }
          break;
        }
        case "message": {
          // A "commentary" phase message is the model's preamble, not its answer:
          // relay it as thinking so text consumers see the final_answer alone.
          const blockType = gstr(getAt(item, "phase")) === "commentary" ? "thinking" : "text";
          const content = getAt(item, "content");
          if (content !== undefined) {
            if (Array.isArray(content)) {
              for (const part of content) {
                if (gstr(getAt(part, "type")) === "output_text") {
                  const text = gstr(getAt(part, "text"));
                  if (text !== "") contentBlocks.push(codexMessageTextBlock(blockType, text));
                }
              }
            } else {
              const text = gstr(content);
              if (text !== "") contentBlocks.push(codexMessageTextBlock(blockType, text));
            }
          }
          break;
        }
        case "web_search_call":
          contentBlocks = appendCodexWebSearchNonStreamBlocks(contentBlocks, item, webSearchSeen);
          break;
        case "function_call": {
          hasToolCall = true;
          let name = gstr(getAt(item, "name"));
          const original = revNames.get(name);
          if (original !== undefined) name = original;

          let input: unknown = {};
          const argsStr = gstr(getAt(item, "arguments"));
          if (argsStr !== "") {
            const argsJSON = tryParse<unknown>(argsStr);
            if (isObj(argsJSON)) input = argsJSON;
          }
          contentBlocks.push({
            type: "tool_use",
            id: shortenCodexCallIDIfNeeded(sanitizeClaudeToolID(gstr(getAt(item, "call_id")))),
            name,
            input,
          });
          break;
        }
      }
    }
  }

  if (contentBlocks.length > 0) out.content = contentBlocks;

  out.stop_reason = mapCodexStopReasonToClaude(codexStopReason(responseData), hasToolCall);
  setClaudeStopSequence(out, "stop_sequence", responseData);

  return JSON.stringify(out);
}

export function codexStopReason(responseData: unknown): string {
  const stopReason = getAt(responseData, "stop_reason");
  if (stopReason !== undefined && gstr(stopReason) !== "") {
    if (gstr(stopReason) === "stop" && gstr(codexStopSequence(responseData)) !== "") return "stop_sequence";
    return gstr(stopReason);
  }
  const reason = getAt(responseData, "incomplete_details.reason");
  if (reason !== undefined && gstr(reason) !== "") return gstr(reason);
  if (gstr(codexStopSequence(responseData)) !== "") return "stop_sequence";
  return "";
}

export function mapCodexStopReasonToClaude(stopReason: string, hasToolCall: boolean): string {
  if (hasToolCall) return "tool_use";
  switch (stopReason) {
    case "":
    case "stop":
    case "completed":
      return "end_turn";
    case "max_tokens":
    case "max_output_tokens":
      return "max_tokens";
    case "tool_use":
    case "tool_calls":
    case "function_call":
      return "end_turn";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
    case "model_context_window_exceeded":
      return stopReason;
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function codexStopSequence(responseData: unknown): unknown {
  return getAt(responseData, "stop_sequence");
}

function setClaudeStopSequence(out: JSONObject, key: string, responseData: unknown): void {
  const stopSequence = codexStopSequence(responseData);
  if (stopSequence !== undefined && gstr(stopSequence) !== "") out[key] = stopSequence;
}

function codexFunctionCallID(itemResult: unknown): string {
  return gstr(getAt(itemResult, "call_id"));
}

function codexFunctionCallKeys(rootResult: unknown, itemResult: unknown): string[] {
  let keys: string[] = [];
  const outputIndex = getAt(rootResult, "output_index");
  if (outputIndex !== undefined) keys = appendUniqueCodexFunctionCallKey(keys, "output:" + JSON.stringify(outputIndex));
  const callID = codexFunctionCallID(itemResult);
  if (callID !== "") keys = appendUniqueCodexFunctionCallKey(keys, "call:" + callID);
  const rootCallID = gstr(getAt(rootResult, "call_id"));
  if (rootCallID !== "") keys = appendUniqueCodexFunctionCallKey(keys, "call:" + rootCallID);
  const itemID = gstr(getAt(itemResult, "id"));
  if (itemID !== "") keys = appendUniqueCodexFunctionCallKey(keys, "item:" + itemID);
  const rootItemID = gstr(getAt(rootResult, "item_id"));
  if (rootItemID !== "") keys = appendUniqueCodexFunctionCallKey(keys, "item:" + rootItemID);
  return keys;
}

function appendUniqueCodexFunctionCallKey(keys: string[], key: string): string[] {
  if (key === "") return keys;
  if (keys.includes(key)) return keys;
  keys.push(key);
  return keys;
}

function codexFunctionCallForKeys(params: ConvertCodexResponseToClaudeParams, keys: string[]): CodexFunctionCallStream | undefined {
  for (const key of keys) {
    const call = params.functionCalls.get(key);
    if (call !== undefined) return call;
  }
  return undefined;
}

function codexFunctionCallForEvent(params: ConvertCodexResponseToClaudeParams, rootResult: unknown, itemResult: unknown): CodexFunctionCallStream | undefined {
  const keys = codexFunctionCallKeys(rootResult, itemResult);
  if (keys.length > 0) return codexFunctionCallForKeys(params, keys);
  return params.lastFunctionCall;
}

function recordCodexFunctionCall(params: ConvertCodexResponseToClaudeParams, rootResult: unknown, itemResult: unknown): CodexFunctionCallStream {
  const keys = codexFunctionCallKeys(rootResult, itemResult);
  let call = codexFunctionCallForKeys(params, keys);
  if (call === undefined) {
    call = new CodexFunctionCallStream();
    params.functionCallQueue.push(call);
  }
  addCodexFunctionCallAliases(params, call, keys);
  params.lastFunctionCall = call;
  return call;
}

function addCodexFunctionCallAliases(params: ConvertCodexResponseToClaudeParams, call: CodexFunctionCallStream, keys: string[]): void {
  for (const key of keys) params.functionCalls.set(key, call);
}

function updateCodexFunctionCallIdentity(params: ConvertCodexResponseToClaudeParams, call: CodexFunctionCallStream, rootResult: unknown, itemResult: unknown): void {
  const callID = codexFunctionCallID(itemResult);
  if (callID !== "") call.callID = callID;
  const name = gstr(getAt(itemResult, "name"));
  if (name !== "") call.name = name;
  addCodexFunctionCallAliases(params, call, codexFunctionCallKeys(rootResult, itemResult));
}

function updateCodexFunctionCallArguments(call: CodexFunctionCallStream, args: string, delta: boolean): void {
  if (args === "") return;
  if (delta) {
    call.arguments += args;
    call.hasReceivedArgumentsDelta = true;
    return;
  }
  if (!call.hasReceivedArgumentsDelta) {
    call.arguments = args;
    return;
  }
  if (args.startsWith(call.arguments)) call.arguments = args;
}

function appendCodexFunctionCallStart(output: string, params: ConvertCodexResponseToClaudeParams, originalRequestRawJSON: string, callID: string, name: string, blockIndex: number): string {
  const template = {
    type: "content_block_start",
    index: blockIndex,
    content_block: {
      type: "tool_use",
      id: shortenCodexCallIDIfNeeded(sanitizeClaudeToolID(callID)),
      name: params.resolveToolUseName(originalRequestRawJSON, name),
      input: {},
    },
  };
  return sse(output, "content_block_start", template);
}

function appendCodexFunctionCallArgumentDelta(output: string, partialJSON: string, blockIndex: number): string {
  const template = { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: partialJSON } };
  return sse(output, "content_block_delta", template);
}

function appendCodexFunctionCallStop(output: string, blockIndex: number): string {
  return sse(output, "content_block_stop", { type: "content_block_stop", index: blockIndex });
}

function appendCodexFunctionCallBufferedArguments(output: string, params: ConvertCodexResponseToClaudeParams, call: CodexFunctionCallStream): string {
  if (params.activeFunctionCall !== call || !call.started || call.closed) return output;
  if (call.emittedArgumentsLength >= call.arguments.length) return output;
  output = appendCodexFunctionCallArgumentDelta(output, call.arguments.slice(call.emittedArgumentsLength), call.blockIndex);
  call.emittedArgumentsLength = call.arguments.length;
  return output;
}

function appendCodexFunctionCallQueue(output: string, params: ConvertCodexResponseToClaudeParams, originalRequestRawJSON: string): string {
  for (;;) {
    const active = params.activeFunctionCall;
    if (active !== undefined) {
      output = appendCodexFunctionCallBufferedArguments(output, params, active);
      if (!active.done) return output;
      output = appendCodexFunctionCallStop(output, active.blockIndex);
      if (params.blockIndex <= active.blockIndex) params.blockIndex = active.blockIndex + 1;
      active.closed = true;
      params.activeFunctionCall = undefined;
      removeCodexFunctionCallFromQueue(params, active);
    }

    while (params.functionCallQueue.length > 0 && params.functionCallQueue[0]!.closed) params.functionCallQueue.shift();
    if (params.functionCallQueue.length === 0) return output;

    const call = params.functionCallQueue[0]!;
    if (call.name === "") return output;

    call.blockIndex = params.blockIndex;
    output = appendCodexFunctionCallStart(output, params, originalRequestRawJSON, call.callID, call.name, call.blockIndex);
    if (call.emitInitialEmptyDelta) output = appendCodexFunctionCallArgumentDelta(output, "", call.blockIndex);
    call.started = true;
    params.activeFunctionCall = call;
    params.hasEmittedToolUse = true;
    output = appendCodexFunctionCallBufferedArguments(output, params, call);
  }
}

function removeCodexFunctionCallFromQueue(params: ConvertCodexResponseToClaudeParams, call: CodexFunctionCallStream): void {
  const index = params.functionCallQueue.indexOf(call);
  if (index >= 0) params.functionCallQueue.splice(index, 1);
}

function appendCodexFunctionCallsFromTerminal(output: string, params: ConvertCodexResponseToClaudeParams, originalRequestRawJSON: string, responseData: unknown): string {
  const outputItems = getAt(responseData, "output");
  if (Array.isArray(outputItems)) {
    outputItems.forEach((item, index) => {
      if (gstr(getAt(item, "type")) !== "function_call") return;

      let keys = codexFunctionCallKeys(undefined, item);
      const itemOutputIndex = getAt(item, "output_index");
      if (itemOutputIndex !== undefined) keys = appendUniqueCodexFunctionCallKey(keys, "output:" + JSON.stringify(itemOutputIndex));
      keys = appendUniqueCodexFunctionCallKey(keys, "output:" + String(index));
      let call = codexFunctionCallForKeys(params, keys);
      if (call === undefined) {
        call = new CodexFunctionCallStream();
        params.functionCallQueue.push(call);
      }
      addCodexFunctionCallAliases(params, call, keys);
      updateCodexFunctionCallIdentity(params, call, undefined, item);
      updateCodexFunctionCallArguments(call, gstr(getAt(item, "arguments")), false);
      call.done = true;
    });
  }

  const queuedCalls: CodexFunctionCallStream[] = [];
  for (const call of params.functionCallQueue) {
    if (call.closed) continue;
    if (call.name === "") {
      call.closed = true;
      continue;
    }
    call.done = true;
    queuedCalls.push(call);
  }
  params.functionCallQueue = queuedCalls;
  output = appendCodexFunctionCallQueue(output, params, originalRequestRawJSON);

  clearCodexFunctionCalls(params);
  return output;
}

function clearCodexFunctionCalls(params: ConvertCodexResponseToClaudeParams): void {
  params.functionCalls.clear();
  params.functionCallQueue = [];
  params.activeFunctionCall = undefined;
  params.lastFunctionCall = undefined;
}

export function resolveCodexClaudeToolUseName(originalRequestRawJSON: string, name: string): string {
  const orig = buildReverseMapFromClaudeOriginalShortToOriginal(originalRequestRawJSON).get(name);
  return orig !== undefined ? orig : name;
}

/**
 * Splits Responses usage into [input, output, cacheRead, cacheWrite] tokens.
 * Cached and cache-write tokens are deducted from input_tokens (clamped at zero),
 * as Claude reports uncached input separately.
 */
export function extractResponsesUsage(usage: unknown): [number, number, number, number] {
  if (usage === undefined || usage === null) return [0, 0, 0, 0];

  let inputTokens = gint(getAt(usage, "input_tokens"));
  const outputTokens = gint(getAt(usage, "output_tokens"));
  const cachedTokens = gint(getAt(usage, "input_tokens_details.cached_tokens"));
  let cacheWriteTokens = gint(getAt(usage, "input_tokens_details.cache_write_tokens"));
  if (cacheWriteTokens <= 0) cacheWriteTokens = gint(getAt(usage, "input_tokens_details.cache_creation_tokens"));

  let deductTokens = 0;
  if (cachedTokens > 0) deductTokens += cachedTokens;
  if (cacheWriteTokens > 0) deductTokens += cacheWriteTokens;

  if (deductTokens > 0) {
    if (inputTokens >= deductTokens) inputTokens -= deductTokens;
    else inputTokens = 0;
  }
  if (inputTokens < 0) inputTokens = 0;

  return [inputTokens, outputTokens, cachedTokens, cacheWriteTokens];
}

/** Copies a non-negative numeric reasoning_tokens detail into usage.output_tokens_details.thinking_tokens (clamped to output_tokens). */
function setClaudeReasoningUsage(out: JSONObject, usage: unknown): void {
  const detail = getAt(usage, "output_tokens_details.reasoning_tokens");
  if (typeof detail !== "number") return;
  if (detail < 0 || Object.is(detail, -0)) return;
  const outputTokens = Math.max(0, gint(getAt(usage, "output_tokens")));
  const tokens = detail >= outputTokens ? outputTokens : gint(detail);
  const usageOut = isObj(out.usage) ? out.usage : undefined;
  if (usageOut === undefined) return;
  const details = isObj(usageOut.output_tokens_details) ? usageOut.output_tokens_details : {};
  details.thinking_tokens = tokens;
  usageOut.output_tokens_details = details;
}

/** Claude count_tokens response body for the given input token count. */
export function claudeTokenCount(_ctx: TranslateContext, count: number): string {
  return claudeInputTokensJSON(count);
}

export function startCodexTextBlock(params: ConvertCodexResponseToClaudeParams): string {
  if (params.textBlockOpen) return "";
  const template = { type: "content_block_start", index: params.blockIndex, content_block: { type: "text", text: "" } };
  params.textBlockOpen = true;
  return sse("", "content_block_start", template);
}

/**
 * Closes the thinking block that carries a commentary message. A reasoning item's
 * encrypted_content never belongs to it, so the internal commentary marker is
 * emitted as the block signature instead of any pending reasoning signature.
 */
export function finalizeCodexCommentaryBlock(params: ConvertCodexResponseToClaudeParams): string {
  if (!params.commentaryMessageOpen || !params.thinkingBlockOpen) return "";
  return finalizeCodexThinkingBlock(params);
}

/**
 * Builds a non-stream content block: {"type":"text","text":...} or, for a
 * commentary message, {"type":"thinking","thinking":...} carrying the internal
 * commentary marker in its signature field.
 */
export function codexMessageTextBlock(blockType: string, text: string): JSONObject {
  if (blockType === "thinking") return { type: "thinking", thinking: text, signature: codexCommentarySignatureMarker };
  return { type: "text", text };
}

export function stopCodexTextBlock(params: ConvertCodexResponseToClaudeParams): string {
  if (!params.textBlockOpen) return "";
  const template = { type: "content_block_stop", index: params.blockIndex };
  params.textBlockOpen = false;
  params.blockIndex++;
  return sse("", "content_block_stop", template);
}

export function extractCodexReasoningItemText(item: unknown): string {
  let thinking = "";
  const summary = getAt(item, "summary");
  if (summary !== undefined) {
    if (Array.isArray(summary)) {
      for (const part of summary) {
        const txt = getAt(part, "text");
        thinking += txt !== undefined ? gstr(txt) : gstr(part);
      }
    } else {
      thinking += gstr(summary);
    }
  }
  if (thinking.length === 0) {
    const content = getAt(item, "content");
    if (content !== undefined) {
      if (Array.isArray(content)) {
        for (const part of content) {
          const txt = getAt(part, "text");
          thinking += txt !== undefined ? gstr(txt) : gstr(part);
        }
      } else {
        thinking += gstr(content);
      }
    }
  }
  return thinking;
}

export function startCodexThinkingBlock(params: ConvertCodexResponseToClaudeParams): string {
  if (params.thinkingBlockOpen) return "";
  const template = { type: "content_block_start", index: params.blockIndex, content_block: { type: "thinking", thinking: "" } };
  params.thinkingBlockOpen = true;
  return sse("", "content_block_start", template);
}

/** Emits a thinking_delta for the currently open thinking block. */
export function appendCodexThinkingDelta(params: ConvertCodexResponseToClaudeParams, text: string): string {
  if (text === "") return "";
  const template = { type: "content_block_delta", index: params.blockIndex, delta: { type: "thinking_delta", thinking: text } };
  return sse("", "content_block_delta", template);
}

export function finalizeCodexSignatureOnlyThinkingBlock(params: ConvertCodexResponseToClaudeParams): string {
  if (params.thinkingSignature === "") return "";
  let output = startCodexThinkingBlock(params);
  output += finalizeCodexThinkingBlock(params);
  return output;
}

export function finalizeCodexThinkingBlock(params: ConvertCodexResponseToClaudeParams): string {
  if (!params.thinkingBlockOpen) return "";

  let output = "";
  let signatureToEmit = "";
  if (params.commentaryMessageOpen) {
    signatureToEmit = codexCommentarySignatureMarker;
  } else if (params.thinkingSignature !== "") {
    signatureToEmit = params.thinkingSignature;
    params.thinkingSignature = "";
  }
  if (signatureToEmit !== "") {
    const signatureDelta = { type: "content_block_delta", index: params.blockIndex, delta: { type: "signature_delta", signature: signatureToEmit } };
    output = sse(output, "content_block_delta", signatureDelta);
  }

  output = sse(output, "content_block_stop", { type: "content_block_stop", index: params.blockIndex });

  params.blockIndex++;
  params.thinkingBlockOpen = false;

  return output;
}

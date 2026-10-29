// Port of internal/translator/openai/claude/openai_claude_response.go.
//
// Converts OpenAI Chat Completions responses into Anthropic Messages responses.
// The stream translator receives one upstream SSE line per call ("data: " +
// chat.completion.chunk JSON, or "data: [DONE]") and returns complete Claude SSE
// frames ("event: <type>\ndata: <json>\n\n"). Per-stream state lives in
// TranslatorState.value as a ConvertOpenAIResponseToAnthropicParams.
import type { TranslateContext, TranslatorState } from "../../types.ts";
import { exists, getAt, gint, gstr, isArr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import { sanitizeClaudeToolID } from "../../../util/claude_tool_id.ts";
import { fixJSON, mapToolName, toolNameMapFromClaudeRequest } from "../../../util/translator.ts";
import { appendSSEEventString, claudeInputTokensJSON, getFromJSON } from "../../common/index.ts";

type JSONObject = Record<string, unknown>;

/** Buffered chunk of text or thinking that arrived while a tool call block was open. */
export interface InterleavedContentChunk {
  type: "text" | "thinking";
  text: string;
}

/** Accumulates one streamed tool call. */
export class ToolCallAccumulator {
  id = "";
  name = "";
  arguments = "";
  /** Whether content_block_start has already been sent for this tool index. */
  startEmitted = false;
}

/** Per-stream conversion state (Go: ConvertOpenAIResponseToAnthropicParams). */
export class ConvertOpenAIResponseToAnthropicParams {
  messageID = "";
  model = "";
  createdAt = 0;
  toolNameMap: Map<string, string> | undefined = undefined;
  /**
   * True once at least one tool_use content_block_start has been emitted on the
   * wire. Using raw upstream tool_calls presence here can produce
   * stop_reason=tool_use with zero announced tool blocks.
   */
  sawToolCall = false;
  contentAccumulator = "";
  toolCallsAccumulator: Map<number, ToolCallAccumulator> | undefined = undefined;
  textContentBlockStarted = false;
  thinkingContentBlockStarted = false;
  finishReason = "";
  contentBlocksStopped = false;
  messageDeltaSent = false;
  messageStarted = false;
  messageStopSent = false;
  /** Tool call content block index mapping (OpenAI tool index -> Claude block index). */
  toolCallBlockIndexes = new Map<number, number>();
  /** Maps a chunk-local tool_calls array position to the active accumulator key when upstream omits tool_calls[].index. */
  omittedToolCallIndexes: Map<number, number> | undefined = undefined;
  textContentBlockIndex = -1;
  thinkingContentBlockIndex = -1;
  nextContentBlockIndex = 0;
  /** Currently open tool call index (-1 if none). */
  openToolCallIndex = -1;
  /** Queue of interleaved text or thinking chunks arriving while a tool call is open. */
  interleavedContentChunks: InterleavedContentChunk[] = [];
  usageInputTokens = 0;
  usageOutputTokens = 0;
  usageCachedTokens = 0;
  usageCacheWriteTokens = 0;
  /** Whether toolNameMap has been resolved from the original request once per stream. */
  toolNameMapResolved = false;
  /** Whether the original request asked for streaming, resolved once per stream. */
  streamResolved = false;
  streamRequested = false;

  toolContentBlockIndex(openAIToolIndex: number): number {
    const existing = this.toolCallBlockIndexes.get(openAIToolIndex);
    if (existing !== undefined) return existing;
    const idx = this.nextContentBlockIndex;
    this.nextContentBlockIndex++;
    this.toolCallBlockIndexes.set(openAIToolIndex, idx);
    return idx;
  }
}

function sse(event: string, payload: unknown): string {
  return appendSSEEventString("", event, JSON.stringify(payload), 2);
}

/**
 * Converts OpenAI streaming response chunks to Anthropic API streaming events.
 * Each call takes one upstream SSE line ("data: ..."); other lines yield nothing.
 */
export function convertOpenAIResponseToClaude(
  _ctx: TranslateContext,
  _model: string,
  originalRequestRawJSON: string,
  _requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
): string[] {
  if (!(state.value instanceof ConvertOpenAIResponseToAnthropicParams)) {
    state.value = new ConvertOpenAIResponseToAnthropicParams();
  }
  const param = state.value;

  if (!rawJSON.startsWith("data:")) return [];
  rawJSON = rawJSON.slice(5).trim();

  if (!param.toolNameMapResolved) {
    if (param.toolNameMap === undefined) param.toolNameMap = toolNameMapFromClaudeRequest(originalRequestRawJSON ?? "");
    param.toolNameMapResolved = true;
  }

  // Check if this is the [DONE] marker
  if (rawJSON === "[DONE]") return convertOpenAIDoneToAnthropic(param);

  if (!param.streamResolved) {
    const streamResult = getFromJSON(originalRequestRawJSON ?? "", "stream");
    param.streamRequested = exists(streamResult) && streamResult !== false;
    param.streamResolved = true;
  }
  if (!param.streamRequested) return convertOpenAINonStreamingToAnthropic(rawJSON);
  return convertOpenAIStreamingChunkToAnthropic(rawJSON, param);
}

function hasValidToolCallArguments(param: ConvertOpenAIResponseToAnthropicParams): boolean {
  if (!param.toolCallsAccumulator || param.toolCallsAccumulator.size === 0) return true;
  for (const acc of param.toolCallsAccumulator.values()) {
    if (!acc.startEmitted && acc.name === "" && acc.id === "" && acc.arguments.length === 0) continue;
    if (acc.arguments.length === 0) continue;
    const argsStr = acc.arguments.trim();
    if (argsStr === "") return false;
    if (argsStr === "{}") continue;
    const fixed = tryParse<unknown>(fixJSON(argsStr));
    if (fixed === undefined || !isObj(fixed)) return false;
  }
  return true;
}

function effectiveOpenAIFinishReason(param: ConvertOpenAIResponseToAnthropicParams): string {
  if (param.finishReason === "length" || param.finishReason === "content_filter") return param.finishReason;
  if (param.sawToolCall) return hasValidToolCallArguments(param) ? "tool_calls" : "length";
  return param.finishReason;
}

function terminalOpenAIFinishReason(param: ConvertOpenAIResponseToAnthropicParams): string {
  const reason = effectiveOpenAIFinishReason(param);
  return reason !== "" ? reason : "stop";
}

/** Converts one OpenAI streaming chunk to Anthropic streaming events. */
function convertOpenAIStreamingChunkToAnthropic(rawJSON: string, param: ConvertOpenAIResponseToAnthropicParams): string[] {
  const root = tryParse<unknown>(rawJSON);
  const results: string[] = [];

  // Initialize parameters if needed
  if (param.messageID === "") param.messageID = gstr(getAt(root, "id"));
  if (param.model === "") param.model = gstr(getAt(root, "model"));
  if (param.createdAt === 0) param.createdAt = gint(getAt(root, "created"));

  // Emit message_start on the very first chunk, regardless of whether it has a role field.
  // Some providers (like Copilot) may send tool_calls in the first chunk without a role field.
  const delta = getAt(root, "choices.0.delta");
  if (exists(delta)) {
    if (!param.messageStarted) {
      results.push(
        sse("message_start", {
          type: "message_start",
          message: {
            id: param.messageID,
            type: "message",
            role: "assistant",
            model: param.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      param.messageStarted = true;
      // Don't send content_block_start for text here - wait for actual content
    }

    // Handle reasoning content delta
    for (const reasoningText of collectOpenAIObjectReasoningTexts(delta)) {
      if (reasoningText === "") continue;
      if (param.openToolCallIndex !== -1) {
        appendInterleaved(param, "thinking", reasoningText);
      } else {
        stopTextContentBlock(param, results);
        if (!param.thinkingContentBlockStarted) {
          if (param.thinkingContentBlockIndex === -1) {
            param.thinkingContentBlockIndex = param.nextContentBlockIndex;
            param.nextContentBlockIndex++;
          }
          results.push(sse("content_block_start", { type: "content_block_start", index: param.thinkingContentBlockIndex, content_block: { type: "thinking", thinking: "" } }));
          param.thinkingContentBlockStarted = true;
        }
        results.push(sse("content_block_delta", { type: "content_block_delta", index: param.thinkingContentBlockIndex, delta: { type: "thinking_delta", thinking: reasoningText } }));
      }
    }

    // Handle content delta
    const content = getAt(delta, "content");
    if (exists(content) && gstr(content) !== "") {
      const text = gstr(content);
      if (param.openToolCallIndex !== -1) {
        // Tool call content block is currently active on the wire.
        // Buffer this text so content blocks remain strictly sequential.
        appendInterleaved(param, "text", text);
        param.contentAccumulator += text;
      } else {
        // Send content_block_start for text if not already sent
        if (!param.textContentBlockStarted) {
          stopThinkingContentBlock(param, results);
          if (param.textContentBlockIndex === -1) {
            param.textContentBlockIndex = param.nextContentBlockIndex;
            param.nextContentBlockIndex++;
          }
          results.push(sse("content_block_start", { type: "content_block_start", index: param.textContentBlockIndex, content_block: { type: "text", text: "" } }));
          param.textContentBlockStarted = true;
        }
        results.push(sse("content_block_delta", { type: "content_block_delta", index: param.textContentBlockIndex, delta: { type: "text_delta", text } }));
        // Accumulate content
        param.contentAccumulator += text;
      }
    }

    // Handle tool calls
    const toolCalls = getAt(delta, "tool_calls");
    if (isArr(toolCalls)) {
      if (!param.toolCallsAccumulator) param.toolCallsAccumulator = new Map();
      const accumulators = param.toolCallsAccumulator;

      toolCalls.forEach((toolCall, pos) => {
        const idValue = getAt(toolCall, "id");
        const incomingID = typeof idValue === "string" ? idValue : "";

        const indexValue = getAt(toolCall, "index");
        let index = gint(indexValue);
        if (!exists(indexValue)) {
          index = pos;
          const mapped = param.omittedToolCallIndexes?.get(pos);
          if (mapped !== undefined) index = mapped;
          const existing = accumulators.get(index);
          if (existing && incomingID !== "" && existing.id !== "" && existing.id !== incomingID) {
            let nextIndex = index + 1;
            for (const k of accumulators.keys()) {
              if (k >= nextIndex) nextIndex = k + 1;
            }
            index = nextIndex;
            if (!param.omittedToolCallIndexes) param.omittedToolCallIndexes = new Map();
            param.omittedToolCallIndexes.set(pos, index);
          }
        }

        // Initialize accumulator if needed
        let accumulator = accumulators.get(index);
        if (!accumulator) {
          accumulator = new ToolCallAccumulator();
          accumulators.set(index, accumulator);
        }

        // Handle tool call ID. Only accept JSON-string, non-empty values so
        // malformed upstream fields do not overwrite a valid ID or coerce into
        // a content_block.id.
        if (incomingID !== "" && !accumulator.startEmitted) accumulator.id = incomingID;

        // Handle function name and arguments
        const fn = getAt(toolCall, "function");
        if (exists(fn)) {
          // Only record the name until content_block_start has been emitted.
          // Some upstreams send "name": "" or repeat the field across chunks;
          // reassigning after start could drift from what was already announced.
          if (!accumulator.startEmitted) {
            const name = getAt(fn, "name");
            if (typeof name === "string" && name !== "") accumulator.name = mapToolName(param.toolNameMap, name);
          }
          // Handle function arguments
          const args = getAt(fn, "arguments");
          if (exists(args)) {
            const argsText = gstr(args);
            if (argsText !== "") accumulator.arguments += argsText;
          }
        }

        // Re-check on every chunk, not only chunks with a function object.
        // Some upstreams split function.name and id across separate deltas.
        // Anthropic requires strictly sequential content blocks.
        // Only emit mid-stream start if no other tool call block is currently open.
        if (!accumulator.startEmitted && accumulator.name !== "" && accumulator.id !== "" && !param.contentBlocksStopped) {
          if (param.openToolCallIndex === -1) emitToolUseStart(param, index, accumulator, results);
        }
      });
    }
  }

  // Handle finish_reason (but don't send message_delta/message_stop yet)
  const finishReason = getAt(root, "choices.0.finish_reason");
  if (exists(finishReason) && gstr(finishReason) !== "") {
    const reason = gstr(finishReason);
    if (reason === "length") param.finishReason = "length";
    else if (reason === "content_filter") param.finishReason = "content_filter";
    else if (param.sawToolCall) param.finishReason = hasValidToolCallArguments(param) ? "tool_calls" : "length";
    else if (reason === "tool_calls") param.finishReason = "stop";
    else param.finishReason = reason;

    finalizeOpenAIAnthropicContentBlocks(param, results);
    // Don't send message_delta here - wait for usage info or [DONE]
  }

  // Cache usage information whenever present
  const usage = getAt(root, "usage");
  const hasUsage = exists(usage) && usage !== null;
  if (hasUsage) {
    const extracted = extractOpenAIUsage(usage);
    param.usageInputTokens = extracted.inputTokens;
    param.usageOutputTokens = extracted.outputTokens;
    param.usageCachedTokens = extracted.cachedTokens;
    param.usageCacheWriteTokens = extracted.cacheWriteTokens;
  }

  // Emit message_delta and message_stop only when generation is finished:
  // - Upstream sent a trailing usage-only chunk (choices array is empty or absent) after content/tools started, or
  // - Upstream sent [DONE] (handled in convertOpenAIDoneToAnthropic).
  // Content chunks with finish_reason and preliminary usage must not emit message_delta early,
  // because authoritative token counts (such as cached_tokens) can arrive in the trailing usage-only chunk.
  const isTrailingUsageChunk =
    hasUsage &&
    !exists(getAt(root, "choices.0")) &&
    (param.finishReason !== "" ||
      param.sawToolCall ||
      param.textContentBlockStarted ||
      param.thinkingContentBlockStarted ||
      param.contentAccumulator.length > 0 ||
      param.interleavedContentChunks.length > 0);

  if (!param.messageDeltaSent && isTrailingUsageChunk) {
    finalizeOpenAIAnthropicContentBlocks(param, results);
    emitAnthropicMessageDelta(param, results);
    emitMessageStopIfNeeded(param, results);
  }

  return results;
}

function appendInterleaved(param: ConvertOpenAIResponseToAnthropicParams, type: "text" | "thinking", text: string): void {
  const chunks = param.interleavedContentChunks;
  const last = chunks[chunks.length - 1];
  if (last && last.type === type) last.text += text;
  else chunks.push({ type, text });
}

/** Handles the [DONE] marker and sends the final events. */
function convertOpenAIDoneToAnthropic(param: ConvertOpenAIResponseToAnthropicParams): string[] {
  const results: string[] = [];
  finalizeOpenAIAnthropicContentBlocks(param, results);
  if (!param.messageDeltaSent) emitAnthropicMessageDelta(param, results);
  emitMessageStopIfNeeded(param, results);
  return results;
}

function newClaudeMessageEnvelope(id: string, model: string): JSONObject {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function toolUseBlockFromOpenAIToolCall(toolCall: unknown, toolNameMap: Map<string, string> | undefined): JSONObject {
  const block: JSONObject = {
    type: "tool_use",
    id: sanitizeClaudeToolID(gstr(getAt(toolCall, "id"))),
    name: mapToolName(toolNameMap, gstr(getAt(toolCall, "function.name"))),
    input: {},
  };
  const argsStr = fixJSON(gstr(getAt(toolCall, "function.arguments")));
  if (argsStr !== "") {
    const parsed = tryParse<unknown>(argsStr);
    if (isObj(parsed)) block.input = parsed;
  }
  return block;
}

function setClaudeUsage(out: JSONObject, usage: unknown): void {
  const { inputTokens, outputTokens, cachedTokens, cacheWriteTokens } = extractOpenAIUsage(usage);
  const usageOut: JSONObject = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (cachedTokens > 0) usageOut.cache_read_input_tokens = cachedTokens;
  if (cacheWriteTokens > 0) usageOut.cache_creation_input_tokens = cacheWriteTokens;
  out.usage = usageOut;
}

/** Converts a complete OpenAI chat.completion delivered on the stream path (stream=false request). */
function convertOpenAINonStreamingToAnthropic(rawJSON: string): string[] {
  const root = tryParse<unknown>(rawJSON);
  const out = newClaudeMessageEnvelope(gstr(getAt(root, "id")), gstr(getAt(root, "model")));

  // Process message content and tool calls
  const choices = getAt(root, "choices");
  if (isArr(choices) && choices.length > 0) {
    const choice = choices[0]; // Take first choice
    const contentBlocks: JSONObject[] = [];

    for (const reasoningText of collectOpenAIObjectReasoningTexts(getAt(choice, "message"))) {
      if (reasoningText === "") continue;
      contentBlocks.push({ type: "thinking", thinking: reasoningText });
    }

    // Handle text content
    const content = getAt(choice, "message.content");
    if (exists(content) && gstr(content) !== "") contentBlocks.push({ type: "text", text: gstr(content) });

    // Handle tool calls
    let hasToolCall = false;
    const toolCalls = getAt(choice, "message.tool_calls");
    if (isArr(toolCalls)) {
      for (const toolCall of toolCalls) {
        hasToolCall = true;
        contentBlocks.push(toolUseBlockFromOpenAIToolCall(toolCall, undefined));
      }
    }

    if (contentBlocks.length > 0) out.content = contentBlocks;

    // Set stop reason
    const finishReason = getAt(choice, "finish_reason");
    if (exists(finishReason) || hasToolCall) {
      out.stop_reason = mapOpenAINonStreamFinishReasonToAnthropic(gstr(finishReason), hasToolCall);
    }
  }

  // Set usage information
  const usage = getAt(root, "usage");
  if (exists(usage)) setClaudeUsage(out, usage);

  return [JSON.stringify(out)];
}

/** Maps OpenAI finish reasons to Anthropic equivalents. */
function mapOpenAIFinishReasonToAnthropic(openAIReason: string): string {
  switch (openAIReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn"; // Anthropic doesn't have direct equivalent
    case "function_call": // Legacy OpenAI
      return "tool_use";
    default:
      return "end_turn";
  }
}

function mapOpenAINonStreamFinishReasonToAnthropic(openAIReason: string, hasToolCall: boolean): string {
  if (hasToolCall && openAIReason !== "length" && openAIReason !== "content_filter") return "tool_use";
  return mapOpenAIFinishReasonToAnthropic(openAIReason);
}

function collectOpenAIObjectReasoningTexts(obj: unknown): string[] {
  if (!exists(obj)) return [];
  for (const path of ["reasoning_content", "reasoning", "reasoning_details"]) {
    const texts = collectOpenAIReasoningTexts(getAt(obj, path));
    if (texts.length > 0) return texts;
  }
  return [];
}

function collectOpenAIReasoningTexts(node: unknown): string[] {
  const texts: string[] = [];
  if (!exists(node)) return texts;

  if (isArr(node)) {
    for (const value of node) texts.push(...collectOpenAIReasoningTexts(value));
    return texts;
  }

  if (typeof node === "string") {
    if (node !== "") texts.push(node);
  } else if (isObj(node)) {
    const text = node.text;
    if (exists(text)) {
      const textStr = gstr(text);
      if (textStr !== "") texts.push(textStr);
    }
  }
  return texts;
}

function stopThinkingContentBlock(param: ConvertOpenAIResponseToAnthropicParams, results: string[]): void {
  if (!param.thinkingContentBlockStarted) return;
  results.push(sse("content_block_stop", { type: "content_block_stop", index: param.thinkingContentBlockIndex }));
  param.thinkingContentBlockStarted = false;
  param.thinkingContentBlockIndex = -1;
}

function emitMessageStopIfNeeded(param: ConvertOpenAIResponseToAnthropicParams, results: string[]): void {
  if (param.messageStopSent) return;
  results.push(sse("message_stop", { type: "message_stop" }));
  param.messageStopSent = true;
}

function stopTextContentBlock(param: ConvertOpenAIResponseToAnthropicParams, results: string[]): void {
  if (!param.textContentBlockStarted) return;
  results.push(sse("content_block_stop", { type: "content_block_stop", index: param.textContentBlockIndex }));
  param.textContentBlockStarted = false;
  param.textContentBlockIndex = -1;
}

function emitToolUseStart(param: ConvertOpenAIResponseToAnthropicParams, openAIToolIndex: number, accumulator: ToolCallAccumulator, results: string[]): void {
  stopThinkingContentBlock(param, results);
  stopTextContentBlock(param, results);

  const blockIndex = param.toolContentBlockIndex(openAIToolIndex);
  results.push(
    sse("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "tool_use", id: sanitizeClaudeToolID(accumulator.id), name: accumulator.name, input: {} },
    }),
  );
  accumulator.startEmitted = true;
  param.sawToolCall = true;
  param.openToolCallIndex = openAIToolIndex;
}

/**
 * Finalizes a tool_use block that never received a mid-stream start. Some
 * OpenAI-compatible providers leave function.name empty for the whole stream;
 * dropping those calls loses tool_use for Claude Code and can trigger retry
 * loops. When name is still empty but the call has an id and/or arguments,
 * synthesize tool_<index> instead of silently discarding it.
 * Returns false when the accumulator has no usable tool-call signal.
 */
function emitBelatedToolUseStart(param: ConvertOpenAIResponseToAnthropicParams, openAIToolIndex: number, accumulator: ToolCallAccumulator, results: string[]): boolean {
  if (accumulator.startEmitted) return true;
  if (accumulator.name === "" && accumulator.id === "" && accumulator.arguments.length === 0) return false;
  if (accumulator.name === "") accumulator.name = `tool_${openAIToolIndex}`;
  emitToolUseStart(param, openAIToolIndex, accumulator, results);
  return true;
}

function finalizeSingleToolCall(param: ConvertOpenAIResponseToAnthropicParams, openAIToolIndex: number, results: string[]): void {
  const accumulator = param.toolCallsAccumulator?.get(openAIToolIndex);
  if (!accumulator) return;
  if (!accumulator.startEmitted) {
    if (!emitBelatedToolUseStart(param, openAIToolIndex, accumulator, results)) return;
  }
  const blockIndex = param.toolContentBlockIndex(openAIToolIndex);

  // Send complete input_json_delta with all accumulated arguments
  if (accumulator.arguments.length > 0) {
    results.push(sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: fixJSON(accumulator.arguments) } }));
  }

  results.push(sse("content_block_stop", { type: "content_block_stop", index: blockIndex }));
  param.toolCallBlockIndexes.delete(openAIToolIndex);
  param.openToolCallIndex = -1;
}

function emitBufferedInterleavedContent(param: ConvertOpenAIResponseToAnthropicParams, results: string[]): void {
  if (param.interleavedContentChunks.length === 0) return;
  for (const chunk of param.interleavedContentChunks) {
    if (chunk.text === "") continue;
    const idx = param.nextContentBlockIndex;
    param.nextContentBlockIndex++;

    if (chunk.type === "thinking") {
      results.push(sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } }));
      results.push(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: chunk.text } }));
      results.push(sse("content_block_stop", { type: "content_block_stop", index: idx }));
    } else {
      results.push(sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } }));
      results.push(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: chunk.text } }));
      results.push(sse("content_block_stop", { type: "content_block_stop", index: idx }));
    }
  }
  param.interleavedContentChunks = [];
}

function finalizeOpenAIAnthropicContentBlocks(param: ConvertOpenAIResponseToAnthropicParams, results: string[]): void {
  stopThinkingContentBlock(param, results);
  stopTextContentBlock(param, results);

  if (!param.contentBlocksStopped) {
    if (param.openToolCallIndex !== -1) finalizeSingleToolCall(param, param.openToolCallIndex, results);

    for (const index of toolCallAccumulatorIndexes(param.toolCallsAccumulator)) {
      const accumulator = param.toolCallsAccumulator?.get(index);
      if (!accumulator || accumulator.startEmitted) continue;
      finalizeSingleToolCall(param, index, results);
    }
    param.contentBlocksStopped = true;

    emitBufferedInterleavedContent(param, results);
  }
}

function emitAnthropicMessageDelta(param: ConvertOpenAIResponseToAnthropicParams, results: string[]): void {
  if (param.messageDeltaSent) return;
  const usage: JSONObject = { input_tokens: param.usageInputTokens, output_tokens: param.usageOutputTokens };
  if (param.usageCachedTokens > 0) usage.cache_read_input_tokens = param.usageCachedTokens;
  if (param.usageCacheWriteTokens > 0) usage.cache_creation_input_tokens = param.usageCacheWriteTokens;
  results.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapOpenAIFinishReasonToAnthropic(terminalOpenAIFinishReason(param)), stop_sequence: null },
      usage,
    }),
  );
  param.messageDeltaSent = true;
}

function toolCallAccumulatorIndexes(accumulators: Map<number, ToolCallAccumulator> | undefined): number[] {
  if (!accumulators) return [];
  return [...accumulators.keys()].sort((a, b) => a - b);
}

/** Converts a non-streaming OpenAI response to a non-streaming Anthropic response. */
export function convertOpenAIResponseToClaudeNonStream(
  _ctx: TranslateContext,
  _model: string,
  originalRequestRawJSON: string,
  _requestRawJSON: string,
  rawJSON: string,
  _state: TranslatorState,
): string {
  const root = tryParse<unknown>(rawJSON);
  const toolNameMap = toolNameMapFromClaudeRequest(originalRequestRawJSON ?? "");
  const out = newClaudeMessageEnvelope(gstr(getAt(root, "id")), gstr(getAt(root, "model")));

  let hasToolCall = false;
  let finishReason = "";
  const blocks: JSONObject[] = [];

  const choices = getAt(root, "choices");
  if (isArr(choices) && choices.length > 0) {
    const choice = choices[0];
    finishReason = gstr(getAt(choice, "finish_reason"));

    const message = getAt(choice, "message");
    if (exists(message)) {
      const contentResult = getAt(message, "content");
      if (exists(contentResult)) {
        if (isArr(contentResult)) {
          let textBuilder = "";
          let thinkingBuilder = "";

          const flushText = (): void => {
            if (textBuilder.length === 0) return;
            blocks.push({ type: "text", text: textBuilder });
            textBuilder = "";
          };
          const flushThinking = (): void => {
            if (thinkingBuilder.length === 0) return;
            blocks.push({ type: "thinking", thinking: thinkingBuilder });
            thinkingBuilder = "";
          };

          for (const item of contentResult) {
            switch (gstr(getAt(item, "type"))) {
              case "text":
                flushThinking();
                textBuilder += gstr(getAt(item, "text"));
                break;
              case "tool_calls": {
                flushThinking();
                flushText();
                const toolCalls = getAt(item, "tool_calls");
                if (isArr(toolCalls)) {
                  for (const tc of toolCalls) {
                    hasToolCall = true;
                    blocks.push(toolUseBlockFromOpenAIToolCall(tc, toolNameMap));
                  }
                }
                break;
              }
              case "reasoning": {
                flushText();
                const thinking = getAt(item, "text");
                if (exists(thinking)) thinkingBuilder += gstr(thinking);
                break;
              }
              default:
                flushThinking();
                flushText();
            }
          }

          flushThinking();
          flushText();
        } else if (typeof contentResult === "string") {
          if (contentResult !== "") blocks.push({ type: "text", text: contentResult });
        }
      }

      for (const reasoningText of collectOpenAIObjectReasoningTexts(message)) {
        if (reasoningText === "") continue;
        blocks.push({ type: "thinking", thinking: reasoningText });
      }

      const toolCalls = getAt(message, "tool_calls");
      if (isArr(toolCalls)) {
        for (const toolCall of toolCalls) {
          hasToolCall = true;
          blocks.push(toolUseBlockFromOpenAIToolCall(toolCall, toolNameMap));
        }
      }
    }
  }

  if (blocks.length > 0) out.content = blocks;

  const respUsage = getAt(root, "usage");
  if (exists(respUsage)) setClaudeUsage(out, respUsage);

  out.stop_reason = mapOpenAINonStreamFinishReasonToAnthropic(finishReason, hasToolCall);

  return JSON.stringify(out);
}

/** Builds the Claude count_tokens response body. */
export function claudeTokenCount(_ctx: TranslateContext, count: number): string {
  return claudeInputTokensJSON(count);
}

export interface OpenAIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

/**
 * Reads OpenAI usage into Claude's accounting: cached and cache-write tokens are
 * deducted from input_tokens (clamped at zero) and reported separately.
 */
export function extractOpenAIUsage(usage: unknown): OpenAIUsage {
  if (!exists(usage) || usage === null) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };

  let inputTokens = gint(getAt(usage, "prompt_tokens"));
  const outputTokens = gint(getAt(usage, "completion_tokens"));
  const cachedTokens = gint(getAt(usage, "prompt_tokens_details.cached_tokens"));
  let cacheWriteTokens = gint(getAt(usage, "prompt_tokens_details.cache_write_tokens"));
  if (cacheWriteTokens <= 0) cacheWriteTokens = gint(getAt(usage, "prompt_tokens_details.cache_creation_tokens"));

  let deductTokens = 0;
  if (cachedTokens > 0) deductTokens += cachedTokens;
  if (cacheWriteTokens > 0) deductTokens += cacheWriteTokens;

  if (deductTokens > 0) inputTokens = inputTokens >= deductTokens ? inputTokens - deductTokens : 0;
  if (inputTokens < 0) inputTokens = 0;

  return { inputTokens, outputTokens, cachedTokens, cacheWriteTokens };
}

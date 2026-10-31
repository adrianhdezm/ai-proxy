// Port of internal/translator/gemini/claude/gemini_claude_response.go.
//
// Converts Gemini generateContent responses into Claude Messages responses: the
// streaming variant is a state machine fed one upstream chunk at a time (the JSON
// payload of a `data:` SSE line, with or without the `data: ` prefix, and finally
// the literal "[DONE]" to flush message_delta/message_stop) and returns complete
// Claude SSE frames; the non-stream variant converts a whole body.
//
// Addition for this port: the Gemini CLI (Code Assist) upstream wraps every chunk
// and non-stream body as {"response": {...gemini response...}, ...}; both variants
// unwrap a top-level "response" object when the root has no "candidates", so one
// translator serves the AI Studio and Gemini CLI executors.
import { sanitizeClaudeToolID } from "../../../util/claude_tool_id.ts";
import { gbool, getAt, gint, gstr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import {
  claudeToolIsParameterless,
  cleanClaudeToolArgumentsWithTranslated,
  mapToolName,
  restoreSanitizedToolName,
  sanitizedToolNameMap,
  unambiguousToolNameMapFromClaudeRequest,
} from "../../../util/translator.ts";
import { appendSSEEventString, claudeInputTokensJSON } from "../../common/index.ts";
import type { TranslateContext, TranslatorState } from "../../types.ts";
import { VertexStreamingToolCall, isVertexStreamingFunctionCall } from "../common/vertex_partial_args.ts";

/** Per-stream state of the Gemini -> Claude streaming conversion (Go: Params). */
export class GeminiClaudeStreamState {
  isGlAPIKey = false;
  hasFirstResponse = false;
  /** 0=none, 1=content, 2=thinking, 3=function */
  responseType = 0;
  responseIndex = 0;
  /** Whether any content (text, thinking, or tool use) has been output. */
  hasContent = false;
  toolNameMap: Map<string, string> | undefined;
  sanitizedNameMap: Map<string, string> | undefined;
  sawToolCall = false;
  hasFinalEvents = false;
  finishReason = "";
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  /** Client-facing name of the currently open tool_use block. */
  currentToolName = "";
  /** Whether the open tool_use block was declared parameterless. */
  currentToolIsParameterless = false;
  /** Whether cleaned input JSON was already emitted for the open tool_use block. */
  currentToolInputEmitted = false;
  /** Whether an empty "{}" input_json_delta is deferred awaiting tool_use completion. */
  currentToolPendingEmpty = false;
  activeToolCall: VertexStreamingToolCall | undefined;
  pendingToolThoughtSignatures: string[] = [];
  hasIncompleteToolCall = false;

  constructor(originalRequestRawJSON: string) {
    this.toolNameMap = unambiguousToolNameMapFromClaudeRequest(originalRequestRawJSON);
    this.sanitizedNameMap = sanitizedToolNameMap(originalRequestRawJSON);
  }
}

export const geminiMalformedFunctionCallErrorPayload = '{"type":"error","error":{"type":"api_error","message":"Gemini response finished with MALFORMED_FUNCTION_CALL"}}';

export function isGeminiMalformedFunctionCall(finishReason: string, sawToolCall: boolean): boolean {
  return finishReason === "MALFORMED_FUNCTION_CALL" && !sawToolCall;
}

export function resolveGeminiClaudeStopReason(finishReason: string, sawToolCall: boolean): string {
  if (sawToolCall) return "tool_use";
  switch (finishReason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "BLOCKLIST":
    case "IMAGE_SAFETY":
    case "MALFORMED_RESPONSE":
      return "refusal";
    case "STOP":
    case "FINISH_REASON_UNSPECIFIED":
    case "UNKNOWN":
    case "":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** Process-wide counter for tool_use identifiers (Go: toolUseIDCounter). */
let toolUseIDCounter = 0;

/** Resets the tool_use id counter (tests only; Go: atomic.StoreUint64(&toolUseIDCounter, 0)). */
export function resetGeminiClaudeToolUseIDCounter(value = 0): void {
  toolUseIDCounter = value;
}

function nextToolUseID(upstreamToolName: string): string {
  toolUseIDCounter++;
  return sanitizeClaudeToolID(`${upstreamToolName}-${toolUseIDCounter}`);
}

/** The text of one upstream stream chunk without its optional `data:` SSE prefix. */
export function geminiStreamPayloadText(rawJSON: string): string {
  let text = rawJSON.trim();
  if (text.startsWith("data:")) text = text.slice("data:".length).trim();
  return text;
}

/**
 * Parses a Gemini response payload and unwraps the Gemini CLI (Code Assist)
 * {"response": {...}} envelope when the root carries no "candidates".
 */
export function unwrapGeminiResponse(rawJSON: string): unknown {
  const parsed = tryParse<unknown>(geminiStreamPayloadText(rawJSON));
  if (isObj(parsed) && parsed.candidates === undefined && isObj(parsed.response)) return parsed.response;
  return parsed;
}

function partThoughtSignature(part: unknown): string {
  let sig = getAt(part, "thoughtSignature");
  if (sig === undefined) sig = getAt(part, "thought_signature");
  if (sig === undefined) return "";
  return gstr(sig);
}

const sseTrailingNewlines = 3;

/** Returns the per-stream state stored in `state.value`, creating it on the first chunk (Go: *param == nil). */
function streamState(state: TranslatorState, originalRequestRawJSON: string): GeminiClaudeStreamState {
  if (state.value instanceof GeminiClaudeStreamState) return state.value;
  const created = new GeminiClaudeStreamState(originalRequestRawJSON);
  state.value = created;
  return created;
}

/**
 * Streaming Gemini -> Claude SSE conversion (Go: ConvertGeminiResponseToClaude).
 * Returns zero or more strings, each holding complete Claude SSE frames.
 */
export function convertGeminiResponseToClaude(
  _ctx: TranslateContext,
  _model: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
): string[] {
  const p = streamState(state, originalRequestRawJSON);

  let output = "";
  const appendEvent = (event: string, payload: string): void => {
    output = appendSSEEventString(output, event, payload, sseTrailingNewlines);
  };
  const contentBlockStop = (index: number): string => `{"type":"content_block_stop","index":${index}}`;
  const delta = (index: number, body: Record<string, unknown>): string => JSON.stringify({ type: "content_block_delta", index, delta: body });
  const inputJSONDelta = (index: number, partialJSON: string): string => delta(index, { type: "input_json_delta", partial_json: partialJSON });
  const textBlockStart = (index: number): string => `{"type":"content_block_start","index":${index},"content_block":{"type":"text","text":""}}`;
  const thinkingBlockStart = (index: number): string => `{"type":"content_block_start","index":${index},"content_block":{"type":"thinking","thinking":""}}`;
  const messageDelta = (): string => {
    const stopReason = resolveGeminiClaudeStopReason(p.finishReason, p.sawToolCall);
    const usage: Record<string, unknown> = { input_tokens: p.inputTokens, output_tokens: p.outputTokens };
    if (p.cachedTokens > 0) usage.cache_read_input_tokens = p.cachedTokens;
    return JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage });
  };

  const flushPendingToolInput = (): void => {
    if (p.responseType === 3 && p.currentToolPendingEmpty && !p.currentToolInputEmitted) {
      appendEvent("content_block_delta", inputJSONDelta(p.responseIndex, "{}"));
      p.currentToolInputEmitted = true;
      p.currentToolPendingEmpty = false;
    }
  };
  const abortActiveToolCall = (): void => {
    p.hasIncompleteToolCall = true;
    if (p.activeToolCall) {
      p.activeToolCall = undefined;
      p.pendingToolThoughtSignatures = [];
      p.currentToolPendingEmpty = false;
      if (p.responseType === 3) {
        p.responseIndex++;
        p.responseType = 0;
      }
    }
  };
  const closeOpenBlock = (): void => {
    if (p.responseType !== 0) {
      flushPendingToolInput();
      appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
      p.responseType = 0;
    }
  };

  const payloadText = geminiStreamPayloadText(rawJSON);
  if (payloadText === "[DONE]") {
    if (p.activeToolCall || p.hasIncompleteToolCall) return [];
    if (isGeminiMalformedFunctionCall(p.finishReason, p.sawToolCall)) {
      closeOpenBlock();
      if (!p.hasFinalEvents) {
        appendEvent("error", geminiMalformedFunctionCallErrorPayload);
        p.hasFinalEvents = true;
      }
      return output.length > 0 ? [output] : [];
    }
    if (p.hasFirstResponse && !p.hasContent) {
      appendEvent("content_block_start", textBlockStart(p.responseIndex));
      p.responseType = 1;
      p.hasContent = true;
    }
    if (p.hasContent) {
      closeOpenBlock();
      if (!p.hasFinalEvents) {
        appendEvent("message_delta", messageDelta());
        p.hasFinalEvents = true;
      }
      appendEvent("message_stop", '{"type":"message_stop"}');
      return [output];
    }
    return [];
  }

  if (isGeminiMalformedFunctionCall(p.finishReason, p.sawToolCall) && p.hasFinalEvents) return [];

  const root = unwrapGeminiResponse(payloadText);

  const appendSignatureDelta = (signature: string): void => {
    if (signature === "" || p.responseType !== 2) return;
    appendEvent("content_block_delta", delta(p.responseIndex, { type: "signature_delta", signature }));
    p.hasContent = true;
  };

  const appendCarrierThinkingBlock = (signature: string): void => {
    if (signature === "") return;
    if (p.responseType !== 0) {
      flushPendingToolInput();
      appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
      p.responseIndex++;
      p.responseType = 0;
    }
    appendEvent("content_block_start", thinkingBlockStart(p.responseIndex));
    appendEvent("content_block_delta", delta(p.responseIndex, { type: "signature_delta", signature }));
    appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
    p.responseIndex++;
    p.responseType = 0;
    p.hasContent = true;
  };

  // Initialize the streaming session with a message_start event (first chunk only).
  if (!p.hasFirstResponse) {
    const message: Record<string, unknown> = {
      id: "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const modelVersion = getAt(root, "modelVersion");
    if (modelVersion !== undefined) message.model = gstr(modelVersion);
    const responseID = getAt(root, "responseId");
    if (responseID !== undefined) message.id = gstr(responseID);
    appendEvent("message_start", JSON.stringify({ type: "message_start", message }));
    p.hasFirstResponse = true;
  }

  // Process the response parts: text content, thinking content, or function calls.
  const parts = getAt(root, "candidates.0.content.parts");
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const textValue = getAt(part, "text");
      const textExists = textValue !== undefined;
      const partText = gstr(textValue);
      const functionCall = getAt(part, "functionCall");
      const partSig = partThoughtSignature(part);
      const hasThoughtSignature = partSig !== "";
      const isThought = gbool(getAt(part, "thought"));

      if (hasThoughtSignature && (!textExists || partText === "") && functionCall === undefined) {
        if (p.responseType === 2) {
          appendSignatureDelta(partSig);
          continue;
        }
        if (p.activeToolCall) {
          p.pendingToolThoughtSignatures.push(partSig);
          continue;
        }
        appendCarrierThinkingBlock(partSig);
        continue;
      }

      if (isThought) {
        if (hasThoughtSignature && (!textExists || partText === "")) {
          if (p.responseType === 2) appendSignatureDelta(partSig);
          else if (p.activeToolCall) p.pendingToolThoughtSignatures.push(partSig);
          else appendCarrierThinkingBlock(partSig);
          continue;
        }
        if (p.activeToolCall) {
          if (!textExists || partText === "") continue;
          abortActiveToolCall();
        }

        if (p.responseType === 2) {
          appendEvent("content_block_delta", delta(p.responseIndex, { type: "thinking_delta", thinking: partText }));
          p.hasContent = true;
        } else {
          if (p.responseType !== 0) {
            flushPendingToolInput();
            appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
            p.responseIndex++;
          }
          appendEvent("content_block_start", thinkingBlockStart(p.responseIndex));
          appendEvent("content_block_delta", delta(p.responseIndex, { type: "thinking_delta", thinking: partText }));
          p.responseType = 2;
          p.hasContent = true;
        }
        if (hasThoughtSignature) appendSignatureDelta(partSig);
        continue;
      }

      // From here on, !isThought (visible text, functionCall, or standalone signature).
      if (functionCall !== undefined) {
        const rawToolName = gstr(getAt(functionCall, "name")).trim();
        const upstreamToolName = restoreSanitizedToolName(p.sanitizedNameMap, rawToolName);
        const clientToolName = mapToolName(p.toolNameMap, upstreamToolName);
        const fcArgs = getAt(functionCall, "args");

        const active = p.activeToolCall;
        if (active && active.canContinueWith(functionCall)) {
          p.sawToolCall = true;
          const [argsDelta, fcDone] = active.assembler.pushFunctionCall(functionCall);
          if (active.assembler.err()) {
            abortActiveToolCall();
            continue;
          }
          if (p.currentToolIsParameterless) {
            if (fcDone && !p.currentToolInputEmitted) {
              appendEvent("content_block_delta", inputJSONDelta(active.index, "{}"));
              p.currentToolInputEmitted = true;
              p.currentToolPendingEmpty = false;
            }
          } else if (argsDelta !== "") {
            appendEvent("content_block_delta", inputJSONDelta(active.index, argsDelta));
            p.currentToolInputEmitted = true;
            p.currentToolPendingEmpty = false;
          }
          if (hasThoughtSignature) p.pendingToolThoughtSignatures.push(partSig);
          if (fcDone) {
            p.activeToolCall = undefined;
            flushPendingToolInput();
            appendEvent("content_block_stop", contentBlockStop(active.index));
            p.responseIndex = active.index + 1;
            p.responseType = 0;
            if (p.pendingToolThoughtSignatures.length > 0) {
              const sigs = p.pendingToolThoughtSignatures;
              p.pendingToolThoughtSignatures = [];
              for (const sig of sigs) appendCarrierThinkingBlock(sig);
            }
          }
          continue;
        }

        if (isVertexStreamingFunctionCall(functionCall)) {
          if (p.activeToolCall) abortActiveToolCall();
          if (rawToolName === "") {
            abortActiveToolCall();
            continue;
          }
          const upstreamID = gstr(getAt(functionCall, "id")).trim();
          const toolID = nextToolUseID(upstreamToolName);
          const streaming = new VertexStreamingToolCall(rawToolName, clientToolName, upstreamID, toolID, 0);
          if (originalRequestRawJSON.length > 0) {
            const toolNameForClean = clientToolName;
            const origReq = originalRequestRawJSON;
            const transReq = requestRawJSON;
            streaming.assembler.setArgumentCleaner((rawArgs: string) => cleanClaudeToolArgumentsWithTranslated(rawArgs, toolNameForClean, origReq, transReq));
          }
          const [argsDelta, fcDone] = streaming.assembler.pushFunctionCall(functionCall);
          if (streaming.assembler.err()) {
            p.hasIncompleteToolCall = true;
            continue;
          }

          p.sawToolCall = true;
          if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);
          if (p.responseType !== 0) {
            flushPendingToolInput();
            appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
            p.responseIndex++;
            p.responseType = 0;
          }

          streaming.index = p.responseIndex;
          p.currentToolName = clientToolName;
          p.currentToolIsParameterless = claudeToolIsParameterless(clientToolName, originalRequestRawJSON);
          p.currentToolInputEmitted = false;
          p.currentToolPendingEmpty = false;
          appendEvent(
            "content_block_start",
            JSON.stringify({ type: "content_block_start", index: p.responseIndex, content_block: { type: "tool_use", id: toolID, name: clientToolName, input: {} } }),
          );
          p.responseType = 3;
          p.hasContent = true;

          if (p.currentToolIsParameterless) {
            if (fcDone) {
              appendEvent("content_block_delta", inputJSONDelta(streaming.index, "{}"));
              p.currentToolInputEmitted = true;
            }
          } else if (argsDelta !== "") {
            appendEvent("content_block_delta", inputJSONDelta(streaming.index, argsDelta));
            p.currentToolInputEmitted = true;
          }
          if (fcDone) {
            flushPendingToolInput();
            appendEvent("content_block_stop", contentBlockStop(streaming.index));
            p.responseIndex = streaming.index + 1;
            p.responseType = 0;
          } else {
            p.activeToolCall = streaming;
          }
          continue;
        }

        if (p.activeToolCall) abortActiveToolCall();
        if (p.responseType === 3 && upstreamToolName === "") {
          if (fcArgs !== undefined) {
            p.sawToolCall = true;
            let partialJSON = cleanClaudeToolArgumentsWithTranslated(JSON.stringify(fcArgs), p.currentToolName, originalRequestRawJSON, requestRawJSON);
            if (p.currentToolIsParameterless) {
              if (p.currentToolInputEmitted) {
                partialJSON = "";
              } else {
                p.currentToolInputEmitted = true;
                p.currentToolPendingEmpty = false;
              }
            } else if (partialJSON === "{}") {
              if (!p.currentToolInputEmitted) p.currentToolPendingEmpty = true;
              partialJSON = "";
            } else if (partialJSON !== "") {
              p.currentToolInputEmitted = true;
              p.currentToolPendingEmpty = false;
            }
            if (partialJSON !== "" || !p.currentToolPendingEmpty) appendEvent("content_block_delta", inputJSONDelta(p.responseIndex, partialJSON));
          }
          if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);
          continue;
        }
        if (rawToolName === "" && fcArgs === undefined) {
          if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);
          continue;
        }
        p.sawToolCall = true;

        if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);

        if (p.responseType === 3) {
          flushPendingToolInput();
          appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
          p.responseIndex++;
          p.responseType = 0;
        }
        if (p.responseType !== 0) {
          flushPendingToolInput();
          appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
          p.responseIndex++;
        }

        p.currentToolName = clientToolName;
        p.currentToolIsParameterless = claudeToolIsParameterless(clientToolName, originalRequestRawJSON);
        p.currentToolInputEmitted = false;
        p.currentToolPendingEmpty = false;
        appendEvent(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: p.responseIndex,
            content_block: { type: "tool_use", id: nextToolUseID(upstreamToolName), name: clientToolName, input: {} },
          }),
        );

        if (fcArgs !== undefined) {
          let partialJSON = cleanClaudeToolArgumentsWithTranslated(JSON.stringify(fcArgs), clientToolName, originalRequestRawJSON, requestRawJSON);
          if (p.currentToolIsParameterless) {
            if (p.currentToolInputEmitted) partialJSON = "";
            else p.currentToolInputEmitted = true;
          } else if (partialJSON === "{}") {
            p.currentToolPendingEmpty = true;
            partialJSON = "";
          } else if (partialJSON !== "") {
            p.currentToolInputEmitted = true;
          }
          if (partialJSON !== "" || !p.currentToolPendingEmpty) appendEvent("content_block_delta", inputJSONDelta(p.responseIndex, partialJSON));
        }
        p.responseType = 3;
        p.hasContent = true;
        continue;
      }

      if (textExists) {
        if (hasThoughtSignature && partText === "") {
          if (p.responseType === 2) {
            appendSignatureDelta(partSig);
            continue;
          }
          if (p.activeToolCall) {
            p.pendingToolThoughtSignatures.push(partSig);
            continue;
          }
          appendCarrierThinkingBlock(partSig);
          continue;
        }
        if (p.activeToolCall) {
          if (partText === "") continue;
          abortActiveToolCall();
        }
        if (hasThoughtSignature) appendCarrierThinkingBlock(partSig);
        if (p.responseType === 1) {
          appendEvent("content_block_delta", delta(p.responseIndex, { type: "text_delta", text: partText }));
          p.hasContent = true;
        } else {
          if (p.responseType !== 0) {
            flushPendingToolInput();
            appendEvent("content_block_stop", contentBlockStop(p.responseIndex));
            p.responseIndex++;
          }
          appendEvent("content_block_start", textBlockStart(p.responseIndex));
          appendEvent("content_block_delta", delta(p.responseIndex, { type: "text_delta", text: partText }));
          p.responseType = 1;
          p.hasContent = true;
        }
        continue;
      }

      if (hasThoughtSignature) {
        if (p.activeToolCall) {
          p.pendingToolThoughtSignatures.push(partSig);
          continue;
        }
        appendCarrierThinkingBlock(partSig);
        continue;
      }
    }
  }

  const finish = getAt(root, "candidates.0.finishReason");
  if (finish !== undefined && gstr(finish) !== "") {
    p.finishReason = gstr(finish);
    flushPendingToolInput();
  }

  const usage = getAt(root, "usageMetadata");
  if (usage !== undefined) {
    const cachedTokens = gint(getAt(usage, "cachedContentTokenCount"));
    let promptTokens = gint(getAt(usage, "promptTokenCount")) - cachedTokens;
    if (promptTokens < 0) promptTokens = 0;
    let outputTokens = gint(getAt(usage, "candidatesTokenCount")) + gint(getAt(usage, "thoughtsTokenCount"));
    if (outputTokens === 0 && gint(getAt(usage, "totalTokenCount")) > 0) {
      outputTokens = gint(getAt(usage, "totalTokenCount")) - gint(getAt(usage, "promptTokenCount"));
      if (outputTokens < 0) outputTokens = 0;
    }
    p.inputTokens = promptTokens;
    p.outputTokens = outputTokens;
    p.cachedTokens = cachedTokens;
  }

  if (isGeminiMalformedFunctionCall(p.finishReason, p.sawToolCall) && !p.hasFinalEvents) {
    closeOpenBlock();
    appendEvent("error", geminiMalformedFunctionCallErrorPayload);
    p.hasFinalEvents = true;
    return [output];
  }

  if (usage !== undefined && payloadText.includes('"finishReason"') && !p.hasFinalEvents && !p.activeToolCall && !p.hasIncompleteToolCall) {
    if (!p.hasContent && p.hasFirstResponse) {
      appendEvent("content_block_start", textBlockStart(p.responseIndex));
      p.responseType = 1;
      p.hasContent = true;
    }
    if (p.hasContent) {
      closeOpenBlock();
      appendEvent("message_delta", messageDelta());
      p.hasFinalEvents = true;
    }
  }

  return output.length > 0 ? [output] : [];
}

/** Non-streaming Gemini -> Claude conversion (Go: ConvertGeminiResponseToClaudeNonStream). */
export function convertGeminiResponseToClaudeNonStream(
  _ctx: TranslateContext,
  _model: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  _state: TranslatorState,
): string {
  const root = unwrapGeminiResponse(rawJSON);
  const toolNameMap = unambiguousToolNameMapFromClaudeRequest(originalRequestRawJSON);
  const sanitizedNameMap = sanitizedToolNameMap(originalRequestRawJSON);

  const out: Record<string, unknown> = {
    id: gstr(getAt(root, "responseId")),
    type: "message",
    role: "assistant",
    model: gstr(getAt(root, "modelVersion")),
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const cachedTokens = gint(getAt(root, "usageMetadata.cachedContentTokenCount"));
  let inputTokens = gint(getAt(root, "usageMetadata.promptTokenCount")) - cachedTokens;
  if (inputTokens < 0) inputTokens = 0;
  const outputTokens = gint(getAt(root, "usageMetadata.candidatesTokenCount")) + gint(getAt(root, "usageMetadata.thoughtsTokenCount"));
  const usage: Record<string, unknown> = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (cachedTokens > 0) usage.cache_read_input_tokens = cachedTokens;
  out.usage = usage;

  const parts = getAt(root, "candidates.0.content.parts");
  let textBuilder = "";
  let thinkingBuilder = "";
  let thinkingSignature = "";
  let hasToolCall = false;
  const blocks: unknown[] = [];

  const flushText = (): void => {
    if (textBuilder.length === 0) return;
    blocks.push({ type: "text", text: textBuilder });
    textBuilder = "";
  };
  const flushThinking = (): void => {
    if (thinkingBuilder.length === 0 && thinkingSignature === "") return;
    const block: Record<string, unknown> = { type: "thinking", thinking: thinkingBuilder };
    if (thinkingSignature !== "") block.signature = thinkingSignature;
    blocks.push(block);
    thinkingBuilder = "";
    thinkingSignature = "";
  };
  const appendCarrierThinkingBlock = (signature: string): void => {
    if (signature === "") return;
    blocks.push({ type: "thinking", thinking: "", signature });
  };

  if (Array.isArray(parts)) {
    for (const part of parts) {
      const partSig = partThoughtSignature(part);
      const textValue = getAt(part, "text");
      const textExists = textValue !== undefined;
      const text = gstr(textValue);
      const functionCall = getAt(part, "functionCall");
      const isThought = gbool(getAt(part, "thought"));

      if (isThought) {
        flushText();
        if (partSig !== "") thinkingSignature = partSig;
        if (textExists && text !== "") thinkingBuilder += text;
        continue;
      }

      // A part without visible text or function call while thinking is in progress:
      // its signature belongs to the thinking block.
      if ((!textExists || text === "") && functionCall === undefined) {
        if (thinkingBuilder.length > 0 && partSig !== "") {
          thinkingSignature = partSig;
          continue;
        }
        if (partSig !== "") {
          flushThinking();
          flushText();
          appendCarrierThinkingBlock(partSig);
          continue;
        }
        continue;
      }

      // From here on, !isThought (visible text or functionCall).
      flushThinking();

      if (functionCall !== undefined) {
        flushText();
        if (partSig !== "") appendCarrierThinkingBlock(partSig);
        hasToolCall = true;

        let upstreamToolName = gstr(getAt(functionCall, "name"));
        upstreamToolName = restoreSanitizedToolName(sanitizedNameMap, upstreamToolName);
        const clientToolName = mapToolName(toolNameMap, upstreamToolName);
        let input: unknown = {};
        const args = getAt(functionCall, "args");
        if (isObj(args)) {
          const cleaned = cleanClaudeToolArgumentsWithTranslated(JSON.stringify(args), clientToolName, originalRequestRawJSON, requestRawJSON);
          const parsed = tryParse<unknown>(cleaned);
          input = parsed === undefined ? args : parsed;
        }
        blocks.push({ type: "tool_use", id: nextToolUseID(upstreamToolName), name: clientToolName, input });
        continue;
      }

      if (textExists && text !== "") {
        if (partSig !== "") {
          flushText();
          appendCarrierThinkingBlock(partSig);
        }
        textBuilder += text;
        continue;
      }

      if (partSig !== "") {
        flushText();
        appendCarrierThinkingBlock(partSig);
        continue;
      }
    }
  }

  flushThinking();
  flushText();

  if (blocks.length > 0) out.content = blocks;

  let finishReason = "";
  const finish = getAt(root, "candidates.0.finishReason");
  if (finish !== undefined) finishReason = gstr(finish);
  if (isGeminiMalformedFunctionCall(finishReason, hasToolCall)) return geminiMalformedFunctionCallErrorPayload;
  out.stop_reason = resolveGeminiClaudeStopReason(finishReason, hasToolCall);

  if (inputTokens === 0 && outputTokens === 0 && getAt(root, "usageMetadata") === undefined) delete out.usage;

  return JSON.stringify(out);
}

/** Claude count_tokens response for a Gemini token count (Go: ClaudeTokenCount). */
export function claudeTokenCount(_ctx: TranslateContext, count: number): string {
  return claudeInputTokensJSON(count);
}

// Port of internal/translator/openai/openai/responses/openai_openai-responses_request.go.
//
// OpenAI Responses request -> OpenAI Chat Completions request: instructions
// become a system message, input items become messages (consecutive function
// calls are grouped into one assistant message, reasoning items attach as
// reasoning_content, orphan tool outputs become user text), Responses tools are
// flattened to function tools, text.format maps to response_format and
// reasoning.effort to reasoning_effort.
//
// Throws an UnsupportedPartError (RequestRejectedError, HTTP 400) when a user
// turn would be sent empty because none of its parts are representable.
import { getAt, gbool, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { UserTurnDrops } from "../../../common/parts.ts";
import { extractResponsesCallID, normalizeResponsesToolCallOutputs } from "../../../common/responses.ts";
import { alignOpenAIToolCallMessages } from "../../../common/openai_tools.ts";
import { goValue, parseJSON, validJSON } from "./go_json.ts";
import { type ResponsesToolIndex, newResponsesToolIndex, responsesToolOutputText } from "./tools.ts";
import { shellHistory } from "./shell_tool.ts";

type JSONObject = Record<string, unknown>;

const reasoningUnavailable = "[reasoning unavailable]";

/** Converts an OpenAI Responses request to Chat Completions (Go: ConvertOpenAIResponsesRequestToOpenAIChatCompletions). */
export function convertOpenAIResponsesRequestToOpenAIChatCompletions(modelName: string, inputRawJSON: string, stream: boolean): string {
  const [body, err] = convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError(modelName, inputRawJSON, stream);
  if (err) throw err;
  return body;
}

/**
 * Same conversion, returning the body together with the refusal instead of
 * throwing (Go returned both; the body is always valid JSON).
 */
export function convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError(modelName: string, inputRawJSON: string, stream: boolean): [string, Error | undefined] {
  const drops = new UserTurnDrops();
  const root = parseJSON(inputRawJSON);
  const toolIndex = newResponsesToolIndex(root);
  const out: JSONObject = { model: modelName, messages: [], stream };
  let messages: JSONObject[] = [];

  // Map Responses text format to Chat Completions response format.
  const textFormat = getAt(root, "text.format");
  if (textFormat !== undefined) {
    const responseFormat = convertResponsesTextFormatToChatResponseFormat(textFormat);
    if (responseFormat) out.response_format = responseFormat;
  }

  const maxTokens = getAt(root, "max_output_tokens");
  if (maxTokens !== undefined) out.max_tokens = maxTokens;

  const instructions = getAt(root, "instructions");
  if (instructions !== undefined) messages.push({ role: "system", content: gstr(instructions) });

  const duplicateOutputIDs = new Set<string>();
  const input = getAt(root, "input");
  if (isArr(input)) {
    const rawInputArray = shellHistory(toolIndex, input);
    const explicitOutputCounts = new Map<string, number>();
    let missingIDOutputsCount = 0;
    for (const item of rawInputArray) {
      const itemType = gstr(getAt(item, "type"));
      if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        const id = extractResponsesCallID(item);
        if (id !== "") explicitOutputCounts.set(id, (explicitOutputCounts.get(id) ?? 0) + 1);
        else missingIDOutputsCount++;
      }
    }
    const unclaimedCalls = new Set<string>();
    for (const item of rawInputArray) {
      const itemType = gstr(getAt(item, "type"));
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const id = extractResponsesCallID(item);
        if (id !== "" && (explicitOutputCounts.get(id) ?? 0) === 0) unclaimedCalls.add(id);
      }
    }

    const inputItems = normalizeResponsesToolCallOutputs(rawInputArray);
    if (missingIDOutputsCount > 1 || (missingIDOutputsCount > 0 && unclaimedCalls.size > 1)) {
      inputItems.forEach((item, idx) => {
        const itemType = gstr(getAt(item, "type"));
        if (itemType !== "function_call_output" && itemType !== "custom_tool_call_output") return;
        if (idx < rawInputArray.length && extractResponsesCallID(rawInputArray[idx]) === "" && isObj(item)) {
          const copy = { ...item };
          delete copy.call_id;
          delete copy.tool_call_id;
          delete copy.callId;
          inputItems[idx] = copy;
        }
      });
    }

    let hasReasoningInSession = false;
    const effortRes = getAt(root, "reasoning.effort");
    const legacyEffort = getAt(root, "reasoning_effort");
    const reasoningObj = getAt(root, "reasoning");
    if (effortRes !== undefined) {
      hasReasoningInSession = usableEffort(gstr(effortRes));
    } else if (legacyEffort !== undefined) {
      hasReasoningInSession = usableEffort(gstr(legacyEffort));
    } else if (reasoningObj !== undefined) {
      const reasoningRaw = gstr(reasoningObj).trim().toLowerCase();
      hasReasoningInSession = reasoningRaw !== "" && reasoningRaw !== "none" && reasoningRaw !== "false" && reasoningRaw !== "{}";
    }
    if (!hasReasoningInSession) {
      hasReasoningInSession = rawInputArray.some((item) => gstr(getAt(item, "type")) === "reasoning" || getAt(item, "reasoning_content") !== undefined);
    }

    let pendingToolCalls: JSONObject[] = [];
    let pendingToolCallIDs: string[] = [];
    let pendingReasoningContent = "";
    let latestReasoningContent = "";
    const awaitingToolOutputs = new Set<string>();
    const outputCounts = new Map<string, number>();
    let mergeableAssistantIndex = -1;

    const fallbackToolReasoning = (): string => {
      if (latestReasoningContent !== "") return latestReasoningContent;
      return hasReasoningInSession ? reasoningUnavailable : "";
    };
    const takePendingReasoningContent = (): string => {
      const reasoningContent = pendingReasoningContent;
      pendingReasoningContent = "";
      return reasoningContent;
    };
    const flushPendingToolCalls = (): void => {
      if (pendingToolCalls.length === 0) return;
      const reasoningContent = takePendingReasoningContent();
      let mergedIntoAssistant = false;
      if (mergeableAssistantIndex >= 0 && mergeableAssistantIndex === messages.length - 1) {
        const assistantMessage = messages[mergeableAssistantIndex]!;
        if (gstr(assistantMessage.role) === "assistant" && assistantMessage.tool_calls === undefined) {
          assistantMessage.tool_calls = pendingToolCalls;
          const combinedReasoning = combineOpenAIResponsesReasoning(gstr(assistantMessage.reasoning_content), reasoningContent);
          if (combinedReasoning !== "") {
            assistantMessage.reasoning_content = combinedReasoning;
            if (isUsableResponsesReasoning(combinedReasoning)) latestReasoningContent = combinedReasoning;
          } else {
            const fallback = fallbackToolReasoning();
            if (fallback !== "") assistantMessage.reasoning_content = fallback;
          }
          mergedIntoAssistant = true;
        }
      }
      if (!mergedIntoAssistant) {
        const assistantMessage: JSONObject = { role: "assistant", tool_calls: pendingToolCalls };
        if (reasoningContent !== "") {
          assistantMessage.reasoning_content = reasoningContent;
          if (isUsableResponsesReasoning(reasoningContent)) latestReasoningContent = reasoningContent;
        } else {
          const fallback = fallbackToolReasoning();
          if (fallback !== "") assistantMessage.reasoning_content = fallback;
        }
        messages.push(assistantMessage);
      }
      for (const id of pendingToolCallIDs) {
        const trimmed = id.trim();
        if (trimmed !== "") awaitingToolOutputs.add(trimmed);
      }
      pendingToolCalls = [];
      pendingToolCallIDs = [];
      mergeableAssistantIndex = -1;
    };
    const appendRegularMessage = (message: JSONObject): number => {
      messages.push(message);
      return messages.length - 1;
    };
    const appendPendingReasoningMessage = (): void => {
      const reasoningContent = takePendingReasoningContent();
      if (reasoningContent === "") return;
      if (isUsableResponsesReasoning(reasoningContent)) latestReasoningContent = reasoningContent;
      appendRegularMessage({ role: "assistant", content: "", reasoning_content: reasoningContent });
    };
    const takeToolCallReasoning = (item: unknown): void => {
      const rc = gstr(getAt(item, "reasoning_content"));
      pendingReasoningContent = combineOpenAIResponsesReasoning(pendingReasoningContent, rc);
      if (isUsableResponsesReasoning(rc)) latestReasoningContent = rc;
    };
    const countOutput = (callID: string): void => {
      if (callID === "") return;
      const count = (outputCounts.get(callID) ?? 0) + 1;
      outputCounts.set(callID, count);
      if (count > 1) duplicateOutputIDs.add(callID);
    };

    for (const item of inputItems) {
      let itemType = gstr(getAt(item, "type"));
      if (itemType === "" && gstr(getAt(item, "role")) !== "") itemType = "message";
      if (itemType !== "function_call" && itemType !== "custom_tool_call") flushPendingToolCalls();

      switch (itemType) {
        case "message":
        case "": {
          let role = gstr(getAt(item, "role"));
          // Only a real user turn can be refused; developer text is sent as user text
          // but never counts as the user's own turn.
          const isUserTurn = role === "user";
          if (role === "developer") role = "user";
          mergeableAssistantIndex = -1;
          if (role !== "assistant") {
            appendPendingReasoningMessage();
            latestReasoningContent = "";
          }
          const message: JSONObject = { role, content: [] };
          const content = getAt(item, "content");
          if (isArr(content)) {
            const contentItems: JSONObject[] = [];
            // Counts the parts this turn really sends; an empty text part does not.
            let turnSendable = 0;
            for (const contentItem of content) {
              let contentType = gstr(getAt(contentItem, "type"));
              if (contentType === "") contentType = "input_text";
              switch (contentType) {
                case "input_text":
                case "output_text": {
                  const text = gstr(getAt(contentItem, "text"));
                  contentItems.push({ type: "text", text });
                  if (text !== "") turnSendable++;
                  break;
                }
                case "input_video":
                case "video_url": {
                  const part: JSONObject = { type: "video_url", video_url: {} };
                  const videoURL = getAt(contentItem, "video_url");
                  if (isObj(videoURL)) part.video_url = { ...videoURL };
                  else if (videoURL !== undefined) part.video_url = { url: videoURL };
                  const processing = getAt(contentItem, "processing");
                  if (processing !== undefined) (part.video_url as JSONObject).processing = processing;
                  // Malformed video parts are preserved for upstream validation.
                  contentItems.push(part);
                  turnSendable++;
                  break;
                }
                case "input_image": {
                  const imageURL: JSONObject = { url: gstr(getAt(contentItem, "image_url")) };
                  const [detail, ok] = normalizeChatImageDetail(getAt(contentItem, "detail"));
                  if (ok && detail !== "") imageURL.detail = detail;
                  contentItems.push({ type: "image_url", image_url: imageURL });
                  turnSendable++;
                  break;
                }
                case "input_file": {
                  const part = responsesInputFileToChatPart(contentItem);
                  if (part) {
                    contentItems.push(part);
                    turnSendable++;
                  } else if (isUserTurn) {
                    // Chat Completions takes a file id or inline bytes only.
                    drops.drop(contentType);
                  }
                  break;
                }
                case "input_audio": {
                  const part = responsesInputAudioToChatPart(contentItem);
                  if (part) {
                    contentItems.push(part);
                    turnSendable++;
                  } else if (isUserTurn) {
                    drops.drop(contentType);
                  }
                  break;
                }
              }
            }
            if (isUserTurn) drops.endTurn(turnSendable);
            if (contentItems.length > 0) message.content = contentItems;
          } else if (typeof content === "string") {
            message.content = content;
          }

          if (role === "assistant") {
            const reasoningContent = combineOpenAIResponsesReasoning(takePendingReasoningContent(), gstr(getAt(item, "reasoning_content")));
            if (reasoningContent !== "") {
              message.reasoning_content = reasoningContent;
              if (isUsableResponsesReasoning(reasoningContent)) latestReasoningContent = reasoningContent;
            }
          }
          const messageIndex = appendRegularMessage(message);
          if (role === "assistant") mergeableAssistantIndex = messageIndex;
          break;
        }

        case "reasoning": {
          const reasoningContent = collectOpenAIResponsesReasoningContent(item);
          pendingReasoningContent = combineOpenAIResponsesReasoning(pendingReasoningContent, reasoningContent);
          if (isUsableResponsesReasoning(reasoningContent)) latestReasoningContent = reasoningContent;
          break;
        }

        case "function_call": {
          takeToolCallReasoning(item);
          // Buffer consecutive function calls and emit them as one assistant message.
          const fn: JSONObject = { arguments: "", name: "" };
          const toolCall: JSONObject = { function: fn, id: "", type: "function" };
          const callID = extractResponsesCallID(item);
          if (callID !== "") toolCall.id = callID;
          const name = getAt(item, "name");
          if (name !== undefined) {
            const namespace = gstr(getAt(item, "namespace")).trim();
            fn.name = namespace !== "" ? toolIndex.namespaceName(namespace, gstr(name)) : toolIndex.canonicalName(gstr(name));
          }
          const args = getAt(item, "arguments");
          if (args !== undefined) fn.arguments = gstr(args);
          pendingToolCalls.push(toolCall);
          if (callID !== "") pendingToolCallIDs.push(callID);
          break;
        }

        case "function_call_output":
        case "custom_tool_call_output": {
          mergeableAssistantIndex = -1;
          const callID = extractResponsesCallID(item);
          countOutput(callID);
          const setContent = itemType === "function_call_output" ? setFunctionCallOutputContent : setCustomToolCallOutputContent;
          const output = getAt(item, "output");
          if (!awaitingToolOutputs.has(callID)) {
            // Orphan outputs (empty call_id or no matching assistant tool_calls,
            // e.g. Codex send_message_to_thread cards) become user text.
            appendStandaloneResponsesToolOutputAsUser(output, setContent, appendRegularMessage);
          } else {
            let toolMessage: JSONObject = { role: "tool", tool_call_id: callID, content: "" };
            awaitingToolOutputs.delete(callID);
            if (output !== undefined) toolMessage = setContent(toolMessage, output);
            messages.push(toolMessage);
          }
          break;
        }

        case "custom_tool_call": {
          takeToolCallReasoning(item);
          // Codex freeform tool call replay: wrap the raw input so it matches the
          // {"input": string} function shape used for custom tool definitions.
          const callID = extractResponsesCallID(item);
          const namespace = gstr(getAt(item, "namespace"));
          const rawName = gstr(getAt(item, "name"));
          const functionName = namespace !== "" ? toolIndex.namespaceName(namespace, rawName) : toolIndex.canonicalName(rawName);
          const wrappedArgs = JSON.stringify({ input: gstr(getAt(item, "input")) });
          pendingToolCalls.push({ function: { arguments: wrappedArgs, name: functionName }, id: callID, type: "function" });
          if (callID !== "") pendingToolCallIDs.push(callID);
          break;
        }

        default:
          mergeableAssistantIndex = -1;
      }
    }
    flushPendingToolCalls();
    appendPendingReasoningMessage();
  } else if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  }

  if (messages.length > 0) {
    messages = alignOpenAIToolCallMessages(messages, ...duplicateOutputIDs) as JSONObject[];
    out.messages = messages;
  }

  // Codex Desktop (Responses Lite) delivers tool definitions through an
  // "additional_tools" input item as well as the top-level "tools" field.
  const chatTools = toolIndex.chatTools();
  if (chatTools.length > 0) {
    // Go stored gjson Value()s, which encoding/json writes with sorted keys.
    out.tools = goValue(chatTools);
    const parallelToolCalls = getAt(root, "parallel_tool_calls");
    if (parallelToolCalls !== undefined) out.parallel_tool_calls = gbool(parallelToolCalls);
    const toolChoice = getAt(root, "tool_choice");
    if (toolChoice !== undefined) out.tool_choice = convertResponsesToolChoiceWithIndex(toolChoice, toolIndex);
  }

  const reasoningEffort = getAt(root, "reasoning.effort");
  if (reasoningEffort !== undefined) {
    const effort = gstr(reasoningEffort).trim().toLowerCase();
    if (effort !== "") out.reasoning_effort = effort;
  }

  return [JSON.stringify(out), drops.err()];
}

function usableEffort(raw: string): boolean {
  const effort = raw.trim().toLowerCase();
  return effort !== "" && effort !== "none" && effort !== "0" && effort !== "false";
}

/** Maps an input_file part to a Chat file part; undefined without a file id or inline bytes. */
export function responsesInputFileToChatPart(contentItem: unknown): JSONObject | undefined {
  const fileID = gstr(getAt(contentItem, "file_id"));
  const fileData = gstr(getAt(contentItem, "file_data"));
  if (fileID === "" && fileData === "") return undefined;
  const file: JSONObject = {};
  if (fileID !== "") file.file_id = fileID;
  if (fileData !== "") file.file_data = fileData;
  const filename = gstr(getAt(contentItem, "filename"));
  if (filename !== "") file.filename = filename;
  return { type: "file", file };
}

/** Maps an input_audio part to a Chat input_audio part; undefined without bytes. */
export function responsesInputAudioToChatPart(contentItem: unknown): JSONObject | undefined {
  let data = gstr(getAt(contentItem, "input_audio.data"));
  if (data === "") data = gstr(getAt(contentItem, "data"));
  if (data === "") return undefined;
  let format = gstr(getAt(contentItem, "input_audio.format"));
  if (format === "") format = gstr(getAt(contentItem, "format"));
  const audio: JSONObject = { data };
  if (format !== "") audio.format = format;
  return { type: "input_audio", input_audio: audio };
}

export function convertResponsesToolChoiceToChatCompletions(toolChoice: unknown, inputRawJSON: string): unknown {
  return convertResponsesToolChoiceWithIndex(toolChoice, newResponsesToolIndex(parseJSON(inputRawJSON)));
}

export function convertResponsesToolChoiceWithIndex(toolChoice: unknown, toolIndex: ResponsesToolIndex): unknown {
  if (!isObj(toolChoice)) return toolChoice;
  const choiceType = gstr(toolChoice.type);
  if (choiceType === "shell") {
    const name = toolIndex.shellName();
    if (name !== "") return { type: "function", function: { name } };
  }
  if (choiceType !== "function" && choiceType !== "custom") return toolChoice;

  let name = gstr(getAt(toolChoice, "function.name"));
  if (name === "") name = gstr(getAt(toolChoice, "custom.name"));
  if (name === "") name = gstr(getAt(toolChoice, "name"));
  if (name === "") return toolChoice;

  let namespace = gstr(getAt(toolChoice, "namespace")).trim();
  if (namespace === "") namespace = gstr(getAt(toolChoice, "function.namespace")).trim();
  if (namespace === "") namespace = gstr(getAt(toolChoice, "custom.namespace")).trim();
  name = namespace !== "" ? toolIndex.namespaceName(namespace, name) : toolIndex.canonicalName(name);
  return { type: "function", function: { name } };
}

export function convertResponsesTextFormatToChatResponseFormat(textFormat: unknown): JSONObject | undefined {
  const formatType = gstr(getAt(textFormat, "type"));
  switch (formatType) {
    case "text":
    case "json_object":
      return { type: formatType };
    case "json_schema": {
      const jsonSchema: JSONObject = {};
      for (const field of ["name", "description", "strict"]) {
        const value = getAt(textFormat, field);
        if (value !== undefined) jsonSchema[field] = goValue(value);
      }
      const schema = getAt(textFormat, "schema");
      if (schema !== undefined) jsonSchema.schema = schema;
      return { type: "json_schema", json_schema: jsonSchema };
    }
    default:
      return undefined;
  }
}

type SetContent = (toolMessage: JSONObject, output: unknown) => JSONObject;

function appendStandaloneResponsesToolOutputAsUser(output: unknown, setContent: SetContent, appendMessage: (m: JSONObject) => number): void {
  let userMessage: JSONObject = { role: "user", content: "" };
  if (output !== undefined) userMessage = setContent(userMessage, output);
  const content = userMessage.content;
  if (content === undefined) return;
  if (typeof content === "string" && content.trim() === "") return;
  if (isArr(content) && content.length === 0) return;
  appendMessage(userMessage);
}

function setFunctionCallOutputContent(toolMessage: JSONObject, output: unknown): JSONObject {
  let structuredContent = output;
  if (typeof output === "string") {
    if (!validJSON(output)) {
      toolMessage.content = output;
      return toolMessage;
    }
    structuredContent = JSON.parse(output);
  }
  if (hasChatToolOutputImagePart(structuredContent)) {
    const items = (structuredContent as unknown[]).map(chatToolOutputContentPart);
    if (items.length > 0) toolMessage.content = items;
    return toolMessage;
  }
  toolMessage.content = gstr(output);
  return toolMessage;
}

function setCustomToolCallOutputContent(toolMessage: JSONObject, output: unknown): JSONObject {
  let structuredContent = output;
  if (typeof output === "string" && validJSON(output)) structuredContent = JSON.parse(output);
  if (hasChatToolOutputImagePart(structuredContent)) return setFunctionCallOutputContent(toolMessage, output);
  toolMessage.content = responsesToolOutputText(output);
  return toolMessage;
}

function chatToolOutputContentPart(item: unknown): JSONObject {
  switch (gstr(getAt(item, "type"))) {
    case "text":
    case "input_text":
    case "output_text":
      return { type: "text", text: gstr(getAt(item, "text")) };
    case "image_url":
    case "input_image": {
      const fields = chatToolOutputImageFields(item);
      if (!fields) return chatToolOutputFallbackPart(item);
      const imageURL: JSONObject = { url: fields[0] };
      if (fields[1] !== "") imageURL.detail = fields[1];
      return { type: "image_url", image_url: imageURL };
    }
    default:
      return chatToolOutputFallbackPart(item);
  }
}

function hasChatToolOutputImagePart(content: unknown): boolean {
  if (!isArr(content)) return false;
  let hasImage = false;
  for (const item of content) {
    const itemType = getAt(item, "type");
    if (typeof itemType !== "string") continue;
    switch (itemType) {
      case "text":
      case "input_text":
      case "output_text":
        if (typeof getAt(item, "text") !== "string") return false;
        break;
      case "image_url":
      case "input_image":
        if (!chatToolOutputImageFields(item)) return false;
        hasImage = true;
        break;
    }
  }
  return hasImage;
}

function chatToolOutputImageFields(item: unknown): [string, string] | undefined {
  let imageURLValue: unknown;
  let detailValue: unknown;
  switch (gstr(getAt(item, "type"))) {
    case "image_url":
      imageURLValue = getAt(item, "image_url.url");
      detailValue = getAt(item, "image_url.detail");
      break;
    case "input_image":
      imageURLValue = getAt(item, "image_url");
      detailValue = getAt(item, "detail");
      break;
    default:
      return undefined;
  }
  if (typeof imageURLValue !== "string") return undefined;
  const imageURL = imageURLValue.trim();
  if (imageURL === "") return undefined;
  const [detail, ok] = normalizeChatImageDetail(detailValue);
  if (!ok) return undefined;
  return [imageURL, detail];
}

/** Normalises an image detail for Chat Completions ("original" becomes "high"); [detail, ok]. */
export function normalizeChatImageDetail(detailValue: unknown): [string, boolean] {
  if (detailValue === undefined) return ["", true];
  if (typeof detailValue !== "string") return ["", false];
  const normalized = detailValue.trim().toLowerCase();
  switch (normalized) {
    case "auto":
    case "low":
    case "high":
      return [normalized, true];
    case "original":
      // Chat Completions does not support Codex's original detail value.
      return ["high", true];
    default:
      return ["", true];
  }
}

function chatToolOutputFallbackPart(item: unknown): JSONObject {
  const text = typeof item === "string" ? item : item === undefined ? "" : JSON.stringify(item);
  return { type: "text", text };
}

/** Concatenated summary_text of a reasoning item, or the unavailable placeholder. */
export function collectOpenAIResponsesReasoningContent(item: unknown): string {
  let reasoningText = "";
  const summary = getAt(item, "summary");
  if (isArr(summary)) {
    for (const summaryItem of summary) {
      if (gstr(getAt(summaryItem, "type")) !== "summary_text") continue;
      reasoningText += gstr(getAt(summaryItem, "text"));
    }
  }
  return reasoningText === "" ? reasoningUnavailable : reasoningText;
}

export function combineOpenAIResponsesReasoning(existing: string, incoming: string): string {
  const existingTrimmed = existing.trim();
  const incomingTrimmed = incoming.trim();
  if (existingTrimmed === "") return incoming;
  if (incomingTrimmed === "") return existing;
  if (existingTrimmed === reasoningUnavailable) return incoming;
  if (incomingTrimmed === reasoningUnavailable || existingTrimmed === incomingTrimmed) return existing;
  return existing + "\n\n" + incoming;
}

export function isUsableResponsesReasoning(reasoning: string): boolean {
  const trimmed = reasoning.trim();
  return trimmed !== "" && trimmed !== reasoningUnavailable;
}

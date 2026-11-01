// Port of internal/translator/gemini/openai/responses/gemini_openai-responses_request.go.
//
// Converts an OpenAI Responses request into a Gemini generateContent request.
// The body is built on parsed objects and serialised on the way out.
import {
  SignatureBlockKindGeminiFunctionCall,
  SignatureBlockKindGeminiModelPart,
  SignatureProviderGemini,
  compatibleSignatureForProviderBlock,
  geminiReplaySignatureOrBypass,
  sanitizeGeminiRequestThoughtSignatures,
  signatureProviderFromModelName,
} from "../../../../signature/index.ts";
import { decodeBase64, rawStdEncoding, stdEncoding } from "../../../../util/base64.ts";
import { sanitizeFunctionName } from "../../../../util/function_name.ts";
import { getAt, gbool, gint, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { qualifyResponsesNamespaceToolName } from "../../../../util/responses_tools.ts";
import { systemReminderText } from "../../../common/claude_system.ts";
import { mimeTypes, normalizeOpenAIFileData } from "../../../common/file_data.ts";
import { mergeAdjacentGeminiUserContents, setGeminiFunctionResponseRaw, setGeminiFunctionResponseResult } from "../../../common/gemini.ts";
import { UserTurnDrops } from "../../../common/parts.ts";
import { extractResponsesCallID, normalizeResponsesToolCallOutputs } from "../../../common/responses.ts";
import { attachDefaultSafetySettings } from "../../common/safety.ts";
import { fileBase, fileExt, gfloat, has, str } from "./helpers.ts";
import {
  geminiResponsesCarrierAny,
  geminiResponsesCarrierDirection,
  geminiResponsesCarrierDirectionField,
  geminiResponsesCarrierFunction,
  geminiResponsesCarrierNext,
  geminiResponsesCarrierPrevious,
  geminiResponsesCarrierTarget,
  geminiResponsesCarrierText,
  isOpenAIResponsesDetachedCarrier,
  normalizeGeminiResponsesCarriers,
  openAIResponsesAssistantVisibleText,
} from "./signature_carrier.ts";
import { normalizeOpenAIResponsesToolSearchItems } from "./tool_search.ts";
import { buildGeminiFunctionDeclarations, convertResponsesToolChoiceToGemini, mapResponsesToolName } from "./tools.ts";
import { restoreGeminiResponsesTextSignatures } from "./trailing_signature.ts";
import {
  allowsResponsesWebSearchToolChoice,
  extractResponsesWebSearchAllowedDomains,
  hasResponsesWebSearchTool,
  modelSupportsWebSearch,
} from "./web_search.ts";

/** Thought signature placed on replayed parts so Gemini skips signature validation. */
export const geminiResponsesThoughtSignature = "skip_thought_signature_validator";

type Obj = Record<string, unknown>;
type Part = Obj;

/** Converts an OpenAI Responses request to a Gemini request. Throws UnsupportedPartError for an emptied user turn. */
export function convertOpenAIResponsesRequestToGemini(modelName: string, inputRawJSON: string, _stream: boolean): string {
  const drops = new UserTurnDrops();
  let useGeminiNativeReasoningLayout = signatureProviderFromModelName(modelName) === SignatureProviderGemini;
  const out: Obj = { contents: [] };
  let root: unknown;
  try {
    root = JSON.parse(inputRawJSON);
  } catch {
    root = undefined;
  }

  const { declarations: functionDeclarations, forwardMap } = buildGeminiFunctionDeclarations(root);
  const toolBlocks: Obj[] = [];
  let hasGoogleSearch = false;
  if (hasResponsesWebSearchTool(root) && modelSupportsWebSearch(modelName) && allowsResponsesWebSearchToolChoice(root)) {
    const googleSearchBlock: Obj = { googleSearch: {} };
    const allowedDomains = extractResponsesWebSearchAllowedDomains(root);
    if (allowedDomains.length > 0) (googleSearchBlock.googleSearch as Obj).includedDomains = allowedDomains;
    toolBlocks.push(googleSearchBlock);
    hasGoogleSearch = true;
  }
  if (functionDeclarations.length > 0) toolBlocks.push({ functionDeclarations });
  if (toolBlocks.length > 0) out.tools = toolBlocks;

  if (functionDeclarations.length > 0) {
    const toolChoice = getAt(root, "tool_choice");
    if (toolChoice !== undefined) {
      const toolConfig = convertResponsesToolChoiceToGemini(toolChoice, forwardMap);
      if (toolConfig) out.toolConfig = { functionCallingConfig: toolConfig };
    }
  }
  // Gemini rejects built-in googleSearch combined with functionDeclarations unless
  // server-side tool invocations are declared.
  if (hasGoogleSearch && functionDeclarations.length > 0) {
    const toolConfig = isObj(out.toolConfig) ? out.toolConfig : {};
    toolConfig.includeServerSideToolInvocations = true;
    out.toolConfig = toolConfig;
  }

  const systemParts: Part[] = [];
  const instructions = getAt(root, "instructions");
  if (instructions !== undefined) systemParts.push({ text: gstr(instructions) });

  const input = getAt(root, "input");
  if (isArr(input)) {
    const carriers = normalizeGeminiResponsesCarriers(restoreGeminiResponsesTextSignatures(modelName, normalizeOpenAIResponsesToolSearchItems(input, forwardMap)));
    let inputItems = carriers.items;
    if (carriers.hasCarrier) useGeminiNativeReasoningLayout = true;
    inputItems = normalizeResponsesToolCallOutputs(inputItems);
    const items = pairOpenAIResponsesReasoningWithFunctionCalls(inputItems);
    const contentItems: Obj[] = [];
    const functionNamesByCallID = new Map<string, string>();
    let pendingFunctionCallIDs: string[] = [];
    for (const item of items) {
      const itemType = str(item, "type");
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const callID = extractResponsesCallID(item);
        if (!functionNamesByCallID.has(callID)) {
          let name = str(item, "name");
          const ns = str(item, "namespace");
          if (ns !== "") name = qualifyResponsesNamespaceToolName(ns, name);
          functionNamesByCallID.set(callID, mapResponsesToolName(forwardMap, name));
        }
      }
    }

    let normalized = items;
    if (useGeminiNativeReasoningLayout) normalized = reorderOpenAIResponsesDetachedReasoning(normalized);
    const consumedFunctionOutputIndexes = new Set<number>();
    let hasEncounteredConversation = false;
    let pendingDeveloperParts: Part[] = [];
    for (let i = 0; i < normalized.length; i++) {
      if (consumedFunctionOutputIndexes.has(i)) continue;
      const item = normalized[i];
      let itemType = str(item, "type");
      let itemRole = str(item, "role");
      if (itemType === "" && itemRole !== "") itemType = "message";
      else if (isResponsesContentPartType(itemType) && itemRole === "") {
        itemType = "message";
        itemRole = "user";
      }

      switch (itemType) {
        case "message": {
          const lowerRole = itemRole.toLowerCase();
          if (lowerRole === "system" || lowerRole === "developer") {
            const contentArray = getAt(item, "content");
            if (!hasEncounteredConversation) {
              pendingFunctionCallIDs = [];
              if (isArr(contentArray)) {
                for (const contentItem of contentArray) systemParts.push({ text: str(contentItem, "text") });
              } else if (typeof contentArray === "string") {
                systemParts.push({ text: contentArray });
              }
              continue;
            }
            const devParts: Part[] = [];
            if (isArr(contentArray)) {
              const texts: string[] = [];
              for (const contentItem of contentArray) {
                let text = str(contentItem, "text");
                if (text === "" && typeof contentItem === "string") text = contentItem;
                if (text !== "") texts.push(text);
              }
              if (texts.length > 0) {
                const joined = texts.join("\n");
                if (joined.trim() !== "") devParts.push({ text: systemReminderText(joined) });
              }
            } else if (typeof contentArray === "string" && contentArray !== "") {
              if (contentArray.trim() !== "") devParts.push({ text: systemReminderText(contentArray) });
            }
            if (devParts.length > 0) {
              if (pendingFunctionCallIDs.length > 0) pendingDeveloperParts.push(...devParts);
              else contentItems.push(geminiContent("user", devParts));
            }
            continue;
          }

          hasEncounteredConversation = true;
          if (openAIResponsesAssistantVisibleText(item) === undefined) {
            if (pendingFunctionCallIDs.length > 0) {
              const rest = normalized.slice(i);
              const anyHasFutureOutput = pendingFunctionCallIDs.some((callID) => responsesHasMatchingOutput(rest, callID));
              if (!anyHasFutureOutput) {
                const synthesizedParts = pendingFunctionCallIDs.map((callID) => buildOpenAIResponsesSynthesizedFunctionResponsePart(callID, functionNamesByCallID));
                if (synthesizedParts.length > 0) contentItems.push(geminiContent("user", synthesizedParts));
                pendingFunctionCallIDs = [];
              }
            }
            if (pendingDeveloperParts.length > 0) {
              contentItems.push(geminiContent("user", pendingDeveloperParts));
              pendingDeveloperParts = [];
            }
          }

          // Responses model outputs may appear as output_text content even under role "user";
          // split such items into Gemini turns with roles derived from the content type.
          const contentArray = getAt(item, "content");
          let partsToProcess: unknown[] = [];
          if (isArr(contentArray)) {
            partsToProcess = contentArray;
          } else if (isResponsesContentPartType(str(item, "type"))) {
            partsToProcess.push(item);
            while (i + 1 < normalized.length) {
              const nextItem = normalized[i + 1];
              if (str(nextItem, "role") === "" && isResponsesContentPartType(str(nextItem, "type"))) {
                partsToProcess.push(nextItem);
                i++;
              } else {
                break;
              }
            }
          }

          if (partsToProcess.length > 0) {
            let currentRole = "";
            let currentParts: Part[] = [];
            let userSendable = 0;
            const flush = (): void => {
              if (currentRole === "" || currentParts.length === 0) {
                currentParts = [];
                return;
              }
              contentItems.push(geminiContent(currentRole, currentParts));
              currentParts = [];
            };
            for (const contentItem of partsToProcess) {
              let contentType = str(contentItem, "type");
              if (contentType === "") contentType = "input_text";
              let effRole = "user";
              if (itemRole !== "") effRole = roleToGemini(itemRole);
              if (contentType === "output_text") effRole = "model";
              if (effRole === "assistant") effRole = "model";
              if (currentRole !== "" && effRole !== currentRole) {
                flush();
                currentRole = "";
              }
              if (currentRole === "") currentRole = effRole;

              let partJSON: Part | undefined;
              let sendsContent = false;
              switch (contentType) {
                case "input_text":
                case "output_text":
                case "text": {
                  const text = getAt(contentItem, "text");
                  if (text !== undefined) {
                    partJSON = { text: gstr(text) };
                    sendsContent = gstr(text) !== "";
                  }
                  break;
                }
                default: {
                  const part = openAIResponsesPartFromBlock(contentItem);
                  if (part) {
                    partJSON = part;
                    sendsContent = true;
                  } else if (effRole === "user" && isResponsesAttachmentPartType(contentType)) {
                    // Gemini has no field for a bare file id and no way to fetch the bytes.
                    drops.drop(contentType);
                  }
                }
              }
              if (partJSON) currentParts.push(partJSON);
              if (sendsContent && effRole === "user") userSendable++;
            }
            flush();
            drops.endTurn(userSendable);
          } else if (typeof contentArray === "string") {
            const effRole = itemRole !== "" ? roleToGemini(itemRole) : "user";
            contentItems.push(geminiContent(effRole, [{ text: contentArray }]));
          }
          break;
        }

        case "function_call":
        case "custom_tool_call": {
          hasEncounteredConversation = true;
          let signature = geminiResponsesThoughtSignature;
          const rawSignature = str(item, "_cpa_reasoning_signature").trim();
          if (rawSignature !== "") signature = geminiReplaySignatureOrBypass(rawSignature, SignatureBlockKindGeminiFunctionCall);
          const thoughtText = str(item, "_cpa_reasoning_summary");
          if (thoughtText !== "") contentItems.push(buildOpenAIResponsesReasoningFunctionCallModelContent(thoughtText, item, signature, forwardMap));
          else if (!useGeminiNativeReasoningLayout && rawSignature !== "") contentItems.push(buildOpenAIResponsesEmptyReasoningFunctionCallModelContent(item, signature, forwardMap));
          else contentItems.push(buildOpenAIResponsesFunctionCallModelContent(item, signature, forwardMap));
          const callID = extractResponsesCallID(item);
          if (callID !== "") pendingFunctionCallIDs.push(callID);
          break;
        }

        case "function_call_output":
        case "custom_tool_call_output": {
          hasEncounteredConversation = true;
          const { ordered: orderedOutputs, consumed } = collectOpenAIResponsesFunctionCallOutputs(normalized, i, pendingFunctionCallIDs);
          for (const consumedIndex of consumed) consumedFunctionOutputIndexes.add(consumedIndex);
          const end = i + consumed.size;
          const after = normalized.slice(end);
          const hasSubsequent = responsesHasSubsequentTurn(after);

          const outputByCallID = new Map<string, unknown>();
          const extraOutputs: unknown[] = [];
          for (const o of orderedOutputs) {
            const id = extractResponsesCallID(o);
            if (id !== "") outputByCallID.set(id, o);
            else extraOutputs.push(o);
          }
          const anyMatched = pendingFunctionCallIDs.some((pendingID) => outputByCallID.has(pendingID));

          const responseParts: Part[] = [];
          const stillPending: string[] = [];
          for (const pendingID of pendingFunctionCallIDs) {
            const o = outputByCallID.get(pendingID);
            if (outputByCallID.has(pendingID)) {
              responseParts.push(...buildOpenAIResponsesFunctionResponseParts(o, functionNamesByCallID));
              outputByCallID.delete(pendingID);
            } else if ((hasSubsequent || anyMatched) && !responsesHasMatchingOutput(after, pendingID)) {
              responseParts.push(buildOpenAIResponsesSynthesizedFunctionResponsePart(pendingID, functionNamesByCallID));
            } else {
              stillPending.push(pendingID);
            }
          }

          const standaloneOutputContents: Obj[] = [];
          // Orphan outputs (no matching function_call) must not become unpaired
          // functionResponse parts. Surface them as user text instead.
          const appendStandaloneOutput = (o: unknown): void => {
            const parts = buildOpenAIResponsesStandaloneToolOutputTextParts(o);
            if (parts.length > 0) standaloneOutputContents.push(geminiContent("user", parts));
          };
          for (const o of orderedOutputs) {
            const id = extractResponsesCallID(o);
            if (outputByCallID.has(id)) {
              appendStandaloneOutput(o);
              outputByCallID.delete(id);
            }
          }
          for (const o of extraOutputs) appendStandaloneOutput(o);

          pendingFunctionCallIDs = stillPending;
          if (responseParts.length > 0) contentItems.push(geminiContent("user", responseParts));
          contentItems.push(...standaloneOutputContents);
          if (pendingFunctionCallIDs.length === 0 && pendingDeveloperParts.length > 0) {
            contentItems.push(geminiContent("user", pendingDeveloperParts));
            pendingDeveloperParts = [];
          }
          break;
        }

        case "reasoning": {
          hasEncounteredConversation = true;
          const thoughtText = str(item, "summary.0.text");
          let rawSignature = str(item, "encrypted_content");
          const carrierDirection = geminiResponsesCarrierDirection(item);
          const carrierTarget = geminiResponsesCarrierTarget(item);
          if (rawSignature.trim() === "" && i + 1 < normalized.length) {
            const nextReasoning = normalized[i + 1];
            if (
              str(nextReasoning, "type") === "reasoning" &&
              str(nextReasoning, "id").includes("_detached_after_") &&
              str(nextReasoning, "summary.0.text").trim() === "" &&
              str(nextReasoning, "encrypted_content").trim() !== ""
            ) {
              rawSignature = str(nextReasoning, "encrypted_content");
              i++;
            }
          }
          let signature = "";
          if (rawSignature.trim() !== "") signature = openAIResponsesGeminiThoughtSignature(rawSignature);

          let visibleText = "";
          if (useGeminiNativeReasoningLayout && i + 1 < normalized.length) {
            const next = normalized[i + 1];
            const directionOK = carrierDirection === "" || carrierDirection === geminiResponsesCarrierNext;
            const canBindText = directionOK && (carrierTarget === "" || carrierTarget === geminiResponsesCarrierText || carrierTarget === geminiResponsesCarrierAny);
            const canBindFunction = directionOK && (carrierTarget === "" || carrierTarget === geminiResponsesCarrierFunction || carrierTarget === geminiResponsesCarrierAny);
            const visible = openAIResponsesAssistantVisibleText(next);
            const nextType = str(next, "type");
            if (visible !== undefined && canBindText) {
              visibleText = visible;
              i++;
            } else if ((nextType === "function_call" || nextType === "custom_tool_call") && canBindFunction && str(next, "_cpa_reasoning_signature").trim() === "") {
              const funcSig = signature !== "" ? signature : geminiResponsesThoughtSignature;
              contentItems.push(buildOpenAIResponsesReasoningFunctionCallModelContent(thoughtText, next, funcSig, forwardMap));
              const callID = extractResponsesCallID(next);
              if (callID !== "") pendingFunctionCallIDs.push(callID);
              i++;
              continue;
            }
          }
          const modelContent = buildOpenAIResponsesReasoningModelContent(thoughtText, visibleText, signature, useGeminiNativeReasoningLayout);
          if (modelContent) contentItems.push(modelContent);
          break;
        }
      }
    }
    if (pendingDeveloperParts.length > 0) {
      contentItems.push(geminiContent("user", pendingDeveloperParts));
      pendingDeveloperParts = [];
    }
    const merged = mergeAdjacentGeminiUserContents(coalesceAdjacentOpenAIResponsesModelContents(contentItems));
    if (merged.length > 0) out.contents = merged;
  } else if (typeof input === "string") {
    out.contents = [geminiContent("user", [{ text: input }])];
  }
  if (systemParts.length > 0) out.systemInstruction = { parts: systemParts };

  const maxOutputTokens = getAt(root, "max_output_tokens");
  if (maxOutputTokens !== undefined) out.generationConfig = { maxOutputTokens: gint(maxOutputTokens) };
  const genConfig = (): Obj => {
    if (!isObj(out.generationConfig)) out.generationConfig = {};
    return out.generationConfig as Obj;
  };
  const temperature = getAt(root, "temperature");
  if (temperature !== undefined) genConfig().temperature = gfloat(temperature);
  const topP = getAt(root, "top_p");
  if (topP !== undefined) genConfig().topP = gfloat(topP);
  const stopSequences = getAt(root, "stop_sequences");
  if (isArr(stopSequences)) genConfig().stopSequences = stopSequences.map((seq) => gstr(seq));

  applyOpenAIResponsesTextFormatToGemini(root, genConfig);

  // reasoning.effort -> thinkingConfig (translation-only; capability checks happen in ApplyThinking).
  const re = getAt(root, "reasoning.effort");
  if (re !== undefined) {
    const effort = gstr(re).trim().toLowerCase();
    if (effort !== "") {
      const gc = genConfig();
      const thinkingConfig = isObj(gc.thinkingConfig) ? gc.thinkingConfig : {};
      if (effort === "auto") thinkingConfig.thinkingBudget = -1;
      else thinkingConfig.thinkingLevel = effort;
      gc.thinkingConfig = thinkingConfig;
    }
  }

  let result = JSON.stringify(out);
  result = attachDefaultSafetySettings(result, "safetySettings");
  if (useGeminiNativeReasoningLayout) result = sanitizeGeminiRequestThoughtSignatures(result, "contents");
  result = stripTrailingOpenAIResponsesModelPrefill(result);
  const err = drops.err();
  if (err) throw err;
  return result;
}

function roleToGemini(itemRole: string): string {
  const lower = itemRole.toLowerCase();
  return lower === "assistant" || lower === "model" ? "model" : lower;
}

export function geminiContent(role: string, parts: Part[]): Obj {
  return { role, parts: [...parts] };
}

function coalesceAdjacentOpenAIResponsesModelContents(contents: Obj[]): Obj[] {
  const coalesced: Obj[] = [];
  for (const content of contents) {
    const isModel = str(content, "role").trim().toLowerCase() === "model";
    if (!isModel || coalesced.length === 0) {
      coalesced.push(content);
      continue;
    }
    const last = coalesced[coalesced.length - 1]!;
    if (str(last, "role").trim().toLowerCase() !== "model") {
      coalesced.push(content);
      continue;
    }
    const parts = content.parts;
    if (!isArr(parts)) {
      coalesced.push(content);
      continue;
    }
    if (parts.length > 0) coalesced[coalesced.length - 1] = { ...last, parts: [...(isArr(last.parts) ? last.parts : []), ...parts] };
  }
  return coalesced;
}

function stripTrailingOpenAIResponsesModelPrefill(payload: string): string {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return payload;
  }
  const contents = getAt(root, "contents");
  if (!isArr(contents) || contents.length === 0 || !shouldStripTrailingOpenAIResponsesModelPrefill(contents[contents.length - 1])) return payload;
  contents.pop();
  return JSON.stringify(root);
}

function shouldStripTrailingOpenAIResponsesModelPrefill(lastContent: unknown): boolean {
  if (str(lastContent, "role") !== "model") return false;
  const parts = getAt(lastContent, "parts");
  if (!isArr(parts)) return false;
  for (const part of parts) {
    if (gbool(getAt(part, "thought")) || has(part, "functionCall") || str(part, "thoughtSignature").trim() !== "") return false;
  }
  return true;
}

function isOpenAIResponsesToolCall(item: unknown): boolean {
  const t = str(item, "type");
  return t === "function_call" || t === "custom_tool_call";
}

function isOpenAIResponsesToolOutput(item: unknown): boolean {
  const t = str(item, "type");
  return t === "function_call_output" || t === "custom_tool_call_output";
}

/**
 * Attaches reasoning signatures to the function calls they belong to, both for a
 * reasoning item that precedes a call and for detached carriers that follow calls
 * whose outputs come after them.
 */
export function pairOpenAIResponsesReasoningWithFunctionCalls(items: unknown[]): unknown[] {
  const isDetachedCarrier = isOpenAIResponsesDetachedCarrier;
  const postCallSignature = new Map<number, string>();
  const postCallCarrier = new Set<number>();
  const consumedPostCallCarrier = new Set<number>();
  for (let groupStart = 0; groupStart < items.length; ) {
    if (!isOpenAIResponsesToolCall(items[groupStart]) && !isDetachedCarrier(items[groupStart])) {
      groupStart++;
      continue;
    }
    let groupEnd = groupStart;
    let hasFunctionCall = false;
    while (groupEnd < items.length && (isOpenAIResponsesToolCall(items[groupEnd]) || isDetachedCarrier(items[groupEnd]))) {
      hasFunctionCall = hasFunctionCall || isOpenAIResponsesToolCall(items[groupEnd]);
      groupEnd++;
    }
    if (!hasFunctionCall || groupEnd >= items.length || !isOpenAIResponsesToolOutput(items[groupEnd])) {
      groupStart = groupEnd;
      continue;
    }
    let outputEnd = groupEnd;
    while (outputEnd < items.length && isOpenAIResponsesToolOutput(items[outputEnd])) outputEnd++;
    // A run beginning with a carrier uses leading-carrier semantics; a run beginning
    // with a call uses post-call semantics.
    if (isOpenAIResponsesToolCall(items[groupStart])) {
      for (let callIndex = groupStart; callIndex < groupEnd; callIndex++) {
        const item = items[callIndex];
        if (!isOpenAIResponsesToolCall(item) || str(item, "_cpa_reasoning_signature").trim() !== "" || callIndex + 1 >= groupEnd || !isDetachedCarrier(items[callIndex + 1])) continue;
        const carrierDirection = geminiResponsesCarrierDirection(items[callIndex + 1]);
        const carrierTarget = geminiResponsesCarrierTarget(items[callIndex + 1]);
        if (
          carrierDirection !== "" &&
          (carrierDirection !== geminiResponsesCarrierPrevious || (carrierTarget !== geminiResponsesCarrierFunction && carrierTarget !== geminiResponsesCarrierAny))
        )
          continue;
        let carrierEnd = callIndex + 1;
        while (carrierEnd < groupEnd && isDetachedCarrier(items[carrierEnd])) {
          postCallCarrier.add(carrierEnd);
          carrierEnd++;
        }
        const callID = extractResponsesCallID(item);
        if (callID === "") continue;
        for (let outputIndex = groupEnd; outputIndex < outputEnd; outputIndex++) {
          if (extractResponsesCallID(items[outputIndex]) === callID) {
            postCallSignature.set(callIndex, str(items[callIndex + 1], "encrypted_content").trim());
            consumedPostCallCarrier.add(callIndex + 1);
            break;
          }
        }
      }
    }
    groupStart = outputEnd;
  }

  const paired: unknown[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const signature = postCallSignature.get(index) ?? "";
    if (signature !== "") {
      paired.push({ ...(item as Obj), _cpa_reasoning_signature: signature });
      continue;
    }
    if (consumedPostCallCarrier.has(index)) continue;
    const carrierDirection = geminiResponsesCarrierDirection(item);
    const carrierTarget = geminiResponsesCarrierTarget(item);
    const canBindFollowingCall =
      carrierDirection === "" || (carrierDirection === geminiResponsesCarrierNext && (carrierTarget === geminiResponsesCarrierFunction || carrierTarget === geminiResponsesCarrierAny));
    if (
      str(item, "type") === "reasoning" &&
      !postCallCarrier.has(index) &&
      canBindFollowingCall &&
      !str(item, "id").includes("_detached_after_") &&
      index + 1 < items.length &&
      isOpenAIResponsesToolCall(items[index + 1])
    ) {
      const rawSignature = str(item, "encrypted_content").trim();
      if (rawSignature !== "") {
        const functionCall: Obj = { ...(items[index + 1] as Obj), _cpa_reasoning_signature: rawSignature };
        const summary = str(item, "summary.0.text");
        if (summary !== "") functionCall._cpa_reasoning_summary = summary;
        paired.push(functionCall);
        index++;
        continue;
      }
    }
    paired.push(item);
  }
  return paired;
}

export function reorderOpenAIResponsesDetachedReasoning(items: unknown[]): unknown[] {
  const reordered: unknown[] = [];
  items.forEach((item, itemIndex) => {
    const isReasoningCarrier = isOpenAIResponsesDetachedCarrier(item);
    const markedDetached = str(item, "id").includes("_detached_after_");
    if (isReasoningCarrier && reordered.length > 0) {
      const previous = reordered[reordered.length - 1];
      let previousType = str(previous, "type");
      if (previousType === "" && str(previous, "role") !== "") previousType = "message";
      let isAssistantMessage = false;
      if (previousType === "message") isAssistantMessage = openAIResponsesAssistantVisibleText(previous) !== undefined;
      const previousIsCall = previousType === "function_call" || previousType === "custom_tool_call";

      const direction = geminiResponsesCarrierDirection(item);
      const targetKind = geminiResponsesCarrierTarget(item);
      if (direction !== "") {
        let alreadyPairedText = false;
        let alreadyPairedFunction = false;
        if (reordered.length > 1) {
          const prior = reordered[reordered.length - 2];
          const priorDirection = geminiResponsesCarrierDirection(prior);
          const priorTarget = geminiResponsesCarrierTarget(prior);
          const priorBindsFollowing =
            isOpenAIResponsesDetachedCarrier(prior) && (priorDirection === geminiResponsesCarrierNext || priorDirection === geminiResponsesCarrierPrevious);
          alreadyPairedText = priorBindsFollowing && (priorTarget === geminiResponsesCarrierText || priorTarget === geminiResponsesCarrierAny);
          alreadyPairedFunction = priorBindsFollowing && (priorTarget === geminiResponsesCarrierFunction || priorTarget === geminiResponsesCarrierAny);
        }
        const bindPreviousMessage =
          direction === geminiResponsesCarrierPrevious &&
          (targetKind === geminiResponsesCarrierText || targetKind === geminiResponsesCarrierAny) &&
          isAssistantMessage &&
          !alreadyPairedText;
        const bindPreviousFunction =
          direction === geminiResponsesCarrierPrevious &&
          (targetKind === geminiResponsesCarrierFunction || targetKind === geminiResponsesCarrierAny) &&
          previousIsCall &&
          str(previous, "_cpa_reasoning_signature").trim() === "" &&
          !alreadyPairedFunction;
        if (bindPreviousMessage || bindPreviousFunction) {
          reordered[reordered.length - 1] = { ...(item as Obj), [geminiResponsesCarrierDirectionField]: geminiResponsesCarrierNext };
          reordered.push(previous);
          return;
        }
        reordered.push(item);
        return;
      }

      if (isAssistantMessage && !markedDetached && itemIndex + 1 < items.length) {
        isAssistantMessage = openAIResponsesAssistantVisibleText(items[itemIndex + 1]) === undefined;
      }
      let alreadyPaired = false;
      if (reordered.length > 1) {
        const prior = reordered[reordered.length - 2];
        alreadyPaired = isOpenAIResponsesDetachedCarrier(prior) && str(prior, "id").includes("_detached_after_");
      }
      if (!alreadyPaired && (isAssistantMessage || (markedDetached && previousIsCall && str(previous, "_cpa_reasoning_signature").trim() === ""))) {
        reordered[reordered.length - 1] = item;
        reordered.push(previous);
        return;
      }
    }
    reordered.push(item);
  });
  return reordered;
}

function buildOpenAIResponsesFunctionCallPart(item: unknown, signature: string, forwardMap: Map<string, string> | undefined): Part {
  let name = str(item, "name");
  const ns = str(item, "namespace");
  if (ns !== "") name = qualifyResponsesNamespaceToolName(ns, name);
  name = mapResponsesToolName(forwardMap, name);
  const functionCall: Obj = { name, args: {} };
  const part: Part = { functionCall, thoughtSignature: signature };
  functionCall.id = extractResponsesCallID(item);
  if (str(item, "type") === "custom_tool_call") {
    const inputVal = getAt(item, "input");
    (functionCall.args as Obj).input = inputVal === undefined ? "" : inputVal;
  } else {
    const args = str(item, "arguments");
    if (args !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        parsed = undefined;
      }
      if (isObj(parsed) || isArr(parsed)) functionCall.args = parsed;
      else (functionCall.args as Obj).arguments = args;
    }
  }
  return part;
}

function geminiResponsesInlineDataPart(mimeType: string, data: string): Part {
  return { inline_data: { mime_type: mimeType, data } };
}

function geminiResponsesFileDataPart(mimeType: string, fileURI: string): Part {
  return { file_data: { mime_type: mimeType, file_uri: fileURI } };
}

function firstNonEmpty(...values: string[]): string {
  for (const v of values) if (v.trim() !== "") return v.trim();
  return "";
}

function isDataURL(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith("data:");
}

function isRemoteURL(u: string): boolean {
  const lower = u.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("gs://");
}

function isGenericMIME(mimeType: string): boolean {
  const m = mimeType.trim().toLowerCase();
  return m === "" || m === "application/octet-stream" || m === "binary/octet-stream";
}

function firstNonGenericFormat(...values: string[]): string {
  for (let v of values) {
    v = v.trim();
    if (v !== "" && !isGenericMIME(v)) return v;
  }
  return "";
}

function extOf(filename: string): string {
  const ext = fileExt(filename);
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

function parseOpenAIResponsesDataURL(rawURL: string): { mimeType: string; data: string } {
  const none = { mimeType: "", data: "" };
  const trimmedRaw = rawURL.trim();
  if (trimmedRaw.length < 5 || trimmedRaw.slice(0, 5).toLowerCase() !== "data:") return none;
  const trimmed = trimmedRaw.slice(5);
  const comma = trimmed.indexOf(",");
  if (comma < 0) return none;
  const metadata = trimmed.slice(0, comma);
  let payload = trimmed.slice(comma + 1);
  if (payload.trim() === "") return none;
  payload = payload.trim();
  const fields = metadata.split(";");
  const mimeType = fields[0]!.trim();
  const isBase64 = fields.slice(1).some((f) => f.trim().toLowerCase() === "base64");
  if (!isBase64) return none;
  if (!decodeBase64(payload, stdEncoding) && !decodeBase64(payload, rawStdEncoding)) return none;
  return { mimeType, data: payload };
}

function isResponsesContentPartType(itemType: string): boolean {
  switch (itemType.trim().toLowerCase()) {
    case "input_text":
    case "output_text":
    case "text":
      return true;
    default:
      return isResponsesAttachmentPartType(itemType);
  }
}

/** The content part types that carry a file, image, audio or video rather than text. */
function isResponsesAttachmentPartType(itemType: string): boolean {
  switch (itemType.trim().toLowerCase()) {
    case "input_image":
    case "image_url":
    case "image":
    case "input_audio":
    case "audio":
    case "input_video":
    case "video_url":
    case "video":
    case "input_file":
    case "file":
      return true;
    default:
      return false;
  }
}

function openAIResponsesAudioMimeType(audioFormat: string): string {
  audioFormat = audioFormat.trim();
  if (isGenericMIME(audioFormat)) return "audio/wav";
  if (audioFormat.includes("/")) return audioFormat;
  const f = audioFormat.toLowerCase();
  switch (f) {
    case "wav":
      return "audio/wav";
    case "mp3":
    case "mpeg":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "webm":
      return "audio/webm";
    case "pcm16":
    case "pcm":
      return "audio/pcm";
    case "g711_ulaw":
    case "g711_alaw":
      return "audio/basic";
    case "opus":
      return "audio/opus";
    case "m4a":
      return "audio/mp4";
    case "wma":
      return "audio/x-ms-wma";
    default: {
      const mapped = mimeTypes[f] ?? "";
      return mapped !== "" && mapped.startsWith("audio/") ? mapped : "audio/wav";
    }
  }
}

function openAIResponsesVideoMimeType(format: string): string {
  format = format.trim();
  if (isGenericMIME(format)) return "video/mp4";
  if (format.includes("/")) return format;
  const f = format.toLowerCase();
  switch (f) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
    case "quicktime":
      return "video/quicktime";
    case "avi":
    case "x-msvideo":
      return "video/x-msvideo";
    case "mpeg":
      return "video/mpeg";
    case "ogg":
      return "video/ogg";
    case "mkv":
    case "x-matroska":
      return "video/x-matroska";
    case "flv":
    case "x-flv":
      return "video/x-flv";
    case "3gpp":
      return "video/3gpp";
    default: {
      const mapped = mimeTypes[f] ?? "";
      return mapped !== "" && mapped.startsWith("video/") ? mapped : "video/mp4";
    }
  }
}

interface Media {
  mimeType: string;
  data: string;
}

function resolveDataURLMedia(url: string, format: string, filename: string, mapper: (f: string) => string, fallback: string): Media | undefined {
  let { mimeType, data } = parseOpenAIResponsesDataURL(url);
  if (data === "") return undefined;
  if (isGenericMIME(mimeType)) {
    if (format !== "" && !isGenericMIME(format)) mimeType = mapper(format);
    else if (filename !== "") mimeType = mapper(extOf(filename));
    else mimeType = fallback;
  }
  return { mimeType, data };
}

function openAIResponsesAudioFromBlock(block: unknown): Media | undefined | null {
  const bType = str(block, "type").trim().toLowerCase();
  if (bType !== "input_audio" && bType !== "audio") return null;
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"));
  let audioObj = getAt(block, "input_audio");
  if (audioObj === undefined) audioObj = getAt(block, "audio");
  let audioFormat = firstNonGenericFormat(str(audioObj, "format"), str(audioObj, "mime_type"), str(block, "format"), str(block, "mime_type"));
  let audioData = str(audioObj, "data");
  if (audioData === "") audioData = str(block, "data");
  if (audioData === "") {
    const audioURL = firstNonEmpty(str(block, "audio_url.url"), str(block, "audio_url"), str(block, "url"));
    if (audioURL !== "") {
      if (isDataURL(audioURL)) return resolveDataURLMedia(audioURL, audioFormat, filename, openAIResponsesAudioMimeType, "audio/wav");
      if (!isRemoteURL(audioURL)) {
        let mType = openAIResponsesAudioMimeType(audioFormat);
        if (isGenericMIME(audioFormat) && filename !== "") mType = openAIResponsesAudioMimeType(extOf(filename));
        return { mimeType: mType, data: audioURL };
      }
    }
  }
  if (audioData === "" && str(block, "source.type") === "base64") {
    audioData = str(block, "source.data");
    if (audioFormat === "") audioFormat = str(block, "source.media_type");
  }
  if (audioData === "") return undefined;
  if (isDataURL(audioData)) return resolveDataURLMedia(audioData, audioFormat, filename, openAIResponsesAudioMimeType, "audio/wav");
  let mType = openAIResponsesAudioMimeType(audioFormat);
  if (isGenericMIME(audioFormat) && filename !== "") mType = openAIResponsesAudioMimeType(extOf(filename));
  return { mimeType: mType, data: audioData };
}

function openAIResponsesVideoFromBlock(block: unknown): Media | undefined | null {
  const bType = str(block, "type").trim().toLowerCase();
  if (bType !== "input_video" && bType !== "video_url" && bType !== "video") return null;
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"));
  let videoObj = getAt(block, "input_video");
  if (videoObj === undefined) videoObj = getAt(block, "video");
  let format = firstNonGenericFormat(str(videoObj, "format"), str(videoObj, "mime_type"), str(block, "format"), str(block, "mime_type"));
  const videoURL = firstNonEmpty(str(block, "video_url.url"), str(block, "video_url"), str(block, "url"));
  if (videoURL !== "") {
    if (isDataURL(videoURL)) return resolveDataURLMedia(videoURL, format, filename, openAIResponsesVideoMimeType, "video/mp4");
    if (!isRemoteURL(videoURL)) {
      let mType = openAIResponsesVideoMimeType(format);
      if (isGenericMIME(format) && filename !== "") mType = openAIResponsesVideoMimeType(extOf(filename));
      return { mimeType: mType, data: videoURL };
    }
  }
  let videoData = str(videoObj, "data");
  if (videoData === "") videoData = str(block, "data");
  if (videoData === "" && str(block, "source.type") === "base64") {
    videoData = str(block, "source.data");
    if (format === "") format = str(block, "source.media_type");
  }
  if (videoData === "") return undefined;
  if (isDataURL(videoData)) return resolveDataURLMedia(videoData, format, filename, openAIResponsesVideoMimeType, "video/mp4");
  let mType = openAIResponsesVideoMimeType(format);
  if (isGenericMIME(format) && filename !== "") mType = openAIResponsesVideoMimeType(extOf(filename));
  return { mimeType: mType, data: videoData };
}

function normalizeFormatToMIME(format: string): string {
  format = format.trim();
  if (format === "" || isGenericMIME(format)) return "";
  if (format.includes("/")) return format;
  const f = format.toLowerCase();
  switch (f) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "pdf":
      return "application/pdf";
  }
  return mimeTypes[f] ?? "";
}

function openAIResponsesFileFromBlock(block: unknown): Media | undefined | null {
  const bType = str(block, "type").trim().toLowerCase();
  if (bType !== "input_file" && bType !== "file") return null;
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"));
  let fileData = firstNonEmpty(str(block, "file_data"), str(block, "file.file_data"), str(block, "data"));
  if (fileData === "") {
    const fileURL = firstNonEmpty(str(block, "file_url.url"), str(block, "file_url"), str(block, "file.file_url"), str(block, "url"));
    if (isDataURL(fileURL)) fileData = fileURL;
  }
  const fileObj = getAt(block, "file");
  let fallbackMIME = firstNonGenericFormat(str(block, "mime_type"), str(fileObj, "mime_type"), str(block, "format"), str(fileObj, "format"));
  if (fallbackMIME !== "") fallbackMIME = normalizeFormatToMIME(fallbackMIME);
  if (isGenericMIME(fallbackMIME) && filename !== "") {
    const ext = extOf(filename).toLowerCase();
    if (ext !== "") fallbackMIME = normalizeFormatToMIME(ext);
  }
  if (isDataURL(fileData)) {
    let { mimeType, data } = parseOpenAIResponsesDataURL(fileData);
    if (data === "") return undefined;
    if (isGenericMIME(mimeType) && fallbackMIME !== "") mimeType = fallbackMIME;
    if (isGenericMIME(mimeType) && filename !== "") {
      const ext = extOf(filename).toLowerCase();
      if (ext !== "") {
        const norm = normalizeFormatToMIME(ext);
        if (norm !== "") mimeType = norm;
      }
    }
    if (isGenericMIME(mimeType)) mimeType = "application/octet-stream";
    return { mimeType, data };
  }
  const normalized = normalizeOpenAIFileData(filename, fallbackMIME, fileData);
  return normalized ? { mimeType: normalized.mimeType, data: normalized.data } : undefined;
}

function openAIResponsesMediaFromBlock(block: unknown): Media | undefined {
  for (const fn of [openAIResponsesImageFromBlock, openAIResponsesAudioFromBlock, openAIResponsesVideoFromBlock, openAIResponsesFileFromBlock]) {
    const media = fn(block);
    if (media) return media;
  }
  return undefined;
}

function openAIResponsesPartFromBlock(block: unknown): Part | undefined {
  const bType = str(block, "type").trim().toLowerCase();
  const rawURL = firstNonEmpty(
    str(block, "video_url.url"),
    str(block, "video_url"),
    str(block, "audio_url.url"),
    str(block, "audio_url"),
    str(block, "image_url.url"),
    str(block, "image_url"),
    str(block, "file_url.url"),
    str(block, "file_url"),
    str(block, "file.file_url"),
    str(block, "url"),
  );
  if (isRemoteURL(rawURL)) {
    let filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"));
    if (filename === "") {
      try {
        filename = fileBase(new URL(rawURL).pathname);
      } catch {
        filename = "";
      }
    }
    const format = firstNonGenericFormat(
      ...[
        "format",
        "mime_type",
        "input_video.format",
        "input_video.mime_type",
        "video.format",
        "video.mime_type",
        "input_audio.format",
        "input_audio.mime_type",
        "audio.format",
        "audio.mime_type",
        "input_image.format",
        "input_image.mime_type",
        "image.format",
        "image.mime_type",
        "file.format",
        "file.mime_type",
      ].map((p) => str(block, p)),
    );
    let mimeType = "";
    switch (bType) {
      case "input_video":
      case "video_url":
      case "video":
        if (format !== "" && !isGenericMIME(format)) mimeType = openAIResponsesVideoMimeType(format);
        else if (filename !== "") {
          const ext = extOf(filename).toLowerCase();
          if (ext !== "") mimeType = openAIResponsesVideoMimeType(ext);
        }
        if (isGenericMIME(mimeType)) mimeType = "video/mp4";
        break;
      case "input_audio":
      case "audio":
        if (format !== "" && !isGenericMIME(format)) mimeType = openAIResponsesAudioMimeType(format);
        else if (filename !== "") {
          const ext = extOf(filename).toLowerCase();
          if (ext !== "") mimeType = openAIResponsesAudioMimeType(ext);
        }
        if (isGenericMIME(mimeType)) mimeType = "audio/wav";
        break;
      case "input_image":
      case "image_url":
      case "image":
        mimeType = openAIResponsesImageMimeType(format, filename);
        break;
      default:
        if (format !== "") mimeType = normalizeFormatToMIME(format);
        if (isGenericMIME(mimeType) && filename !== "") {
          const ext = extOf(filename).toLowerCase();
          if (ext !== "") mimeType = normalizeFormatToMIME(ext);
        }
        if (isGenericMIME(mimeType)) mimeType = "application/octet-stream";
    }
    return geminiResponsesFileDataPart(mimeType, rawURL);
  }
  const media = openAIResponsesMediaFromBlock(block);
  if (media) return geminiResponsesInlineDataPart(media.mimeType, media.data);
  return undefined;
}

function openAIResponsesImageMimeType(format: string, filename: string): string {
  format = format.trim();
  if (format !== "" && !isGenericMIME(format)) {
    if (format.includes("/")) return format;
    const f = format.toLowerCase();
    if (f === "jpg" || f === "jpeg") return "image/jpeg";
    const mapped = mimeTypes[f];
    if (mapped) return mapped;
    return "image/" + format;
  }
  if (filename !== "") {
    const ext = extOf(filename).toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext !== "") {
      const mapped = mimeTypes[ext];
      if (mapped) return mapped;
    }
  }
  return "image/png";
}

function openAIResponsesImageFromBlock(block: unknown): Media | undefined | null {
  const blockType = str(block, "type").trim().toLowerCase();
  if (blockType !== "input_image" && blockType !== "image_url" && blockType !== "image") return null;
  let format = firstNonGenericFormat(
    str(block, "format"),
    str(block, "mime_type"),
    str(block, "input_image.format"),
    str(block, "input_image.mime_type"),
    str(block, "image.format"),
    str(block, "image.mime_type"),
  );
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"));
  const imageURL = firstNonEmpty(str(block, "image_url.url"), str(block, "image_url"), str(block, "url"));
  if (imageURL !== "") {
    if (isDataURL(imageURL)) {
      let { mimeType, data } = parseOpenAIResponsesDataURL(imageURL);
      if (data === "") return undefined;
      if (isGenericMIME(mimeType)) mimeType = openAIResponsesImageMimeType(format, filename);
      return { mimeType, data };
    }
    if (!isRemoteURL(imageURL)) return { mimeType: openAIResponsesImageMimeType(format, filename), data: imageURL };
  }
  let imageData = "";
  if (str(block, "source.type") === "base64") {
    imageData = str(block, "source.data");
    if (format === "") format = str(block, "source.media_type");
  }
  if (imageData === "" && has(block, "data")) imageData = str(block, "data");
  if (imageData === "") return undefined;
  if (isDataURL(imageData)) {
    let { mimeType, data } = parseOpenAIResponsesDataURL(imageData);
    if (data === "") return undefined;
    if (isGenericMIME(mimeType)) mimeType = openAIResponsesImageMimeType(format, filename);
    return { mimeType, data };
  }
  return { mimeType: openAIResponsesImageMimeType(format, filename), data: imageData };
}

interface OutputBlock {
  text: string;
  isText: boolean;
  raw: string;
}

function parseOpenAIResponsesArrayOutput(output: unknown[]): { result: string; isRaw: boolean; images: Part[] } {
  const imageParts: Part[] = [];
  const nonImageEntries: OutputBlock[] = [];
  let hasContentBlock = false;
  let hasNonTextBlock = false;
  for (const block of output) {
    const media = openAIResponsesMediaFromBlock(block);
    if (media) {
      hasContentBlock = true;
      imageParts.push(geminiResponsesInlineDataPart(media.mimeType, media.data));
      continue;
    }
    const bType = str(block, "type");
    if (bType === "input_text" || bType === "output_text" || bType === "text") {
      hasContentBlock = true;
      nonImageEntries.push({ text: str(block, "text"), isText: true, raw: JSON.stringify(block) });
    } else if (typeof block === "string") {
      nonImageEntries.push({ text: block, isText: true, raw: JSON.stringify(block) });
    } else {
      hasNonTextBlock = true;
      nonImageEntries.push({ text: JSON.stringify(block), isText: false, raw: JSON.stringify(block) });
    }
  }
  if (!hasContentBlock) return { result: JSON.stringify(output), isRaw: true, images: [] };
  switch (nonImageEntries.length) {
    case 0:
      return { result: "", isRaw: false, images: imageParts };
    case 1:
      if (nonImageEntries[0]!.isText) return { result: nonImageEntries[0]!.text, isRaw: false, images: imageParts };
      return { result: nonImageEntries[0]!.raw, isRaw: true, images: imageParts };
    default:
      if (!hasNonTextBlock) return { result: nonImageEntries.map((e) => e.text).join("\n"), isRaw: false, images: imageParts };
      return { result: "[" + nonImageEntries.map((e) => e.raw).join(",") + "]", isRaw: true, images: imageParts };
  }
}

function buildOpenAIResponsesSynthesizedFunctionResponsePart(callID: string, functionNamesByCallID: Map<string, string>): Part {
  let functionName = "unknown";
  const matched = functionNamesByCallID.get(callID);
  if (matched !== undefined && matched !== "") functionName = matched;
  const functionResponse: Obj = { name: sanitizeFunctionName(functionName), response: { result: "call interrupted, no output" } };
  if (callID !== "") functionResponse.id = callID;
  return { functionResponse };
}

function responsesHasMatchingOutput(items: unknown[], callID: string): boolean {
  if (callID === "") return false;
  return items.some((item) => isOpenAIResponsesToolOutput(item) && extractResponsesCallID(item) === callID);
}

function responsesHasSubsequentTurn(items: unknown[]): boolean {
  for (const item of items) {
    const typ = str(item, "type");
    const role = str(item, "role");
    if (typ === "message" || (typ === "" && role !== "")) return true;
    if (typ === "function_call" || typ === "custom_tool_call") return true;
  }
  return false;
}

function buildOpenAIResponsesStandaloneToolOutputTextParts(item: unknown): Part[] {
  const output = getAt(item, "output");
  if (output === undefined) return [];
  if (isArr(output)) {
    const parts: Part[] = [];
    for (const part of output) {
      const text = str(part, "text");
      if (text.trim() === "") continue;
      parts.push({ text });
    }
    return parts;
  }
  const text = gstr(output);
  if (text.trim() === "") return [];
  return [{ text }];
}

function buildOpenAIResponsesFunctionResponseParts(item: unknown, functionNamesByCallID: Map<string, string>): Part[] {
  const callID = extractResponsesCallID(item);
  let functionName = "unknown";
  const matched = functionNamesByCallID.get(callID);
  if (matched !== undefined) functionName = matched;
  else {
    const name = str(item, "name").trim();
    if (name !== "") functionName = name;
  }
  let part: Part = { functionResponse: { name: sanitizeFunctionName(functionName), response: {}, id: callID } };
  const fr = (): Obj => part.functionResponse as Obj;

  const outputResult = getAt(item, "output");
  if (typeof outputResult === "string") {
    if (outputResult === "" || outputResult === "null") return [part];
    // Keep it as a string instead of parsing it into JSON (parsing may trigger an upstream 400).
    (fr().response as Obj).result = outputResult;
    return [part];
  }

  let imageParts: Part[] = [];
  if (isArr(outputResult)) {
    const { result, isRaw, images } = parseOpenAIResponsesArrayOutput(outputResult);
    imageParts = images;
    if (isRaw) part = setGeminiFunctionResponseRaw(part, "functionResponse.response.result", result);
    else (fr().response as Obj).result = result;
  } else if (isObj(outputResult)) {
    const media = openAIResponsesMediaFromBlock(outputResult);
    if (media) {
      imageParts.push(geminiResponsesInlineDataPart(media.mimeType, media.data));
      (fr().response as Obj).result = "";
    } else {
      part = setGeminiFunctionResponseResult(part, "functionResponse.response.result", outputResult);
    }
  } else if (outputResult !== undefined && outputResult !== null) {
    (fr().response as Obj).result = gstr(outputResult);
  }

  for (const p of imageParts) {
    const inline = getAt(p, "inline_data");
    const fileData = getAt(p, "file_data");
    const list = isArr(fr().parts) ? (fr().parts as unknown[]) : [];
    if (inline !== undefined) list.push({ inlineData: { mimeType: str(inline, "mime_type"), data: str(inline, "data") } });
    else if (fileData !== undefined) list.push({ fileData: { mimeType: str(fileData, "mime_type"), fileUri: str(fileData, "file_uri") } });
    else continue;
    fr().parts = list;
  }
  return [part];
}

function collectOpenAIResponsesFunctionCallOutputs(items: unknown[], start: number, pendingCallIDs: string[]): { ordered: unknown[]; consumed: Set<number> } {
  let end = start + 1;
  while (end < items.length && isOpenAIResponsesToolOutput(items[end])) end++;
  const outputs = items.slice(start, end);
  const ordered: unknown[] = [];
  const used = new Array<boolean>(outputs.length).fill(false);
  for (const pendingID of pendingCallIDs) {
    const match = outputs.findIndex((o, idx) => !used[idx] && extractResponsesCallID(o) === pendingID);
    if (match < 0) continue;
    used[match] = true;
    ordered.push(outputs[match]);
  }
  outputs.forEach((o, idx) => {
    if (!used[idx]) ordered.push(o);
  });
  const consumed = new Set<number>();
  for (let idx = start; idx < end; idx++) consumed.add(idx);
  return { ordered, consumed };
}

function buildOpenAIResponsesFunctionCallModelContent(item: unknown, signature: string, forwardMap: Map<string, string> | undefined): Obj {
  return { role: "model", parts: [buildOpenAIResponsesFunctionCallPart(item, signature, forwardMap)] };
}

function buildOpenAIResponsesEmptyReasoningFunctionCallModelContent(item: unknown, signature: string, forwardMap: Map<string, string> | undefined): Obj {
  return { role: "model", parts: [{ text: "", thought: true, thoughtSignature: signature }, buildOpenAIResponsesFunctionCallPart(item, signature, forwardMap)] };
}

function buildOpenAIResponsesReasoningFunctionCallModelContent(thoughtText: string, item: unknown, signature: string, forwardMap: Map<string, string> | undefined): Obj {
  const parts: Part[] = [];
  if (thoughtText !== "") parts.push({ text: thoughtText, thought: true });
  parts.push(buildOpenAIResponsesFunctionCallPart(item, signature, forwardMap));
  return { role: "model", parts };
}

function buildOpenAIResponsesReasoningModelContent(thoughtText: string, visibleText: string, signature: string, useGeminiNativeReasoningLayout: boolean): Obj | undefined {
  const hasRealSignature = signature !== "" && signature !== geminiResponsesThoughtSignature;
  if (useGeminiNativeReasoningLayout) {
    if (thoughtText === "" && visibleText === "") {
      if (!hasRealSignature) return undefined;
      return { role: "model", parts: [{ text: "", thoughtSignature: signature }] };
    }
    const parts: Part[] = [];
    if (thoughtText !== "") {
      const thought: Part = { text: thoughtText, thought: true };
      if (visibleText === "" && hasRealSignature) thought.thoughtSignature = signature;
      parts.push(thought);
    }
    if (visibleText !== "") {
      const visible: Part = { text: visibleText };
      if (hasRealSignature) visible.thoughtSignature = signature;
      parts.push(visible);
    }
    return { role: "model", parts };
  }
  const thought: Part = { text: thoughtText, thought: true };
  if (hasRealSignature) thought.thoughtSignature = signature;
  return { role: "model", parts: [thought] };
}

function openAIResponsesGeminiThoughtSignature(rawSignature: string): string {
  return compatibleSignatureForProviderBlock(SignatureProviderGemini, rawSignature, SignatureBlockKindGeminiModelPart) ?? "";
}

function applyOpenAIResponsesTextFormatToGemini(root: unknown, genConfig: () => Obj): void {
  const textFormat = getAt(root, "text.format");
  if (textFormat === undefined) return;
  const formatType = str(textFormat, "type").trim().toLowerCase();
  switch (formatType) {
    case "json_object":
      genConfig().responseMimeType = "application/json";
      break;
    case "json_schema": {
      genConfig().responseMimeType = "application/json";
      let schema = getAt(textFormat, "schema");
      if (schema === undefined) schema = getAt(textFormat, "json_schema.schema");
      if (schema !== undefined) genConfig().responseJsonSchema = schema;
      break;
    }
  }
}

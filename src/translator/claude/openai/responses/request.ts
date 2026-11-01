// Port of internal/translator/claude/openai/responses/claude_openai-responses_request.go.
//
// OpenAI Responses request -> Claude Messages request:
//   - instructions, input[].role==system/developer -> separate top-level system blocks, in source order
//   - input[].type==message with input_text/output_text -> user/assistant messages
//   - function_call/custom_tool_call -> assistant tool_use
//   - function_call_output/custom_tool_call_output -> user tool_result
//   - tool_search_call/tool_search_output -> tool_use/tool_result (client tool search)
//   - web_search_call -> server_tool_use + web_search_tool_result
//   - reasoning -> thinking / redacted_thinking
//   - top-level tools and input[].additional_tools -> Claude tools[].input_schema
//   - max_output_tokens -> max_tokens, reasoning.effort -> thinking, text.format -> system instruction
import { log } from "../../../../log.ts";
import { lookupModelInfo } from "../../../../registry/index.ts";
import { SignatureProviderClaude, compatibleSignatureForProvider } from "../../../../signature/index.ts";
import { applyTranslatedSummaryToClaude, convertLevelToBudget, hasLevel, mapToClaudeEffort } from "../../../../thinking/index.ts";
import { UserTurnDrops } from "../../../common/parts.ts";
import { attachCacheControl } from "../../../common/cache_control.ts";
import { buildClaudeStructuredOutputInstruction } from "../../../common/claude_system.ts";
import { deriveClaudeUserID } from "../../../common/claude_user_id.ts";
import { generateClaudeToolCallID } from "../../../common/request.ts";
import { extractResponsesCallID, normalizeResponsesToolCallOutputs } from "../../../common/responses.ts";
import { applyPatchDescription, applyPatchParameters, isApplyPatchCustomTool } from "../../../common/apply_patch_tool.ts";
import { normalizeClaudeToolInputSchema } from "../../../../util/claude_schema.ts";
import { sanitizeClaudeFunctionName, sanitizeClaudeToolID } from "../../../../util/claude_tool_id.ts";
import { deepCopy, exists, garray, gbool, getAt, gint, gstr, isArr, isObj } from "../../../../util/gpath.ts";
import { tryParse } from "../../../../util/json.ts";
import {
  type ResponsesToolDescriptor,
  buildClaudeToolNames,
  qualifyResponsesNamespaceToolName,
  isUnsupportedOpenAIBuiltinToolType,
  responsesClientToolSearchWins,
  responsesDiscoveredToolPriority,
  responsesToolDescription,
  responsesToolDescriptors,
  responsesToolName,
  responsesToolNameMap,
  responsesToolParameters,
  responsesToolSearchType,
  responsesToolWinners,
} from "./tools.ts";
import {
  clientToolSearchEnabled,
  convertResponsesToolSearchCallToClaude,
  convertResponsesToolSearchToolToClaude,
  responsesDeferredAnchorTool,
  responsesToolSearchOutputContent,
  responsesToolSearchOutputText,
} from "./tool_search.ts";
import { ResponsesWebSearchHistory, attachClaudeCitations } from "./web_search.ts";

type JSONObject = Record<string, unknown>;

const defaultClaudeResponsesMaxTokens = 32000;
const defaultFableResponsesMaxTokens = 64000;

/**
 * Marks a Responses reasoning item whose encrypted_content carries an Anthropic
 * redacted_thinking payload instead of a thinking signature.
 */
export const claudeResponsesRedactedThinkingPrefix = "claude-redacted-thinking:";

/** The translated body plus the request-scoped refusal Go returned alongside it. */
export interface ClaudeRequestResult {
  body: string;
  err: Error | undefined;
}

/**
 * Converts a Responses request into a Claude Messages request with the current
 * upstream.claude.tool-search setting. Throws the request-scoped refusal (an
 * UnsupportedPartError) when a user turn would be sent empty.
 */
export function convertOpenAIResponsesRequestToClaude(modelName: string, inputRawJSON: string, stream: boolean): string {
  return unwrap(convertOpenAIResponsesRequestToClaudeResult(modelName, inputRawJSON, stream, false, clientToolSearchEnabled()));
}

/** Preserves reasoning items whose encrypted content is empty for configured compatibility endpoints. */
export function convertOpenAIResponsesRequestToClaudeWithCompat(modelName: string, inputRawJSON: string, stream: boolean): string {
  return unwrap(convertOpenAIResponsesRequestToClaudeResult(modelName, inputRawJSON, stream, true, clientToolSearchEnabled()));
}

/**
 * Translates with an explicitly pinned upstream.claude.tool-search value (Go:
 * ConvertOpenAIResponsesRequestEnvelopeToClaude / ...WithCompatContext).
 */
export function convertOpenAIResponsesRequestToClaudeWithToolSearch(
  modelName: string,
  inputRawJSON: string,
  stream: boolean,
  toolSearch: boolean,
  preserveEmptyThinkingBlocks = false,
): string {
  return unwrap(convertOpenAIResponsesRequestToClaudeResult(modelName, inputRawJSON, stream, preserveEmptyThinkingBlocks, toolSearch));
}

function unwrap(result: ClaudeRequestResult): string {
  if (result.err) throw result.err;
  return result.body;
}

/** The Go-shaped translation: the body is produced even when a refusal is reported. */
export function convertOpenAIResponsesRequestToClaudeResult(
  modelName: string,
  inputRawJSON: string,
  stream: boolean,
  preserveEmptyThinkingBlocks: boolean,
  toolSearch: boolean,
): ClaudeRequestResult {
  const rawJSON = normalizeCodexAgentMessages(inputRawJSON);
  const drops = new UserTurnDrops();
  const userID = deriveClaudeUserID(rawJSON);

  const out: JSONObject = { model: "", max_tokens: 32000, messages: [], metadata: {} };
  (out.metadata as JSONObject).user_id = userID;
  out.max_tokens = defaultClaudeResponsesMaxTokensForModel(modelName);

  const root = tryParse<unknown>(rawJSON);

  // Convert OpenAI Responses reasoning.effort to Claude thinking config.
  const effortValue = getAt(root, "reasoning.effort");
  if (exists(effortValue)) {
    let effort = gstr(effortValue).trim().toLowerCase();
    if (effort !== "") {
      const mi = lookupModelInfo(modelName, "claude");
      const levels = mi?.thinking?.levels;
      const supportsAdaptive = !!levels && levels.length > 0;
      const supportsMax = supportsAdaptive && hasLevel(levels, "max");
      const thinking = (): JSONObject => {
        if (!isObj(out.thinking)) out.thinking = {};
        return out.thinking as JSONObject;
      };
      const deleteOutputEffort = (): void => {
        if (isObj(out.output_config)) delete (out.output_config as JSONObject).effort;
      };
      if (supportsAdaptive) {
        switch (effort) {
          case "none":
            thinking().type = "disabled";
            delete thinking().budget_tokens;
            deleteOutputEffort();
            break;
          case "auto":
            thinking().type = "adaptive";
            delete thinking().budget_tokens;
            deleteOutputEffort();
            break;
          default: {
            if (!hasLevel(levels, effort)) {
              const mapped = mapToClaudeEffort(effort, supportsMax);
              if (mapped.ok) effort = mapped.effort;
            }
            thinking().type = "adaptive";
            delete thinking().budget_tokens;
            if (!isObj(out.output_config)) out.output_config = {};
            (out.output_config as JSONObject).effort = effort;
          }
        }
      } else {
        // Legacy/manual thinking (budget_tokens).
        const { budget, ok } = convertLevelToBudget(effort);
        if (ok) {
          if (budget === 0) thinking().type = "disabled";
          else if (budget === -1) thinking().type = "enabled";
          else if (budget > 0) {
            thinking().type = "enabled";
            thinking().budget_tokens = budget;
          }
        }
      }
    }
  }

  out.model = modelName;

  const mot = getAt(root, "max_output_tokens");
  if (exists(mot) && mot !== null) {
    let val = gint(mot);
    const info = lookupModelInfo(modelName, "claude");
    if (info && (info.maxCompletionTokens ?? 0) > 0 && val > info.maxCompletionTokens!) val = info.maxCompletionTokens!;
    out.max_tokens = val;
  }

  out.stream = stream;

  if (getAt(root, "service_tier") === "priority") out.speed = "fast";

  // System-level inputs become canonical top-level Claude system blocks in
  // source order: instructions first, then every input item whose role is
  // system or developer. The Claude executor decides the final placement.
  const messageBlocks: JSONObject[] = [];
  const systemBlocks: JSONObject[] = [];
  const appendSystemText = (text: string, cacheSource?: unknown): void => {
    if (text.trim() === "") return;
    let block: JSONObject = { type: "text", text };
    if (cacheSource !== undefined) block = attachCacheControl(block, cacheSource);
    systemBlocks.push(block);
  };
  const instructions = getAt(root, "instructions");
  if (typeof instructions === "string") appendSystemText(instructions);
  const rootInput = getAt(root, "input");
  if (isArr(rootInput)) {
    for (const item of rootInput) {
      if (!isResponsesSystemLevelRole(gstr(getAt(item, "role")))) continue;
      const startIdx = systemBlocks.length;
      const content = getAt(item, "content");
      if (typeof content === "string") {
        appendSystemText(content);
      } else if (isArr(content)) {
        for (const part of content) {
          switch (gstr(getAt(part, "type"))) {
            case "input_text":
            case "output_text":
            case "text": {
              const txt = gstr(getAt(part, "text"));
              if (txt.trim() === "") {
                if (exists(getAt(part, "cache_control")) && systemBlocks.length > startIdx) {
                  const prev = systemBlocks[systemBlocks.length - 1]!;
                  if (!exists(prev.cache_control)) attachCacheControl(prev, part);
                }
                continue;
              }
              appendSystemText(txt, part);
              break;
            }
            default: {
              const block = responsesSystemUnsupportedBlock(part);
              if (block) systemBlocks.push(block);
            }
          }
        }
      }
      // Item-level cache_control applies to the last block this item produced.
      if (exists(getAt(item, "cache_control")) && systemBlocks.length > startIdx) {
        const last = systemBlocks[systemBlocks.length - 1]!;
        if (!exists(last.cache_control)) attachCacheControl(last, item);
      }
    }
  }

  let formatResult = getAt(root, "text.format");
  if (!exists(formatResult)) formatResult = getAt(root, "response_format");
  const formatInstruction = buildClaudeStructuredOutputInstruction(formatResult);
  if (formatInstruction !== "") appendSystemText(formatInstruction);

  const names = buildClaudeToolNames(root, toolSearch);
  const winners = responsesToolWinners(root, toolSearch);
  // Native tool search declares discovered tools as deferred and replays
  // search results as tool_reference blocks, which keeps the cached prefix.
  const nativeToolSearch = responsesClientToolSearchWins(responsesToolDescriptors(root, toolSearch));

  let pendingRole = "";
  let pendingParts: JSONObject[] = [];
  let pendingToolUseParts: JSONObject[] = [];
  const flushPendingMessage = (): void => {
    if (pendingRole === "") return;
    let parts = pendingParts;
    if (pendingRole === "assistant" && pendingToolUseParts.length > 0) {
      const combined = [...pendingParts];
      const separator = claudeThinkingSeparatorForToolUse(pendingParts);
      if (separator) combined.push(deepCopy(separator));
      combined.push(...pendingToolUseParts);
      parts = combined;
    }
    if (parts.length > 0) {
      const msg: JSONObject = { role: pendingRole, content: [] };
      if (parts.length === 1 && isPlainTextPart(parts[0]!)) msg.content = gstr(parts[0]!.text);
      else msg.content = parts;
      messageBlocks.push(msg);
    }
    pendingRole = "";
    pendingParts = [];
    pendingToolUseParts = [];
  };
  const appendParts = (role: string, ...parts: JSONObject[]): void => {
    if (role === "" || parts.length === 0) return;
    if (pendingRole !== "" && pendingRole !== role) flushPendingMessage();
    pendingRole = role;
    pendingParts.push(...parts);
  };
  const appendToolUse = (toolUse: JSONObject | undefined): void => {
    if (!toolUse) return;
    if (pendingRole !== "" && pendingRole !== "assistant") flushPendingMessage();
    pendingRole = "assistant";
    pendingToolUseParts.push(toolUse);
  };
  const appendReasoning = (reasoningPart: JSONObject | undefined): void => {
    if (!reasoningPart) return;
    if (pendingRole !== "" && pendingRole !== "assistant") flushPendingMessage();
    pendingRole = "assistant";
    // Client tool calls normally stay at the end of an assistant message, but
    // a later reasoning item makes them a real separator between thinking blocks.
    if (pendingToolUseParts.length > 0) {
      pendingParts.push(...pendingToolUseParts);
      pendingToolUseParts = [];
    }
    if (reasoningPart.type === "thinking" && pendingParts.length > 0) {
      const lastIdx = pendingParts.length - 1;
      if (pendingParts[lastIdx]!.type === "thinking") {
        pendingParts[lastIdx] = reasoningPart;
        return;
      }
    }
    pendingParts.push(reasoningPart);
  };

  let inputItems: unknown[] = [];
  if (exists(rootInput)) {
    if (isArr(rootInput)) inputItems = normalizeResponsesToolCallOutputs(rootInput);
    else if (typeof rootInput === "string" && rootInput.trim() !== "") appendParts("user", { type: "text", text: rootInput });
  }

  const lastToolResult = new Map<string, unknown>();
  for (const item of inputItems) {
    const typ = gstr(getAt(item, "type"));
    if (typ === "function_call_output" || typ === "custom_tool_call_output") {
      const rawID = extractResponsesCallID(item);
      if (rawID !== "") lastToolResult.set(rawID, item);
    }
  }
  const emittedToolResults = new Set<string>();
  const emittedRawToolUses = new Set<string>();
  const unmappedItemTypes = new Map<string, number>();
  const countUnmapped = (typ: string): void => {
    unmappedItemTypes.set(typ, (unmappedItemTypes.get(typ) ?? 0) + 1);
  };
  const webSearchHistory = new ResponsesWebSearchHistory(inputItems);

  inputItems.forEach((item, itemIndex) => {
    // System-level items already became top-level system blocks.
    if (isResponsesSystemLevelRole(gstr(getAt(item, "role")))) return;
    let typ = gstr(getAt(item, "type"));
    if (typ === "" && gstr(getAt(item, "role")) !== "") typ = "message";
    switch (typ) {
      case "message": {
        let role = "";
        const partsJSON: JSONObject[] = [];
        let droppedPartType = "";
        const attachCacheControlToPrecedingPart = (src: unknown): void => {
          if (!exists(getAt(src, "cache_control")) || partsJSON.length === 0) return;
          const prev = partsJSON[partsJSON.length - 1]!;
          if (!exists(prev.cache_control)) attachCacheControl(prev, src);
        };
        const parts = getAt(item, "content");
        if (isArr(parts)) {
          for (const part of parts) {
            const ptype = gstr(getAt(part, "type"));
            switch (ptype) {
              case "input_text":
              case "output_text": {
                const t = getAt(part, "text");
                if (exists(t)) {
                  const txt = gstr(t);
                  if (txt.trim() !== "") {
                    let contentPart: JSONObject = { type: "text", text: txt };
                    contentPart = attachClaudeCitations(contentPart, getAt(part, "annotations"));
                    partsJSON.push(attachCacheControl(contentPart, part));
                  } else {
                    attachCacheControlToPrecedingPart(part);
                  }
                }
                role = ptype === "input_text" ? "user" : "assistant";
                break;
              }
              case "refusal": {
                // Claude has no refusal block; the text keeps the turn intact.
                const t = getAt(part, "refusal");
                if (exists(t)) {
                  const txt = gstr(t);
                  if (txt.trim() !== "") partsJSON.push(attachCacheControl({ type: "text", text: txt }, part));
                  else attachCacheControlToPrecedingPart(part);
                }
                role = "assistant";
                break;
              }
              case "input_image": {
                const contentPart = convertResponsesImagePart(part);
                if (contentPart) {
                  partsJSON.push(attachCacheControl(contentPart, part));
                  if (role === "") role = "user";
                }
                break;
              }
              case "input_file": {
                const contentPart = convertResponsesFilePart(part);
                if (contentPart) {
                  partsJSON.push(attachCacheControl(contentPart, part));
                  if (role === "") role = "user";
                } else if (droppedPartType === "") {
                  droppedPartType = ptype;
                }
                break;
              }
              case "input_audio":
                // Claude has no audio block, so the part cannot be sent.
                if (droppedPartType === "") droppedPartType = ptype;
                break;
            }
          }
        } else if (typeof parts === "string" && parts.trim() !== "") {
          partsJSON.push({ type: "text", text: parts });
        }

        // Fallback to given role if content types not decisive.
        if (role === "") {
          const r = gstr(getAt(item, "role"));
          role = r === "user" || r === "assistant" ? r : "user";
        }
        if (role === "user") {
          if (droppedPartType !== "") drops.drop(droppedPartType);
          drops.endTurn(partsJSON.length);
        }
        if (partsJSON.length > 0) {
          const last = partsJSON[partsJSON.length - 1]!;
          if (!exists(last.cache_control)) attachCacheControl(last, item);
          appendParts(role, ...partsJSON);
        }
        break;
      }

      case "web_search_call": {
        // Rebuild the Claude server-side search pair so the replayed turn still shows the search and its hits.
        const blocks = webSearchHistory.claudeBlocks(itemIndex, item);
        if (blocks.length > 0) appendParts("assistant", ...blocks);
        break;
      }

      case "reasoning":
        appendReasoning(convertResponsesReasoningToClaudeThinking(item, preserveEmptyThinkingBlocks));
        break;

      case "function_call":
      case "custom_tool_call": {
        // Freeform custom input is wrapped in an object because Claude tool_use input must be a JSON object.
        const rawCallID = extractResponsesCallID(item);
        let callID = rawCallID;
        if (callID === "") callID = generateClaudeToolCallID();
        callID = sanitizeClaudeToolID(callID);
        if (rawCallID !== "") emittedRawToolUses.add(rawCallID);
        let name = gstr(getAt(item, "name"));
        const namespaceName = gstr(getAt(item, "namespace")).trim();
        if (namespaceName !== "") name = qualifyResponsesNamespaceToolName(namespaceName, name);
        const toolUse: JSONObject = { type: "tool_use", id: callID, name: names.claudeName(name), input: {} };
        if (typ === "custom_tool_call") {
          toolUse.input = { input: gstr(getAt(item, "input")) };
        } else {
          const argsStr = gstr(getAt(item, "arguments"));
          const args = argsStr !== "" ? tryParse<unknown>(argsStr) : undefined;
          if (isObj(args)) toolUse.input = args;
        }
        appendToolUse(toolUse);
        break;
      }

      case "function_call_output":
      case "custom_tool_call_output": {
        const rawID = extractResponsesCallID(item);
        if (rawID !== "") {
          if (emittedToolResults.has(rawID)) return;
          emittedToolResults.add(rawID);
        }
        const outputItem = rawID !== "" && lastToolResult.has(rawID) ? lastToolResult.get(rawID) : item;
        const output = getAt(outputItem, "output");
        // Standalone outputs (no call_id, or one that never paired with a
        // function_call in this input) have no tool_use to attach to. Claude
        // rejects orphan tool_result blocks, so surface them as plain user text.
        if (rawID === "" || !emittedRawToolUses.has(rawID)) {
          appendParts("user", ...convertResponsesStandaloneToolOutputToClaudeText(output));
          return;
        }
        let toolResult: JSONObject = { type: "tool_result", tool_use_id: sanitizeClaudeToolID(rawID), content: "" };
        // Responses reports an unfinished tool output as status "incomplete";
        // Claude's only in-band equivalent is is_error on tool_result.
        if (gstr(getAt(outputItem, "status")).trim().toLowerCase() === "incomplete") toolResult.is_error = true;
        toolResult = applyResponsesToolResultContent(toolResult, output);
        appendParts("user", toolResult);
        break;
      }

      case "tool_search_call": {
        if (!toolSearch) {
          countUnmapped(typ);
          return;
        }
        const converted = convertResponsesToolSearchCallToClaude(item, names.claudeName(responsesToolSearchType));
        if (!converted) {
          countUnmapped(typ);
          return;
        }
        emittedRawToolUses.add(converted.callID);
        appendToolUse(converted.toolUse);
        break;
      }

      case "tool_search_output": {
        if (!toolSearch) {
          countUnmapped(typ);
          return;
        }
        const rawID = gstr(getAt(item, "call_id")).trim();
        if (rawID !== "") {
          if (emittedToolResults.has(rawID)) return;
          emittedToolResults.add(rawID);
        }
        if (rawID === "" || !emittedRawToolUses.has(rawID)) {
          appendParts("user", { type: "text", text: responsesToolSearchOutputText(item, names) });
          return;
        }
        appendParts("user", {
          type: "tool_result",
          tool_use_id: sanitizeClaudeToolID(rawID),
          content: responsesToolSearchOutputContent(item, names, winners, nativeToolSearch),
        });
        break;
      }

      default: {
        // Reachability guard: make an unmapped item type visible instead of dropping it in silence.
        // additional_tools is consumed later when building tools[].
        const t = gstr(getAt(item, "type"));
        if (t !== "" && t !== "additional_tools") countUnmapped(t);
      }
    }
  });
  flushPendingMessage();
  if (unmappedItemTypes.size > 0) {
    log.warn(`responses->claude: dropped input items of unmapped types ${JSON.stringify(Object.fromEntries(unmappedItemTypes))} (model=${modelName})`);
  }
  const hadMessages = messageBlocks.length > 0;
  let messages = messageBlocks;
  if (!preserveEmptyThinkingBlocks) messages = stripTrailingClaudeThinkingBlocks(messages);
  // Answer dangling tool_use blocks before the prefill check so an interrupted turn
  // ends with a synthesized user tool_result instead of a rejected assistant prefill.
  messages = repairClaudeToolPairing(messages);
  if (!preserveEmptyThinkingBlocks) messages = dropUnsupportedClaudeAssistantPrefill(modelName, messages);
  const problems = claudeMessageInvariantProblems(messages);
  if (problems.length > 0) log.warn(`responses->claude: message invariants violated after repair (model=${modelName}): ${problems.join("; ")}`);
  // Preserve a minimal conversational turn for system-only inputs or when messages became empty.
  if (messages.length === 0 && (systemBlocks.length > 0 || hadMessages)) messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  if (messages.length > 0) out.messages = messages;
  if (systemBlocks.length > 0) out.system = systemBlocks;

  const includedToolNames = new Set<string>();
  // Responses Lite puts tool definitions in input[].additional_tools. Select one
  // winner for each final name, keeping the original order for surviving tools.
  let toolItems: JSONObject[] = [];
  // The deferred anchor goes between declared and discovered tools, so each discovery only appends to tools[].
  let anchorIndex = -1;
  for (const descriptor of responsesToolDescriptors(root, toolSearch)) {
    const winner = winners.get(descriptor.name);
    if (!winner || winner.order !== descriptor.order) continue;
    const claudeName = names.claudeName(descriptor.name);
    const tJSON = convertResponsesToolDescriptorToClaude(descriptor, claudeName);
    if (!tJSON) continue;
    if (nativeToolSearch && descriptor.sourcePriority === responsesDiscoveredToolPriority) {
      if (anchorIndex < 0) anchorIndex = toolItems.length;
      // Anthropic rejects cache_control on deferred tools.
      delete tJSON.cache_control;
      tJSON.defer_loading = true;
    }
    const toolName = gstr(tJSON.name);
    if (toolName !== "") {
      includedToolNames.add(descriptor.name);
      includedToolNames.add(toolName);
    }
    toolItems.push(tJSON);
  }
  if (nativeToolSearch) {
    if (anchorIndex < 0) anchorIndex = toolItems.length;
    const anchor = responsesDeferredAnchorTool(toolItems);
    if (anchor) toolItems = [...toolItems.slice(0, anchorIndex), anchor, ...toolItems.slice(anchorIndex)];
  }
  const toolNameMap = responsesToolNameMap(root, includedToolNames, toolSearch);
  if (toolItems.length > 0) out.tools = toolItems;

  let toolChoiceNone = false;
  let forcedToolFilteredOut = false;
  const toolChoice = getAt(root, "tool_choice");
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto":
        out.tool_choice = { type: "auto" };
        break;
      case "none":
        toolChoiceNone = true;
        break;
      case "required":
        if (includedToolNames.size > 0) out.tool_choice = { type: "any" };
        else forcedToolFilteredOut = true;
        break;
    }
  } else if (isObj(toolChoice) || isArr(toolChoice)) {
    const choiceType = gstr(getAt(toolChoice, "type")).trim();
    if (choiceType === "none") {
      toolChoiceNone = true;
    } else if (choiceType === "function" || choiceType === "custom") {
      let fn = gstr(getAt(toolChoice, "function.name"));
      if (fn === "") fn = gstr(getAt(toolChoice, "custom.name"));
      if (fn === "") fn = gstr(getAt(toolChoice, "name"));
      let namespaceName = gstr(getAt(toolChoice, "namespace"));
      if (namespaceName === "") namespaceName = gstr(getAt(toolChoice, "function.namespace"));
      if (namespaceName === "") namespaceName = gstr(getAt(toolChoice, "custom.namespace"));
      if (namespaceName !== "") fn = qualifyResponsesNamespaceToolName(namespaceName, fn);
      const mappedName = toolNameMap.get(fn);
      if (mappedName) fn = mappedName;
      if (includedToolNames.has(fn)) out.tool_choice = { name: names.claudeName(fn), type: "tool" };
      else forcedToolFilteredOut = true;
    } else if (choiceType !== "" && choiceType !== "auto") {
      if (!includedToolNames.has(choiceType)) forcedToolFilteredOut = true;
    }
  }

  // parallel_tool_calls=false maps to Anthropic's disable_parallel_tool_use; not
  // added when the effective choice is none, no tool survived, or a forced tool was filtered out.
  if (getAt(root, "parallel_tool_calls") === false && !toolChoiceNone && !forcedToolFilteredOut && toolItems.length > 0) {
    if (isObj(out.tool_choice)) {
      if (gstr((out.tool_choice as JSONObject).type) !== "none") (out.tool_choice as JSONObject).disable_parallel_tool_use = true;
    } else {
      out.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }

  return { body: applyTranslatedSummaryToClaude(JSON.stringify(out), rawJSON, "openai-response", modelName), err: drops.err() };
}

function isPlainTextPart(part: JSONObject): boolean {
  return part.type === "text" && !exists(part.cache_control) && !exists(part.citations);
}

function convertResponsesImagePart(part: unknown): JSONObject | undefined {
  let url = gstr(getAt(part, "image_url"));
  if (url === "") url = gstr(getAt(part, "url"));
  if (url === "") return undefined;
  if (url.startsWith("data:")) {
    const { mediaType, data } = splitDataURL(url.slice(5), "");
    if (data === "") return undefined;
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  return { type: "image", source: { type: "url", url } };
}

function convertResponsesFilePart(part: unknown): JSONObject | undefined {
  const fileData = gstr(getAt(part, "file_data"));
  if (fileData === "") return undefined;
  let mediaType = "application/octet-stream";
  let data = fileData;
  if (fileData.startsWith("data:")) ({ mediaType, data } = splitDataURL(fileData.slice(5), fileData));
  return { type: "document", source: { type: "base64", media_type: mediaType, data } };
}

/** Splits "<media>;base64,<data>"; without the separator the fallback data is kept. */
function splitDataURL(trimmed: string, fallbackData: string): { mediaType: string; data: string } {
  const idx = trimmed.indexOf(";base64,");
  if (idx < 0) return { mediaType: "application/octet-stream", data: fallbackData };
  const media = trimmed.slice(0, idx);
  return { mediaType: media !== "" ? media : "application/octet-stream", data: trimmed.slice(idx + ";base64,".length) };
}

export function defaultClaudeResponsesMaxTokensForModel(modelName: string): number {
  const normalized = modelName.trim().toLowerCase();
  let maxTokens = defaultClaudeResponsesMaxTokens;
  if (normalized.includes("fable")) maxTokens = defaultFableResponsesMaxTokens;
  const info = lookupModelInfo(modelName, "claude");
  const limit = info?.maxCompletionTokens ?? 0;
  if (!info || limit <= 0) return maxTokens;
  // Fable keeps its conservative omitted-field ceiling; every other registered model uses its output limit.
  if (normalized.includes("fable") && limit >= maxTokens) return maxTokens;
  return limit;
}

/** Developer and system instructions rank above user content, so both map to Claude's system slot. */
export function isResponsesSystemLevelRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return r === "system" || r === "developer";
}

/**
 * Removes a trailing assistant message for Claude model families that reject
 * assistant prefill, except when it ends on a paused server-tool block.
 */
export function dropUnsupportedClaudeAssistantPrefill(modelName: string, messages: JSONObject[]): JSONObject[] {
  if (!claudeModelRejectsAssistantPrefill(modelName) || messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  if (gstr(last.role).trim().toLowerCase() !== "assistant") return messages;
  if (claudeAssistantMessageEndsWithPausedServerTool(last)) return messages;
  return messages.slice(0, -1);
}

function claudeAssistantMessageEndsWithPausedServerTool(message: JSONObject): boolean {
  const content = message.content;
  if (!isArr(content) || content.length === 0) return false;
  const t = gstr(getAt(content[content.length - 1], "type")).trim().toLowerCase();
  return t === "server_tool_use" || t === "web_search_tool_result";
}

/**
 * Removes trailing thinking and redacted_thinking blocks from the final assistant
 * message; the message is dropped when nothing remains.
 */
export function stripTrailingClaudeThinkingBlocks(messages: JSONObject[]): JSONObject[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;
  if (gstr(last.role).trim().toLowerCase() !== "assistant") return messages;
  const parts = last.content;
  if (!isArr(parts)) return messages;
  let end = parts.length;
  while (end > 0) {
    const partType = gstr(getAt(parts[end - 1], "type")).trim();
    if (partType === "thinking" || partType === "redacted_thinking") end--;
    else break;
  }
  if (end === parts.length) return messages;
  if (end === 0) return messages.slice(0, lastIdx);
  const remaining = parts.slice(0, end) as JSONObject[];
  last.content = end === 1 && isPlainTextPart(remaining[0]!) ? gstr(remaining[0]!.text) : remaining;
  return messages;
}

/** Reports whether a Claude model family disallows trailing assistant prefill. */
export function claudeModelRejectsAssistantPrefill(modelName: string): boolean {
  let normalized = modelName.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) normalized = normalized.slice(slash + 1);
  if (normalized.startsWith("claude-")) normalized = normalized.slice("claude-".length);
  const tokens = normalized.replaceAll(".", "-").split("-");
  if (tokens[0] === "fable") return true;
  if (tokens.length < 2 || (tokens[0] !== "opus" && tokens[0] !== "sonnet" && tokens[0] !== "haiku")) return false;
  const parseVersion = (token: string): number => {
    // Eight-digit snapshot dates must never be treated as versions.
    if (token === "" || token.length >= 8 || !/^[0-9]+$/.test(token)) return -1;
    return Number(token);
  };
  const major = parseVersion(tokens[1]!);
  if (major >= 5) return true;
  return tokens[0] === "sonnet" && major === 4 && tokens.length > 2 && parseVersion(tokens[2]!) >= 6;
}

/**
 * Represents a system-level content part Claude cannot carry as a typed marker
 * so the Claude executor can fail the request naming the offending type.
 */
export function responsesSystemUnsupportedBlock(part: unknown): JSONObject | undefined {
  const partType = gstr(getAt(part, "type")).trim();
  if (partType === "") return undefined;
  return { type: partType };
}

/**
 * Rebuilds one Claude thinking block from a Responses reasoning item. Items whose
 * encrypted_content is missing or belongs to another provider are dropped unless
 * compatibility mode keeps the opaque value as the signature.
 */
export function convertResponsesReasoningToClaudeThinking(item: unknown, preserveEmptyThinkingBlocks = false): JSONObject | undefined {
  const encrypted = gstr(getAt(item, "encrypted_content"));
  const redacted = responsesRedactedThinkingData(encrypted);
  if (redacted.isRedacted) {
    if (redacted.data === "") return undefined;
    return { type: "redacted_thinking", data: redacted.data };
  }
  let signature = compatibleSignatureForProvider(SignatureProviderClaude, encrypted);
  if (signature === undefined) {
    if (!preserveEmptyThinkingBlocks) return undefined;
    signature = encrypted;
  }
  return { type: "thinking", thinking: responsesReasoningText(item), signature };
}

/** Reports whether encrypted_content carries an Anthropic redacted_thinking payload and returns it. */
export function responsesRedactedThinkingData(encryptedContent: string): { data: string; isRedacted: boolean } {
  const trimmed = encryptedContent.trim();
  if (!trimmed.startsWith(claudeResponsesRedactedThinkingPrefix)) return { data: "", isRedacted: false };
  return { data: trimmed.slice(claudeResponsesRedactedThinkingPrefix.length).trim(), isRedacted: true };
}

/** Reasoning text from summary[] (preferred) or content[]. */
export function responsesReasoningText(item: unknown): string {
  const text = responsesReasoningPartsText(getAt(item, "summary"));
  if (text !== "") return text;
  return responsesReasoningPartsText(getAt(item, "content"));
}

function responsesReasoningPartsText(parts: unknown): string {
  if (!isArr(parts)) return "";
  let out = "";
  for (const part of parts) {
    const text = getAt(part, "text");
    if (exists(text)) out += gstr(text);
    else if (typeof part === "string") out += part;
  }
  return out;
}

/**
 * Returns the most recent thinking block when the buffered assistant content ends
 * with a server tool result, so the tool-use run that follows keeps a thinking block.
 */
export function claudeThinkingSeparatorForToolUse(parts: JSONObject[]): JSONObject | undefined {
  if (parts.length === 0 || parts[parts.length - 1]!.type !== "web_search_tool_result") return undefined;
  for (let index = parts.length - 1; index >= 0; index--) if (parts[index]!.type === "thinking") return parts[index];
  return undefined;
}

function applyResponsesToolResultContent(toolResult: JSONObject, output: unknown): JSONObject {
  if (isArr(output)) {
    const partsJSON: JSONObject[] = [];
    let hasImage = false;
    let hasFile = false;
    let droppedEmptyPart = false;
    for (const part of output) {
      const partJSON = convertResponsesContentPartToClaude(part);
      if (!partJSON) continue;
      if (!contentPartHasVisibleContent(partJSON)) {
        droppedEmptyPart = true;
        continue;
      }
      partsJSON.push(partJSON);
      if (partJSON.type === "image") hasImage = true;
      if (partJSON.type === "document") hasFile = true;
    }
    if (partsJSON.length === 0) {
      toolResult.content = droppedEmptyPart ? "" : JSON.stringify(output);
      return toolResult;
    }
    if (partsJSON.length === 1 && !hasImage && !hasFile && partsJSON[0]!.type === "text") {
      toolResult.content = gstr(partsJSON[0]!.text);
      return toolResult;
    }
    delete toolResult.content;
    toolResult.content = partsJSON;
    return toolResult;
  }
  toolResult.content = gstr(output);
  return toolResult;
}

/**
 * Reports shapes Anthropic rejects. It only describes; repairClaudeToolPairing
 * already fixes the known cases.
 */
export function claudeMessageInvariantProblems(messages: JSONObject[]): string[] {
  const problems: string[] = [];
  if (messages.length > 0 && gstr(messages[0]!.role) !== "user") problems.push("first message is not user");
  messages.forEach((msg, i) => {
    const role = gstr(msg.role);
    const content = garray(msg.content);
    if (role === "assistant") {
      const toolUseIDs = content.filter((b) => gstr(getAt(b, "type")) === "tool_use").map((b) => gstr(getAt(b, "id")));
      if (toolUseIDs.length === 0) return;
      if (i + 1 >= messages.length || gstr(messages[i + 1]!.role) !== "user") {
        problems.push(`messages[${i}] tool_use has no following user message`);
        return;
      }
      const answered = new Set(garray(messages[i + 1]!.content).filter((b) => gstr(getAt(b, "type")) === "tool_result").map((b) => gstr(getAt(b, "tool_use_id"))));
      for (const id of toolUseIDs) if (!answered.has(id)) problems.push(`messages[${i}] tool_use ${id} has no tool_result in messages[${i + 1}]`);
    } else if (role === "user") {
      const previous = i > 0 ? garray(messages[i - 1]!.content) : [];
      const toolUses = new Set(previous.filter((b) => gstr(getAt(b, "type")) === "tool_use").map((b) => gstr(getAt(b, "id"))));
      let leading = true;
      for (const block of content) {
        if (gstr(getAt(block, "type")) === "tool_result") {
          if (!leading) problems.push(`messages[${i}] tool_result after non-tool_result block`);
          const id = gstr(getAt(block, "tool_use_id"));
          if (!toolUses.has(id)) problems.push(`messages[${i}] tool_result ${id} has no tool_use in the previous message`);
        } else {
          leading = false;
        }
      }
    }
  });
  return problems;
}

/**
 * Enforces the Anthropic invariant that every assistant tool_use is answered by a
 * tool_result at the start of the very next user message, and that every
 * tool_result references a tool_use in the immediately preceding assistant
 * message. Missing results are synthesized as errors and orphan results fold into plain text.
 */
export function repairClaudeToolPairing(messages: JSONObject[]): JSONObject[] {
  if (messages.length === 0) return messages;
  let prevToolUseIDs = new Set<string>();
  const out: JSONObject[] = [];
  for (let i = 0; i < messages.length; i++) {
    let msg = messages[i]!;
    const role = gstr(msg.role);
    if (role === "user") {
      const rebuilt = normalizeClaudeToolResultMessage(msg, prevToolUseIDs);
      if (rebuilt) {
        msg = rebuilt;
        messages[i] = msg;
      }
    }
    out.push(msg);
    prevToolUseIDs = new Set<string>();
    if (role !== "assistant") continue;
    const toolUseIDs: string[] = [];
    for (const block of garray(msg.content)) {
      if (gstr(getAt(block, "type")) !== "tool_use") continue;
      const id = gstr(getAt(block, "id"));
      if (id !== "") {
        toolUseIDs.push(id);
        prevToolUseIDs.add(id);
      }
    }
    if (toolUseIDs.length === 0) continue;
    const hasNextUser = i + 1 < messages.length && gstr(messages[i + 1]!.role) === "user";
    const answered = new Set<string>();
    if (hasNextUser) {
      for (const block of garray(messages[i + 1]!.content)) if (gstr(getAt(block, "type")) === "tool_result") answered.add(gstr(getAt(block, "tool_use_id")));
    }
    const synthesized: JSONObject[] = [];
    for (const id of toolUseIDs) {
      if (answered.has(id)) continue;
      synthesized.push({ type: "tool_result", tool_use_id: id, is_error: true, content: "Tool call was interrupted before any output was recorded." });
    }
    if (synthesized.length === 0) continue;
    if (hasNextUser) {
      // Prepend the missing results so tool_result blocks still lead the existing user message.
      const nextContent = messages[i + 1]!.content;
      const parts: unknown[] = [...synthesized];
      if (isArr(nextContent)) parts.push(...nextContent);
      else if (typeof nextContent === "string") parts.push({ type: "text", text: nextContent });
      messages[i + 1] = { role: "user", content: parts };
    } else {
      out.push({ role: "user", content: synthesized });
    }
  }
  return out;
}

/**
 * Rebuilds a user message so tool_result blocks lead the content and any
 * tool_result that does not answer the preceding assistant folds into plain text.
 * Returns undefined when nothing changed.
 */
function normalizeClaudeToolResultMessage(msg: JSONObject, answeredIDs: Set<string>): JSONObject | undefined {
  const content = msg.content;
  if (!isArr(content)) return undefined;
  const resultParts: unknown[] = [];
  const otherParts: unknown[] = [];
  let seenOther = false;
  let changed = false;
  for (const block of content) {
    if (gstr(getAt(block, "type")) === "tool_result") {
      if (!answeredIDs.has(gstr(getAt(block, "tool_use_id")))) {
        changed = true;
        seenOther = true;
        const textParts = toolResultTextParts(block);
        // An empty orphan result keeps an explicit marker instead of an empty user message.
        if (textParts.length > 0) otherParts.push(...textParts);
        else otherParts.push({ type: "text", text: "Tool result was empty." });
        continue;
      }
      resultParts.push(block);
      if (seenOther) changed = true;
      continue;
    }
    seenOther = true;
    otherParts.push(block);
  }
  if (!changed) return undefined;
  return { role: "user", content: [...resultParts, ...otherParts] };
}

/** Folds an orphan tool_result block into visible plain text parts. */
function toolResultTextParts(block: unknown): unknown[] {
  const content = getAt(block, "content");
  if (isArr(content)) {
    const parts: unknown[] = [];
    for (const part of content) {
      let raw = deepCopy(part);
      if (gstr(getAt(part, "type")) === "") raw = isObj(raw) ? { ...raw, type: "text" } : { type: "text" };
      if (!contentPartHasVisibleContent(raw as JSONObject)) continue;
      parts.push(raw);
    }
    return parts;
  }
  const text = gstr(content);
  if (text.trim() === "") return [];
  return [{ type: "text", text }];
}

/** Renders a tool output that has no matching tool_use as ordinary user content blocks. */
function convertResponsesStandaloneToolOutputToClaudeText(output: unknown): JSONObject[] {
  if (isArr(output)) {
    const partsJSON: JSONObject[] = [];
    for (const part of output) {
      const partJSON = convertResponsesContentPartToClaude(part);
      // Drop empty text parts; images and documents always count.
      if (partJSON && contentPartHasVisibleContent(partJSON)) partsJSON.push(partJSON);
    }
    if (partsJSON.length > 0) return partsJSON;
  }
  const text = gstr(output);
  if (isArr(output) || text.trim() === "") return [{ type: "text", text: "Tool result was empty." }];
  return [{ type: "text", text }];
}

/** Whether a converted Claude content block carries user-visible payload. */
function contentPartHasVisibleContent(part: JSONObject): boolean {
  if (gstr(part.type) === "text") return gstr(part.text).trim() !== "";
  return true;
}

function convertResponsesContentPartToClaude(part: unknown): JSONObject | undefined {
  switch (gstr(getAt(part, "type"))) {
    case "input_text":
    case "output_text": {
      const t = getAt(part, "text");
      return exists(t) ? { type: "text", text: gstr(t) } : undefined;
    }
    case "input_image":
      return convertResponsesImagePart(part);
    case "input_file":
      return convertResponsesFilePart(part);
  }
  return undefined;
}

function convertResponsesToolDescriptorToClaude(descriptor: ResponsesToolDescriptor, claudeName: string): JSONObject | undefined {
  let overrideName = claudeName;
  if (overrideName === "" && !descriptor.direct) overrideName = descriptor.name;
  if (descriptor.clientSearch) return convertResponsesToolSearchToolToClaude(descriptor.tool, claudeName);
  switch (descriptor.toolType) {
    case "function":
      return convertResponsesFunctionToolToClaude(descriptor.tool, overrideName);
    case "custom":
      return convertResponsesCustomToolToClaude(descriptor.tool, overrideName);
    case "web_search":
      return convertResponsesWebSearchToolToClaude(descriptor.tool);
    default:
      if (isUnsupportedOpenAIBuiltinToolType(descriptor.toolType)) return undefined;
      if (gstr(getAt(descriptor.tool, "name")) === "") return undefined;
      return isObj(descriptor.tool) ? deepCopy(descriptor.tool) : undefined;
  }
}

function convertResponsesFunctionToolToClaude(tool: unknown, overrideName: string): JSONObject | undefined {
  let name = overrideName.trim();
  if (name === "") name = sanitizeClaudeFunctionName(responsesToolName(tool));
  if (name === "") return undefined;
  let tJSON: JSONObject = { name, description: "", input_schema: { type: "object", properties: {} } };
  const description = responsesToolDescription(tool);
  if (description !== "") tJSON.description = description;
  const parameters = responsesToolParameters(tool);
  tJSON.input_schema = JSON.parse(normalizeClaudeToolInputSchema(parameters === undefined ? "" : JSON.stringify(parameters)));
  tJSON = attachCacheControl(tJSON, tool);
  if (!exists(tJSON.cache_control)) tJSON = attachCacheControl(tJSON, getAt(tool, "function"));
  return tJSON;
}

function convertResponsesCustomToolToClaude(tool: unknown, overrideName: string): JSONObject | undefined {
  let name = overrideName.trim();
  if (name === "") name = sanitizeClaudeFunctionName(responsesToolName(tool));
  if (name === "") return undefined;
  const tJSON: JSONObject = { name, description: "", input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } };
  const description = responsesToolDescription(tool);
  if (description !== "") tJSON.description = description;
  if (isApplyPatchCustomTool(tool)) {
    tJSON.description = applyPatchDescription(tool);
    tJSON.input_schema = JSON.parse(applyPatchParameters());
  }
  return attachCacheControl(tJSON, tool);
}

function convertResponsesWebSearchToolToClaude(tool: unknown): JSONObject | undefined {
  const externalWebAccess = getAt(tool, "external_web_access");
  if (exists(externalWebAccess) && !gbool(externalWebAccess)) return undefined;
  let name = gstr(getAt(tool, "name")).trim();
  if (name === "") name = "web_search";
  const tJSON: JSONObject = { type: "web_search_20250305", name };
  const maxUses = getAt(tool, "max_uses");
  if (exists(maxUses)) tJSON.max_uses = gint(maxUses);
  const allowedDomains = getAt(tool, "filters.allowed_domains");
  if (isArr(allowedDomains)) tJSON.allowed_domains = deepCopy(allowedDomains);
  const userLocation = getAt(tool, "user_location");
  if (isObj(userLocation)) tJSON.user_location = deepCopy(userLocation);
  return tJSON;
}

/**
 * Rewrites Codex multi-agent v2 "agent_message" input items into plain user
 * "message" items; encrypted content parts are surfaced as input_text.
 */
export function normalizeCodexAgentMessages(payload: string): string {
  const root = tryParse<unknown>(payload);
  const input = getAt(root, "input");
  if (!isArr(input)) return payload;
  let changed = false;
  for (const item of input) {
    if (!isObj(item) || gstr(item.type).trim() !== "agent_message") continue;
    if (isArr(item.content)) {
      for (const part of item.content) {
        if (!isObj(part) || gstr(part.type).trim() !== "encrypted_content") continue;
        const enc = part.encrypted_content;
        if (typeof enc !== "string") continue;
        part.type = "input_text";
        part.text = enc;
        delete part.encrypted_content;
      }
    }
    item.role = "user";
    item.type = "message";
    changed = true;
  }
  return changed ? JSON.stringify(root) : payload;
}

/** Freeform custom tool names (and their Claude names) declared by a Responses request. */
export function responsesCustomToolNames(requestRawJSON: string): Set<string> {
  const names = new Set<string>();
  const root = tryParse<unknown>(requestRawJSON);
  const toolSearch = clientToolSearchEnabled();
  const winners = responsesToolWinners(root, toolSearch);
  const toolNames = buildClaudeToolNames(root, toolSearch);
  for (const [name, descriptor] of winners) {
    if (descriptor.toolType !== "custom") continue;
    names.add(name);
    const cName = toolNames.claudeName(name);
    if (cName !== "") names.add(cName);
  }
  return names;
}

/** Extracts the freeform input from custom tool arguments, tolerating truncated JSON. */
export function unwrapCustomToolInput(args: string): string {
  const trimmed = args.trim();
  const parsed = tryParse<unknown>(trimmed);
  const v = getAt(parsed, "input");
  if (exists(v)) return typeof v === "string" ? v : JSON.stringify(v);
  const idx = trimmed.indexOf(`"input"`);
  if (idx >= 0) {
    let rest = trimmed.slice(idx + 7).trim();
    if (rest.startsWith(":")) {
      rest = rest.slice(1).trim();
      if (rest.startsWith(`"`)) {
        const content = rest.slice(1);
        let unescaped = "";
        let inEscape = false;
        for (let i = 0; i < content.length; i++) {
          const c = content[i]!;
          if (inEscape) {
            switch (c) {
              case '"':
              case "\\":
              case "/":
                unescaped += c;
                break;
              case "b":
                unescaped += "\b";
                break;
              case "f":
                unescaped += "\f";
                break;
              case "n":
                unescaped += "\n";
                break;
              case "r":
                unescaped += "\r";
                break;
              case "t":
                unescaped += "\t";
                break;
              case "u": {
                const hex = content.slice(i + 1, i + 5);
                if (i + 4 < content.length && /^[0-9a-fA-F]{4}$/.test(hex)) {
                  unescaped += String.fromCharCode(parseInt(hex, 16));
                  i += 4;
                  inEscape = false;
                  continue;
                }
                unescaped += "\\u";
                break;
              }
              default:
                unescaped += "\\" + c;
            }
            inEscape = false;
          } else if (c === "\\") {
            inEscape = true;
          } else if (c === '"') {
            break;
          } else {
            unescaped += c;
          }
        }
        if (inEscape) unescaped += "\\";
        return unescaped;
      }
    }
  }
  return args;
}

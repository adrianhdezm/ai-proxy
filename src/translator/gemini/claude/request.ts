// Port of internal/translator/gemini/claude/gemini_claude_request.go.
//
// Parses a Claude Messages request and returns a complete Gemini generateContent
// request body (as a JSON string). Payloads are strings; the body is built on
// parsed objects and serialised on the way out.
import { lookupModelInfo } from "../../../registry/index.ts";
import { SignatureBlockKindGeminiModelPart, geminiReplaySignatureOrBypass, restoreCodexCommentaryMarkers } from "../../../signature/index.ts";
import { applySummaryConfigForModel, extractTranslatedSummaryConfig } from "../../../thinking/index.ts";
import { isClaudeCodeAttributionSystemText } from "../../../util/claude_attribution.ts";
import { convertClaudeToolResultContent } from "../../../util/claude_tool_result.ts";
import { sanitizeFunctionName } from "../../../util/function_name.ts";
import { cleanJSONSchemaForGeminiJSONSchema } from "../../../util/gemini_schema.ts";
import { deepCopy, getAt, gstr, isObj, setAt } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import {
  UserTurnDrops,
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
  countSendableGeminiParts,
  mergeAdjacentGeminiContents,
  reorderGeminiUserParts,
  setGeminiFunctionResponseRaw,
} from "../../common/index.ts";
import { FormatClaude, FormatGemini } from "../../types.ts";
import { attachDefaultSafetySettings } from "../common/safety.ts";

/** Thought signature placed on replayed functionCall parts so Gemini skips signature validation. */
export const geminiClaudeThoughtSignature = "skip_thought_signature_validator";

/**
 * Converts a Claude Messages request into a Gemini generateContent request body.
 * Throws an UnsupportedPartError (request-scoped, HTTP 400) when a user turn is
 * left with nothing sendable after dropping unrepresentable parts.
 */
export function convertClaudeRequestToGemini(modelName: string, inputRawJSON: string, stream: boolean): string {
  return convertClaudeRequestToGeminiInternal(modelName, inputRawJSON, stream, false);
}

/** Like convertClaudeRequestToGemini but preserves assistant thinking blocks (with bypass signatures) for compatibility endpoints. */
export function convertClaudeRequestToGeminiWithCompat(modelName: string, inputRawJSON: string, stream: boolean): string {
  return convertClaudeRequestToGeminiInternal(modelName, inputRawJSON, stream, true);
}

function convertClaudeRequestToGeminiInternal(modelName: string, inputRawJSON: string, _stream: boolean, preserveEmptyThinkingBlocks: boolean): string {
  // Upstream's SDK registry extracts the summary (thinking.display) intent before
  // translation and writes it onto the translated body afterwards; this port's
  // registry is a thin dispatcher, so the translator does both steps itself.
  const summaryConfig = extractTranslatedSummaryConfig(inputRawJSON, FormatClaude, FormatGemini);

  // The internal commentary marker must be restored as assistant text before
  // any thinking handling, so it is never dropped or mapped to thought.
  const rawJSON = restoreCodexCommentaryMarkers(inputRawJSON).payload;
  const root = tryParse<unknown>(rawJSON);
  const drops = new UserTurnDrops();
  const out: Record<string, unknown> = { contents: [], model: modelName };

  // system instruction
  const system = getAt(root, "system");
  if (Array.isArray(system)) {
    const systemParts: unknown[] = [];
    for (const item of system) {
      if (gstr(getAt(item, "type")) !== "text") continue;
      const text = getAt(item, "text");
      if (typeof text !== "string") continue;
      if (isClaudeCodeAttributionSystemText(text)) continue;
      systemParts.push({ text });
    }
    if (systemParts.length > 0) out.systemInstruction = { role: "user", parts: systemParts };
  } else if (typeof system === "string" && !isClaudeCodeAttributionSystemText(system)) {
    out.systemInstruction = { parts: [{ text: system }] };
  }

  // contents
  const messages = getAt(root, "messages");
  if (Array.isArray(messages)) {
    const contentItems: unknown[] = [];
    const toolNameByID = new Map<string, string>();
    let pendingToolUseIDs: string[] = [];
    for (const message of messages) {
      const roleValue = getAt(message, "role");
      if (typeof roleValue !== "string") continue;
      const originalRole = roleValue;
      let precedingToolUseIDs: string[] = [];
      if (originalRole !== "system" && originalRole !== "developer") {
        precedingToolUseIDs = pendingToolUseIDs;
        pendingToolUseIDs = [];
      }
      let role = originalRole;
      if (role === "assistant") role = "model";
      else if (role === "system" || role === "developer") role = "user";

      let partItems: unknown[] = [];
      let content = getAt(message, "content");
      if (originalRole === "system" || originalRole === "developer") {
        const reminderText = claudeMessageSystemReminderText(content);
        if (reminderText !== undefined) contentItems.push(geminiContentWithParts(role, [{ text: reminderText }]));
        continue;
      }
      if (Array.isArray(content)) {
        if (originalRole === "user") content = alignClaudeToolResults(content, precedingToolUseIDs);
        for (const block of content as unknown[]) {
          switch (gstr(getAt(block, "type"))) {
            case "text": {
              const text = gstr(getAt(block, "text"));
              if (text === "") break;
              partItems.push({ text });
              break;
            }
            case "thinking": {
              if (!preserveEmptyThinkingBlocks) break;
              const signature = geminiReplaySignatureOrBypass(gstr(getAt(block, "signature")), SignatureBlockKindGeminiModelPart);
              partItems.push({ text: gstr(getAt(block, "thinking")), thought: true, thoughtSignature: signature });
              break;
            }
            case "tool_use": {
              const rawFunctionName = gstr(getAt(block, "name"));
              const toolUseID = gstr(getAt(block, "id"));
              if (toolUseID !== "" && rawFunctionName !== "") toolNameByID.set(toolUseID, rawFunctionName);
              const functionName = sanitizeFunctionName(rawFunctionName);
              const args = claudeToolUseArgs(getAt(block, "input"));
              if (args === undefined) break;
              const functionCall: Record<string, unknown> = { name: functionName, args };
              if (toolUseID !== "") functionCall.id = toolUseID;
              partItems.push({ thoughtSignature: geminiClaudeThoughtSignature, functionCall });
              if (originalRole === "assistant") pendingToolUseIDs.push(toolUseID);
              break;
            }
            case "tool_result": {
              const toolCallID = gstr(getAt(block, "tool_use_id"));
              if (toolCallID === "") break;
              let funcName = toolNameByID.get(toolCallID) ?? "";
              if (funcName === "") funcName = toolNameFromClaudeToolUseID(toolCallID);
              if (funcName === "") funcName = toolCallID;
              funcName = sanitizeFunctionName(funcName);
              const toolResult = convertClaudeToolResultContent(getAt(block, "content"));
              let part: unknown = { functionResponse: { id: toolCallID, name: funcName, response: { result: "" } } };
              if (toolResult.resultIsRaw) part = setGeminiFunctionResponseRaw(part, "functionResponse.response.result", toolResult.result);
              else part = setAt(part, "functionResponse.response.result", toolResult.result);
              partItems.push(part);
              for (const img of toolResult.images) partItems.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
              break;
            }
            case "image":
            case "document":
            case "container_upload": {
              const part = claudeBase64InlineData(getAt(block, "source"));
              if (part !== undefined) partItems.push(part);
              else if (originalRole === "user") {
                // A part that cannot be inlined (url or file source) is dropped; the turn is refused only if nothing else is left.
                drops.drop(gstr(getAt(block, "type")));
              }
              break;
            }
            default:
              break;
          }
        }
        if (role === "user") partItems = reorderGeminiUserParts(partItems);
        if (originalRole === "user") {
          // Whitespace-only text is forwarded but never keeps an emptied turn alive.
          drops.endTurn(countSendableGeminiParts(partItems));
        }
        if (partItems.length > 0) contentItems.push(geminiContentWithParts(role, partItems));
      } else if (typeof content === "string") {
        contentItems.push(geminiContentWithParts(role, [{ text: content }]));
      }
    }

    // Strip a trailing model turn with unanswered function calls.
    if (contentItems.length > 0) {
      const last = contentItems[contentItems.length - 1];
      if (gstr(getAt(last, "role")) === "model") {
        const parts = getAt(last, "parts");
        if (Array.isArray(parts) && parts.some((part) => getAt(part, "functionCall") !== undefined)) contentItems.pop();
      }
    }
    const merged = mergeAdjacentGeminiContents(contentItems);
    if (merged.length > 0) out.contents = merged;
  }

  // tools
  const toolItems: unknown[] = [];
  let hasStrictTool = false;
  const tools = getAt(root, "tools");
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (getAt(tool, "strict") === true) hasStrictTool = true;
      const inputSchema = getAt(tool, "input_schema");
      if (inputSchema === undefined || !isObj(inputSchema) || !isObj(tool)) continue;
      const cleanedSchema = tryParse<unknown>(cleanJSONSchemaForGeminiJSONSchema(JSON.stringify(inputSchema)));
      if (cleanedSchema === undefined) continue;
      const declaration = deepCopy(tool) as Record<string, unknown>;
      delete declaration.input_schema;
      declaration.parametersJsonSchema = cleanedSchema;
      for (const key of ["strict", "input_examples", "type", "cache_control", "defer_loading", "eager_input_streaming"]) delete declaration[key];
      const nameValue = tool.name;
      const originalName = gstr(nameValue);
      const sanitizedName = sanitizeFunctionName(originalName);
      if (typeof nameValue !== "string" || sanitizedName !== originalName) declaration.name = sanitizedName;
      toolItems.push(declaration);
    }
    if (toolItems.length > 0) out.tools = [{ functionDeclarations: toolItems }];
  }

  // tool_choice
  const toolChoice = getAt(root, "tool_choice");
  if (toolChoice !== undefined && toolChoice !== null) {
    let toolChoiceType = "";
    let toolChoiceName = "";
    if (isObj(toolChoice)) {
      toolChoiceType = gstr(toolChoice.type);
      toolChoiceName = gstr(toolChoice.name);
    } else if (typeof toolChoice === "string") {
      toolChoiceType = toolChoice;
    }
    switch (toolChoiceType) {
      case "auto":
        setAt(out, "toolConfig.functionCallingConfig.mode", hasStrictTool ? "VALIDATED" : "AUTO");
        break;
      case "none":
        setAt(out, "toolConfig.functionCallingConfig.mode", "NONE");
        break;
      case "any":
        setAt(out, "toolConfig.functionCallingConfig.mode", "ANY");
        break;
      case "tool":
        setAt(out, "toolConfig.functionCallingConfig.mode", "ANY");
        if (toolChoiceName !== "") setAt(out, "toolConfig.functionCallingConfig.allowedFunctionNames", [sanitizeFunctionName(toolChoiceName)]);
        break;
    }
  } else if (hasStrictTool && toolItems.length > 0) {
    setAt(out, "toolConfig.functionCallingConfig.mode", "VALIDATED");
  }

  // Map Anthropic thinking -> Gemini thinking config when enabled.
  // The translator only converts the format; applyThinking handles model capability validation.
  const thinking = getAt(root, "thinking");
  if (isObj(thinking)) {
    switch (gstr(thinking.type)) {
      case "enabled": {
        const budget = thinking.budget_tokens;
        if (typeof budget === "number") setAt(out, "generationConfig.thinkingConfig.thinkingBudget", Math.trunc(budget));
        break;
      }
      case "adaptive":
      case "auto": {
        // For adaptive thinking:
        // - If output_config.effort is explicitly present, pass through as thinkingLevel.
        // - Otherwise, treat it as "enabled with target-model maximum" and emit thinkingBudget=max.
        // applyThinking handles clamping to the target model's supported levels.
        let effort = "";
        const effortValue = getAt(root, "output_config.effort");
        if (typeof effortValue === "string") effort = effortValue.trim().toLowerCase();
        if (effort !== "") {
          setAt(out, "generationConfig.thinkingConfig.thinkingLevel", effort);
        } else {
          let maxBudget = 0;
          const modelInfo = lookupModelInfo(modelName, "gemini");
          if (modelInfo?.thinking) maxBudget = modelInfo.thinking.max ?? 0;
          if (maxBudget > 0) setAt(out, "generationConfig.thinkingConfig.thinkingBudget", maxBudget);
          else setAt(out, "generationConfig.thinkingConfig.thinkingLevel", "high");
        }
        break;
      }
    }
  }
  const temperature = getAt(root, "temperature");
  if (typeof temperature === "number") setAt(out, "generationConfig.temperature", temperature);
  const topP = getAt(root, "top_p");
  if (typeof topP === "number") setAt(out, "generationConfig.topP", topP);
  const topK = getAt(root, "top_k");
  if (typeof topK === "number") setAt(out, "generationConfig.topK", topK);

  let result = JSON.stringify(out);
  result = attachDefaultSafetySettings(result, "safetySettings");
  result = applySummaryConfigForModel(result, FormatGemini, modelName, summaryConfig);

  const err = drops.err();
  if (err) throw err;
  return result;
}

/** The functionCall.args object for a Claude tool_use input (object, or JSON text of an object); undefined otherwise. */
function claudeToolUseArgs(input: unknown): Record<string, unknown> | undefined {
  if (isObj(input)) return input;
  if (typeof input === "string") {
    const parsed = tryParse<unknown>(input);
    if (isObj(parsed)) return parsed;
  }
  return undefined;
}

function claudeBase64InlineData(source: unknown): unknown {
  if (gstr(getAt(source, "type")) !== "base64") return undefined;
  const mimeType = gstr(getAt(source, "media_type"));
  const data = gstr(getAt(source, "data"));
  if (mimeType === "" || data === "") return undefined;
  return { inline_data: { mime_type: mimeType, data } };
}

function geminiContentWithParts(role: string, parts: unknown[]): unknown {
  return { role, parts };
}

function toolNameFromClaudeToolUseID(toolUseID: string): string {
  const parts = toolUseID.split("-");
  if (parts.length <= 1) return "";
  return parts.slice(0, parts.length - 1).join("-");
}

/**
 * Wraps a Gemini generateContent body in the Gemini CLI (Code Assist) request
 * envelope {"project","model","request"} (port of the v7.0.12 gemini-cli request
 * shape). The inner body's "model" is lifted to the envelope; an empty project is
 * omitted (countTokens requests carry neither).
 */
export function wrapGeminiCLIRequest(project: string, model: string, geminiBody: string): string {
  const parsed = tryParse<unknown>(geminiBody);
  const request: Record<string, unknown> = isObj(parsed) ? { ...parsed } : {};
  if (model === "") model = gstr(request.model);
  delete request.model;
  const envelope: Record<string, unknown> = {};
  if (project !== "") envelope.project = project;
  envelope.model = model;
  envelope.request = request;
  return JSON.stringify(envelope);
}

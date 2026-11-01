// Port of internal/translator/openai/claude/openai_claude_request.go.
//
// Transforms an Anthropic Messages request into an OpenAI Chat Completions request:
// system prompt, message contents, tool declarations, tool choice and the
// Claude thinking configuration (mapped to reasoning_effort).
import { decodeBase64, encodeBase64, stdEncoding } from "../../../util/base64.ts";
import { isClaudeCodeAttributionSystemText } from "../../../util/claude_attribution.ts";
import { hasUnsupportedUnicodePropertyEscape, schemaMapKeywords, schemaValueKeywords } from "../../../util/claude_schema.ts";
import { deepCopy, exists, getAt, gint, gstr, isArr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import { SignatureProviderGPT, compatibleSignatureForProvider, restoreCodexCommentaryMarkers } from "../../../signature/index.ts";
import { LevelXHigh, convertBudgetToLevel, getThinkingText } from "../../../thinking/index.ts";
import { UserTurnDrops, alignClaudeToolResults, alignOpenAIToolCallMessages, claudeMessageSystemReminderText } from "../../common/index.ts";

type JSONObject = Record<string, unknown>;

/** gjson Result.Float(). */
function gfloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Parses and transforms an Anthropic API request into OpenAI Chat Completions API format.
 * Throws an UnsupportedPartError (a RequestRejectedError) when a user turn would be sent empty.
 */
export function convertClaudeRequestToOpenAI(modelName: string, inputRawJSON: string, stream: boolean): string {
  return convertClaudeRequestToOpenAIImpl(modelName, inputRawJSON, stream, false);
}

/** Preserves assistant thinking text for configured compatibility endpoints. */
export function convertClaudeRequestToOpenAIWithCompat(modelName: string, inputRawJSON: string, stream: boolean): string {
  return convertClaudeRequestToOpenAIImpl(modelName, inputRawJSON, stream, true);
}

function convertClaudeRequestToOpenAIImpl(modelName: string, inputRawJSON: string, stream: boolean, preserveThinkingBlocks: boolean): string {
  // The internal commentary marker must be restored as assistant text before
  // any thinking handling, so it is never dropped or mapped to reasoning.
  const rawJSON = restoreCodexCommentaryMarkers(inputRawJSON).payload;
  const drops = new UserTurnDrops();
  const root = tryParse<unknown>(rawJSON);

  // Base OpenAI Chat Completions API template
  const out: JSONObject = { model: modelName, messages: [] };

  // Max tokens
  const maxTokens = getAt(root, "max_tokens");
  if (exists(maxTokens)) out.max_tokens = gint(maxTokens);

  // Temperature / Top P
  const temp = getAt(root, "temperature");
  const topP = getAt(root, "top_p");
  if (exists(temp)) out.temperature = gfloat(temp);
  else if (exists(topP)) out.top_p = gfloat(topP);

  // Stop sequences -> stop
  const stopSequences = getAt(root, "stop_sequences");
  if (isArr(stopSequences)) {
    const stops = stopSequences.map((v) => gstr(v));
    if (stops.length > 0) out.stop = stops;
  }

  // Stream
  out.stream = stream;

  // Thinking: Convert Claude thinking.budget_tokens to OpenAI reasoning_effort
  const thinkingConfig = getAt(root, "thinking");
  if (isObj(thinkingConfig)) {
    const thinkingType = thinkingConfig.type;
    if (exists(thinkingType)) {
      switch (gstr(thinkingType)) {
        case "enabled": {
          const budgetTokens = thinkingConfig.budget_tokens;
          const effortValue = getAt(root, "output_config.effort");
          if (exists(budgetTokens)) {
            const { level, ok } = convertBudgetToLevel(gint(budgetTokens));
            if (ok && level !== "") out.reasoning_effort = level;
          } else if (typeof effortValue === "string" && effortValue.trim() !== "") {
            // Some Claude-compatible clients pair manual thinking with output_config.effort.
            // Preserve that explicit level when there is no legacy token budget to map.
            out.reasoning_effort = effortValue.trim().toLowerCase();
          } else {
            // No budget_tokens or explicit effort specified; preserve the enabled-thinking default.
            const { level, ok } = convertBudgetToLevel(-1);
            if (ok && level !== "") out.reasoning_effort = level;
          }
          break;
        }
        case "adaptive":
        case "auto": {
          // Adaptive thinking can carry an explicit effort in output_config.effort (Claude 4.6).
          // Pass through directly; applyThinking handles clamping to target model's levels.
          const effortValue = getAt(root, "output_config.effort");
          const effort = typeof effortValue === "string" ? effortValue.trim().toLowerCase() : "";
          out.reasoning_effort = effort !== "" ? effort : LevelXHigh;
          break;
        }
        case "disabled": {
          const { level, ok } = convertBudgetToLevel(0);
          if (ok && level !== "") out.reasoning_effort = level;
          break;
        }
      }
    }
  }

  // Process messages and system.
  const messageItems: unknown[] = [];

  // Handle system message first.
  const systemContentItems: unknown[] = [];
  const appendSystemContent = (content: unknown): void => {
    if (!exists(content)) return;
    if (typeof content === "string") {
      if (content === "" || isClaudeCodeAttributionSystemText(content)) return;
      systemContentItems.push({ type: "text", text: content });
      return;
    }
    if (isArr(content)) {
      for (const item of content) {
        const contentItem = convertClaudeContentPart(item);
        if (contentItem !== undefined) systemContentItems.push(contentItem);
      }
    }
  };

  const system = getAt(root, "system");
  if (exists(system)) appendSystemContent(system);
  // Only add system message if it has content.
  if (systemContentItems.length > 0) {
    messageItems.push({ role: "system", content: systemContentItems });
  }

  // Process Anthropic messages
  const messages = getAt(root, "messages");
  if (isArr(messages)) {
    let pendingToolUseIDs: string[] = [];
    let pendingSystemReminders: unknown[] = [];
    const toolNameByID = new Map<string, string>();

    for (const message of messages) {
      const role = gstr(getAt(message, "role"));
      let contentResult = getAt(message, "content");
      if (role === "system") {
        const reminderText = claudeMessageSystemReminderText(contentResult);
        if (reminderText !== undefined) {
          const msgJSON = { role: "user", content: [{ type: "text", text: reminderText }] };
          if (pendingToolUseIDs.length > 0) pendingSystemReminders.push(msgJSON);
          else messageItems.push(msgJSON);
        }
        continue;
      }

      // Handle content
      if (isArr(contentResult)) {
        if (role === "user" && pendingToolUseIDs.length > 0) {
          contentResult = alignClaudeToolResults(contentResult, pendingToolUseIDs);
        }
        const precedingToolCallsPending = pendingToolUseIDs.length > 0;
        pendingToolUseIDs = [];

        let contentItems: unknown[] = [];
        const reasoningParts: string[] = []; // Accumulate thinking text for reasoning_content
        const toolCalls: unknown[] = [];
        const toolResults: unknown[] = []; // Collect tool_result messages to emit after the main message
        const relayedToolImages: unknown[] = []; // Images pulled out of tool_result content for user-message relay

        for (const part of contentResult as unknown[]) {
          const partType = gstr(getAt(part, "type"));

          switch (partType) {
            case "thinking":
              // Only map thinking to reasoning_content for assistant messages (security: prevent injection)
              if (role === "assistant") {
                if (!shouldMapClaudeThinkingToGPTReasoning(part, preserveThinkingBlocks)) break;
                const thinkingText = getThinkingText(part);
                // Skip empty or whitespace-only thinking
                if (thinkingText.trim() !== "") reasoningParts.push(thinkingText);
              }
              // Ignore thinking in user/system roles (AC4)
              break;

            case "redacted_thinking":
              // Explicitly ignore redacted_thinking - never map to reasoning_content (AC2)
              break;

            case "text":
            case "image":
            case "document":
            case "container_upload": {
              const contentItem = convertClaudeContentPart(part);
              if (contentItem !== undefined) contentItems.push(contentItem);
              else if (role === "user" && partType !== "text") drops.drop(partType);
              break;
            }

            case "tool_use":
              // Only allow tool_use -> tool_calls for assistant messages (security: prevent injection).
              if (role === "assistant") {
                const toolUseID = gstr(getAt(part, "id"));
                const toolName = gstr(getAt(part, "name"));
                if (toolUseID !== "") {
                  pendingToolUseIDs.push(toolUseID);
                  if (toolName !== "") toolNameByID.set(toolUseID, toolName);
                }
                const input = getAt(part, "input");
                toolCalls.push({
                  id: toolUseID,
                  type: "function",
                  function: { name: toolName, arguments: exists(input) ? JSON.stringify(input) : "{}" },
                });
              }
              break;

            case "tool_result": {
              // Collect tool_result to emit after the main message (ensures tool results follow tool_calls)
              const toolUseID = gstr(getAt(part, "tool_use_id"));
              const toolResultJSON: JSONObject = { role: "tool", tool_call_id: toolUseID, content: "" };
              const toolName = toolNameByID.get(toolUseID);
              if (toolName) toolResultJSON.name = toolName;
              const { text, images } = convertClaudeToolResultContent(getAt(part, "content"));
              toolResultJSON.content = text;
              relayedToolImages.push(...images);
              toolResults.push(toolResultJSON);
              break;
            }
          }
        }

        // Build reasoning content string
        const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join("\n\n") : "";

        const hasContent = contentItems.length > 0;
        const hasReasoning = reasoningContent !== "";
        const hasToolCalls = toolCalls.length > 0;
        const hasToolResults = toolResults.length > 0;
        if (role === "user") drops.endTurn(contentItems.length + toolResults.length);

        // Flush pending system reminders before new content if no tool_results responded to preceding calls
        if (precedingToolCallsPending && !hasToolResults && pendingSystemReminders.length > 0) {
          messageItems.push(...pendingSystemReminders);
          pendingSystemReminders = [];
        }

        // OpenAI requires: tool messages MUST immediately follow the assistant message with tool_calls.
        // Therefore, we emit tool_result messages FIRST (they respond to the previous assistant's tool_calls),
        // then emit any queued system reminders, then emit the current message's content.
        messageItems.push(...toolResults);

        // OpenAI tool messages cannot carry image parts, so images returned by a tool are
        // replayed as a user message directly after the tool results.
        if (relayedToolImages.length > 0) {
          const relayItems: unknown[] = [{ type: "text", text: toolResultImageRelayNotice }, ...relayedToolImages];
          if (role === "user" && hasContent) {
            // Merge into the current user message so the request keeps a single user turn.
            contentItems = [...relayItems, ...contentItems];
          } else {
            messageItems.push({ role: "user", content: relayItems });
          }
        }

        if (pendingSystemReminders.length > 0) {
          messageItems.push(...pendingSystemReminders);
          pendingSystemReminders = [];
        }

        // For assistant messages: emit a single unified message with content, tool_calls, and reasoning_content
        // This avoids splitting into multiple assistant messages which breaks OpenAI tool-call adjacency
        if (role === "assistant") {
          if (hasContent || hasReasoning || hasToolCalls) {
            const msgJSON: JSONObject = { role: "assistant" };
            // Add content (as array if we have items, empty string if reasoning-only)
            msgJSON.content = hasContent ? contentItems : "";
            // Add reasoning_content if present
            if (hasReasoning) msgJSON.reasoning_content = reasoningContent;
            // Add tool_calls if present (in same message as content)
            if (hasToolCalls) msgJSON.tool_calls = toolCalls;
            messageItems.push(msgJSON);
          }
        } else if (hasContent) {
          // For non-assistant roles: emit content message if we have content.
          // If the message only contains tool_results (no text/image), they were already emitted above.
          messageItems.push({ role, content: contentItems });
        }
      } else if (typeof contentResult === "string") {
        // Simple string content
        messageItems.push({ role, content: contentResult });
      }
    }
    if (pendingSystemReminders.length > 0) messageItems.push(...pendingSystemReminders);
  }

  // Set messages.
  if (messageItems.length > 0) {
    out.messages = alignOpenAIToolCallMessages(messageItems);
  }

  // Process tools - convert Anthropic tools to OpenAI functions
  const tools = getAt(root, "tools");
  if (isArr(tools)) {
    const toolItems: unknown[] = [];
    for (const tool of tools) {
      const fn: JSONObject = { name: gstr(getAt(tool, "name")), description: gstr(getAt(tool, "description")) };
      // Convert Anthropic input_schema to OpenAI function parameters
      const inputSchema = getAt(tool, "input_schema");
      if (exists(inputSchema) && inputSchema !== null) {
        fn.parameters = normalizeObjectSchemaProperties(deepCopy(inputSchema));
      } else {
        fn.parameters = { type: "object", properties: {} };
      }
      toolItems.push({ type: "function", function: fn });
    }
    if (toolItems.length > 0) out.tools = toolItems;
  }

  // Tool choice mapping - convert Anthropic tool_choice to OpenAI format
  const toolChoice = getAt(root, "tool_choice");
  if (exists(toolChoice) && toolChoice !== null) {
    let choiceType = gstr(getAt(toolChoice, "type"));
    if (choiceType === "" && typeof toolChoice === "string") choiceType = toolChoice;
    switch (choiceType) {
      case "auto":
        out.tool_choice = "auto";
        break;
      case "any":
        out.tool_choice = "required";
        break;
      case "none":
        out.tool_choice = "none";
        break;
      case "tool": {
        // Specific tool choice
        const toolName = gstr(getAt(toolChoice, "name"));
        if (toolName !== "") out.tool_choice = { type: "function", function: { name: toolName } };
        else out.tool_choice = "none";
        break;
      }
      default:
        // Fail closed: unrecognized tool_choice values must not turn into permission
        out.tool_choice = "none";
    }

    if (getAt(toolChoice, "disable_parallel_tool_use") === true) out.parallel_tool_calls = false;
  }

  // Handle user parameter (for tracking)
  const user = getAt(root, "user");
  if (exists(user)) out.user = gstr(user);

  const err = drops.err();
  if (err) throw err;
  return JSON.stringify(out);
}

/**
 * Normalises a tool input schema for OpenAI function parameters: object schemas
 * get an explicit properties map, boolean `true` subschemas become `{}`, and
 * regex patterns strict validators reject are removed. Mutates in place.
 */
export function normalizeObjectSchemaProperties(schema: unknown): unknown {
  if (typeof schema === "boolean") {
    // JSON Schema boolean subschemas (true/false) are valid, but strict OpenAPI 3.0
    // upstream validators reject boolean subschemas.
    // Normalize `true` (accept anything) to an empty object schema `{}`.
    // Preserve `false` (reject all) to avoid turning rejection constraints into open schemas.
    return schema ? {} : schema;
  }
  if (isArr(schema)) {
    for (let i = 0; i < schema.length; i++) schema[i] = normalizeObjectSchemaProperties(schema[i]);
    return schema;
  }
  if (!isObj(schema)) return schema;

  const value = schema;
  if (value.type === "object" && !("properties" in value)) value.properties = {};
  if (typeof value.pattern === "string" && hasUnsupportedUnicodePropertyEscape(value.pattern)) delete value.pattern;

  // Inspect regex keys under patternProperties
  const patternProps = value.patternProperties;
  if (isObj(patternProps)) {
    for (const patternKey of Object.keys(patternProps)) {
      if (hasUnsupportedUnicodePropertyEscape(patternKey)) delete patternProps[patternKey];
      else patternProps[patternKey] = normalizeObjectSchemaProperties(patternProps[patternKey]);
    }
  }

  for (const mapKey of schemaMapKeywords) {
    if (mapKey === "patternProperties") continue;
    const subMap = value[mapKey];
    if (isObj(subMap)) {
      for (const subKey of Object.keys(subMap)) subMap[subKey] = normalizeObjectSchemaProperties(subMap[subKey]);
    }
  }

  for (const valKey of schemaValueKeywords) {
    if (!(valKey in value)) continue;
    const sub = value[valKey];
    if (typeof sub === "boolean") {
      // Normalize boolean subschemas (e.g. items: true), but preserve boolean
      // additionalProperties (false/true) required by OpenAI structured outputs.
      if (valKey !== "additionalProperties" && sub) value[valKey] = {};
    } else if (isObj(sub)) {
      value[valKey] = normalizeObjectSchemaProperties(sub);
    } else if (isArr(sub)) {
      for (let i = 0; i < sub.length; i++) sub[i] = normalizeObjectSchemaProperties(sub[i]);
    }
  }
  return value;
}

function shouldMapClaudeThinkingToGPTReasoning(part: unknown, preserveThinkingBlocks: boolean): boolean {
  if (preserveThinkingBlocks) return true;
  const signature = getAt(part, "signature");
  if (!exists(signature) || gstr(signature).trim() === "") return false;
  return compatibleSignatureForProvider(SignatureProviderGPT, gstr(signature)) !== undefined;
}

/** Converts one Claude content part into an OpenAI content part, or undefined when it cannot be sent. */
export function convertClaudeContentPart(part: unknown): JSONObject | undefined {
  const partType = gstr(getAt(part, "type"));

  switch (partType) {
    case "text": {
      const text = gstr(getAt(part, "text"));
      if (text.trim() === "" || isClaudeCodeAttributionSystemText(text)) return undefined;
      return { type: "text", text };
    }

    case "image": {
      let imageURL = "";
      const source = getAt(part, "source");
      if (exists(source)) {
        switch (gstr(getAt(source, "type"))) {
          case "base64": {
            let mediaType = gstr(getAt(source, "media_type"));
            if (mediaType === "") mediaType = "application/octet-stream";
            const data = gstr(getAt(source, "data"));
            if (data !== "") imageURL = "data:" + mediaType + ";base64," + data;
            break;
          }
          case "url":
            imageURL = gstr(getAt(source, "url"));
            break;
        }
      }
      if (imageURL === "") imageURL = gstr(getAt(part, "url"));
      if (imageURL === "") return undefined;
      return { type: "image_url", image_url: { url: imageURL } };
    }

    case "document":
    case "container_upload":
      return convertClaudeFilePartToOpenAI(part);

    default:
      return undefined;
  }
}

/**
 * Emits an OpenAI file part for inline base64 bytes. A file id carries none,
 * so it stays unconverted and the caller reports it.
 */
function convertClaudeFilePartToOpenAI(part: unknown): JSONObject | undefined {
  const source = getAt(part, "source");
  let mimeType = gstr(getAt(source, "media_type"));

  let data: Uint8Array | undefined;
  if (gstr(getAt(source, "type")) === "base64") {
    const decoded = decodeBase64(gstr(getAt(source, "data")).trim(), stdEncoding);
    if (decoded === null) return undefined;
    data = decoded;
  }

  if (!data || data.length === 0) return undefined;
  if (mimeType === "") mimeType = "application/octet-stream";

  return {
    type: "file",
    file: {
      filename: gstr(getAt(part, "filename")),
      file_data: "data:" + mimeType + ";base64," + encodeBase64(data, stdEncoding),
    },
  };
}

/** Keeps the OpenAI tool message non-empty when a Claude tool_result carried nothing but images. */
export const toolResultImagePlaceholder = "[Tool returned image content; the images follow in the next user message.]";

/** Labels the user message that carries relayed tool images. */
export const toolResultImageRelayNotice = "Images returned by the preceding tool call(s):";

/** Flattens a Claude tool_result content value to the OpenAI tool message text plus any images to relay. */
export function convertClaudeToolResultContent(content: unknown): { text: string; images: unknown[] } {
  if (!exists(content)) return { text: "", images: [] };

  if (typeof content === "string") return { text: content, images: [] };

  if (isArr(content)) {
    const parts: string[] = [];
    const images: unknown[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (isObj(item) && gstr(item.type) === "text") {
        parts.push(gstr(item.text));
      } else if (isObj(item) && gstr(item.type) === "image") {
        const contentItem = convertClaudeContentPart(item);
        if (contentItem !== undefined) images.push(contentItem);
        else parts.push(JSON.stringify(item));
      } else if (isObj(item) && typeof item.text === "string") {
        parts.push(item.text);
      } else {
        parts.push(JSON.stringify(item));
      }
    }

    const joined = parts.join("\n\n");
    if (joined.trim() === "") {
      if (images.length > 0) return { text: toolResultImagePlaceholder, images };
      return { text: JSON.stringify(content), images: [] };
    }
    return { text: joined, images };
  }

  if (isObj(content)) {
    if (gstr(content.type) === "image") {
      const contentItem = convertClaudeContentPart(content);
      if (contentItem !== undefined) return { text: toolResultImagePlaceholder, images: [contentItem] };
    }
    if (typeof content.text === "string") return { text: content.text, images: [] };
    return { text: JSON.stringify(content), images: [] };
  }

  return { text: JSON.stringify(content), images: [] };
}

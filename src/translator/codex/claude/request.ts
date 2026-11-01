// Port of internal/translator/codex/claude/codex_claude_request.go.
//
// Claude Messages request -> OpenAI Codex Responses API request. Payloads are
// JSON strings; the body is parsed once, assembled as plain objects and
// serialised on the way out (Go built it with gjson/sjson over raw bytes).
import {
  SignatureBlockKindClaudeThinking,
  SignatureProviderUnknown,
  detectSignatureProviderForBlock,
  isCodexCommentarySignatureMarker,
} from "../../../signature/index.ts";
import { LevelXHigh, convertBudgetToLevel } from "../../../thinking/index.ts";
import {
  UserTurnDrops,
  alignClaudeToolResults,
  claudeMessageSystemReminderText,
  codexReplaySignatureForTarget,
  isHTTPURL,
  resolveCodexReplayTargetModel,
} from "../../common/index.ts";
import { isClaudeCodeAttributionSystemText } from "../../../util/claude_attribution.ts";
import { hasUnsupportedUnicodePropertyEscape, schemaMapKeywords, schemaValueKeywords } from "../../../util/claude_schema.ts";
import { deepCopy, deleteAt, exists, garray, gbool, getAt, gint, graw, gstr, isObj } from "../../../util/gpath.ts";
import { sha256Hex } from "../../../util/hash.ts";
import { tryParse } from "../../../util/json.ts";

type JSONObject = Record<string, unknown>;

/**
 * Parses and transforms a Claude Messages request into the Codex Responses format
 * (model, instructions/developer input, messages, tools, reasoning, text.format).
 * Throws an UnsupportedPartError (a RequestRejectedError) when a user turn would
 * be sent empty because none of its parts are representable.
 */
export function convertClaudeRequestToCodex(modelName: string, inputRawJSON: string, stream: boolean): string {
  return convertClaudeRequestToCodexImpl(modelName, inputRawJSON, stream, false);
}

/**
 * Same as convertClaudeRequestToCodex but preserves assistant thinking blocks with
 * empty or unknown-format signatures for configured compatibility endpoints.
 */
export function convertClaudeRequestToCodexWithCompat(modelName: string, inputRawJSON: string, stream: boolean): string {
  return convertClaudeRequestToCodexImpl(modelName, inputRawJSON, stream, true);
}

function convertClaudeRequestToCodexImpl(modelName: string, inputRawJSON: string, _stream: boolean, preserveEmptyThinkingBlocks: boolean): string {
  const drops = new UserTurnDrops();
  const root = tryParse<unknown>(inputRawJSON);
  const toolNameMap = buildReverseMapFromClaudeOriginalToShort(inputRawJSON);
  const signatureTargetModel = resolveCodexReplayTargetModel(modelName, inputRawJSON);

  const template: JSONObject = { model: modelName, instructions: "", input: [] };
  const inputItems: unknown[] = [];

  // Process system messages and convert them to developer input content.
  const systemsResult = getAt(root, "system");
  if (exists(systemsResult)) {
    const contentItems: unknown[] = [];
    const appendSystemText = (text: string): void => {
      if (text === "" || isClaudeCodeAttributionSystemText(text)) return;
      contentItems.push({ type: "input_text", text });
    };
    if (typeof systemsResult === "string") {
      appendSystemText(systemsResult);
    } else if (Array.isArray(systemsResult)) {
      for (const systemResult of systemsResult) {
        if (gstr(getAt(systemResult, "type")) === "text") appendSystemText(gstr(getAt(systemResult, "text")));
      }
    }
    if (contentItems.length > 0) {
      inputItems.push({ type: "message", role: "developer", content: contentItems });
    }
  }

  // Process messages and transform their contents to appropriate formats.
  const messagesResult = getAt(root, "messages");
  if (Array.isArray(messagesResult)) {
    let pendingToolUseIDs: string[] = [];
    let pendingSystemReminders: unknown[] = [];

    const flushPendingSystemReminders = (): void => {
      if (pendingSystemReminders.length > 0) {
        inputItems.push(...pendingSystemReminders);
        pendingSystemReminders = [];
      }
    };

    for (const messageResult of messagesResult) {
      const messageRole = gstr(getAt(messageResult, "role"));
      if (messageRole === "system") {
        const reminderText = claudeMessageSystemReminderText(getAt(messageResult, "content"));
        if (reminderText !== undefined) {
          const message = { type: "message", role: "user", content: [{ type: "input_text", text: reminderText }] };
          if (pendingToolUseIDs.length > 0) pendingSystemReminders.push(message);
          else inputItems.push(message);
        }
        continue;
      }

      let messageContentsResult = getAt(messageResult, "content");
      if (messageRole === "user" && pendingToolUseIDs.length > 0 && Array.isArray(messageContentsResult)) {
        messageContentsResult = alignClaudeToolResults(messageContentsResult, pendingToolUseIDs);
      }
      pendingToolUseIDs = [];
      let contentItems: unknown[] = [];
      // Counts only what this turn itself sends, not system reminders flushed beside it.
      // Empty text is forwarded but does not count: it can hide an emptied attachment.
      let turnSendable = 0;
      let bufferedSendable = 0;

      const flushMessage = (): void => {
        if (contentItems.length > 0) {
          turnSendable += bufferedSendable;
          bufferedSendable = 0;
          inputItems.push({ type: "message", role: messageRole, content: contentItems });
          contentItems = [];
        }
      };

      const appendTextContent = (text: string): void => {
        const partType = messageRole === "assistant" ? "output_text" : "input_text";
        contentItems.push({ type: partType, text });
        if (text !== "") bufferedSendable++;
      };

      const appendImageContent = (content: unknown): void => {
        contentItems.push(content);
        bufferedSendable++;
      };

      const appendDocumentContent = (dataURL: string): void => {
        contentItems.push({ type: "input_file", file_data: dataURL, filename: "document.pdf" });
        bufferedSendable++;
      };

      const appendCommentaryContent = (part: unknown): void => {
        if (messageRole !== "assistant") return;
        const text = gstr(getAt(part, "thinking"));
        if (text === "") return;
        // A relayed commentary block becomes its own assistant message item
        // carrying phase "commentary", mirroring the Codex output item it
        // came from. The internal marker is consumed here and never
        // forwarded upstream.
        flushMessage();
        inputItems.push({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text }] });
      };

      const appendReasoningContent = (part: unknown): void => {
        if (messageRole !== "assistant") return;

        const signatureValue = getAt(part, "signature");
        const rawSignature = gstr(signatureValue);
        if (isCodexCommentarySignatureMarker(rawSignature)) {
          appendCommentaryContent(part);
          return;
        }
        let signature = codexReplaySignatureForTarget(signatureTargetModel, rawSignature);
        let ok = signature !== undefined;
        if (
          !ok &&
          preserveEmptyThinkingBlocks &&
          typeof signatureValue === "string" &&
          rawSignature.trim() !== "" &&
          detectSignatureProviderForBlock(rawSignature, SignatureBlockKindClaudeThinking) === SignatureProviderUnknown
        ) {
          signature = rawSignature;
          ok = true;
        }
        if (!ok) {
          if (preserveEmptyThinkingBlocks && rawSignature.trim() === "") {
            signature = rawSignature;
          } else {
            return;
          }
        }

        flushMessage();
        inputItems.push({ type: "reasoning", summary: [], content: null, encrypted_content: signature ?? "" });
      };

      if (Array.isArray(messageContentsResult)) {
        for (const messageContentResult of messageContentsResult) {
          const contentType = gstr(getAt(messageContentResult, "type"));
          switch (contentType) {
            case "text":
              flushPendingSystemReminders();
              appendTextContent(gstr(getAt(messageContentResult, "text")));
              break;
            case "thinking":
              appendReasoningContent(messageContentResult);
              break;
            case "image": {
              flushPendingSystemReminders();
              const imagePart = claudeImageInputPart(getAt(messageContentResult, "source"));
              if (imagePart !== undefined) appendImageContent(imagePart);
              else if (messageRole === "user") drops.drop(contentType);
              break;
            }
            case "document":
            case "container_upload": {
              flushPendingSystemReminders();
              const dataURL = claudeDocumentDataURL(messageContentResult);
              if (dataURL !== undefined) appendDocumentContent(dataURL);
              else if (messageRole === "user") drops.drop(contentType);
              break;
            }
            case "tool_use": {
              flushMessage();
              const id = gstr(getAt(messageContentResult, "id"));
              if (id !== "") pendingToolUseIDs.push(id);
              let name = gstr(getAt(messageContentResult, "name"));
              const short = toolNameMap.get(name);
              name = short !== undefined ? short : shortenNameIfNeeded(name);
              inputItems.push({
                type: "function_call",
                call_id: shortenCodexCallIDIfNeeded(id),
                name,
                arguments: graw(getAt(messageContentResult, "input")),
              });
              break;
            }
            case "tool_result": {
              flushMessage();
              const functionCallOutputMessage: JSONObject = {
                type: "function_call_output",
                call_id: shortenCodexCallIDIfNeeded(gstr(getAt(messageContentResult, "tool_use_id"))),
              };
              const contentResult = getAt(messageContentResult, "content");
              if (Array.isArray(contentResult)) {
                const toolResultContentItems: unknown[] = [];
                for (const entry of contentResult) {
                  const toolResultContentType = gstr(getAt(entry, "type"));
                  if (toolResultContentType === "image") {
                    const sourceResult = getAt(entry, "source");
                    if (exists(sourceResult)) {
                      let data = gstr(getAt(sourceResult, "data"));
                      if (data === "") data = gstr(getAt(sourceResult, "base64"));
                      if (data !== "") {
                        let mediaType = gstr(getAt(sourceResult, "media_type"));
                        if (mediaType === "") mediaType = gstr(getAt(sourceResult, "mime_type"));
                        if (mediaType === "") mediaType = "application/octet-stream";
                        toolResultContentItems.push({ type: "input_image", image_url: `data:${mediaType};base64,${data}` });
                      }
                    }
                  } else if (toolResultContentType === "text") {
                    toolResultContentItems.push({ type: "input_text", text: gstr(getAt(entry, "text")) });
                  }
                }
                if (toolResultContentItems.length > 0) functionCallOutputMessage.output = toolResultContentItems;
                else functionCallOutputMessage.output = gstr(contentResult);
              } else {
                functionCallOutputMessage.output = gstr(contentResult);
              }
              inputItems.push(functionCallOutputMessage);
              turnSendable++;
              break;
            }
          }
        }
        flushMessage();
        flushPendingSystemReminders();
      } else if (typeof messageContentsResult === "string") {
        appendTextContent(messageContentsResult);
        flushMessage();
        flushPendingSystemReminders();
      }
      if (messageRole === "user") drops.endTurn(turnSendable);
    }

    if (pendingSystemReminders.length > 0) inputItems.push(...pendingSystemReminders);
  }

  // Convert tools declarations to the expected format for the Codex API.
  const toolsResult = getAt(root, "tools");
  let hasWebSearchTool = false;
  let toolItems: unknown[] = [];
  if (Array.isArray(toolsResult)) {
    const webSearchToolNames = buildClaudeWebSearchToolNameSet(toolsResult);
    template.tool_choice = convertClaudeToolChoiceToCodex(getAt(root, "tool_choice"), toolNameMap, webSearchToolNames);
    toolItems = [];
    for (const toolResult of toolsResult) {
      // Special handling: map Claude web search tool to Codex web_search
      if (isClaudeWebSearchToolType(gstr(getAt(toolResult, "type")))) {
        hasWebSearchTool = true;
        toolItems.push(convertClaudeWebSearchToolToCodex(toolResult));
        continue;
      }
      const tool: JSONObject = isObj(toolResult) ? (deepCopy(toolResult) as JSONObject) : {};
      const toolType = getAt(toolResult, "type");
      if (typeof toolType !== "string" || toolType !== "function") tool.type = "function";
      // Apply shortened name if needed
      const nameValue = getAt(toolResult, "name");
      if (exists(nameValue)) {
        const originalName = gstr(nameValue);
        let name = originalName;
        const short = toolNameMap.get(name);
        name = short !== undefined ? short : shortenNameIfNeeded(name);
        if (typeof nameValue !== "string" || name !== originalName) tool.name = name;
      }
      tool.parameters = normalizeToolParametersValue(getAt(toolResult, "input_schema"));
      for (const path of ["input_schema", "parameters.$schema", "cache_control", "defer_loading"]) {
        if (exists(getAt(tool, path))) deleteAt(tool, path);
      }
      if (tool.strict !== false) tool.strict = false;
      toolItems.push(tool);
    }
  }

  // Default to parallel tool calls unless tool_choice explicitly disables them.
  let parallelToolCalls = true;
  const disableParallelToolUse = getAt(root, "tool_choice.disable_parallel_tool_use");
  if (exists(disableParallelToolUse)) parallelToolCalls = !gbool(disableParallelToolUse);
  template.parallel_tool_calls = parallelToolCalls;

  // Convert Claude thinking budgets and effort to reasoning.effort.
  let reasoningEffort = "medium";
  let effort = "";
  const effortValue = getAt(root, "output_config.effort");
  if (typeof effortValue === "string") effort = effortValue.trim().toLowerCase();
  const thinkingConfig = getAt(root, "thinking");
  if (isObj(thinkingConfig)) {
    switch (gstr(thinkingConfig.type)) {
      case "enabled": {
        const budgetTokens = thinkingConfig.budget_tokens;
        if (exists(budgetTokens)) {
          const converted = convertBudgetToLevel(gint(budgetTokens));
          if (converted.ok && converted.level !== "") reasoningEffort = converted.level;
        }
        break;
      }
      case "adaptive":
      case "auto":
        // Adaptive thinking can carry an explicit effort in output_config.effort (Claude 4.6).
        // Pass through directly; applyThinking handles clamping to target model's levels.
        reasoningEffort = effort !== "" ? effort : LevelXHigh;
        break;
      case "disabled": {
        const converted = convertBudgetToLevel(0);
        if (converted.ok && converted.level !== "") reasoningEffort = converted.level;
        break;
      }
    }
  } else if (!exists(thinkingConfig) && effort !== "") {
    reasoningEffort = effort;
  }
  template.reasoning = { effort: reasoningEffort };
  // OpenAI documents reasoning summaries as explicit opt-in output. Leave
  // reasoning.summary to the source request's canonical summary intent instead
  // of coupling it to reasoning effort.
  let serviceTier = normalizeCodexServiceTier(getAt(root, "service_tier"));
  const speed = getAt(root, "speed");
  if (typeof speed === "string" && speed === "fast") serviceTier = "priority";
  if (serviceTier !== "") template.service_tier = serviceTier;
  template.stream = true;
  template.store = false;
  const includeFields = ["reasoning.encrypted_content"];
  if (hasWebSearchTool) includeFields.push("web_search_call.action.sources");
  template.include = includeFields;

  // Map Claude output_config.format to Codex Responses text.format.
  const format = getAt(root, "output_config.format");
  if (isObj(format) && gstr(format.type) === "json_schema" && isObj(format.schema)) {
    let name = "cli_proxy_structured_output";
    const n = gstr(format.name);
    if (n !== "") name = n;
    let strict = true;
    if (format.strict === false) strict = false;
    // OpenAI strict mode requires every declared property to be listed
    // in required. Downgrade instead of emitting an unsatisfiable
    // strict schema that strict backends reject with HTTP 400.
    if (strict && codexSchemaMissesRequired(format.schema)) strict = false;
    template.text = { format: { type: "json_schema", name, strict, schema: deepCopy(format.schema) } };
  }

  if (Array.isArray(toolsResult)) template.tools = toolItems;
  if (inputItems.length > 0) template.input = inputItems;

  const err = drops.err();
  if (err !== undefined) throw err;
  return JSON.stringify(template);
}

export function normalizeCodexServiceTier(result: unknown): string {
  if (typeof result !== "string") return "";
  switch (result.trim().toLowerCase()) {
    case "fast":
    case "priority":
      return "priority";
    default:
      return "";
  }
}

/**
 * Keeps Claude tool IDs within the OpenAI Responses API call_id limit while
 * preserving a stable, low-collision mapping.
 */
export function shortenCodexCallIDIfNeeded(id: string): string {
  const limit = 64;
  if (id.length <= limit) return id;
  const suffix = "_" + sha256Hex(id).slice(0, 16);
  const prefixLen = limit - suffix.length;
  if (prefixLen <= 0) return suffix.slice(suffix.length - limit);
  return id.slice(0, prefixLen) + suffix;
}

export function isClaudeWebSearchToolType(toolType: string): boolean {
  return toolType === "web_search_20250305" || toolType === "web_search_20260209";
}

export function buildClaudeWebSearchToolNameSet(tools: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (!isClaudeWebSearchToolType(gstr(getAt(tool, "type")))) continue;
    const name = gstr(getAt(tool, "name"));
    if (name !== "") names.add(name);
  }
  return names;
}

/** Maps a Claude tool_choice onto the Codex tool_choice value (a string or an object). */
export function convertClaudeToolChoiceToCodex(toolChoice: unknown, toolNameMap: Map<string, string>, webSearchToolNames: Set<string>): unknown {
  if (toolChoice === undefined || toolChoice === null) return "auto";

  let choiceType = gstr(getAt(toolChoice, "type"));
  if (choiceType === "" && typeof toolChoice === "string") choiceType = toolChoice;

  switch (choiceType) {
    case "auto":
    case "":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      let name = gstr(getAt(toolChoice, "name"));
      if (webSearchToolNames.has(name)) return { type: "web_search" };
      const short = toolNameMap.get(name);
      name = short !== undefined ? short : shortenNameIfNeeded(name);
      if (name === "") return "auto";
      return { type: "function", name };
    }
    default:
      return "auto";
  }
}

export function convertClaudeWebSearchToolToCodex(tool: unknown): JSONObject {
  const out: JSONObject = { type: "web_search" };
  const allowedDomains = getAt(tool, "allowed_domains");
  if (Array.isArray(allowedDomains)) out.filters = { allowed_domains: deepCopy(allowedDomains) };
  const userLocation = getAt(tool, "user_location");
  if (isObj(userLocation)) out.user_location = deepCopy(userLocation);
  return out;
}

/** Applies a simple shortening rule for a single name. */
export function shortenNameIfNeeded(name: string): string {
  const limit = 64;
  if (name.length <= limit) return name;
  if (name.startsWith("mcp__")) {
    const idx = name.lastIndexOf("__");
    if (idx > 0) {
      const cand = "mcp__" + name.slice(idx + 2);
      if (cand.length > limit) return cand.slice(0, limit);
      return cand;
    }
  }
  return name.slice(0, limit);
}

/** Ensures uniqueness of shortened names within a request (original -> short). */
export function buildShortNameMap(names: string[]): Map<string, string> {
  const limit = 64;
  const used = new Set<string>();
  const m = new Map<string, string>();

  const baseCandidate = (n: string): string => {
    if (n.length <= limit) return n;
    if (n.startsWith("mcp__")) {
      const idx = n.lastIndexOf("__");
      if (idx > 0) {
        let cand = "mcp__" + n.slice(idx + 2);
        if (cand.length > limit) cand = cand.slice(0, limit);
        return cand;
      }
    }
    return n.slice(0, limit);
  };

  const makeUnique = (cand: string): string => {
    if (!used.has(cand)) return cand;
    const base = cand;
    for (let i = 1; ; i++) {
      const suffix = "_" + String(i);
      let allowed = limit - suffix.length;
      if (allowed < 0) allowed = 0;
      let tmp = base;
      if (tmp.length > allowed) tmp = tmp.slice(0, allowed);
      tmp = tmp + suffix;
      if (!used.has(tmp)) return tmp;
    }
  };

  for (const n of names) {
    const uniq = makeUnique(baseCandidate(n));
    used.add(uniq);
    m.set(n, uniq);
  }
  return m;
}

/** Builds the original->short tool name map, used to map tool_use names to short. */
export function buildReverseMapFromClaudeOriginalToShort(original: string): Map<string, string> {
  const tools = getAt(tryParse<unknown>(original), "tools");
  if (!Array.isArray(tools)) return new Map();
  const names: string[] = [];
  for (const tool of tools) {
    const n = gstr(getAt(tool, "name"));
    if (n !== "") names.push(n);
  }
  if (names.length > 0) return buildShortNameMap(names);
  return new Map();
}

/** Builds a short->original tool name map from the original Claude request tools. */
export function buildReverseMapFromClaudeOriginalShortToOriginal(original: string): Map<string, string> {
  const rev = new Map<string, string>();
  for (const [orig, short] of buildReverseMapFromClaudeOriginalToShort(original)) rev.set(short, orig);
  return rev;
}

const emptyObjectSchema = '{"type":"object","properties":{}}';

/**
 * Ensures object schemas contain at least an empty properties map, strips dialect
 * keywords ($schema, $id), and drops regex patterns containing unsupported Unicode
 * property escapes (\p{...} / \P{...}) that cause upstream schema validation failures.
 * Takes and returns a JSON string (Go: raw schema bytes).
 */
export function normalizeToolParameters(raw: string): string {
  raw = raw.trim();
  if (raw === "" || raw === "null") return emptyObjectSchema;
  const parsed = tryParse<unknown>(raw);
  if (parsed === undefined) return emptyObjectSchema;
  return JSON.stringify(normalizeToolParametersValue(parsed));
}

/** normalizeToolParameters over an already parsed schema value; returns a new object. */
export function normalizeToolParametersValue(schema: unknown): JSONObject {
  if (!isObj(schema)) return { type: "object", properties: {} };
  const root = deepCopy(schema) as JSONObject;

  stripDialectKeywordsFromSchema(root);

  const typeVal = root.type;
  let isObject = false;
  if (!("type" in root) || typeVal === null || typeVal === undefined || typeVal === "") {
    root.type = "object";
    isObject = true;
  } else if (typeof typeVal === "string") {
    if (typeVal === "object") isObject = true;
  } else if (Array.isArray(typeVal)) {
    for (const elem of typeVal) {
      if (elem === "object") {
        isObject = true;
        break;
      }
    }
  }
  if (isObject) {
    if (!("properties" in root) || root.properties === null || root.properties === undefined) root.properties = {};
  }
  return root;
}

/** Removes $schema/$id and unsupported regex patterns from a schema tree in place. */
export function stripDialectKeywordsFromSchema(v: unknown): void {
  if (Array.isArray(v)) {
    for (const item of v) stripDialectKeywordsFromSchema(item);
    return;
  }
  if (!isObj(v)) return;
  const schema = v;
  delete schema.$schema;
  delete schema.$id;
  if (typeof schema.pattern === "string" && hasUnsupportedUnicodePropertyEscape(schema.pattern)) delete schema.pattern;

  // Inspect regex keys under patternProperties
  const patternProps = schema.patternProperties;
  if (isObj(patternProps)) {
    for (const patternKey of Object.keys(patternProps)) {
      if (hasUnsupportedUnicodePropertyEscape(patternKey)) delete patternProps[patternKey];
      else stripDialectKeywordsFromSchema(patternProps[patternKey]);
    }
  }

  for (const mapKey of codexSchemaMapKeywords) {
    if (mapKey === "patternProperties") continue;
    const subMap = schema[mapKey];
    if (isObj(subMap)) {
      for (const key of Object.keys(subMap)) stripDialectKeywordsFromSchema(subMap[key]);
    }
  }

  for (const valKey of codexSchemaValueKeywords) {
    if (!(valKey in schema)) continue;
    const val = schema[valKey];
    if (isObj(val)) stripDialectKeywordsFromSchema(val);
    else if (Array.isArray(val)) for (const item of val) stripDialectKeywordsFromSchema(item);
  }
}

// codexSchemaMapKeywords and codexSchemaValueKeywords reference the unified JSON
// Schema keywords declared in src/util/claude_schema.ts.
export const codexSchemaMapKeywords: ReadonlyArray<string> = schemaMapKeywords;
export const codexSchemaValueKeywords: ReadonlyArray<string> = schemaValueKeywords;

/**
 * Reports whether a JSON Schema has any declared property missing from its sibling
 * required list (recursively). OpenAI strict mode rejects such schemas with HTTP
 * 400, so callers downgrade text.format.strict instead of emitting an
 * unsatisfiable schema.
 */
export function codexSchemaMissesRequired(schema: unknown): boolean {
  if (!isObj(schema)) {
    if (Array.isArray(schema)) {
      for (const child of schema) if (codexSchemaMissesRequired(child)) return true;
    }
    return false;
  }
  const properties = schema.properties;
  if (isObj(properties)) {
    const required = schema.required;
    if (!Array.isArray(required)) return Object.keys(properties).length > 0;
    const names = new Set<string>();
    for (const item of required) if (typeof item === "string") names.add(item);
    for (const name of Object.keys(properties)) if (!names.has(name)) return true;
  }
  for (const keyword of codexSchemaMapKeywords) {
    const children = schema[keyword];
    if (!isObj(children)) continue;
    for (const key of Object.keys(children)) if (codexSchemaMissesRequired(children[key])) return true;
  }
  for (const keyword of codexSchemaValueKeywords) {
    if (keyword in schema && codexSchemaMissesRequired(schema[keyword])) return true;
  }
  return false;
}

/**
 * Maps a Claude image source onto a Responses input_image part. Base64 bytes
 * become a data URL, an http(s) url passes through and a file id is carried as
 * file_id. Returns undefined for a source with none of them.
 */
export function claudeImageInputPart(source: unknown): JSONObject | undefined {
  if (!exists(source)) return undefined;
  const part: JSONObject = { type: "input_image" };
  let data = gstr(getAt(source, "data"));
  if (data === "") data = gstr(getAt(source, "base64"));
  const sourceType = gstr(getAt(source, "type"));
  const url = gstr(getAt(source, "url"));
  const fileID = gstr(getAt(source, "file_id"));
  if (data !== "") {
    let mediaType = gstr(getAt(source, "media_type"));
    if (mediaType === "") mediaType = gstr(getAt(source, "mime_type"));
    if (mediaType === "") mediaType = "application/octet-stream";
    part.image_url = `data:${mediaType};base64,${data}`;
  } else if (sourceType === "url" && isHTTPURL(url)) {
    part.image_url = url.trim();
  } else if (sourceType === "file" && fileID !== "") {
    part.file_id = fileID;
  } else {
    return undefined;
  }
  return part;
}

/**
 * Turns an inline PDF into a Codex input_file data URL. Anything else, a file id
 * included, is not representable and is reported by the caller.
 */
export function claudeDocumentDataURL(part: unknown): string | undefined {
  const source = getAt(part, "source");
  if (gstr(getAt(source, "type")) !== "base64") return undefined;
  const mediaType = gstr(getAt(source, "media_type")).trim();
  if (mediaType.toLowerCase() !== "application/pdf") return undefined;
  let data = gstr(getAt(source, "data"));
  if (data === "") data = gstr(getAt(source, "base64"));
  if (data === "") return undefined;
  return `data:${mediaType};base64,${data}`;
}

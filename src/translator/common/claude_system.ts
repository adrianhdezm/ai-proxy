// Port of internal/translator/common/claude_system.go.
import { isClaudeCodeAttributionSystemText } from "../../util/claude_attribution.ts";
import { getAt, gstr } from "../../util/gpath.ts";

const claudeSystemReminderStart = "<system-reminder>";
const claudeSystemReminderEnd = "</system-reminder>";

/** Wraps text in the <system-reminder> envelope so non-Claude upstreams treat demoted system text as directives. */
export function systemReminderText(text: string): string {
  return claudeSystemReminderStart + "\n" + text + "\n" + claudeSystemReminderEnd;
}

/** Converts a Claude message-level system value into reminder text; undefined when there is nothing to send. */
export function claudeMessageSystemReminderText(content: unknown): string | undefined {
  const parts = claudeSystemTextParts(content);
  if (parts.length === 0) return undefined;
  const text = parts.join("\n");
  if (text.trim() === "") return undefined;
  return systemReminderText(text);
}

function claudeSystemTextParts(content: unknown): string[] {
  if (content === undefined) return [];
  if (typeof content === "string") {
    if (content === "" || isClaudeCodeAttributionSystemText(content)) return [];
    return [content];
  }
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content) {
    if (gstr(getAt(item, "type")) !== "text") continue;
    const text = gstr(getAt(item, "text"));
    if (text === "" || isClaudeCodeAttributionSystemText(text)) continue;
    parts.push(text);
  }
  return parts;
}

const jsonObjectInstruction =
  "You must format your entire response as a valid JSON object. Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.";

/**
 * Formats structured output settings (Chat Completions response_format or
 * Responses text.format) as explicit instructions for Claude's system prompt.
 */
export function buildClaudeStructuredOutputInstruction(format: unknown): string {
  if (format === undefined || format === null) return "";
  const formatType = gstr(getAt(format, "type")).trim().toLowerCase();
  switch (formatType) {
    case "json_object":
      return jsonObjectInstruction;
    case "json_schema": {
      const jsonSchema = getAt(format, "json_schema");
      let schema = getAt(jsonSchema, "schema");
      if (schema === undefined) schema = getAt(format, "schema");
      if (schema === undefined) return jsonObjectInstruction;
      let out = "You must format your entire response as valid JSON that conforms strictly to the following JSON schema:\n";
      let name = gstr(getAt(jsonSchema, "name")).trim();
      if (name === "") name = gstr(getAt(format, "name")).trim();
      if (name !== "") out += "Schema Name: " + name + "\n";
      let desc = gstr(getAt(jsonSchema, "description")).trim();
      if (desc === "") desc = gstr(getAt(format, "description")).trim();
      if (desc !== "") out += "Schema Description: " + desc + "\n";
      out += "JSON Schema:\n" + JSON.stringify(schema);
      out += "\nDo not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.";
      return out;
    }
    default:
      return "";
  }
}


// Local token estimate for the Codex executor. Port of countCodexInputTokens
// (internal/runtime/executor/codex_executor_tokens.go) with one deviation: Go
// counted the collected text with tiktoken (o200k/cl100k per model family); this
// port has no tokenizer dependency and uses ceil(characters / 4), the usual
// rule-of-thumb for English text and JSON. The collected segments are the same:
// instructions, message text parts, function call names/arguments, function
// call outputs, other items' text, tool names/descriptions/parameters and the
// text.format name/schema.
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

/** ceil(code points / 4); 0 for empty text. */
export function estimateTokensByChars(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const _ of text) count++;
  return Math.ceil(count / 4);
}

function rawOrString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? "";
}

/** Go: countCodexInputTokens (estimate instead of tiktoken). */
export function countCodexInputTokens(body: string): number {
  if (body.length === 0) return 0;
  const root = tryParse<unknown>(body);
  const segments: string[] = [];
  const push = (s: string): void => {
    const trimmed = s.trim();
    if (trimmed !== "") segments.push(trimmed);
  };

  push(gstr(getAt(root, "instructions")));

  const input = getAt(root, "input");
  if (isArr(input)) {
    for (const item of input) {
      switch (gstr(getAt(item, "type"))) {
        case "message": {
          const content = getAt(item, "content");
          if (isArr(content)) for (const part of content) push(gstr(getAt(part, "text")));
          break;
        }
        case "function_call":
          push(gstr(getAt(item, "name")));
          push(gstr(getAt(item, "arguments")));
          break;
        case "function_call_output":
          push(rawOrString(getAt(item, "output")));
          break;
        default:
          push(gstr(getAt(item, "text")));
      }
    }
  }

  const tools = getAt(root, "tools");
  if (isArr(tools)) {
    for (const tool of tools) {
      push(gstr(getAt(tool, "name")));
      push(gstr(getAt(tool, "description")));
      push(rawOrString(getAt(tool, "parameters")));
    }
  }

  const textFormat = getAt(root, "text.format");
  if (isObj(textFormat)) {
    push(gstr(textFormat.name));
    push(rawOrString(textFormat.schema));
  }

  return estimateTokensByChars(segments.join("\n"));
}

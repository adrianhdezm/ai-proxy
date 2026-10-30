// Port of internal/runtime/executor/helps/gemini_content_turns.go
// (EnsureGeminiLeadingUserContent / EnsureGeminiTrailingUserContent /
// EnsureGeminiBoundaryUserContent). Gemini rejects a contents array that starts
// (or, for generation, ends) with a model turn; an empty user turn is inserted.
// A payload that needs no change is returned as the same string.
import { getAt, isObj, setAt } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

function emptyGeminiUserTurn(): Record<string, unknown> {
  return { role: "user", parts: [{ text: "" }] };
}

function roleOf(content: unknown): string {
  const role = getAt(content, "role");
  return typeof role === "string" ? role : "";
}

/** Ensures the contents array at `path` starts with a user turn. */
export function ensureGeminiLeadingUserContent(payload: string, path: string): string {
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return payload;
  const contents = getAt(root, path);
  if (!Array.isArray(contents) || contents.length === 0) return payload;
  if (roleOf(contents[0]) !== "model") return payload;
  setAt(root, path, [emptyGeminiUserTurn(), ...contents]);
  return JSON.stringify(root);
}

function contentHasFunctionResponse(content: unknown): boolean {
  const parts = getAt(content, "parts");
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => getAt(part, "functionResponse") !== undefined);
}

/** Whether any functionResponse in the content carries nested media parts (inlineData/fileData). */
function contentHasFunctionResponseMedia(content: unknown): boolean {
  const parts = getAt(content, "parts");
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    const nested = getAt(part, "functionResponse.parts");
    if (!Array.isArray(nested)) continue;
    for (const item of nested) {
      if (!isObj(item)) continue;
      if (item.inlineData !== undefined || item.inline_data !== undefined || item.fileData !== undefined || item.file_data !== undefined) return true;
    }
  }
  return false;
}

/**
 * Ensures the contents array at `path` ends with a user turn. A final turn
 * carrying a functionResponse is kept as is (the model must answer it), unless
 * it is a model-role functionResponse with nested media (#6524).
 */
export function ensureGeminiTrailingUserContent(payload: string, path: string): string {
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return payload;
  const contents = getAt(root, path);
  if (!Array.isArray(contents) || contents.length === 0) return payload;
  const last = contents[contents.length - 1];
  const lastRole = roleOf(last);
  if (lastRole !== "model" && lastRole !== "assistant") return payload;
  if (contentHasFunctionResponse(last) && !contentHasFunctionResponseMedia(last)) return payload;
  setAt(root, path, [...contents, emptyGeminiUserTurn()]);
  return JSON.stringify(root);
}

/** Ensures the contents array at `path` both starts and ends with a user turn. */
export function ensureGeminiBoundaryUserContent(payload: string, path: string): string {
  return ensureGeminiTrailingUserContent(ensureGeminiLeadingUserContent(payload, path), path);
}

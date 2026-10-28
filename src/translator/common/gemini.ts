// Port of internal/translator/common/gemini.go onto parsed Gemini contents/parts.
import { gbool, getAt, gstr, isObj, setAt } from "../../util/gpath.ts";

/** Whether a Gemini part contains hidden model thought. */
export function isGeminiThoughtPart(part: unknown): boolean {
  return gbool(getAt(part, "thought"));
}

function partsOf(content: unknown): unknown[] | undefined {
  const parts = getAt(content, "parts");
  return Array.isArray(parts) ? parts : undefined;
}

/**
 * Merges consecutive user Content turns (mid-conversation system messages demoted
 * to user reminders are folded in). Consecutive model turns are never merged so
 * part indices and thought signatures stay intact.
 */
export function mergeAdjacentGeminiContents(contents: unknown[]): unknown[] {
  if (contents.length <= 1) return contents;
  const merged: unknown[] = [];
  for (const content of contents) {
    if (content === undefined || content === null || content === "") continue;
    const role = gstr(getAt(content, "role"));
    const parts = partsOf(content);
    if (!parts || parts.length === 0) continue;
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (gstr(getAt(last, "role")) === "user" && role === "user") {
        const combined = reorderGeminiUserParts([...(partsOf(last) ?? []), ...parts]);
        merged[merged.length - 1] = { ...(last as Record<string, unknown>), parts: combined };
        continue;
      }
    }
    merged.push(content);
  }
  return merged;
}

/** Whether a Gemini content turn contains any functionCall part. */
export function contentHasGeminiFunctionCall(content: unknown): boolean {
  return (partsOf(content) ?? []).some((part) => getAt(part, "functionCall") !== undefined || getAt(part, "function_call") !== undefined);
}

/** Whether a Gemini content turn contains any functionResponse part. */
export function contentHasGeminiFunctionResponse(content: unknown): boolean {
  return (partsOf(content) ?? []).some(isFunctionResponsePart);
}

function isFunctionResponsePart(part: unknown): boolean {
  return getAt(part, "functionResponse") !== undefined || getAt(part, "function_response") !== undefined;
}

/**
 * Reorders parts within a Gemini user turn so text parts precede functionResponse
 * parts (Vertex rejects functionResponse followed by text in the same turn).
 */
export function reorderGeminiUserParts(parts: unknown[]): unknown[] {
  let hasFR = false;
  let hasTrailingText = false;
  for (const p of parts) {
    if (isFunctionResponsePart(p)) hasFR = true;
    else if (hasFR && getAt(p, "text") !== undefined) {
      hasTrailingText = true;
      break;
    }
  }
  if (!hasFR || !hasTrailingText) return parts;
  const promptParts: unknown[] = [];
  const toolParts: unknown[] = [];
  for (const p of parts) {
    if (getAt(p, "text") !== undefined) promptParts.push(p);
    else toolParts.push(p);
  }
  return [...promptParts, ...toolParts];
}

/** Merges consecutive user turns, leaving turns containing functionResponse unmerged. */
export function mergeAdjacentGeminiUserContents(contents: unknown[]): unknown[] {
  if (contents.length <= 1) return contents;
  const merged: unknown[] = [];
  for (const content of contents) {
    if (content === undefined || content === null || content === "") continue;
    const role = gstr(getAt(content, "role"));
    const parts = partsOf(content);
    if (!parts || parts.length === 0) continue;
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (gstr(getAt(last, "role")) === "user" && role === "user" && !contentHasGeminiFunctionResponse(last) && !contentHasGeminiFunctionResponse(content)) {
        merged[merged.length - 1] = { ...(last as Record<string, unknown>), parts: [...(partsOf(last) ?? []), ...parts] };
        continue;
      }
    }
    merged.push(content);
  }
  return merged;
}

/**
 * Separates functionResponse parts from other user parts into their own turns and
 * hoists function-response turns directly after the model turn that issued the calls.
 */
export function splitGeminiFunctionResponseTurns(contents: unknown[]): unknown[] {
  if (contents.length === 0) return contents;
  const split: unknown[] = [];
  for (const content of contents) {
    if (gstr(getAt(content, "role")) !== "user" || !contentHasGeminiFunctionResponse(content)) {
      split.push(content);
      continue;
    }
    const parts = partsOf(content) ?? [];
    const responseParts = parts.filter(isFunctionResponsePart);
    const otherParts = parts.filter((p) => !isFunctionResponsePart(p));
    if (responseParts.length > 0) split.push({ ...(content as Record<string, unknown>), parts: responseParts });
    if (otherParts.length > 0) split.push({ ...(content as Record<string, unknown>), parts: otherParts });
  }

  const out: unknown[] = [];
  const n = split.length;
  for (let i = 0; i < n; ) {
    if (gstr(getAt(split[i], "role")) !== "user") {
      out.push(split[i]);
      i++;
      continue;
    }
    const precedingModelHasFC = out.length > 0 && gstr(getAt(out[out.length - 1], "role")) === "model" && contentHasGeminiFunctionCall(out[out.length - 1]);
    let j = i;
    let hasFR = false;
    while (j < n && gstr(getAt(split[j], "role")) === "user") {
      if (contentHasGeminiFunctionResponse(split[j])) hasFR = true;
      j++;
    }
    const userRun = split.slice(i, j);
    if (precedingModelHasFC && hasFR && userRun.length > 1) {
      const combinedFRParts: unknown[] = [];
      const otherTurns: unknown[] = [];
      for (const turn of userRun) {
        if (contentHasGeminiFunctionResponse(turn)) combinedFRParts.push(...(partsOf(turn) ?? []));
        else otherTurns.push(turn);
      }
      if (combinedFRParts.length > 0) out.push({ role: "user", parts: combinedFRParts });
      out.push(...otherTurns);
    } else {
      out.push(...userRun);
    }
    i = j;
  }
  return out;
}

/** Whether value (recursively) contains a string-valued "$ref" property. */
export function containsJSONRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsJSONRef);
  if (isObj(value)) {
    if (typeof value.$ref === "string") return true;
    return Object.keys(value).some((key) => containsJSONRef(value[key]));
  }
  return false;
}

/**
 * Sets the Gemini functionResponse result (mutating part). A result containing a
 * string-valued "$ref" is stored as opaque JSON text (under ".result" when the path
 * ends in "response") so Gemini does not read it as a media-part reference.
 * `result` undefined writes an empty string.
 */
export function setGeminiFunctionResponseResult<T>(part: T, path: string, result: unknown): T {
  if (result === undefined) return setAt(part, path, "") as T;
  if (containsJSONRef(result)) {
    const targetPath = path.endsWith("response") ? path + ".result" : path;
    return setAt(part, targetPath, JSON.stringify(result)) as T;
  }
  return setAt(part, path, result) as T;
}

/** setGeminiFunctionResponseResult for a raw JSON string. */
export function setGeminiFunctionResponseRaw<T>(part: T, path: string, rawJSON: string): T {
  const trimmed = rawJSON.trim();
  if (trimmed === "") return setAt(part, path, "") as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // gjson.Parse tolerates invalid input and yields the raw text as a string.
    parsed = trimmed;
  }
  return setGeminiFunctionResponseResult(part, path, parsed);
}

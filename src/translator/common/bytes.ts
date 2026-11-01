// Port of internal/translator/common/bytes.go.
//
// Go built SSE frames and raw JSON arrays byte-by-byte. Payloads here are JSON
// strings, so the helpers keep the same shapes on strings.
import { getAt, setAt } from "../../util/gpath.ts";

export function geminiTokenCountJSON(count: number): string {
  return `{"totalTokens":${count},"promptTokensDetails":[{"modality":"TEXT","tokenCount":${count}}]}`;
}

export function claudeInputTokensJSON(count: number): string {
  return `{"input_tokens":${count}}`;
}

/** Joins raw JSON items into a JSON array string. */
export function joinRawArray(items: string[]): string {
  if (items.length === 0) return "[]";
  return "[" + items.join(",") + "]";
}

/** Replaces the array at `path` in `data` (a JSON string) with the raw items; no-op for an empty list. */
export function setRawArrayItems(data: string, path: string, items: string[]): string {
  if (items.length === 0) return data;
  const root = JSON.parse(data) as unknown;
  const parsedItems = items.map((item) => JSON.parse(item) as unknown);
  return JSON.stringify(setAt(root, path, parsedItems));
}

/** Builds one complete SSE frame with its own blank-line terminator. */
export function sseEventData(event: string, payload: string): string {
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function appendSSEEventString(out: string, event: string, payload: string, trailingNewlines: number): string {
  return out + `event: ${event}\ndata: ${payload}` + "\n".repeat(Math.max(0, trailingNewlines));
}

/**
 * Sets a string field in a JSON payload. JSON.stringify never escapes HTML
 * characters, so this is a plain path set; the name is kept for parity with Go,
 * where sjson delegated to encoding/json and escaped <, > and &.
 */
export function setStringWithoutHTMLEscape(data: string, path: string, value: string): string {
  const root = JSON.parse(data) as unknown;
  return JSON.stringify(setAt(root, path, value));
}

/** Reads a dotted path from a JSON string (undefined when absent or unparsable). */
export function getFromJSON(data: string, path: string): unknown {
  try {
    return getAt(JSON.parse(data), path);
  } catch {
    return undefined;
  }
}

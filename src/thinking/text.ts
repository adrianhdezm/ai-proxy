// Port of internal/thinking/text.go.
import { isObject } from "../util/json.ts";

/**
 * Extracts the thinking text from a content part. Handles:
 *   - { "thinking": "text" } or { "text": "text" }
 *   - { "thinking": { "text": "text", "cache_control": {...} } }
 *   - Gemini-style { "thought": true, "text": "text" }
 */
export function getThinkingText(part: unknown): string {
  if (!isObject(part)) return "";
  if (typeof part.text === "string") return part.text;
  const thinking = part.thinking;
  if (thinking === undefined) return "";
  if (typeof thinking === "string") return thinking;
  if (isObject(thinking)) {
    if (typeof thinking.text === "string") return thinking.text;
    if (typeof thinking.thinking === "string") return thinking.thinking;
  }
  return "";
}

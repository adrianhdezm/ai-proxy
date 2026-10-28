// Port of internal/translator/common/cache_control.go onto parsed blocks/messages.
import { deepCopy, getAt, gstr, isObj } from "../../util/gpath.ts";

/** Whether cache_control is an object with exactly type "ephemeral". */
export function isValidCacheControl(cc: unknown): boolean {
  if (!isObj(cc)) return false;
  return cc.type === "ephemeral";
}

export function claudeBlockCanHostCacheControl(block: unknown): boolean {
  if (!isObj(block)) return false;
  switch (gstr(block.type)) {
    case "":
      return true;
    case "thinking":
    case "redacted_thinking":
      return false;
    case "text":
      return gstr(block.text).trim() !== "";
    default:
      return true;
  }
}

/**
 * Copies a Claude-compatible cache_control object from src onto dst (mutating dst).
 * dst is returned unchanged when cache_control is missing, invalid, or dst cannot host it.
 */
export function attachCacheControl<T>(dst: T, src: unknown): T {
  const cc = getAt(src, "cache_control");
  if (!isValidCacheControl(cc) || !claudeBlockCanHostCacheControl(dst)) return dst;
  (dst as Record<string, unknown>).cache_control = deepCopy(cc);
  return dst;
}

/**
 * Applies message-level cache_control onto the last eligible non-empty content block.
 * Part-level cache_control wins when the target already has one. String content is
 * promoted to a content array so Claude can accept cache_control.
 */
export function attachMessageCacheControl<T>(msg: T, src: unknown): T {
  const cc = getAt(src, "cache_control");
  if (!isValidCacheControl(cc) || !isObj(msg)) return msg;
  const content = msg.content;
  if (Array.isArray(content)) {
    let targetIdx = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (claudeBlockCanHostCacheControl(content[i])) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) return msg;
    const target = content[targetIdx] as Record<string, unknown>;
    if (target.cache_control !== undefined) return msg;
    target.cache_control = deepCopy(cc);
    return msg;
  }
  if (typeof content !== "string" || content.trim() === "") return msg;
  (msg as Record<string, unknown>).content = [{ type: "text", text: content, cache_control: deepCopy(cc) }];
  return msg;
}

/**
 * Hoists part-level (preferred) or message-level cache_control from src onto the
 * tool_result content block in msg.
 */
export function attachToolMessageCacheControl<T>(msg: T, src: unknown): T {
  let cc = extractFirstPartCacheControl(src);
  if (cc === undefined) {
    const messageCC = getAt(src, "cache_control");
    if (isValidCacheControl(messageCC)) cc = messageCC;
  }
  if (cc === undefined || !isObj(msg)) return msg;
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return msg;
  const targetIdx = content.findIndex((block) => gstr(getAt(block, "type")) === "tool_result");
  if (targetIdx === -1) return msg;
  (content[targetIdx] as Record<string, unknown>).cache_control = deepCopy(cc);
  return msg;
}

function extractFirstPartCacheControl(src: unknown): unknown {
  let content = getAt(src, "content");
  if (content === undefined) content = src;
  if (Array.isArray(content)) {
    for (const part of content) {
      const cc = getAt(part, "cache_control");
      if (isValidCacheControl(cc)) return cc;
    }
    return undefined;
  }
  if (isObj(content)) {
    const cc = content.cache_control;
    if (isValidCacheControl(cc)) return cc;
  }
  return undefined;
}

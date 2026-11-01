// Port of internal/signature/claude.go: stripping invalid Claude thinking blocks from a Messages body.
import { getAt, gstr, isObj } from "../util/gpath.ts";
import { type ClaudeSignatureValidationOptions, isValidClaudeThinkingSignature } from "./claude_validation.ts";

function parseMessagesPayload(payload: string): { root: Record<string, unknown>; messages: unknown[] } | undefined {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isObj(root) || !Array.isArray(root.messages)) return undefined;
  return { root, messages: root.messages };
}

/**
 * Removes Claude thinking blocks whose signatures are empty or not valid Claude
 * thinking signatures (after stripping an optional cache prefix), unless the
 * options allow an empty thinking placeholder. Returns the payload unchanged when
 * nothing is stripped.
 */
export function stripInvalidClaudeThinkingBlocks(payload: string, opt: ClaudeSignatureValidationOptions = {}): string {
  const parsed = parseMessagesPayload(payload);
  if (!parsed) return payload;
  let modified = false;
  const kept = parsed.messages.map((msg) => {
    const content = getAt(msg, "content");
    if (!Array.isArray(content)) return msg;
    let stripped = false;
    const keptParts = content.filter((part) => {
      if (gstr(getAt(part, "type")) === "thinking" && shouldStripClaudeThinkingBlock(part, opt)) {
        stripped = true;
        return false;
      }
      return true;
    });
    if (!stripped) return msg;
    modified = true;
    return { ...(msg as Record<string, unknown>), content: keptParts };
  });
  if (!modified) return payload;
  return JSON.stringify({ ...parsed.root, messages: kept });
}

/** stripInvalidClaudeThinkingBlocks that also removes messages whose content becomes empty. */
export function stripInvalidClaudeThinkingBlocksAndEmptyMessages(payload: string, opt: ClaudeSignatureValidationOptions = {}): string {
  const stripped = stripInvalidClaudeThinkingBlocks(payload, opt);
  if (stripped === payload) return payload;
  const parsed = parseMessagesPayload(stripped);
  if (!parsed) return stripped;
  const kept = parsed.messages.filter((message) => {
    const content = getAt(message, "content");
    return !(Array.isArray(content) && content.length === 0);
  });
  return JSON.stringify({ ...parsed.root, messages: kept });
}

function shouldStripClaudeThinkingBlock(part: unknown, opt: ClaudeSignatureValidationOptions): boolean {
  if (opt.allowEmptySignatureWithEmptyText && isEmptyClaudeThinkingPlaceholder(part)) return false;
  return !isValidClaudeThinkingSignature(gstr(getAt(part, "signature")), opt);
}

export function isEmptyClaudeThinkingPlaceholder(part: unknown): boolean {
  if (gstr(getAt(part, "signature")).trim() !== "") return false;
  return claudeThinkingBlockText(part).trim() === "";
}

export function claudeThinkingBlockText(part: unknown): string {
  const text = getAt(part, "text");
  if (typeof text === "string") return text;
  const thinking = getAt(part, "thinking");
  if (thinking === undefined) return "";
  if (typeof thinking === "string") return thinking;
  if (isObj(thinking)) {
    if (typeof thinking.text === "string") return thinking.text;
    if (typeof thinking.thinking === "string") return thinking.thinking;
  }
  return "";
}

// Port of internal/util/claude_attribution.go.
import { getAt, gstr, isObj } from "./gpath.ts";

const claudeCodeAttributionSystemPrefix = "x-anthropic-billing-header:";

/** Reports whether text is the Claude Code attribution block carrying per-request billing data. */
export function isClaudeCodeAttributionSystemText(text: string): boolean {
  return text.replace(/^\s+/u, "").startsWith(claudeCodeAttributionSystemPrefix);
}

/**
 * Removes Claude Code billing/CCH attribution blocks from a Messages body (JSON string).
 * Other system content is kept. The payload is returned unchanged when nothing is removed.
 */
export function stripClaudeCodeAttributionSystem(payload: string): string {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isObj(root) || !("system" in root)) return payload;
  const system = root.system;
  if (typeof system === "string") {
    if (!isClaudeCodeAttributionSystemText(system)) return payload;
    delete root.system;
    return JSON.stringify(root);
  }
  if (!Array.isArray(system)) return payload;
  const kept: unknown[] = [];
  let removed = false;
  for (const block of system) {
    if (gstr(getAt(block, "type")) === "text" && isClaudeCodeAttributionSystemText(gstr(getAt(block, "text")))) {
      removed = true;
      continue;
    }
    kept.push(block);
  }
  if (!removed) return payload;
  if (kept.length === 0) delete root.system;
  else root.system = kept;
  return JSON.stringify(root);
}

// context_management injection for cloaked requests to api.anthropic.com. Port of
// claudeCodeContextManagement, claudeThinkingAcceptsClearThinking,
// injectClaudeCodeContextManagement, claudeCodeContextManagementState and
// reconcileClaudeCodeContextManagement (claude_executor_cloaking.go).
import { isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

/** The object Claude Code 2.1.220 sends on every Messages request. */
export const claudeCodeContextManagement = `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`;

export interface ClaudeCodeContextManagementState {
  eligible: boolean;
  callerOwned: boolean;
  automaticallyInjected: boolean;
}

/** Anthropic accepts clear_thinking_20251015 only with enabled/adaptive thinking. */
export function claudeThinkingAcceptsClearThinking(root: unknown): boolean {
  if (!isObj(root) || !isObj(root.thinking)) return false;
  const type = root.thinking.type;
  return type === "enabled" || type === "adaptive";
}

/** Supplies context_management when the caller omitted it and thinking allows it. */
export function injectClaudeCodeContextManagement(payload: string): { payload: string; injected: boolean } {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || root.context_management !== undefined || !claudeThinkingAcceptsClearThinking(root)) return { payload, injected: false };
  root.context_management = JSON.parse(claudeCodeContextManagement);
  return { payload: JSON.stringify(root), injected: true };
}

/**
 * Resolves built-in ownership after forced tool-choice processing: drops an
 * unchanged CPA-injected object once thinking no longer accepts it, and adds it
 * back for an eligible request that lost it.
 */
export function reconcileClaudeCodeContextManagement(payload: string, state: ClaudeCodeContextManagementState): string {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return payload;
  const cm = root.context_management;
  if (!claudeThinkingAcceptsClearThinking(root)) {
    if (state.callerOwned || !state.automaticallyInjected) return payload;
    if (cm === undefined || JSON.stringify(cm) !== claudeCodeContextManagement) return payload;
    delete root.context_management;
    return JSON.stringify(root);
  }
  if (!state.eligible || state.callerOwned || cm !== undefined) return payload;
  root.context_management = JSON.parse(claudeCodeContextManagement);
  return JSON.stringify(root);
}


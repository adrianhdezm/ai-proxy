// Claude Code session identity helpers. Port of the session parts of
// internal/runtime/executor/helps/claude_code_session.go
// (ExtractClaudeCodeSessionID, ExtractClaudeCodeAgentID, ClaudeCodeExecutionScope).
// ClaudeCodePromptCache (Codex prompt_cache_key) is not ported here.
import { getAt, gstr } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { headerValueCaseInsensitive } from "./upstream.ts";

export const ClaudeCodeAgentHeader = "X-Claude-Code-Agent-Id";
export const ClaudeCodeMainAgentID = "main";
const claudeCodeSessionHeader = "X-Claude-Code-Session-Id";
const claudeCodeSessionSuffixPattern = /_session_([a-f0-9-]+)$/;

function extractClaudeCodeSessionIDFromPayload(payload: string): string {
  if (payload === "") return "";
  const userID = gstr(getAt(tryParse(payload), "metadata.user_id"));
  if (userID === "") return "";
  const m = claudeCodeSessionSuffixPattern.exec(userID);
  if (m) return m[1]!;
  if (userID.startsWith("{")) return gstr(getAt(tryParse(userID), "session_id")).trim();
  return "";
}

/** X-Claude-Code-Session-Id, else the metadata.user_id session (Go: ExtractClaudeCodeSessionID). */
export function extractClaudeCodeSessionID(payload: string, headers: Headers | undefined): string {
  const header = headerValueCaseInsensitive(headers, claudeCodeSessionHeader).trim();
  if (header !== "") return header;
  return extractClaudeCodeSessionIDFromPayload(payload);
}

/** The Claude Code agent id, "main" for the root agent (Go: ExtractClaudeCodeAgentID). */
export function extractClaudeCodeAgentID(headers: Headers | undefined): string {
  const agent = headerValueCaseInsensitive(headers, ClaudeCodeAgentHeader).trim();
  return agent !== "" ? agent : ClaudeCodeMainAgentID;
}

/** "claude:<session>:agent:<agent>", or "" without a session (Go: ClaudeCodeExecutionScope). */
export function claudeCodeExecutionScope(payload: string, headers: Headers | undefined): string {
  const sessionID = extractClaudeCodeSessionID(payload, headers);
  if (sessionID === "") return "";
  return `claude:${sessionID}:agent:${extractClaudeCodeAgentID(headers)}`;
}

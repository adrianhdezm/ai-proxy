// Port of internal/runtime/executor/helps/claude_tool_search_model.go.
import { parseSuffix } from "../../thinking/suffix.ts";

/** Anthropic models that predate tool search: Claude Opus 4.1 and earlier reject defer_loading tools and tool_reference blocks. */
const claudeToolSearchLegacyPrefixes = ["claude-3", "claude-2", "claude-instant"];

const claudeToolSearchLegacyModels = new Set([
  "claude-opus-4",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
]);

/**
 * Reports Anthropic models that predate tool search. Unknown names, including
 * third-party models, are treated as supported (Go: ClaudeModelLacksToolSearch).
 */
export function claudeModelLacksToolSearch(model: string): boolean {
  let name = parseSuffix(model.trim()).modelName.trim().toLowerCase();
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);
  const bracket = name.indexOf("[");
  if (bracket >= 0) name = name.slice(0, bracket);
  name = name.trim();
  if (name === "") return false;
  if (claudeToolSearchLegacyModels.has(name)) return true;
  return claudeToolSearchLegacyPrefixes.some((prefix) => name.startsWith(prefix));
}

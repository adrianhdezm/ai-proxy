// Port of internal/thinking/configuration_update.go: OpenAI Responses `configuration_update`
// input items, which carry in-turn reasoning effort changes for Codex models that support them.
import { Doc, gjsonString, isEmptyObject, validJSON } from "./json.ts";
import { isObject } from "../util/json.ts";
import { ModeLevel, type ThinkingConfig, autoConfig, emptyThinkingConfig, noneConfig } from "./types.ts";
import { hasThinkingConfig } from "./suffix.ts";
import { reasoningEffortFromConfig } from "./effort.ts";

export function isResponsesFormat(format: string): boolean {
  return format === "codex" || format === "openai-response";
}

/** The last nonempty Responses effort update in `input` (Go: extractConfigurationUpdateConfig). */
export function extractConfigurationUpdateConfig(body: string): ThinkingConfig {
  if (!validJSON(body)) return emptyThinkingConfig();
  const doc = new Doc(body);
  const input = doc.get("input");
  if (!Array.isArray(input)) return emptyThinkingConfig();
  let effort = "";
  for (const item of input) {
    if (!isObject(item) || gjsonString(item.type) !== "configuration_update") continue;
    const reasoning = item.reasoning;
    if (!isObject(reasoning) || typeof reasoning.effort !== "string") continue;
    const normalized = reasoning.effort.trim().toLowerCase();
    if (normalized !== "") effort = normalized;
  }
  switch (effort) {
    case "":
      return emptyThinkingConfig();
    case "none":
      return noneConfig();
    case "auto":
      return autoConfig();
    default:
      return { mode: ModeLevel, budget: 0, level: effort };
  }
}

/**
 * Removes every configuration_update input item. Unless keepTopLevelEffort is true, the last
 * nonempty update effort is promoted into the top-level reasoning.effort. Targets that reject
 * configuration_update items use it to degrade to the classic request-level effort
 * (Go: CollapseConfigurationUpdates).
 */
export function collapseConfigurationUpdates(body: string, keepTopLevelEffort = false): string {
  const updated = stripConfigurationUpdates(body);
  if (keepTopLevelEffort) return updated;
  const effort = reasoningEffortFromConfig(extractConfigurationUpdateConfig(body));
  if (effort === "") return updated;
  const doc = new Doc(updated);
  if (!doc.valid) return updated;
  doc.set("reasoning.effort", effort);
  return doc.toString();
}

/** Removes configuration_update input items without changing reasoning (Go: StripConfigurationUpdates). */
export function stripConfigurationUpdates(body: string): string {
  if (!validJSON(body)) return body;
  const doc = new Doc(body);
  const input = doc.get("input");
  if (!Array.isArray(input)) return body;
  const kept = input.filter((item) => !(isObject(item) && gjsonString(item.type) === "configuration_update"));
  if (kept.length === input.length) return body;
  doc.set("input", kept);
  return doc.toString();
}

/** Removes reasoning.effort, leaving summary and unrelated reasoning fields intact (Go: stripResponsesEffort). */
export function stripResponsesEffort(body: string): string {
  if (!validJSON(body)) return body;
  const doc = new Doc(body);
  if (!doc.exists("reasoning.effort")) return body;
  doc.del("reasoning.effort");
  if (isEmptyObject(doc.get("reasoning"))) doc.del("reasoning");
  return doc.toString();
}

/** hasThinkingConfig re-exported for callers that only import this module. */
export { hasThinkingConfig };

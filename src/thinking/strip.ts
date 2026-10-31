// Port of internal/thinking/strip.go (kept providers only).
import { Doc } from "./json.ts";

/**
 * Removes thinking configuration fields from a request body for a model that does not
 * support thinking. Unknown providers, invalid JSON and bodies without thinking config are
 * returned unchanged.
 */
export function stripThinkingConfig(body: string, provider: string): string {
  const doc = new Doc(body);
  if (body.length === 0 || !doc.valid) return body;

  let paths: string[];
  switch (provider) {
    case "claude":
      paths = ["thinking", "output_config.effort"];
      break;
    case "gemini":
      paths = ["generationConfig.thinkingConfig"];
      break;
    case "openai":
      paths = ["reasoning_effort", "reasoning"];
      break;
    case "codex":
      paths = ["reasoning"];
      break;
    default:
      return body;
  }
  for (const path of paths) doc.del(path);
  // Avoid leaving an empty output_config object for Claude when effort was the only field.
  if (provider === "claude") doc.deleteIfEmptyObject("output_config");
  return doc.toString();
}

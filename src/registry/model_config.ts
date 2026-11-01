// Capability resolution for configured (API-key) models. Port of
// internal/modelconfig/model_info.go: a configured upstream name inherits the
// static catalog capabilities of its suffix-free id, and an explicit thinking
// block from the config replaces the catalog levels.
import { parseSuffix } from "../thinking/suffix.ts";
import { lookupStaticModelInfo } from "./model_definitions.ts";
import type { ModelInfo, ThinkingSupport } from "./types.ts";

/**
 * Returns a private capability snapshot for a configured model (Go: ResolveModelInfo).
 * The id is the configured name (suffix kept); capabilities come from the static catalog
 * entry of the suffix-free name; explicit `support` takes precedence, keeping the
 * catalog's way of turning thinking off when it sets none of its own.
 */
export function resolveModelInfo(name: string, modelType: string, support?: ThinkingSupport): ModelInfo {
  const trimmedName = name.trim();
  const baseName = parseSuffix(trimmedName).modelName.trim();
  const info: ModelInfo = lookupStaticModelInfo(baseName) ?? { id: "", type: "" };
  info.id = trimmedName;
  info.type = modelType.trim();
  if (support) {
    const normalized = normalizeThinkingSupport(support)!;
    if ((normalized.disableType ?? "") === "" && info.thinking?.disableType) normalized.disableType = info.thinking.disableType;
    info.thinking = normalized;
  }
  info.userDefined = false;
  return info;
}

/**
 * Clones and normalises configured reasoning levels (Go: NormalizeThinkingSupport):
 * levels are trimmed, lower-cased and de-duplicated; "none" enables zeroAllowed and
 * "auto" enables dynamicAllowed.
 */
export function normalizeThinkingSupport(raw: ThinkingSupport | undefined): ThinkingSupport | undefined {
  if (!raw) return undefined;
  const normalized: ThinkingSupport = { ...raw };
  delete normalized.levels;
  const seen = new Set<string>();
  const levels: string[] = [];
  for (const value of raw.levels ?? []) {
    const level = value.trim().toLowerCase();
    if (level === "") continue;
    if (level === "none") normalized.zeroAllowed = true;
    if (level === "auto") normalized.dynamicAllowed = true;
    if (seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  if (levels.length > 0) normalized.levels = levels;
  return normalized;
}

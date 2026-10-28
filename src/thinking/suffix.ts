// Port of internal/thinking/suffix.go plus parseSuffixToConfig from apply.go (kept here so
// hasThinkingSuffix does not depend on the apply pipeline).
import { log } from "../log.ts";
import {
  LevelHigh,
  LevelLow,
  LevelMax,
  LevelMedium,
  LevelMinimal,
  LevelXHigh,
  ModeAuto,
  ModeBudget,
  ModeNone,
  type SuffixResult,
  type ThinkingConfig,
  type ThinkingLevel,
  type ThinkingMode,
  autoConfig,
  budgetConfig,
  emptyThinkingConfig,
  levelConfig,
  noneConfig,
} from "./types.ts";

/**
 * Extracts a thinking suffix from a model name: "claude-sonnet-4-5(16384)" ->
 * { modelName: "claude-sonnet-4-5", rawSuffix: "16384" }. Only extracts; does not interpret.
 */
export function parseSuffix(model: string): SuffixResult {
  const lastOpen = model.lastIndexOf("(");
  if (lastOpen === -1 || !model.endsWith(")")) return { modelName: model, hasSuffix: false, rawSuffix: "" };
  return { modelName: model.slice(0, lastOpen), hasSuffix: true, rawSuffix: model.slice(lastOpen + 1, model.length - 1) };
}

/** Whether the model suffix defines a thinking configuration. */
export function hasThinkingSuffix(model: string): boolean {
  const result = parseSuffix(model);
  return result.hasSuffix && hasThinkingConfig(parseSuffixToConfig(result.rawSuffix, "", result.modelName));
}

/** Go's "config carries something" check (zero value ThinkingConfig{} means no config). */
export function hasThinkingConfig(config: ThinkingConfig): boolean {
  return config.mode !== ModeBudget || config.budget !== 0 || config.level !== "";
}

/**
 * Parses a raw suffix as a non-negative integer budget (leading zeros accepted; negatives,
 * non-numeric and out-of-range values are rejected).
 */
export function parseNumericSuffix(rawSuffix: string): { budget: number; ok: boolean } {
  if (rawSuffix === "" || !/^[+-]?\d+$/.test(rawSuffix)) return { budget: 0, ok: false };
  const value = Number(rawSuffix);
  if (!Number.isSafeInteger(value)) return { budget: 0, ok: false };
  if (value < 0) return { budget: 0, ok: false };
  return { budget: value, ok: true };
}

/** Parses "none" -> ModeNone, "auto"/"-1" -> ModeAuto (case-insensitive). */
export function parseSpecialSuffix(rawSuffix: string): { mode: ThinkingMode; ok: boolean } {
  if (rawSuffix === "") return { mode: ModeBudget, ok: false };
  switch (rawSuffix.toLowerCase()) {
    case "none":
      return { mode: ModeNone, ok: true };
    case "auto":
    case "-1":
      return { mode: ModeAuto, ok: true };
    default:
      return { mode: ModeBudget, ok: false };
  }
}

/** Parses a discrete level (minimal/low/medium/high/xhigh/max), case-insensitive. */
export function parseLevelSuffix(rawSuffix: string): { level: ThinkingLevel; ok: boolean } {
  if (rawSuffix === "") return { level: "", ok: false };
  switch (rawSuffix.toLowerCase()) {
    case "minimal":
      return { level: LevelMinimal, ok: true };
    case "low":
      return { level: LevelLow, ok: true };
    case "medium":
      return { level: LevelMedium, ok: true };
    case "high":
      return { level: LevelHigh, ok: true };
    case "xhigh":
      return { level: LevelXHigh, ok: true };
    case "max":
      return { level: LevelMax, ok: true };
    default:
      return { level: "", ok: false };
  }
}

/**
 * Converts a raw suffix to a ThinkingConfig. Priority: special values (none/auto/-1), then
 * level names, then numeric budgets (0 -> ModeNone). Unknown suffixes yield an empty config.
 */
export function parseSuffixToConfig(rawSuffix: string, provider: string, model: string): ThinkingConfig {
  const special = parseSpecialSuffix(rawSuffix);
  if (special.ok) {
    if (special.mode === ModeNone) return noneConfig();
    if (special.mode === ModeAuto) return autoConfig();
  }
  const level = parseLevelSuffix(rawSuffix);
  if (level.ok) return levelConfig(level.level);
  const numeric = parseNumericSuffix(rawSuffix);
  if (numeric.ok) return numeric.budget === 0 ? noneConfig() : budgetConfig(numeric.budget);
  log.debug("thinking: unknown suffix format, treating as no config |", { provider, model, raw_suffix: rawSuffix });
  return emptyThinkingConfig();
}

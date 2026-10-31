// Port of internal/thinking/convert.go: level <-> budget conversion and model capability detection.
import type { ModelInfo } from "../registry/types.ts";
import { LevelAuto, LevelHigh, LevelLow, LevelMedium, LevelMinimal, LevelNone, LevelXHigh } from "./types.ts";

/** Standard level -> budget mapping (keys lowercase). */
const levelToBudgetMap: Record<string, number> = {
  none: 0,
  auto: -1,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  // "max" is Claude adaptive effort; mapped to a large budget and clamped per model.
  max: 128000,
};

/** Converts a level to a budget (case-insensitive). */
export function convertLevelToBudget(level: string): { budget: number; ok: boolean } {
  const budget = levelToBudgetMap[level.toLowerCase()];
  return budget === undefined ? { budget: 0, ok: false } : { budget, ok: true };
}

export const ThresholdMinimal = 512;
export const ThresholdLow = 1024;
export const ThresholdMedium = 8192;
export const ThresholdHigh = 24576;

/**
 * Converts a budget to the nearest level: -1 auto, 0 none, 1-512 minimal, 513-1024 low,
 * 1025-8192 medium, 8193-24576 high, 24577+ xhigh. Budgets below -1 are invalid.
 */
export function convertBudgetToLevel(budget: number): { level: string; ok: boolean } {
  if (budget < -1) return { level: "", ok: false };
  if (budget === -1) return { level: LevelAuto, ok: true };
  if (budget === 0) return { level: LevelNone, ok: true };
  if (budget <= ThresholdMinimal) return { level: LevelMinimal, ok: true };
  if (budget <= ThresholdLow) return { level: LevelLow, ok: true };
  if (budget <= ThresholdMedium) return { level: LevelMedium, ok: true };
  if (budget <= ThresholdHigh) return { level: LevelHigh, ok: true };
  return { level: LevelXHigh, ok: true };
}

/** Whether target exists in levels (case-insensitive, trimmed). */
export function hasLevel(levels: ReadonlyArray<string> | undefined, target: string): boolean {
  if (!levels) return false;
  const t = target.toLowerCase();
  return levels.some((level) => level.trim().toLowerCase() === t);
}

/**
 * Maps a generic level to a Claude adaptive effort (low/medium/high/max). supportsMax says
 * whether the target model accepts "max".
 */
export function mapToClaudeEffort(level: string, supportsMax: boolean): { effort: string; ok: boolean } {
  level = level.trim().toLowerCase();
  switch (level) {
    case "":
      return { effort: "", ok: false };
    case "minimal":
      return { effort: "low", ok: true };
    case "low":
    case "medium":
    case "high":
      return { effort: level, ok: true };
    case "xhigh":
    case "max":
      return { effort: supportsMax ? "max" : "high", ok: true };
    case "auto":
      return { effort: "high", ok: true };
    default:
      return { effort: "", ok: false };
  }
}

/** Thinking format support of a model (Go: ModelCapability). */
export type ModelCapability = "unknown" | "none" | "budget-only" | "level-only" | "hybrid";

export const CapabilityUnknown: ModelCapability = "unknown";
export const CapabilityNone: ModelCapability = "none";
export const CapabilityBudgetOnly: ModelCapability = "budget-only";
export const CapabilityLevelOnly: ModelCapability = "level-only";
export const CapabilityHybrid: ModelCapability = "hybrid";

/**
 * Classifies a model's ThinkingSupport: none (no thinking), budget-only (min/max, no levels),
 * level-only (levels, no min/max), hybrid (both). Unknown when modelInfo is undefined.
 */
export function detectModelCapability(modelInfo: ModelInfo | undefined): ModelCapability {
  if (!modelInfo) return CapabilityUnknown;
  const support = modelInfo.thinking;
  if (!support) return CapabilityNone;
  const hasBudget = (support.min ?? 0) > 0 || (support.max ?? 0) > 0;
  const hasLevels = (support.levels?.length ?? 0) > 0;
  if (hasBudget && hasLevels) return CapabilityHybrid;
  if (hasBudget) return CapabilityBudgetOnly;
  if (hasLevels) return CapabilityLevelOnly;
  return CapabilityNone;
}

/**
 * Whether the model is user-defined (config models[]) or unknown; such models have thinking
 * applied without validation and the upstream validates it (Go: IsUserDefinedModel).
 */
export function isUserDefinedModel(modelInfo: ModelInfo | undefined): boolean {
  if (!modelInfo) return true;
  return modelInfo.userDefined === true;
}

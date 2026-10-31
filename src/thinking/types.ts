// Port of internal/thinking/types.go: unified thinking configuration types shared by the
// suffix parser, validator, provider appliers and the apply pipeline.
import type { ModelInfo } from "../registry/types.ts";

/** Thinking configuration mode (Go: ThinkingMode; the String() names are used as values). */
export type ThinkingMode = "budget" | "level" | "none" | "auto";

/** Numeric budget (suffix "(1000)" etc.). This is Go's zero value: budget 0 means "no config". */
export const ModeBudget: ThinkingMode = "budget";
/** Discrete level (suffix "(high)" etc.). */
export const ModeLevel: ThinkingMode = "level";
/** Thinking disabled (suffix "(none)" or budget=0). */
export const ModeNone: ThinkingMode = "none";
/** Automatic/dynamic thinking (suffix "(auto)" or budget=-1). */
export const ModeAuto: ThinkingMode = "auto";

/** A discrete thinking level (Go: ThinkingLevel). */
export type ThinkingLevel = string;

export const LevelNone: ThinkingLevel = "none";
export const LevelAuto: ThinkingLevel = "auto";
export const LevelMinimal: ThinkingLevel = "minimal";
export const LevelLow: ThinkingLevel = "low";
export const LevelMedium: ThinkingLevel = "medium";
export const LevelHigh: ThinkingLevel = "high";
export const LevelXHigh: ThinkingLevel = "xhigh";
/** Used by Claude adaptive thinking (opus supports "max"). */
export const LevelMax: ThinkingLevel = "max";

/**
 * Unified thinking configuration (Go: ThinkingConfig). Depending on mode either budget or
 * level is effective:
 *   - ModeNone: budget=0, level ignored
 *   - ModeAuto: budget=-1, level ignored
 *   - ModeBudget: budget is a positive integer, level ignored
 *   - ModeLevel: budget ignored, level is a valid level
 */
export interface ThinkingConfig {
  mode: ThinkingMode;
  /** Thinking budget in tokens; 0 means disabled, -1 means automatic. */
  budget: number;
  level: ThinkingLevel;
}

/** Go's zero-value ThinkingConfig{} ("no config"). */
export function emptyThinkingConfig(): ThinkingConfig {
  return { mode: ModeBudget, budget: 0, level: "" };
}

export function budgetConfig(budget: number): ThinkingConfig {
  return { mode: ModeBudget, budget, level: "" };
}

export function levelConfig(level: ThinkingLevel): ThinkingConfig {
  return { mode: ModeLevel, budget: 0, level };
}

export function noneConfig(): ThinkingConfig {
  return { mode: ModeNone, budget: 0, level: "" };
}

export function autoConfig(): ThinkingConfig {
  return { mode: ModeAuto, budget: -1, level: "" };
}

/** Result of parsing a model name for a thinking suffix "model(value)" (Go: SuffixResult). */
export interface SuffixResult {
  /** Model name with the suffix removed (equals the input when no suffix was found). */
  modelName: string;
  hasSuffix: boolean;
  /** Content inside the parentheses; empty when hasSuffix is false. */
  rawSuffix: string;
}

/**
 * Provider-specific application of a validated ThinkingConfig to a request body
 * (Go: ProviderApplier). Implementations must be idempotent, must not mutate config or
 * modelInfo, and return the modified body JSON string. They throw a ThinkingError for
 * unsupported configurations.
 */
export interface ProviderApplier {
  apply(body: string, config: ThinkingConfig, modelInfo: ModelInfo | undefined): string;
}

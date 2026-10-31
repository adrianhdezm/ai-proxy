// Port of internal/thinking/validate.go (kept provider families: claude, gemini, openai/codex).
import type { ModelInfo, ThinkingSupport } from "../registry/types.ts";
import { log } from "../log.ts";
import {
  CapabilityBudgetOnly,
  CapabilityHybrid,
  CapabilityLevelOnly,
  convertBudgetToLevel,
  convertLevelToBudget,
  detectModelCapability,
} from "./convert.ts";
import { ErrBudgetOutOfRange, ErrLevelNotSupported, ErrThinkingNotSupported, ErrUnknownLevel, newThinkingError, newThinkingErrorWithModel } from "./errors.ts";
import {
  LevelAuto,
  LevelHigh,
  LevelLow,
  LevelMax,
  LevelMedium,
  LevelMinimal,
  LevelNone,
  LevelXHigh,
  ModeAuto,
  ModeBudget,
  ModeLevel,
  ModeNone,
  type ThinkingConfig,
  type ThinkingLevel,
} from "./types.ts";

/**
 * Validates and normalises a thinking configuration against model capabilities
 * (Go: ValidateConfig). It converts between budget and level forms based on the model,
 * checks requested levels against the supported list, clamps budgets to the model range
 * (strictly rejecting out-of-range budgets for same-family body configs) and resolves
 * auto/none for models that cannot be dynamic or disabled. Throws a ThinkingError.
 */
export function validateConfig(input: ThinkingConfig, modelInfo: ModelInfo | undefined, fromFormat: string, toFormat: string, fromSuffix: boolean): ThinkingConfig {
  fromFormat = fromFormat.trim().toLowerCase();
  toFormat = toFormat.trim().toLowerCase();
  let config: ThinkingConfig = { ...input };
  let model = "unknown";
  let support: ThinkingSupport | undefined;
  if (modelInfo) {
    if (modelInfo.id !== "") model = modelInfo.id;
    support = modelInfo.thinking;
  }

  if (!support) {
    if (config.mode !== ModeNone) throw newThinkingErrorWithModel(ErrThinkingNotSupported, "thinking not supported for this model", model);
    return config;
  }
  const levels = support.levels ?? [];
  const min = support.min ?? 0;
  const max = support.max ?? 0;

  // allowClampUnsupported: clamp unsupported levels instead of erroring when crossing provider
  // families and the target supports discrete levels. modelFamilyMismatch covers providers
  // that reuse another protocol on the wire (the model's type is not the wire family).
  const toCapability = detectModelCapability(modelInfo);
  const toHasLevelSupport = toCapability === CapabilityLevelOnly || toCapability === CapabilityHybrid;
  let modelFamilyMismatch = false;
  if (modelInfo) {
    const modelType = modelInfo.type.trim().toLowerCase();
    if (isKnownProviderFamily(modelType)) {
      if ((fromFormat !== "" && !isSameProviderFamily(fromFormat, modelType)) || (toFormat !== "" && !isSameProviderFamily(toFormat, modelType))) {
        modelFamilyMismatch = true;
      }
    }
  }
  const allowClampUnsupported = toHasLevelSupport && (!isSameProviderFamily(fromFormat, toFormat) || modelFamilyMismatch);

  // strictBudget: enforce the budget range when the config came from a request body of a
  // known same-family source. Cross-family or suffix configs are clamped instead.
  const strictBudget = !fromSuffix && fromFormat !== "" && isSameProviderFamily(fromFormat, toFormat) && !modelFamilyMismatch;
  let budgetDerivedFromLevel = false;

  const capability = detectModelCapability(modelInfo);
  if (capability === CapabilityBudgetOnly) {
    if (config.mode === ModeLevel && config.level !== LevelAuto) {
      const { budget, ok } = convertLevelToBudget(config.level);
      if (!ok) throw newThinkingError(ErrUnknownLevel, `unknown level: ${config.level}`);
      config = { mode: ModeBudget, budget, level: "" };
      budgetDerivedFromLevel = true;
    }
  } else if (capability === CapabilityLevelOnly) {
    if (config.mode === ModeBudget) {
      const { level, ok } = convertBudgetToLevel(config.budget);
      if (!ok) throw newThinkingError(ErrUnknownLevel, `budget ${config.budget} cannot be converted to a valid level`);
      // Clamp the derived standard level to the nearest supported level; none/auto are preserved.
      config = { mode: ModeLevel, level: clampLevel(level, modelInfo, toFormat), budget: 0 };
    }
  }

  if (config.mode === ModeLevel && config.level === LevelNone) config = { mode: ModeNone, budget: 0, level: "" };
  if (config.mode === ModeLevel && config.level === LevelAuto) config = { mode: ModeAuto, budget: -1, level: "" };
  if (config.mode === ModeBudget && config.budget === 0) config = { mode: ModeNone, budget: 0, level: "" };

  if (levels.length > 0 && config.mode === ModeLevel) {
    if (!isLevelSupported(config.level, levels)) {
      if (allowClampUnsupported) config = { ...config, level: clampLevel(config.level, modelInfo, toFormat) };
      if (!isLevelSupported(config.level, levels)) {
        const validLevels = normalizeLevels(levels);
        throw newThinkingError(ErrLevelNotSupported, `level "${config.level.toLowerCase()}" not supported, valid levels: ${validLevels.join(", ")}`);
      }
    }
  }

  if (strictBudget && config.mode === ModeBudget && !budgetDerivedFromLevel) {
    if (min !== 0 || max !== 0) {
      if (config.budget < min || config.budget > max || (config.budget === 0 && !support.zeroAllowed)) {
        throw newThinkingError(ErrBudgetOutOfRange, `budget ${config.budget} out of range [${min},${max}]`);
      }
    }
  }

  // Convert ModeAuto to a mid-range value if dynamic is not allowed.
  if (config.mode === ModeAuto && !support.dynamicAllowed) {
    config = convertAutoToMidRange(config, support, toFormat, model);
    // The canonical mid-range level may be absent from a discrete subset (Levels=[low, high]).
    if (config.mode === ModeLevel && levels.length > 0 && !isLevelSupported(config.level, levels)) {
      config = { ...config, level: clampLevel(config.level, modelInfo, toFormat) };
    }
  }

  if (config.mode === ModeNone && toFormat === "claude") {
    if (!support.zeroAllowed) {
      const lowest = lowestSupportedLevel(levels);
      if (lowest !== undefined) {
        // Adaptive-only Claude models reject thinking.type="disabled"; fall back to the lowest level.
        config = { mode: ModeLevel, budget: 0, level: lowest };
      } else {
        config = { ...config, budget: 0, level: "" };
      }
    } else {
      // Claude supports explicit disable; keep budget=0 so the applier omits budget_tokens.
      config = { ...config, budget: 0, level: "" };
    }
  } else {
    if (config.mode === ModeBudget || config.mode === ModeAuto || config.mode === ModeNone) {
      config = { ...config, budget: clampBudget(config.budget, modelInfo, toFormat) };
    }
    // ModeNone for a model that cannot be disabled falls back to the lowest supported level.
    const cannotDisableLevelModel = !support.zeroAllowed && !isLevelSupported(LevelNone, levels);
    if (config.mode === ModeNone && levels.length > 0 && (config.budget > 0 || cannotDisableLevelModel)) {
      const lowest = lowestSupportedLevel(levels);
      if (lowest !== undefined) config = { ...config, level: lowest };
    }
  }

  return config;
}

/**
 * Converts ModeAuto to a mid-range value when dynamic is not allowed: level-only models get
 * ModeLevel/medium, budget models get (min+max)/2 (Go: convertAutoToMidRange).
 */
export function convertAutoToMidRange(config: ThinkingConfig, support: ThinkingSupport, provider: string, model: string): ThinkingConfig {
  const levels = support.levels ?? [];
  const min = support.min ?? 0;
  const max = support.max ?? 0;
  if (levels.length > 0 && min === 0 && max === 0) {
    log.debug("thinking: mode converted, dynamic not allowed, using medium level |", { provider, model, original_mode: "auto", clamped_to: LevelMedium });
    return { mode: ModeLevel, level: LevelMedium, budget: 0 };
  }
  const mid = Math.trunc((min + max) / 2);
  let out: ThinkingConfig;
  if (mid <= 0 && support.zeroAllowed) out = { ...config, mode: ModeNone, budget: 0 };
  else if (mid <= 0) out = { ...config, mode: ModeBudget, budget: min };
  else out = { ...config, mode: ModeBudget, budget: mid };
  log.debug("thinking: mode converted, dynamic not allowed |", { provider, model, original_mode: "auto", clamped_to: out.budget });
  return out;
}

/** Canonical ordering of thinking levels from lowest to highest. */
export const standardLevelOrder: ThinkingLevel[] = [LevelMinimal, LevelLow, LevelMedium, LevelHigh, LevelXHigh, LevelMax];

/** Lowest canonical effort level in supported, ignoring mode markers such as "none" and "auto". */
export function lowestSupportedLevel(supported: ReadonlyArray<string>): ThinkingLevel | undefined {
  let bestIdx = -1;
  for (const s of supported) {
    const idx = levelIndex(s.trim());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  return bestIdx >= 0 ? standardLevelOrder[bestIdx] : undefined;
}

/** Clamps a level to the nearest supported level; on tie prefers the lower level (Go: clampLevel). */
export function clampLevel(level: ThinkingLevel, modelInfo: ModelInfo | undefined, provider: string): ThinkingLevel {
  const model = modelInfo?.id || "unknown";
  const supported = modelInfo?.thinking?.levels ?? [];
  if (supported.length === 0 || isLevelSupported(level, supported)) return level;
  const pos = levelIndex(level);
  if (pos === -1) return level;
  let bestIdx = -1;
  let bestDist = standardLevelOrder.length + 1;
  for (const s of supported) {
    const idx = levelIndex(s.trim());
    if (idx === -1) continue;
    const dist = Math.abs(pos - idx);
    if (dist < bestDist || (dist === bestDist && idx < bestIdx)) {
      bestIdx = idx;
      bestDist = dist;
    }
  }
  if (bestIdx >= 0) {
    const clamped = standardLevelOrder[bestIdx]!;
    log.debug("thinking: level clamped |", { provider, model, original_value: level, clamped_to: clamped });
    return clamped;
  }
  return level;
}

/** Clamps a budget to the model's supported range (Go: clampBudget). -1 passes through. */
export function clampBudget(value: number, modelInfo: ModelInfo | undefined, provider: string): number {
  const model = modelInfo?.id || "unknown";
  const support = modelInfo?.thinking;
  if (!support) return value;
  if (value === -1) return value;
  const min = support.min ?? 0;
  const max = support.max ?? 0;
  if (value === 0 && !support.zeroAllowed) {
    log.warn("thinking: budget zero not allowed |", { provider, model, original_value: value, clamped_to: min, min, max });
    return min;
  }
  // Level-only models do not define numeric budget ranges.
  if (min === 0 && max === 0) return value;
  if (value < min) {
    if (value === 0 && support.zeroAllowed) return 0;
    log.debug("thinking: budget clamped |", { provider, model, original_value: value, min, max, clamped_to: min });
    return min;
  }
  if (value > max) {
    log.debug("thinking: budget clamped |", { provider, model, original_value: value, min, max, clamped_to: max });
    return max;
  }
  return value;
}

export function isLevelSupported(level: string, supported: ReadonlyArray<string>): boolean {
  const l = level.toLowerCase();
  return supported.some((s) => s.trim().toLowerCase() === l);
}

export function levelIndex(level: string): number {
  const l = level.toLowerCase();
  return standardLevelOrder.findIndex((candidate) => candidate === l);
}

function normalizeLevels(levels: ReadonlyArray<string>): string[] {
  return levels.map((l) => l.trim().toLowerCase());
}

/** Providers that support budget-based thinking (may also support levels). */
export function isBudgetCapableProvider(provider: string): boolean {
  return provider === "gemini" || provider === "claude";
}

export function isGeminiFamily(provider: string): boolean {
  return provider === "gemini";
}

export function isOpenAIFamily(provider: string): boolean {
  return provider === "openai" || provider === "openai-response" || provider === "codex";
}

export function isKnownProviderFamily(provider: string): boolean {
  switch (provider) {
    case "gemini":
    case "claude":
    case "openai":
    case "openai-response":
    case "codex":
      return true;
    default:
      return false;
  }
}

export function isSameProviderFamily(from: string, to: string): boolean {
  if (from === to) return true;
  return (isGeminiFamily(from) && isGeminiFamily(to)) || (isOpenAIFamily(from) && isOpenAIFamily(to));
}

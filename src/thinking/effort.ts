// reasoningEffortFromConfig (from apply.go), split out so configuration_update.ts and apply.ts
// can share it without an import cycle.
import { convertBudgetToLevel } from "./convert.ts";
import { hasThinkingConfig } from "./suffix.ts";
import { LevelAuto, LevelNone, ModeAuto, ModeBudget, ModeLevel, ModeNone, type ThinkingConfig } from "./types.ts";

/** Canonical reasoning_effort label for a config ("" when it carries nothing). */
export function reasoningEffortFromConfig(config: ThinkingConfig): string {
  if (!hasThinkingConfig(config)) return "";
  switch (config.mode) {
    case ModeNone:
      return LevelNone;
    case ModeAuto:
      return LevelAuto;
    case ModeLevel:
      return config.level.trim().toLowerCase();
    case ModeBudget: {
      const { level, ok } = convertBudgetToLevel(config.budget);
      return ok ? level : "";
    }
    default:
      return "";
  }
}

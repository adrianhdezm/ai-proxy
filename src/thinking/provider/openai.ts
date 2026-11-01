// Port of internal/thinking/provider/openai/apply.go: OpenAI Chat Completions reasoning_effort.
import type { ModelInfo } from "../../registry/types.ts";
import { registerProvider } from "../appliers.ts";
import { convertBudgetToLevel, hasLevel, isUserDefinedModel } from "../convert.ts";
import { Doc } from "../json.ts";
import { LevelAuto, LevelNone, ModeAuto, ModeBudget, ModeLevel, ModeNone, type ProviderApplier, type ThinkingConfig } from "../types.ts";

function objectDoc(body: string): Doc {
  const doc = new Doc(body);
  return doc.valid ? doc : new Doc("{}");
}

/** Shared effort resolution for the OpenAI and Codex appliers (level-only models). */
export function resolveLevelEffort(config: ThinkingConfig, modelInfo: ModelInfo): string | undefined {
  if (config.mode === ModeLevel) return config.level;
  const support = modelInfo.thinking!;
  let effort = "";
  if (config.budget === 0 && (support.zeroAllowed || hasLevel(support.levels, LevelNone))) effort = LevelNone;
  if (effort === "" && config.level !== "") effort = config.level;
  if (effort === "" && (support.levels?.length ?? 0) > 0) effort = support.levels![0]!;
  return effort === "" ? undefined : effort;
}

/** Shared effort resolution for user-defined models (no validation). */
export function resolveCompatibleEffort(config: ThinkingConfig): string | undefined {
  switch (config.mode) {
    case ModeLevel:
      return config.level === "" ? undefined : config.level;
    case ModeNone:
      return config.level !== "" ? config.level : LevelNone;
    case ModeAuto:
      return LevelAuto;
    case ModeBudget: {
      const { level, ok } = convertBudgetToLevel(config.budget);
      return ok ? level : undefined;
    }
    default:
      return undefined;
  }
}

/** OpenAI Chat applier. Output: {"reasoning_effort":"high"}. */
export class OpenAIApplier implements ProviderApplier {
  apply(body: string, config: ThinkingConfig, modelInfo: ModelInfo | undefined): string {
    if (isUserDefinedModel(modelInfo)) {
      const effort = resolveCompatibleEffort(config);
      if (effort === undefined) return body;
      const doc = objectDoc(body);
      doc.set("reasoning_effort", effort);
      return doc.toString();
    }
    if (!modelInfo?.thinking) return body;
    // Only ModeLevel and ModeNone are handled; other modes pass through unchanged.
    if (config.mode !== ModeLevel && config.mode !== ModeNone) return body;
    const effort = resolveLevelEffort(config, modelInfo);
    if (effort === undefined) return body;
    const doc = objectDoc(body);
    doc.set("reasoning_effort", effort);
    return doc.toString();
  }
}

registerProvider("openai", new OpenAIApplier());

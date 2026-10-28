// Port of internal/thinking/provider/gemini/apply.go.
//
// Gemini 2.5 uses thinkingBudget (numeric); Gemini 3.x uses thinkingLevel (minimal/low/medium/high)
// or thinkingBudget=-1 for dynamic mode. ThinkingSupport.levels decides the output format.
import type { ModelInfo } from "../../registry/types.ts";
import { registerProvider } from "../appliers.ts";
import { isUserDefinedModel } from "../convert.ts";
import { Doc } from "../json.ts";
import { ModeAuto, ModeBudget, ModeLevel, ModeNone, type ProviderApplier, type ThinkingConfig } from "../types.ts";

const prefix = "generationConfig.thinkingConfig";

function objectDoc(body: string): Doc {
  const doc = new Doc(body);
  return doc.valid ? doc : new Doc("{}");
}

function isSupportedMode(config: ThinkingConfig): boolean {
  return config.mode === ModeBudget || config.mode === ModeLevel || config.mode === ModeNone || config.mode === ModeAuto;
}

/** Reads the documented includeThoughts boolean (either spelling) before the config is rewritten. */
function readIncludeThoughts(doc: Doc): boolean | undefined {
  for (const path of [`${prefix}.includeThoughts`, `${prefix}.include_thoughts`]) {
    const value = doc.get(path);
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function applyGeminiIncludeThoughts(doc: Doc, includeThoughts: boolean | undefined): void {
  if (includeThoughts !== undefined) doc.set(`${prefix}.includeThoughts`, includeThoughts);
}

function applyLevelFormat(body: string, config: ThinkingConfig): string {
  const doc = objectDoc(body);
  const includeThoughts = readIncludeThoughts(doc);
  // Remove conflicting fields to avoid both thinkingLevel and thinkingBudget in the output, and
  // normalise includeThoughts so only the documented boolean spelling is retained.
  for (const path of [`${prefix}.thinkingBudget`, `${prefix}.thinking_budget`, `${prefix}.thinking_level`, `${prefix}.includeThoughts`, `${prefix}.include_thoughts`]) doc.del(path);

  if (config.mode === ModeNone) {
    if (config.budget === 0 && config.level === "") {
      // With the amount fully disabled, visibility is irrelevant: restoring includeThoughts alone
      // would recreate thinkingConfig and let a default-on model think again.
      doc.del(prefix);
      return doc.toString();
    }
    if (config.level !== "") doc.set(`${prefix}.thinkingLevel`, config.level);
    applyGeminiIncludeThoughts(doc, includeThoughts);
    return doc.toString();
  }
  if (config.mode !== ModeLevel) return body;
  doc.set(`${prefix}.thinkingLevel`, config.level);
  applyGeminiIncludeThoughts(doc, includeThoughts);
  return doc.toString();
}

function applyBudgetFormat(body: string, config: ThinkingConfig): string {
  const doc = objectDoc(body);
  const includeThoughts = readIncludeThoughts(doc);
  for (const path of [`${prefix}.thinkingLevel`, `${prefix}.thinking_level`, `${prefix}.thinking_budget`, `${prefix}.includeThoughts`, `${prefix}.include_thoughts`]) doc.del(path);
  doc.set(`${prefix}.thinkingBudget`, config.budget);
  applyGeminiIncludeThoughts(doc, includeThoughts);
  return doc.toString();
}

function applyCompatible(body: string, config: ThinkingConfig): string {
  if (!isSupportedMode(config)) return body;
  if (config.mode === ModeAuto) return applyBudgetFormat(body, config);
  if (config.mode === ModeLevel || (config.mode === ModeNone && config.level !== "")) return applyLevelFormat(body, config);
  return applyBudgetFormat(body, config);
}

/**
 * Gemini thinking applier. Output:
 *   Gemini 2.5: {"generationConfig":{"thinkingConfig":{"thinkingBudget":8192}}}
 *   Gemini 3.x: {"generationConfig":{"thinkingConfig":{"thinkingLevel":"high"}}}
 */
export class GeminiApplier implements ProviderApplier {
  apply(body: string, config: ThinkingConfig, modelInfo: ModelInfo | undefined): string {
    if (isUserDefinedModel(modelInfo)) return applyCompatible(body, config);
    const support = modelInfo?.thinking;
    if (!support) return body;
    if (!isSupportedMode(config)) return body;
    switch (config.mode) {
      case ModeLevel:
        return applyLevelFormat(body, config);
      case ModeNone:
        // Route based on model capability (has levels or not).
        return (support.levels?.length ?? 0) > 0 ? applyLevelFormat(body, config) : applyBudgetFormat(body, config);
      default:
        return applyBudgetFormat(body, config);
    }
  }
}

registerProvider("gemini", new GeminiApplier());

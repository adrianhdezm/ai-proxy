// Port of internal/thinking/provider/claude/apply.go.
//
// Claude models support two thinking control styles:
//   - Manual thinking: thinking.type="enabled" with thinking.budget_tokens
//   - Adaptive thinking (Claude 4.6+): thinking.type="adaptive" with output_config.effort
import type { ModelInfo } from "../../registry/types.ts";
import { registerProvider } from "../appliers.ts";
import { convertLevelToBudget, isUserDefinedModel } from "../convert.ts";
import { Doc, gjsonInt } from "../json.ts";
import { ModeAuto, ModeBudget, ModeLevel, ModeNone, type ProviderApplier, type ThinkingConfig } from "../types.ts";

function objectDoc(body: string): Doc {
  const doc = new Doc(body);
  return doc.valid ? doc : new Doc("{}");
}

/**
 * Turns thinking off with the type the model accepts. Most Claude models take "disabled";
 * claude-sonnet-5-5 needs "between_tools". Neither accepts extra thinking fields, so the block
 * is replaced wholesale and output_config.effort is dropped.
 */
function disableThinking(doc: Doc, modelInfo: ModelInfo | undefined): Doc {
  const disableType = modelInfo?.thinking?.disableType || "disabled";
  doc.set("thinking", { type: disableType });
  doc.del("output_config.effort");
  doc.deleteIfEmptyObject("output_config");
  return doc;
}

function setEnabledBudget(doc: Doc, budget: number): void {
  doc.set("thinking.type", "enabled");
  doc.set("thinking.budget_tokens", budget);
  doc.del("output_config.effort");
  doc.deleteIfEmptyObject("output_config");
}

function setAdaptive(doc: Doc, effort: string | undefined): void {
  doc.set("thinking.type", "adaptive");
  doc.del("thinking.budget_tokens");
  if (effort !== undefined) {
    doc.set("output_config.effort", effort);
  } else {
    doc.del("output_config.effort");
    doc.deleteIfEmptyObject("output_config");
  }
}

/** Prefer request max_tokens; otherwise the model default (and report that it came from the model). */
function effectiveMaxTokens(doc: Doc, modelInfo: ModelInfo | undefined): { max: number; fromModel: boolean } {
  const maxTok = doc.get("max_tokens");
  if (maxTok !== undefined && gjsonInt(maxTok) > 0) return { max: gjsonInt(maxTok), fromModel: false };
  if (modelInfo?.maxCompletionTokens && modelInfo.maxCompletionTokens > 0) return { max: modelInfo.maxCompletionTokens, fromModel: true };
  return { max: 0, fromModel: false };
}

/** Ensures max_tokens > thinking.budget_tokens (Anthropic API constraint). */
function normalizeClaudeBudget(doc: Doc, budgetTokens: number, modelInfo: ModelInfo | undefined): void {
  if (budgetTokens <= 0) return;
  const { max, fromModel } = effectiveMaxTokens(doc, modelInfo);
  if (fromModel && max > 0) doc.set("max_tokens", max);
  let adjustedBudget = budgetTokens;
  if (max > 0 && adjustedBudget >= max) adjustedBudget = max - 1;
  const minBudget = modelInfo?.thinking?.min ?? 0;
  // If enforcing the constraint would push the budget below the model minimum, leave it.
  if (minBudget > 0 && adjustedBudget > 0 && adjustedBudget < minBudget) return;
  if (adjustedBudget !== budgetTokens) doc.set("thinking.budget_tokens", adjustedBudget);
}

/** User-defined Claude-compatible models: apply without ThinkingSupport validation. */
function applyCompatibleClaude(body: string, config: ThinkingConfig): string {
  const doc = objectDoc(body);
  switch (config.mode) {
    case ModeNone:
      return disableThinking(doc, undefined).toString();
    case ModeAuto:
      doc.set("thinking.type", "enabled");
      doc.del("thinking.budget_tokens");
      doc.del("output_config.effort");
      doc.deleteIfEmptyObject("output_config");
      return doc.toString();
    case ModeLevel:
      // Interpret ModeLevel as adaptive effort; the upstream validates model support.
      if (config.level === "") return body;
      setAdaptive(doc, config.level);
      return doc.toString();
    case ModeBudget:
      if (config.budget === 0) return disableThinking(doc, undefined).toString();
      setEnabledBudget(doc, config.budget);
      return doc.toString();
    default:
      return body;
  }
}

/**
 * Claude thinking applier. Expects a config pre-validated by validateConfig (mode conversion,
 * clamping, zero-allowed handling). Produces:
 *   enabled:  {"thinking":{"type":"enabled","budget_tokens":N}}
 *   adaptive: {"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}
 *   disabled: {"thinking":{"type":"disabled"}} (or the model's disableType)
 */
export class ClaudeApplier implements ProviderApplier {
  apply(body: string, config: ThinkingConfig, modelInfo: ModelInfo | undefined): string {
    if (isUserDefinedModel(modelInfo)) return applyCompatibleClaude(body, config);
    const support = modelInfo?.thinking;
    if (!support) return body;
    const doc = objectDoc(body);
    const supportsAdaptive = (support.levels?.length ?? 0) > 0;

    if (config.mode === ModeNone) return disableThinking(doc, modelInfo).toString();

    if (config.mode === ModeLevel) {
      // Adaptive effort is only valid when the model advertises discrete levels.
      if (supportsAdaptive && config.level !== "") {
        setAdaptive(doc, config.level);
        return doc.toString();
      }
      // Fallback for non-adaptive Claude models: convert level to budget_tokens.
      const { budget, ok } = convertLevelToBudget(config.level);
      if (!ok) return body;
      config = { mode: ModeBudget, budget, level: "" };
    }

    if (config.mode === ModeBudget) {
      if (config.budget === 0) return disableThinking(doc, modelInfo).toString();
      setEnabledBudget(doc, config.budget);
      normalizeClaudeBudget(doc, config.budget, modelInfo);
      return doc.toString();
    }

    if (config.mode === ModeAuto) {
      if (supportsAdaptive) {
        // Explicit effort is optional for adaptive thinking; omit it to allow the upstream default.
        setAdaptive(doc, undefined);
        return doc.toString();
      }
      // Legacy fallback: enable thinking without specifying budget_tokens.
      doc.set("thinking.type", "enabled");
      doc.del("thinking.budget_tokens");
      doc.del("output_config.effort");
      doc.deleteIfEmptyObject("output_config");
      return doc.toString();
    }

    return body;
  }
}

registerProvider("claude", new ClaudeApplier());

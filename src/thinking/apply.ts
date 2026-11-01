// Port of internal/thinking/apply.go: the unified thinking entry point.
//
// Processing order: route check -> model capability lookup -> config extraction (model suffix
// takes priority over the request body) -> validation -> provider-specific application ->
// summary visibility restore. Validation failures throw a ThinkingError (HTTP 400).
//
// Dropped from upstream: antigravity/kimi/xai/interactions appliers and extractors, and the
// plugin-provider registry. "openai-response" is an alias of the "codex" target.
import type { ModelInfo } from "../registry/types.ts";
import { lookupModelInfo } from "../registry/model_registry.ts";
import { log } from "../log.ts";
import { getProviderApplier } from "./appliers.ts";
import { convertLevelToBudget, isUserDefinedModel } from "./convert.ts";
import { reasoningEffortFromConfig } from "./effort.ts";
import { extractConfigurationUpdateConfig, isResponsesFormat, stripConfigurationUpdates, stripResponsesEffort } from "./configuration_update.ts";
import { Doc, gjsonInt, gjsonString, validJSON } from "./json.ts";
import { stripThinkingConfig } from "./strip.ts";
import { hasThinkingConfig, parseSuffix, parseSuffixToConfig } from "./suffix.ts";
import {
  SummaryDisabled,
  SummaryEnabled,
  SummaryUnspecified,
  type SummaryConfig,
  applySummaryConfigForProvider,
  extractSummaryConfig,
  stripInferredClaudeSummaryActivation,
} from "./summary.ts";
import {
  LevelHigh,
  LevelMax,
  LevelXHigh,
  ModeBudget,
  ModeLevel,
  ModeNone,
  type SuffixResult,
  type ThinkingConfig,
  type ThinkingLevel,
  autoConfig,
  budgetConfig,
  emptyThinkingConfig,
  levelConfig,
  noneConfig,
} from "./types.ts";
import { isBudgetCapableProvider, isLevelSupported, isSameProviderFamily, validateConfig } from "./validate.ts";

// Register the native provider appliers.
import "./provider/claude.ts";
import "./provider/gemini.ts";
import "./provider/openai.ts";
import "./provider/codex.ts";

/**
 * Applies thinking configuration to a request body (Go: ApplyThinking).
 *
 * @param body        target request body JSON (already translated to toFormat)
 * @param model       model name, optionally with a thinking suffix ("claude-sonnet-4-5(16384)")
 * @param fromFormat  source request format (openai, codex, gemini, claude, openai-response)
 * @param toFormat    target provider format of the body (gemini, claude, openai, codex)
 * @param providerKey provider identifier for registry lookups (may differ from toFormat)
 * @returns the modified body; unknown providers and models without thinking pass through.
 * @throws ThinkingError when validation fails.
 */
export function applyThinking(body: string, model: string, fromFormat: string, toFormat: string, providerKey: string): string {
  const summaryConfig = extractSummaryConfig(body, toFormat);
  return applyThinkingInternal(body, "", model, fromFormat, toFormat, providerKey, undefined, false, summaryConfig, false);
}

/**
 * Applies canonical thinking effort while preserving summary visibility extracted from the
 * original source request (Go: ApplyThinkingWithSummary).
 */
export function applyThinkingWithSummary(body: string, model: string, fromFormat: string, toFormat: string, providerKey: string, summaryConfig: SummaryConfig): string {
  return applyThinkingInternal(body, "", model, fromFormat, toFormat, providerKey, undefined, false, summaryConfig, false);
}

/**
 * Applies thinking using the original source request when translation has already changed the
 * target protocol (Go: ApplyThinkingWithSourceAndSummary).
 */
export function applyThinkingWithSourceAndSummary(
  body: string,
  sourceBody: string,
  model: string,
  fromFormat: string,
  toFormat: string,
  providerKey: string,
  summaryConfig: SummaryConfig,
  normalizedUpdatesChanged = false,
): string {
  return applyThinkingInternal(body, sourceBody, model, fromFormat, toFormat, providerKey, undefined, false, summaryConfig, normalizedUpdatesChanged);
}

/**
 * Applies thinking using the global registry first and falling back to fallbackModelInfo when
 * the registry has no entry for the model (Go: ApplyThinkingWithFallbackModelInfoAndSummary).
 */
export function applyThinkingWithFallbackModelInfoAndSummary(
  body: string,
  sourceBody: string,
  model: string,
  fromFormat: string,
  toFormat: string,
  providerKey: string,
  fallbackModelInfo: ModelInfo | undefined,
  summaryConfig: SummaryConfig,
  normalizedUpdatesChanged = false,
): string {
  return applyThinkingInternal(body, sourceBody, model, fromFormat, toFormat, providerKey, fallbackModelInfo, false, summaryConfig, normalizedUpdatesChanged);
}

/**
 * Applies thinking with the exact model definition selected for an API-key execution attempt,
 * preserving summary visibility from the original source body (Go: ApplyThinkingWithModelInfo).
 */
export function applyThinkingWithModelInfo(
  body: string,
  sourceBody: string,
  model: string,
  fromFormat: string,
  toFormat: string,
  providerKey: string,
  modelInfo: ModelInfo | undefined,
): string {
  let summaryConfig = extractSummaryConfig(sourceBody, fromFormat);
  if (sourceBody.length === 0) summaryConfig = extractSummaryConfig(body, toFormat);
  return applyThinkingWithModelInfoAndSummary(body, sourceBody, model, fromFormat, toFormat, providerKey, modelInfo, summaryConfig);
}

/**
 * Applies the exact model definition with a summary intent already resolved across source
 * translation and normalisation (Go: ApplyThinkingWithModelInfoAndSummary).
 */
export function applyThinkingWithModelInfoAndSummary(
  body: string,
  sourceBody: string,
  model: string,
  fromFormat: string,
  toFormat: string,
  providerKey: string,
  modelInfo: ModelInfo | undefined,
  summaryConfig: SummaryConfig,
  normalizedUpdatesChanged = false,
): string {
  return applyThinkingInternal(body, sourceBody, model, fromFormat, toFormat, providerKey, modelInfo, true, summaryConfig, normalizedUpdatesChanged);
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function applyThinkingInternal(
  body: string,
  sourceBody: string,
  model: string,
  fromFormatIn: string,
  toFormat: string,
  providerKeyIn: string,
  resolvedModelInfo: ModelInfo | undefined,
  modelInfoResolved: boolean,
  summaryConfig: SummaryConfig,
  updatesChanged: boolean,
): string {
  let providerFormat = normalize(toFormat);
  if (providerFormat === "openai-response") providerFormat = "codex";
  let providerKey = normalize(providerKeyIn);
  if (providerKey === "") providerKey = providerFormat;
  let fromFormat = normalize(fromFormatIn);
  if (fromFormat === "") fromFormat = providerFormat;

  // 1. Parse suffix and resolve modelInfo (provider-specific lookup handles capability
  //    differences across providers).
  const suffixResult = parseSuffix(model);
  const baseModel = suffixResult.modelName;
  let modelInfo = resolvedModelInfo;
  if (!modelInfoResolved) {
    const lookedUp = lookupModelInfo(baseModel, providerKey);
    if (lookedUp) modelInfo = lookedUp;
  }

  // Resolve source intent before stripping unsupported target input items.
  let sourceConfig = emptyThinkingConfig();
  if (isResponsesFormat(fromFormat)) {
    let sourceRequest = body;
    if (!updatesChanged && sourceBody.length > 0) sourceRequest = sourceBody;
    if (!updatesChanged || providerFormat === "codex") sourceConfig = extractCodexUsageConfig(sourceRequest);
  }
  const responseTarget = providerFormat === "codex";
  const supportsUpdates = modelInfo?.supportConfigurationUpdate === true;
  if (responseTarget && !supportsUpdates) body = stripConfigurationUpdates(body);
  const nativeResponses = responseTarget && isResponsesFormat(fromFormat) && supportsUpdates;

  // 2. Route check: get the provider applier after target cleanup.
  const applier = getProviderApplier(providerFormat);
  if (!applier) {
    log.debug("thinking: unknown provider, passthrough |", { provider: providerFormat, model });
    return body;
  }

  // 3. Model capability check. Unknown models are treated as user-defined so the config is
  //    still applied and the upstream validates it.
  if (!suffixResult.hasSuffix && sourceBody.length > 0 && isResponsesFormat(fromFormat) && !validJSON(body) && hasThinkingConfig(extractConfigurationUpdateConfig(sourceBody))) {
    // Do not rebuild a malformed target from a separate source update.
    return body;
  }
  if (nativeResponses && !suffixResult.hasSuffix) {
    // Native Responses keeps the top-level baseline and in-turn updates as-is. Log the effective
    // effort without validating or rewriting the payload.
    if (modelInfo && (modelInfo.thinking || modelInfo.userDefined)) {
      const config = extractCodexUsageConfig(body);
      if (hasThinkingConfig(config)) {
        const fields: Record<string, unknown> = { provider: providerFormat, model: modelInfo.id, mode: config.mode, budget: config.budget, level: config.level };
        const baseline = extractCodexConfig(body);
        if (baseline.mode === ModeLevel) fields.baseline_level = baseline.level;
        log.debug("thinking: original config from request |", fields);
        log.debug("thinking: processed config to apply |", fields);
      }
    }
    return body;
  }
  if (fromFormat === "claude" && providerFormat === "claude" && !suffixResult.hasSuffix && !new Doc(body).exists("thinking")) {
    // Native Claude effort is independent of thinking activation. Preserve the model's thinking
    // default unless a suffix or explicit summary changes it.
    return applySummaryConfigForProvider(body, providerFormat, baseModel, providerKey, modelInfo, summaryConfig);
  }
  if (isUserDefinedModel(modelInfo)) {
    return applyUserDefinedModel(body, modelInfo, fromFormat, providerFormat, providerKey, suffixResult, sourceConfig, nativeResponses, summaryConfig);
  }
  const known = modelInfo as ModelInfo;
  if (!known.thinking) {
    const config = extractThinkingConfig(body, providerFormat);
    if (hasThinkingConfig(config) || summaryConfig.mode !== SummaryUnspecified) {
      log.debug("thinking: model does not support thinking, stripping config |", { model: baseModel, provider: providerFormat });
      return responseTarget ? stripResponsesEffort(body) : stripThinkingConfig(body, providerFormat);
    }
    log.debug("thinking: model does not support thinking, passthrough |", { provider: providerFormat, model: baseModel });
    return body;
  }

  // 4. Get config: suffix priority over body.
  let config: ThinkingConfig;
  if (suffixResult.hasSuffix) {
    config = parseSuffixToConfig(suffixResult.rawSuffix, providerFormat, model);
    if (!hasThinkingConfig(config) && !nativeResponses && suffixResult.rawSuffix.trim() !== "" && known.id.trim().toLowerCase() !== model.trim().toLowerCase()) {
      config = levelConfig(suffixResult.rawSuffix.trim());
    }
    log.debug("thinking: config from model suffix |", { provider: providerFormat, model, mode: config.mode, budget: config.budget, level: config.level });
  } else {
    config = sourceConfig;
    if (!hasThinkingConfig(config) && !updatesChanged && modelInfoResolved && sourceBody.length > 0) config = extractSourceThinkingConfig(sourceBody, fromFormat);
    if (!hasThinkingConfig(config)) config = extractThinkingConfig(body, providerFormat);
    if (!hasThinkingConfig(config) && fromFormat !== providerFormat) config = extractThinkingConfig(body, fromFormat);
    if (hasThinkingConfig(config)) {
      log.debug("thinking: original config from request |", { provider: providerFormat, model: known.id, mode: config.mode, budget: config.budget, level: config.level });
    }
  }

  if (!hasThinkingConfig(config)) {
    log.debug("thinking: no config found, passthrough |", { provider: providerFormat, model: known.id });
    if (nativeResponses) return body;
    if (modelInfoResolved && providerFormat === "claude" && fromFormat !== providerFormat && extractSummaryConfig(sourceBody, fromFormat).mode === SummaryEnabled) {
      // Registry translation only sees aggregate capabilities; for a cross-protocol summary-only
      // request it may have activated adaptive thinking solely to make display valid. The
      // selected API-key model is authoritative, so discard that inferred activation when the
      // exact model supports only manual extended thinking.
      body = stripInferredClaudeSummaryActivation(body, known);
    }
    return applySummaryConfigForProvider(body, providerFormat, baseModel, providerKey, known, summaryConfig);
  }
  if (modelInfoResolved && config.mode === ModeLevel && known.thinking && shouldMapConfiguredHighIntent(fromFormat, providerFormat, known)) {
    config = { ...config, level: mapConfiguredHighIntent(config.level, known) };
  }

  // 5. Validate and normalise (throws ThinkingError).
  let validated: ThinkingConfig;
  try {
    validated = validateConfig(config, known, fromFormat, providerFormat, suffixResult.hasSuffix);
  } catch (err) {
    log.warn("thinking: validation failed |", { provider: providerFormat, model: known.id, error: (err as Error).message });
    throw err;
  }
  log.debug("thinking: processed config to apply |", { provider: providerFormat, model: known.id, mode: validated.mode, budget: validated.budget, level: validated.level });

  // 6. Apply with the provider applier, then restore the target summary intent.
  let applied = applier.apply(body, validated, known);
  // A fully disabled amount takes precedence over visibility: re-applying a summary-only field
  // could recreate an otherwise removed provider config and make a default-on model think again.
  if (thinkingIsFullyDisabled(validated) || nativeResponses) return applied;
  let summary = summaryConfig;
  if (providerFormat === "claude" && thinkingRequestedOff(config)) {
    // The model cannot turn thinking off, so validateConfig fell back to its lowest level. Drop
    // any stale block_binding from the off request and keep the caller's intent of seeing no
    // thinking: without an explicit omitted display, cloaking would add progress updates.
    const doc = new Doc(applied);
    doc.del("thinking.block_binding");
    applied = doc.toString();
    summary = { mode: SummaryDisabled };
  }
  return applySummaryConfigForProvider(applied, providerFormat, baseModel, providerKey, known, summary);
}

function thinkingIsFullyDisabled(config: ThinkingConfig): boolean {
  return config.mode === ModeNone && config.budget === 0 && config.level === "";
}

function thinkingRequestedOff(config: ThinkingConfig): boolean {
  return config.mode === ModeNone || (config.mode === ModeBudget && config.budget === 0);
}

function shouldMapConfiguredHighIntent(fromFormat: string, toFormat: string, modelInfo: ModelInfo | undefined): boolean {
  fromFormat = normalize(fromFormat);
  toFormat = normalize(toFormat);
  if (fromFormat !== toFormat) return true;
  if (!modelInfo) return false;
  const modelType = normalize(modelInfo.type);
  return modelType !== "" && !isSameProviderFamily(toFormat, modelType);
}

function mapConfiguredHighIntent(level: ThinkingLevel, modelInfo: ModelInfo): ThinkingLevel {
  const levels = modelInfo.thinking?.levels ?? [];
  if (levels.length === 0) return level;
  level = normalize(level);
  let candidates: ThinkingLevel[];
  if (level === LevelXHigh) candidates = [LevelXHigh, LevelMax, LevelHigh];
  else if (level === LevelMax) candidates = [LevelMax, LevelXHigh, LevelHigh];
  else return level;
  for (const candidate of candidates) {
    if (isLevelSupported(candidate, levels)) return candidate;
  }
  return level;
}

function extractSourceThinkingConfig(body: string, provider: string): ThinkingConfig {
  provider = normalize(provider);
  if (provider === "openai-response") return extractCodexConfig(body);
  return extractThinkingConfig(body, provider);
}

/** Applies thinking for user-defined (or unknown) models without ThinkingSupport validation. */
function applyUserDefinedModel(
  body: string,
  modelInfo: ModelInfo | undefined,
  fromFormat: string,
  toFormat: string,
  providerKey: string,
  suffixResult: SuffixResult,
  sourceConfig: ThinkingConfig,
  nativeResponses: boolean,
  summaryConfig: SummaryConfig,
): string {
  const modelID = modelInfo ? modelInfo.id : suffixResult.modelName;

  let config: ThinkingConfig;
  if (suffixResult.hasSuffix) {
    config = parseSuffixToConfig(suffixResult.rawSuffix, toFormat, modelID);
    log.debug("thinking: config from model suffix |", { provider: toFormat, model: modelID, mode: config.mode, budget: config.budget, level: config.level });
  } else {
    config = sourceConfig;
    if (!hasThinkingConfig(config)) config = extractThinkingConfig(body, fromFormat);
    if (!hasThinkingConfig(config) && fromFormat !== toFormat) config = extractThinkingConfig(body, toFormat);
    if (hasThinkingConfig(config)) {
      log.debug("thinking: original config from request |", { provider: toFormat, model: modelID, mode: config.mode, budget: config.budget, level: config.level });
    }
  }

  if (!hasThinkingConfig(config)) {
    log.debug("thinking: user-defined model, passthrough (no config) |", { model: modelID, provider: toFormat });
    return applySummaryConfigForProvider(body, toFormat, modelID, providerKey, modelInfo, summaryConfig);
  }

  const applier = getProviderApplier(toFormat);
  if (!applier) {
    log.debug("thinking: user-defined model, passthrough (unknown provider) |", { model: modelID, provider: toFormat });
    return body;
  }

  config = normalizeUserDefinedConfig(config, fromFormat, toFormat);
  log.debug("thinking: processed config to apply |", { provider: toFormat, model: modelID, mode: config.mode, budget: config.budget, level: config.level });
  const applied = applier.apply(body, config, modelInfo);
  if (thinkingIsFullyDisabled(config) || nativeResponses) return applied;
  return applySummaryConfigForProvider(applied, toFormat, modelID, providerKey, modelInfo, summaryConfig);
}

function normalizeUserDefinedConfig(config: ThinkingConfig, _fromFormat: string, toFormat: string): ThinkingConfig {
  if (config.mode !== ModeLevel) return config;
  if (toFormat === "claude") return config;
  if (!isBudgetCapableProvider(toFormat)) return config;
  const { budget, ok } = convertLevelToBudget(config.level);
  if (!ok) return config;
  return budgetConfig(budget);
}

// ---------------------------------------------------------------------------
// Provider-specific config extraction
// ---------------------------------------------------------------------------

/** Extracts provider-specific thinking config from a request body (Go: extractThinkingConfig). */
export function extractThinkingConfig(body: string, provider: string): ThinkingConfig {
  if (!validJSON(body)) return emptyThinkingConfig();
  switch (provider) {
    case "claude":
      return extractClaudeConfig(body);
    case "gemini":
      return extractGeminiConfig(body);
    case "openai":
      return extractOpenAIConfig(body);
    case "codex":
      return extractCodexConfig(body);
    default:
      return emptyThinkingConfig();
  }
}

function effortToConfig(value: string): ThinkingConfig {
  switch (value) {
    case "none":
      return noneConfig();
    case "auto":
      return autoConfig();
    default:
      return levelConfig(value);
  }
}

function budgetToConfig(value: number): ThinkingConfig {
  switch (value) {
    case 0:
      return noneConfig();
    case -1:
      return autoConfig();
    default:
      return budgetConfig(value);
  }
}

/**
 * Claude format: thinking.type (enabled/adaptive/auto/disabled), thinking.budget_tokens
 * (-1 auto, 0 disabled, >0 budget) and output_config.effort (none/auto/low/medium/high/max).
 * Priority: type="disabled" wins; with type="enabled", budget_tokens wins over effort; with
 * type="enabled" and no budget, effort is used when present, otherwise ModeAuto.
 */
export function extractClaudeConfig(body: string): ThinkingConfig {
  const doc = new Doc(body);
  const thinkingType = gjsonString(doc.get("thinking.type"));
  if (thinkingType === "disabled") return noneConfig();
  const standaloneEffort = (): ThinkingConfig | undefined => {
    const effort = doc.get("output_config.effort");
    if (typeof effort !== "string") return undefined;
    const value = effort.trim().toLowerCase();
    if (value === "") return emptyThinkingConfig();
    return effortToConfig(value);
  };
  if (!doc.exists("thinking") || thinkingType === "adaptive" || thinkingType === "auto") {
    // output_config.effort also applies when thinking is omitted; only an explicit effort counts.
    return standaloneEffort() ?? emptyThinkingConfig();
  }
  const budget = doc.get("thinking.budget_tokens");
  if (budget !== undefined) return budgetToConfig(gjsonInt(budget));
  if (thinkingType === "enabled") {
    const fromEffort = standaloneEffort();
    if (fromEffort && hasThinkingConfig(fromEffort)) return fromEffort;
    return autoConfig();
  }
  return emptyThinkingConfig();
}

/**
 * Gemini format: generationConfig.thinkingConfig.thinkingLevel (Gemini 3) checked first, then
 * thinkingBudget (Gemini 2.5). snake_case spellings from the official SDK are accepted.
 */
export function extractGeminiConfig(body: string): ThinkingConfig {
  const doc = new Doc(body);
  const prefix = "generationConfig.thinkingConfig";
  let level = doc.get(`${prefix}.thinkingLevel`);
  if (level === undefined) level = doc.get(`${prefix}.thinking_level`);
  if (level !== undefined) return effortToConfig(gjsonString(level));
  let budget = doc.get(`${prefix}.thinkingBudget`);
  if (budget === undefined) budget = doc.get(`${prefix}.thinking_budget`);
  if (budget !== undefined) return budgetToConfig(gjsonInt(budget));
  return emptyThinkingConfig();
}

/** OpenAI Chat format: reasoning_effort (levels only; "none" -> ModeNone). */
export function extractOpenAIConfig(body: string): ThinkingConfig {
  const doc = new Doc(body);
  const effort = doc.get("reasoning_effort");
  if (effort === undefined) return emptyThinkingConfig();
  const value = gjsonString(effort);
  return value === "none" ? noneConfig() : levelConfig(value);
}

/** Codex / OpenAI Responses format: reasoning.effort. */
export function extractCodexConfig(body: string): ThinkingConfig {
  const doc = new Doc(body);
  const effort = doc.get("reasoning.effort");
  if (effort === undefined) return emptyThinkingConfig();
  const value = gjsonString(effort);
  return value === "none" ? noneConfig() : levelConfig(value);
}

/** The last effective Responses update, falling back to the top-level effort (Go: extractCodexUsageConfig). */
export function extractCodexUsageConfig(body: string): ThinkingConfig {
  if (!validJSON(body)) return emptyThinkingConfig();
  const config = extractConfigurationUpdateConfig(body);
  if (hasThinkingConfig(config)) return config;
  return extractCodexConfig(body);
}

// ---------------------------------------------------------------------------
// Usage reporting helpers
// ---------------------------------------------------------------------------

/**
 * The source request's thinking setting as a canonical reasoning_effort label for usage logging
 * (Go: ExtractReasoningEffort). Responses updates take precedence over a suffix; otherwise a
 * valid suffix overrides the top-level setting.
 */
export function extractReasoningEffort(body: string, provider: string, model: string): string {
  provider = normalize(provider);
  if (isResponsesFormat(provider)) {
    const effort = reasoningEffortFromConfig(extractConfigurationUpdateConfig(body));
    if (effort !== "") return effort;
  }
  const fromSuffix = reasoningEffortFromSuffix(parseSuffix(model));
  if (fromSuffix !== "") return fromSuffix;
  let config = extractThinkingConfigForUsage(body, provider);
  if (!hasThinkingConfig(config) && (provider === "openai-response" || provider === "openai")) config = extractCodexUsageConfig(body);
  return reasoningEffortFromConfig(config);
}

/** The final provider payload's thinking setting as a reasoning_effort label (Go: ExtractTranslatedReasoningEffort). */
export function extractTranslatedReasoningEffort(body: string, provider: string): string {
  provider = normalize(provider);
  let config = extractThinkingConfigForUsage(body, provider);
  if (!hasThinkingConfig(config) && (provider === "openai" || provider === "openai-response")) {
    config = extractCodexUsageConfig(body);
    if (!hasThinkingConfig(config)) config = extractOpenAIConfig(body);
  }
  return reasoningEffortFromConfig(config);
}

function extractThinkingConfigForUsage(body: string, provider: string): ThinkingConfig {
  switch (normalize(provider)) {
    case "codex":
    case "openai-response":
      return extractCodexUsageConfig(body);
    case "claude":
      // between_tools is how claude-sonnet-5-5 turns thinking off.
      if (gjsonString(new Doc(body).get("thinking.type")) === "between_tools") return noneConfig();
      return extractThinkingConfig(body, provider);
    default:
      return extractThinkingConfig(body, provider);
  }
}

function reasoningEffortFromSuffix(suffix: SuffixResult): string {
  if (!suffix.hasSuffix) return "";
  return reasoningEffortFromConfig(parseSuffixToConfig(suffix.rawSuffix, "", suffix.modelName));
}

export { reasoningEffortFromConfig };

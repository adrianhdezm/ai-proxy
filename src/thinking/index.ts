// Thinking pipeline: port of internal/thinking (claude, gemini, openai, codex only).
//
// Executors call applyThinking* on the translated upstream body; the registry's ModelInfo
// (ThinkingSupport) drives validation. Importing this module registers the provider appliers.
export * from "./types.ts";
export * from "./errors.ts";
export { getThinkingText } from "./text.ts";
export { stripThinkingConfig } from "./strip.ts";
export { parseSuffix, hasThinkingSuffix, hasThinkingConfig, parseNumericSuffix, parseSpecialSuffix, parseLevelSuffix, parseSuffixToConfig } from "./suffix.ts";
export * from "./convert.ts";
export { validateConfig, convertAutoToMidRange, clampLevel, clampBudget, lowestSupportedLevel, isLevelSupported, isSameProviderFamily, isBudgetCapableProvider } from "./validate.ts";
export * from "./summary.ts";
export { isResponsesFormat, extractConfigurationUpdateConfig, collapseConfigurationUpdates, stripConfigurationUpdates, stripResponsesEffort } from "./configuration_update.ts";
export { reasoningEffortFromConfig } from "./effort.ts";
export { registerProvider, getProviderApplier } from "./appliers.ts";
export {
  applyThinking,
  applyThinkingWithSummary,
  applyThinkingWithSourceAndSummary,
  applyThinkingWithFallbackModelInfoAndSummary,
  applyThinkingWithModelInfo,
  applyThinkingWithModelInfoAndSummary,
  extractThinkingConfig,
  extractClaudeConfig,
  extractGeminiConfig,
  extractOpenAIConfig,
  extractCodexConfig,
  extractCodexUsageConfig,
  extractReasoningEffort,
  extractTranslatedReasoningEffort,
} from "./apply.ts";
export { ClaudeApplier } from "./provider/claude.ts";
export { GeminiApplier } from "./provider/gemini.ts";
export { OpenAIApplier } from "./provider/openai.ts";
export { CodexApplier } from "./provider/codex.ts";

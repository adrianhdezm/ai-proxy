// Model registry: static model definitions (models.json), the global per-credential registry
// and alias/exclusion helpers. Port of internal/registry (kept providers only).
export type { ModelInfo, ThinkingSupport, ModelConfig } from "./types.ts";
export {
  type StaticModelsCatalog,
  modelInfoFromJSON,
  modelInfoToJSON,
  cloneModelInfo,
  cloneModelInfos,
  validateModelSection,
  validateModelsCatalog,
  parseModelsCatalog,
  getModels,
  setModelsCatalog,
  getClaudeModels,
  getGeminiModels,
  getGeminiCLIModels,
  getAIStudioModels,
  getCodexFreeModels,
  getCodexTeamModels,
  getCodexPlusModels,
  getCodexProModels,
  getCodexModelsForPlan,
  withCodexBuiltins,
  getStaticModelDefinitionsByChannel,
  lookupStaticModelInfoByChannel,
  lookupStaticModelInfo,
  claudeFamilyModelIds,
} from "./model_definitions.ts";
export {
  type ModelRegistration,
  type ClientModelProjection,
  type ModelRegistryOptions,
  ModelRegistry,
  DefaultClaudeMaxInputTokens,
  DefaultClaudeMaxOutputTokens,
  modelQuotaExceededWindowMs,
  convertModelToMap,
  getGlobalRegistry,
  lookupModelInfo,
  modelOverrideHeaders,
} from "./model_registry.ts";
export { type ModelAlias, applyModelAliases, applyExcludedModels, matchWildcard, rewriteModelInfoName } from "./aliases.ts";
export { resolveModelInfo, normalizeThinkingSupport } from "./model_config.ts";

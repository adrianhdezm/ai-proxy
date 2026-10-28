// Port of internal/registry/model_definitions.go plus the embedded models.json loader from
// internal/registry/model_updater.go (loadModelsFromBytes / validateModelsCatalog).
//
// Only the Claude, Gemini (Gemini CLI OAuth and AI Studio) and Codex sections of upstream's
// models.json are kept; they are copied verbatim into ./models.json. Remote catalog refresh,
// Vertex, Kimi, Antigravity, xAI, Devin and Meta sections are dropped.
import modelsJSON from "./models.json" with { type: "json" };
import type { ModelConfig, ModelInfo, ThinkingSupport } from "./types.ts";
import { asArray, asNumber, asString, isObject, type JSONObject } from "../util/json.ts";

const codexBuiltinImage15ModelID = "gpt-image-1.5";
const codexBuiltinImageModelID = "gpt-image-2";
const codexBuiltinImage25FlareModelID = "gpt-image-2.5-flare";
const codexBuiltinImage25SunburstModelID = "gpt-image-2.5-sunburst";
const codexBuiltinImage25ModelID = "gpt-image-2.5";

/** Mirrors the kept top-level sections of models.json (Go: staticModelsJSON). */
export interface StaticModelsCatalog {
  claude: ModelInfo[];
  gemini: ModelInfo[];
  geminiCli: ModelInfo[];
  aistudio: ModelInfo[];
  codexFree: ModelInfo[];
  codexTeam: ModelInfo[];
  codexPlus: ModelInfo[];
  codexPro: ModelInfo[];
}

const catalogSections: ReadonlyArray<[keyof StaticModelsCatalog, string]> = [
  ["claude", "claude"],
  ["gemini", "gemini"],
  ["geminiCli", "gemini-cli"],
  ["aistudio", "aistudio"],
  ["codexFree", "codex-free"],
  ["codexTeam", "codex-team"],
  ["codexPlus", "codex-plus"],
  ["codexPro", "codex-pro"],
];

// ---------------------------------------------------------------------------
// JSON <-> ModelInfo (Go used struct tags; the TS ModelInfo is camelCase)
// ---------------------------------------------------------------------------

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === "string");
}

function thinkingSupportFromJSON(raw: unknown): ThinkingSupport | undefined {
  if (!isObject(raw)) return undefined;
  const out: ThinkingSupport = {};
  if (typeof raw.min === "number") out.min = raw.min;
  if (typeof raw.max === "number") out.max = raw.max;
  if (typeof raw.zero_allowed === "boolean") out.zeroAllowed = raw.zero_allowed;
  if (typeof raw.dynamic_allowed === "boolean") out.dynamicAllowed = raw.dynamic_allowed;
  if (typeof raw.disable_type === "string" && raw.disable_type !== "") out.disableType = raw.disable_type;
  const levels = stringList(raw.levels);
  if (levels && levels.length > 0) out.levels = levels;
  return out;
}

function modelConfigFromJSON(raw: unknown): ModelConfig | undefined {
  if (!isObject(raw)) return undefined;
  const out: ModelConfig = {};
  if (isObject(raw.override_header)) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.override_header)) {
      if (typeof value === "string") headers[key] = value;
    }
    out.overrideHeader = headers;
  }
  return out;
}

/**
 * Builds a ModelInfo from one models.json entry (Go: ModelInfo.UnmarshalJSON).
 * Unknown keys are ignored; `support_configuration_update` is kept as internal metadata.
 */
export function modelInfoFromJSON(raw: unknown): ModelInfo {
  const obj: JSONObject = isObject(raw) ? raw : {};
  const info: ModelInfo = { id: asString(obj.id), type: asString(obj.type) };
  const setStr = (key: keyof ModelInfo, v: unknown) => {
    if (typeof v === "string" && v !== "") (info as unknown as Record<string, unknown>)[key] = v;
  };
  const setNum = (key: keyof ModelInfo, v: unknown) => {
    if (typeof v === "number" && v !== 0) (info as unknown as Record<string, unknown>)[key] = v;
  };
  const setList = (key: keyof ModelInfo, v: unknown) => {
    const list = stringList(v);
    if (list && list.length > 0) (info as unknown as Record<string, unknown>)[key] = list;
  };
  setStr("object", obj.object);
  setNum("created", obj.created);
  setStr("ownedBy", obj.owned_by);
  setStr("displayName", obj.display_name);
  setStr("name", obj.name);
  setStr("version", obj.version);
  setStr("description", obj.description);
  setNum("inputTokenLimit", obj.inputTokenLimit);
  setNum("outputTokenLimit", obj.outputTokenLimit);
  setList("supportedGenerationMethods", obj.supportedGenerationMethods);
  setNum("contextLength", obj.context_length);
  setNum("maxCompletionTokens", obj.max_completion_tokens);
  setList("supportedParameters", obj.supported_parameters);
  setList("supportedInputModalities", obj.supportedInputModalities);
  setList("supportedOutputModalities", obj.supportedOutputModalities);
  const thinking = thinkingSupportFromJSON(obj.thinking);
  if (thinking) info.thinking = thinking;
  const config = modelConfigFromJSON(obj.config);
  if (config) info.config = config;
  if (obj.support_configuration_update === true) info.supportConfigurationUpdate = true;
  return info;
}

/**
 * Serialises a ModelInfo in the models.json wire shape (Go: json.Marshal(ModelInfo)).
 * Internal fields (metadataModelId, supportConfigurationUpdate, userDefined, isCompat) are omitted.
 */
export function modelInfoToJSON(info: ModelInfo): JSONObject {
  const out: JSONObject = { id: info.id, object: info.object ?? "", created: info.created ?? 0, owned_by: info.ownedBy ?? "", type: info.type };
  if (info.displayName) out.display_name = info.displayName;
  if (info.name) out.name = info.name;
  if (info.version) out.version = info.version;
  if (info.description) out.description = info.description;
  if (info.inputTokenLimit) out.inputTokenLimit = info.inputTokenLimit;
  if (info.outputTokenLimit) out.outputTokenLimit = info.outputTokenLimit;
  if (info.supportedGenerationMethods?.length) out.supportedGenerationMethods = [...info.supportedGenerationMethods];
  if (info.contextLength) out.context_length = info.contextLength;
  if (info.maxCompletionTokens) out.max_completion_tokens = info.maxCompletionTokens;
  if (info.supportedParameters?.length) out.supported_parameters = [...info.supportedParameters];
  if (info.supportedInputModalities?.length) out.supportedInputModalities = [...info.supportedInputModalities];
  if (info.supportedOutputModalities?.length) out.supportedOutputModalities = [...info.supportedOutputModalities];
  if (info.thinking) {
    const t: JSONObject = {};
    if (info.thinking.min) t.min = info.thinking.min;
    if (info.thinking.max) t.max = info.thinking.max;
    if (info.thinking.zeroAllowed) t.zero_allowed = true;
    if (info.thinking.dynamicAllowed) t.dynamic_allowed = true;
    if (info.thinking.disableType) t.disable_type = info.thinking.disableType;
    if (info.thinking.levels?.length) t.levels = [...info.thinking.levels];
    out.thinking = t;
  }
  if (info.config?.overrideHeader && Object.keys(info.config.overrideHeader).length > 0) {
    out.config = { override_header: { ...info.config.overrideHeader } };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catalog store (Go: modelsCatalogStore)
// ---------------------------------------------------------------------------

/** Deep-copies a ModelInfo so callers can never mutate registry/catalog state (Go: cloneModelInfo). */
export function cloneModelInfo(model: ModelInfo): ModelInfo;
export function cloneModelInfo(model: ModelInfo | undefined): ModelInfo | undefined;
export function cloneModelInfo(model: ModelInfo | undefined): ModelInfo | undefined {
  if (!model) return undefined;
  return structuredClone(model);
}

/** Clones every entry of a model list (Go: cloneModelInfos). */
export function cloneModelInfos(models: ReadonlyArray<ModelInfo>): ModelInfo[] {
  return models.map((m) => cloneModelInfo(m));
}

/**
 * Validates one catalog section: no null entries, no empty ids, no duplicate ids
 * (Go: validateModelSection). Empty sections are allowed.
 */
export function validateModelSection(section: string, models: ReadonlyArray<ModelInfo | null | undefined>): void {
  const seen = new Set<string>();
  models.forEach((model, i) => {
    if (model === null || model === undefined) throw new Error(`${section}[${i}] is null`);
    const id = model.id.trim();
    if (id === "") throw new Error(`${section}[${i}] has empty id`);
    if (seen.has(id)) throw new Error(`${section} contains duplicate model id "${id}"`);
    seen.add(id);
  });
}

/** Validates every section of a parsed catalog (Go: validateModelsCatalog). */
export function validateModelsCatalog(catalog: StaticModelsCatalog): void {
  for (const [field, name] of catalogSections) {
    validateModelSection(name, catalog[field] as ReadonlyArray<ModelInfo | null | undefined>);
  }
}

/** Parses a models.json document into a validated catalog (Go: loadModelsFromBytes). */
export function parseModelsCatalog(data: unknown, source = "embed"): StaticModelsCatalog {
  if (!isObject(data)) throw new Error(`${source}: decode models catalog: not a JSON object`);
  const catalog = {} as StaticModelsCatalog;
  for (const [field, name] of catalogSections) {
    const raw = data[name];
    const entries = asArray(raw);
    catalog[field] = entries.map((entry) => (entry === null || entry === undefined ? (null as unknown as ModelInfo) : modelInfoFromJSON(entry)));
  }
  try {
    validateModelsCatalog(catalog);
  } catch (err) {
    throw new Error(`${source}: validate models catalog: ${(err as Error).message}`);
  }
  return catalog;
}

let catalog: StaticModelsCatalog = parseModelsCatalog(modelsJSON as unknown, "embed");

/** Returns the active static catalog (Go: getModels). */
export function getModels(): StaticModelsCatalog {
  return catalog;
}

/** Replaces the active static catalog (used by tests; upstream fed remote refreshes through it). */
export function setModelsCatalog(next: StaticModelsCatalog): void {
  catalog = next;
}

// ---------------------------------------------------------------------------
// Public getters (Go: GetClaudeModels, GetGeminiModels, ...)
// ---------------------------------------------------------------------------

export function getClaudeModels(): ModelInfo[] {
  return cloneModelInfos(catalog.claude);
}

export function getGeminiModels(): ModelInfo[] {
  return cloneModelInfos(catalog.gemini);
}

/** Gemini CLI OAuth catalog (models.json "gemini-cli", as in v7.0.12's GetGeminiCLIModels). */
export function getGeminiCLIModels(): ModelInfo[] {
  return cloneModelInfos(catalog.geminiCli);
}

export function getAIStudioModels(): ModelInfo[] {
  return cloneModelInfos(catalog.aistudio);
}

export function getCodexFreeModels(): ModelInfo[] {
  return withCodexBuiltins(cloneModelInfos(catalog.codexFree));
}

export function getCodexTeamModels(): ModelInfo[] {
  return withCodexBuiltins(cloneModelInfos(catalog.codexTeam));
}

export function getCodexPlusModels(): ModelInfo[] {
  return withCodexBuiltins(cloneModelInfos(catalog.codexPlus));
}

export function getCodexProModels(): ModelInfo[] {
  return withCodexBuiltins(cloneModelInfos(catalog.codexPro));
}

/** Codex model list for a ChatGPT plan type (Go: the plan_type switch in service_models.go). */
export function getCodexModelsForPlan(planType: string): ModelInfo[] {
  switch (planType.trim().toLowerCase()) {
    case "pro":
      return getCodexProModels();
    case "plus":
      return getCodexPlusModels();
    case "team":
    case "business":
    case "go":
      return getCodexTeamModels();
    case "free":
      return getCodexFreeModels();
    default:
      return getCodexProModels();
  }
}

/**
 * Injects hard-coded Codex-only model definitions that never depend on catalog updates
 * (Go: WithCodexBuiltins). Built-ins replace any matching IDs already present.
 */
export function withCodexBuiltins(models: ModelInfo[]): ModelInfo[] {
  return upsertModelInfos(models, [
    codexBuiltinImageModel(codexBuiltinImage15ModelID, "GPT Image 1.5"),
    codexBuiltinImageModel(codexBuiltinImageModelID, "GPT Image 2"),
    codexBuiltinImageModel(codexBuiltinImage25FlareModelID, "GPT Image 2.5 Flare"),
    codexBuiltinImageModel(codexBuiltinImage25SunburstModelID, "GPT Image 2.5 Sunburst"),
    codexBuiltinImageModel(codexBuiltinImage25ModelID, "GPT Image 2.5"),
  ]);
}

function codexBuiltinImageModel(id: string, displayName: string): ModelInfo {
  return {
    id,
    object: "model",
    created: 1704067200, // 2024-01-01
    ownedBy: "openai",
    type: "openai",
    displayName,
    version: id,
  };
}

function upsertModelInfos(models: ModelInfo[], extras: ModelInfo[]): ModelInfo[] {
  if (extras.length === 0) return models;
  const extraIDs = new Set<string>();
  const extraList: ModelInfo[] = [];
  for (const extra of extras) {
    const id = extra.id.trim();
    if (id === "") continue;
    const key = id.toLowerCase();
    if (extraIDs.has(key)) continue;
    extraIDs.add(key);
    extraList.push(cloneModelInfo(extra));
  }
  if (extraList.length === 0) return models;
  const filtered: ModelInfo[] = [];
  for (const model of models) {
    if (!model) continue;
    const id = model.id.trim();
    if (id === "") continue;
    if (extraIDs.has(id.toLowerCase())) continue;
    filtered.push(model);
  }
  return filtered.concat(extraList);
}

/**
 * Static model definitions for a provider channel (Go: GetStaticModelDefinitionsByChannel).
 * Returns undefined for unknown channels.
 *
 * Supported channels: claude, gemini, gemini-cli, aistudio, codex.
 */
export function getStaticModelDefinitionsByChannel(channel: string): ModelInfo[] | undefined {
  switch (channel.trim().toLowerCase()) {
    case "claude":
      return getClaudeModels();
    case "gemini":
      return getGeminiModels();
    case "gemini-cli":
      return getGeminiCLIModels();
    case "aistudio":
      return getAIStudioModels();
    case "codex":
      return getCodexProModels();
    default:
      return undefined;
  }
}

/**
 * Searches one provider-specific static section without cross-provider fallback
 * (Go: LookupStaticModelInfoByChannel).
 */
export function lookupStaticModelInfoByChannel(modelId: string, channel: string): ModelInfo | undefined {
  modelId = modelId.trim();
  if (modelId === "") return undefined;
  const models = getStaticModelDefinitionsByChannel(channel);
  if (!models) return undefined;
  for (const model of models) {
    if (model && model.id === modelId) return cloneModelInfo(model);
  }
  if (channel.trim().toLowerCase() === "claude") {
    for (const familyId of claudeFamilyModelIds(modelId)) {
      for (const model of models) {
        if (model && model.id === familyId) return cloneModelInfo(model);
      }
    }
  }
  return undefined;
}

/**
 * Searches all static model definitions for a model ID (Go: LookupStaticModelInfo).
 * Dated and bracketed Claude variants (claude-sonnet-5-5-20261001, claude-opus-5-5[1m])
 * share the capabilities of their catalog entry.
 */
export function lookupStaticModelInfo(modelId: string): ModelInfo | undefined {
  if (modelId === "") return undefined;
  const data = getModels();
  const allModels = [data.claude, data.gemini, data.geminiCli, data.aistudio, data.codexPro];
  for (const models of allModels) {
    for (const m of models) {
      if (m && m.id === modelId) return cloneModelInfo(m);
    }
  }
  for (const familyId of claudeFamilyModelIds(modelId)) {
    for (const m of data.claude) {
      if (m && m.id === familyId) return cloneModelInfo(m);
    }
  }
  return undefined;
}

/**
 * Catalog IDs a Claude model variant may belong to: without a "[...]" context suffix,
 * then also without a "-YYYYMMDD" date (Go: claudeFamilyModelIDs).
 */
export function claudeFamilyModelIds(modelId: string): string[] {
  if (!modelId.startsWith("claude-")) return [];
  const ids: string[] = [];
  let base = modelId;
  const i = base.indexOf("[");
  if (i > 0 && base.endsWith("]")) {
    base = base.slice(0, i);
    ids.push(base);
  }
  const n = base.length;
  if (n > 9 && base[n - 9] === "-" && isEightDigits(base.slice(n - 8))) {
    ids.push(base.slice(0, n - 9));
  }
  return ids;
}

function isEightDigits(s: string): boolean {
  return /^[0-9]{8}$/.test(s);
}

/** Context length helper used by model-list conversion (Go used ints; keep as number). */
export function modelContextLength(model: ModelInfo): number {
  return asNumber(model.contextLength);
}

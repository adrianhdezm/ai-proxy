// Credential-aware execution model resolution. Port of the API-key half of
// sdk/cliproxy/auth/conductor_models.go (rewriteModelForAuth,
// lookupAPIKeyUpstreamModel, compileAPIKeyModelAliasForModels,
// applyAPIKeyModelAlias, resolveAPIKeyConfig, resolveAPIKeyModelAliasWithResult),
// the alias helpers of oauth_model_alias.go (modelAliasLookupCandidates,
// preserveResolvedModelSuffix, resolveModelAliasResultFromConfigModels) and
// the configured-capability lookup of api_key_model_capabilities.go
// (attachResolvedAPIKeyModelInfo).
//
// Dropped from upstream: OAuth model aliases (oauth-model-alias is not a config
// section here), OpenAI-compatibility alias pools, Home dispatch models and the
// force-mapping response rewriter.
import type { ExecRequest } from "../../executor/types.ts";
import type { ApiKeyCredential, Config, ModelOverride } from "../../config/types.ts";
import { resolveModelInfo } from "../../registry/model_config.ts";
import type { ModelInfo } from "../../registry/types.ts";
import { parseSuffix } from "../../thinking/suffix.ts";
import type { SuffixResult } from "../../thinking/types.ts";
import { AttributeAPIKey, AttributeBaseURL, AttributeConfigIndex, type Auth } from "../types.ts";
import { AuthKindAPIKey, AuthSourceConfig, authKind, authSourceKind } from "./classification.ts";

/** ExecRequest.metadata key carrying the configured model definition of the selected API key (Go: resolvedAPIKeyModelInfoMetadataKey). */
export const ResolvedAPIKeyModelInfoMetadataKey = "cliproxy.resolved_api_key_model_info";

/** Strips the credential routing prefix ("team/model" -> "model") (Go: rewriteModelForAuth). */
export function rewriteModelForAuth(model: string, auth: Auth | undefined): string {
  if (!auth || model === "") return model;
  const prefix = (auth.prefix ?? "").trim();
  if (prefix === "") return model;
  const needle = prefix + "/";
  return model.startsWith(needle) ? model.slice(needle.length) : model;
}

/** The requested model and its suffix-free base (Go: modelAliasLookupCandidates). */
export function modelAliasLookupCandidates(requestedModel: string): { result: SuffixResult; candidates: string[] } {
  const requested = (requestedModel ?? "").trim();
  if (requested === "") return { result: { modelName: "", hasSuffix: false, rawSuffix: "" }, candidates: [] };
  const result = parseSuffix(requested);
  const base = result.modelName === "" ? requested : result.modelName;
  const candidates = [requested];
  if (base !== requested) candidates.push(base);
  return { result, candidates };
}

/** Keeps the request's thinking suffix unless the resolved model carries its own (Go: preserveResolvedModelSuffix). */
export function preserveResolvedModelSuffix(resolved: string, requestResult: SuffixResult): string {
  const trimmed = (resolved ?? "").trim();
  if (trimmed === "") return "";
  if (parseSuffix(trimmed).hasSuffix) return trimmed;
  if (requestResult.hasSuffix && requestResult.rawSuffix !== "") return `${trimmed}(${requestResult.rawSuffix})`;
  return trimmed;
}

export function preserveRequestedModelSuffix(requestedModel: string, resolved: string): string {
  return preserveResolvedModelSuffix(resolved, parseSuffix(requestedModel));
}

/**
 * Per-credential alias table: lower-cased alias, suffix-free alias, upstream
 * name and suffix-free upstream name all map to the upstream name; the first
 * entry wins (Go: compileAPIKeyModelAliasForModels).
 */
export function compileAPIKeyModelAlias(models: ReadonlyArray<ModelOverride>): Map<string, string> {
  const out = new Map<string, string>();
  const add = (key: string, name: string) => {
    const normalized = key.trim().toLowerCase();
    if (normalized === "" || out.has(normalized)) return;
    out.set(normalized, name);
  };
  for (const model of models) {
    const alias = (model.alias ?? "").trim();
    const name = (model.name ?? "").trim();
    if (alias === "" || name === "") continue;
    add(alias, name);
    add(parseSuffix(alias).modelName, name);
    add(name, name);
    add(parseSuffix(name).modelName, name);
  }
  return out;
}

/** Fast-path alias lookup with suffix preservation; "" when the model is unknown (Go: lookupAPIKeyUpstreamModel). */
export function lookupAPIKeyUpstreamModel(byAlias: Map<string, string> | undefined, requestedModel: string): string {
  if (!byAlias || byAlias.size === 0) return "";
  const requested = (requestedModel ?? "").trim();
  if (requested === "") return "";
  const keys = [requested.toLowerCase()];
  const baseKey = parseSuffix(requested).modelName.trim().toLowerCase();
  if (baseKey !== "" && baseKey !== keys[0]) keys.push(baseKey);
  for (const key of keys) {
    const resolved = (byAlias.get(key) ?? "").trim();
    if (resolved !== "") return preserveRequestedModelSuffix(requested, resolved);
  }
  return "";
}

/** The config list serving a provider key (the four kept API-key families). */
export function apiKeyEntriesForProvider(cfg: Config | undefined, provider: string): ApiKeyCredential[] {
  if (!cfg) return [];
  switch ((provider ?? "").trim().toLowerCase()) {
    case "claude":
      return cfg.claudeApiKeys ?? [];
    case "codex":
      return cfg.codexApiKeys ?? [];
    case "openai":
      return cfg.openaiApiKeys ?? [];
    case "gemini":
    case "aistudio":
      return cfg.geminiApiKeys ?? [];
    default:
      return [];
  }
}

function equalFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The config entry of an API-key credential: the config index when it still
 * matches the credentials, then key+base (+prefix/proxy), then the key alone
 * (Go: resolveAPIKeyConfig).
 */
export function resolveAPIKeyConfig(entries: ReadonlyArray<ApiKeyCredential>, auth: Auth | undefined): ApiKeyCredential | undefined {
  if (!auth || entries.length === 0) return undefined;
  const attrKey = (auth.attributes?.[AttributeAPIKey] ?? "").trim();
  const attrBase = (auth.attributes?.[AttributeBaseURL] ?? "").trim();
  const matchesCredentials = (entry: ApiKeyCredential): boolean => {
    const cfgKey = (entry.apiKey ?? "").trim();
    const cfgBase = (entry.baseUrl ?? "").trim();
    if (attrKey !== "" && attrBase !== "") return equalFold(cfgKey, attrKey) && equalFold(cfgBase, attrBase);
    if (attrKey !== "") return equalFold(cfgKey, attrKey) && (cfgBase === "" || equalFold(cfgBase, attrBase));
    return attrBase !== "" && equalFold(cfgBase, attrBase);
  };
  if (authSourceKind(auth) === AuthSourceConfig) {
    const raw = (auth.attributes?.[AttributeConfigIndex] ?? "").trim();
    const index = raw === "" ? NaN : Number(raw);
    if (Number.isInteger(index) && index >= 0 && index < entries.length && matchesCredentials(entries[index]!)) return entries[index];
  }
  for (const entry of entries) {
    if (matchesCredentials(entry) && equalFold((entry.prefix ?? "").trim(), (auth.prefix ?? "").trim()) && equalFold((entry.proxyUrl ?? "").trim(), (auth.proxyUrl ?? "").trim())) return entry;
  }
  for (const entry of entries) if (matchesCredentials(entry)) return entry;
  if (attrKey !== "") {
    for (const entry of entries) if (equalFold((entry.apiKey ?? "").trim(), attrKey)) return entry;
  }
  return undefined;
}

/** Whether the credential's models come from a config entry (Go: isConfiguredModelRoutingAuth). */
export function isConfiguredModelRoutingAuth(auth: Auth | undefined): boolean {
  return !!auth && authKind(auth) === AuthKindAPIKey;
}

/** Configured model overrides of an API-key credential ([] for OAuth or unknown keys). */
export function configuredModelOverrides(cfg: Config | undefined, auth: Auth | undefined): ModelOverride[] {
  if (!cfg || !isConfiguredModelRoutingAuth(auth)) return [];
  return resolveAPIKeyConfig(apiKeyEntriesForProvider(cfg, auth!.provider), auth)?.models ?? [];
}

/** Result of resolving a requested alias (Go: OAuthModelAliasResult). */
export interface ModelAliasResult {
  upstreamModel: string;
  forceMapping: boolean;
  originalAlias: string;
}

const emptyAliasResult = (): ModelAliasResult => ({ upstreamModel: "", forceMapping: false, originalAlias: "" });

/** Alias resolution over configured models, exact suffix first (Go: resolveModelAliasResultFromConfigModels). */
export function resolveModelAliasResultFromConfigModels(requestedModel: string, models: ReadonlyArray<ModelOverride>): ModelAliasResult {
  const requested = (requestedModel ?? "").trim();
  if (requested === "" || models.length === 0) return emptyAliasResult();
  const { result, candidates } = modelAliasLookupCandidates(requested);
  if (candidates.length === 0) return emptyAliasResult();
  const baseModel = result.modelName === "" ? requested : result.modelName;
  for (const candidate of candidates) {
    const key = candidate.trim();
    if (key === "") continue;
    for (const model of models) {
      const original = (model.name ?? "").trim();
      const alias = (model.alias ?? "").trim();
      if (original === "" || alias === "" || !equalFold(alias, key)) continue;
      if (equalFold(original, baseModel)) {
        if (!model.forceMapping) return emptyAliasResult();
        return { upstreamModel: preserveResolvedModelSuffix(original, result), forceMapping: true, originalAlias: alias };
      }
      return { upstreamModel: preserveResolvedModelSuffix(original, result), forceMapping: model.forceMapping === true, originalAlias: alias };
    }
  }
  return emptyAliasResult();
}

/** Alias resolution for a configured credential; unknown models resolve to themselves (Go: resolveAPIKeyModelAliasWithResult). */
export function resolveAPIKeyModelAliasWithResult(cfg: Config | undefined, auth: Auth | undefined, requestedModel: string): ModelAliasResult {
  if (!auth) return emptyAliasResult();
  const requested = (requestedModel ?? "").trim();
  if (requested === "") return emptyAliasResult();
  const models = configuredModelOverrides(cfg, auth);
  if (models.length === 0) return { upstreamModel: requested, forceMapping: false, originalAlias: "" };
  const result = resolveModelAliasResultFromConfigModels(requested, models);
  if (result.upstreamModel.trim() === "") return { upstreamModel: requested, forceMapping: false, originalAlias: "" };
  return result;
}

/**
 * The upstream model for an API-key credential: alias table first, then the
 * requested model unchanged (Go: applyAPIKeyModelAlias). OAuth credentials
 * are returned unchanged.
 */
export function applyAPIKeyModelAlias(cfg: Config | undefined, auth: Auth | undefined, requestedModel: string): string {
  if (!auth || authKind(auth) !== AuthKindAPIKey) return requestedModel;
  const requested = (requestedModel ?? "").trim();
  if (requested === "") return requested;
  const resolved = lookupAPIKeyUpstreamModel(compileAPIKeyModelAlias(configuredModelOverrides(cfg, auth)), requested);
  return resolved !== "" ? resolved : requested;
}

/** The upstream model an execution sends for `routeModel` on this credential (Go: ResolveExecutionModel, API-key half). */
export function resolveExecutionModel(cfg: Config | undefined, auth: Auth | undefined, routeModel: string): string {
  const route = (routeModel ?? "").trim();
  const requested = rewriteModelForAuth(route, auth);
  const resolved = applyAPIKeyModelAlias(cfg, auth, requested);
  return resolved.trim() !== "" ? resolved : route;
}

/** Model-type label used for configured capabilities per provider (Go: compileAPIKeyModelCapabilitiesForAuth). */
function capabilityModelType(provider: string): string {
  switch ((provider ?? "").trim().toLowerCase()) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
    case "aistudio":
      return "gemini";
    default:
      return "openai-compatibility";
  }
}

function configuredUpstreamFallbackMatches(configured: string, selected: string): boolean {
  const configuredResult = parseSuffix(configured.trim());
  if (configuredResult.hasSuffix) return false;
  return equalFold(configuredResult.modelName.trim(), parseSuffix(selected.trim()).modelName.trim());
}

/**
 * The configured model definition the selected credential binds to the
 * execution (thinking levels, is-compat), exact upstream match first
 * (Go: lookupAPIKeyModelCapability + addConfiguredModelCapability).
 */
export function lookupAPIKeyModelCapability(cfg: Config | undefined, auth: Auth | undefined, routeModel: string, upstreamModel: string): ModelInfo | undefined {
  if (!isConfiguredModelRoutingAuth(auth)) return undefined;
  const models = configuredModelOverrides(cfg, auth);
  if (models.length === 0) return undefined;
  const modelType = capabilityModelType(auth!.provider);
  const routes = new Map<string, Array<{ upstreamModel: string; model: ModelOverride }>>();
  for (const model of models) {
    let name = (model.name ?? "").trim();
    let alias = (model.alias ?? "").trim();
    if (name === "") name = alias;
    if (alias === "") alias = name;
    if (name === "") continue;
    const seen = new Set<string>();
    for (const routeName of [alias, name]) {
      for (const candidate of modelAliasLookupCandidates(routeName).candidates) {
        const key = candidate.trim().toLowerCase();
        if (key === "" || seen.has(key)) continue;
        seen.add(key);
        const list = routes.get(key) ?? [];
        if (!list.some((existing) => equalFold(existing.upstreamModel, name))) list.push({ upstreamModel: name, model });
        routes.set(key, list);
      }
    }
  }
  const requested = rewriteModelForAuth((routeModel ?? "").trim(), auth);
  const matched: Array<{ upstreamModel: string; model: ModelOverride }> = [];
  for (const candidate of modelAliasLookupCandidates(requested).candidates) matched.push(...(routes.get(candidate.trim().toLowerCase()) ?? []));
  const selected = (upstreamModel ?? "").trim();
  const build = (route: { upstreamModel: string; model: ModelOverride }): ModelInfo => {
    const info = resolveModelInfo(route.upstreamModel, modelType, route.model.thinking);
    info.isCompat = route.model.isCompat === true;
    return info;
  };
  for (const route of matched) if (equalFold(route.upstreamModel.trim(), selected)) return build(route);
  for (const route of matched) if (configuredUpstreamFallbackMatches(route.upstreamModel, selected)) return build(route);
  return undefined;
}

/**
 * Binds the configured model definition to the request metadata, replacing a
 * stale binding from an earlier attempt (Go: attachResolvedAPIKeyModelInfo).
 */
export function attachResolvedAPIKeyModelInfo(cfg: Config | undefined, req: ExecRequest, auth: Auth | undefined, routeModel: string, upstreamModel: string): ExecRequest {
  const info = lookupAPIKeyModelCapability(cfg, auth, routeModel, upstreamModel);
  const hadBinding = !!req.metadata && Object.prototype.hasOwnProperty.call(req.metadata, ResolvedAPIKeyModelInfoMetadataKey);
  if (!info && !hadBinding) return req;
  const metadata: Record<string, unknown> = { ...(req.metadata ?? {}) };
  delete metadata[ResolvedAPIKeyModelInfoMetadataKey];
  if (info) metadata[ResolvedAPIKeyModelInfoMetadataKey] = info;
  return { ...req, metadata };
}

/** The bound configured model definition, if any (Go: ResolvedAPIKeyModelInfo). */
export function resolvedAPIKeyModelInfo(req: ExecRequest): ModelInfo | undefined {
  const raw = req.metadata?.[ResolvedAPIKeyModelInfoMetadataKey];
  return raw && typeof raw === "object" ? (raw as ModelInfo) : undefined;
}

// Application wiring: config -> token store -> login manager -> auth manager ->
// executors -> model registry -> HTTP server. Port of the kept parts of
// cmd/server/main.go and sdk/cliproxy/{builder.go, service.go, service_auth.go,
// service_executors.go, service_models.go} (registerModelsForAuth, buildConfigModels,
// applyModelPrefixes), reduced to the three kept upstreams.
//
// Usage statistics (usage.statisticsEnabled) are kept in memory and served on
// GET /v0/usage instead of the management API.
//
// Model registration follows registerModelsForAuth: provider catalog or the
// config models of the credential's resolved config entry, exclusions (the
// credential's own patterns, else oauth-excluded-models), OAuth model aliases
// (oauth-model-alias plus per-auth model_aliases), oauth-settings and the
// routing prefix.
//
// Dropped from upstream: the file watcher / hot reload, management API,
// plugins, Home mode, registration fences/epochs, force-model-prefix and the
// compatibility-provider catalogs.
import type { Server } from "bun";
import { newLoginManager, type LoginManager } from "./auth/login.ts";
import {
  AuthManager,
  authKind,
  AuthKindAPIKey,
  FillFirstSelector,
  RoundRobinSelector,
  setQuotaCooldownDisabled,
  setTransientErrorCooldownSeconds,
  type AutoRefreshLoop,
  type Selector,
} from "./auth/manager/index.ts";
import { StatusDisabled, type Auth } from "./auth/types.ts";
import { resolveConfigEntry, synthesizeApiKeyAuths } from "./config/auths.ts";
import { normalizeModalities, resolveOAuthModelSetting, sanitizeOAuthModelAlias, validateCredentialWeights } from "./config/load.ts";
import type { Config, ModelOverride, OAuthModelAlias, RoutingStrategy } from "./config/types.ts";
import { applyClaudeToolSearchSetting, createExecutors } from "./executor/index.ts";
import type { ProviderExecutor } from "./executor/types.ts";
import { log, setLogLevel } from "./log.ts";
import {
  applyExcludedModels,
  applyModelAliases,
  cloneModelInfo,
  getAIStudioModels,
  getClaudeModels,
  getCodexModelsForPlan,
  getCodexProModels,
  getGeminiCLIModels,
  getGlobalRegistry,
  getStaticModelDefinitionsByChannel,
  resolveModelInfo,
  rewriteModelInfoName,
  type ModelInfo,
  type ModelRegistry,
} from "./registry/index.ts";
import { createTokenStore, type FetchLike, type PersistingTokenStore } from "./store/index.ts";
import { createServer, serverOptionsFromConfig, type ProxyServer } from "./server/server.ts";
import { UsageStatistics } from "./usage/statistics.ts";
import type { JSONObject } from "./util/json.ts";

export interface AppOptions {
  /** Executors to register; defaults to createExecutors(config). */
  executors?: ProviderExecutor[];
  /** Token store; defaults to createTokenStore(config.auth). */
  store?: PersistingTokenStore;
  /** fetch used by the Vault store. */
  fetch?: FetchLike;
  /** Model registry; defaults to the global one. */
  registry?: ModelRegistry;
  /** Clock (epoch ms). */
  now?: () => number;
  /** Start the credential auto-refresh loop (default true). */
  autoRefresh?: boolean;
}

export interface App {
  readonly config: Config;
  readonly store: PersistingTokenStore;
  readonly loginManager: LoginManager;
  readonly manager: AuthManager;
  readonly registry: ModelRegistry;
  readonly server: ProxyServer;
  /** In-memory usage statistics (records are discarded when usage.statisticsEnabled is false). */
  readonly usage: UsageStatistics;
  /** The HTTP handler (works without a listening socket). */
  fetch(request: Request): Promise<Response>;
  /** Starts listening. */
  start(): Server<undefined>;
  /** Stops the server and the refresh loop and flushes pending persistence. */
  stop(): Promise<void>;
  /** Registers (or replaces) a credential at runtime and publishes its models. */
  registerAuth(auth: Auth): Auth;
  /**
   * Removes a credential at runtime and withdraws its models (Go: applyCoreAuthRemoval).
   * A later registerAuth with the same id starts from fresh runtime state.
   */
  removeAuth(id: string): void;
  /** The model list the server advertises on /v1/models (Anthropic list shape, uncloaked). */
  models(): JSONObject[];
  readonly refreshLoop: AutoRefreshLoop | undefined;
}

/**
 * Builds the whole application: token store, login manager, auth manager with
 * the retry/cooldown settings from the config, executors, stored OAuth auths
 * plus config API-key auths with their models registered per provider, the
 * auto-refresh loop and the HTTP server (Go: cliproxy.Service start-up).
 */
export async function createApp(config: Config, options: AppOptions = {}): Promise<App> {
  // Go: Builder.Build rejects an invalid credential weight before anything starts.
  try {
    validateCredentialWeights(config);
  } catch (err) {
    throw new Error(`validate credential weights: ${(err as Error).message}`);
  }
  setLogLevel(config.debug ? "debug" : config.loggingLevel);
  const store = options.store ?? createTokenStore(config.auth, { fetch: options.fetch, now: options.now });
  const loginManager = newLoginManager(store);
  const registry = options.registry ?? getGlobalRegistry();

  // Global cooldown switches (Go: SetQuotaCooldownDisabled / SetTransientErrorCooldownSeconds).
  setQuotaCooldownDisabled(config.routing.cooldown.disabled);
  // upstream.claude.tool-search: Responses -> Claude native tool search (also with injected executors).
  applyClaudeToolSearchSetting(config);
  setTransientErrorCooldownSeconds(config.routing.cooldown.transientErrorSeconds);

  const manager = new AuthManager({
    store,
    registry,
    now: options.now,
    cooldownDisabled: config.routing.cooldown.disabled,
    refreshLead: (auth) => loginManager.refreshLead(auth.provider),
    selector: newRoutingSelector(config.routing.strategy),
  });
  manager.setRetryConfig(config.routing.retry.maxAttempts, config.routing.retry.maxRetryIntervalSeconds * 1000, config.routing.retry.maxRetryCredentials);

  const executors = options.executors ?? createExecutors(config);
  for (const executor of executors) manager.registerExecutor(executor);

  // Stored OAuth credentials.
  try {
    await manager.load();
  } catch (err) {
    log.warn("failed to load stored credentials:", err instanceof Error ? err.message : String(err));
  }
  for (const auth of manager.list()) registerAuthModels(registry, config, auth);

  // Config API keys (runtime-only, never persisted).
  for (const auth of synthesizeApiKeyAuths(config, { now: options.now })) {
    const registered = manager.register(auth);
    registerAuthModels(registry, config, registered);
  }

  const providers = manager.availableProviders();
  const missing = providers.filter((provider) => !manager.executor(provider));
  if (missing.length > 0) log.warn(`no executor registered for provider(s): ${missing.join(", ")}; their credentials cannot serve requests yet`);
  log.info(`loaded ${manager.list().length} credential(s); providers: ${providers.join(", ") || "none"}; models: ${registry.getAvailableModelInfos().length}`);

  const refreshLoop = options.autoRefresh === false ? undefined : manager.startAutoRefresh();
  const usage = new UsageStatistics({ enabled: config.usage.statisticsEnabled, now: options.now });
  const server = createServer({ ...serverOptionsFromConfig(config, manager, registry), usage, now: options.now });

  return {
    config,
    store,
    loginManager,
    manager,
    registry,
    server,
    usage,
    fetch: (request) => server.fetch(request),
    start: () => server.start(),
    async stop() {
      await server.stop();
      manager.stopAutoRefresh();
      await manager.flushPersistence();
    },
    registerAuth(auth) {
      const current = manager.getById(auth.id) ? manager.update(auth) : manager.register(auth);
      const effective = current ?? manager.register(auth);
      registerAuthModels(registry, config, effective);
      return effective;
    },
    removeAuth(id) {
      const key = id.trim();
      if (key === "") return;
      manager.remove(key);
      registry.unregisterClient(key);
    },
    models: () => registry.getAvailableModels("claude"),
    get refreshLoop() {
      return refreshLoop ?? manager.autoRefreshLoop();
    },
  };
}

/**
 * The credential selector for routing.strategy (Go: newRoutingSelector). The manager has
 * no weighted selector, so "weighted-round-robin" runs as round-robin.
 */
export function newRoutingSelector(strategy: RoutingStrategy): Selector {
  switch (strategy) {
    case "fill-first":
      return new FillFirstSelector();
    case "weighted-round-robin":
      log.warn("routing.strategy weighted-round-robin is not supported; using round-robin");
      return new RoundRobinSelector();
    default:
      return new RoundRobinSelector();
  }
}

// ---------------------------------------------------------------------------
// Model registration per auth (Go: registerModelsForAuth)
// ---------------------------------------------------------------------------

/** Provider key used for the registry client (Go: provider normalisation in registerModelsForAuth). */
export function registryProviderForAuth(auth: Auth): string {
  const provider = (auth.provider ?? "").trim().toLowerCase();
  if (provider === "gemini") return "gemini-cli";
  return provider;
}

/**
 * Registers the models an auth serves in the registry, or removes them when
 * the auth is disabled. Returns the registered list.
 */
export function registerAuthModels(registry: ModelRegistry, config: Config, auth: Auth): ModelInfo[] {
  if (auth.disabled || auth.status === StatusDisabled) {
    registry.unregisterClient(auth.id);
    return [];
  }
  const models = modelsForAuth(config, auth);
  const provider = registryProviderForAuth(auth);
  if (models.length === 0 || provider === "") {
    registry.unregisterClient(auth.id);
    return [];
  }
  registry.registerClient(auth.id, provider, models);
  return models;
}

/**
 * The model list for a credential (Go: registerModelsForAuth switch):
 *
 * - claude: static Claude catalog, or the `models` of the resolved config entry.
 * - codex: OAuth -> catalog for the ChatGPT plan; API key -> the config entry's
 *   `models`, else the Pro catalog without configuration_update; an API key with
 *   no matching config entry advertises nothing.
 * - openai: config `models`; without them the static OpenAI channel when the
 *   catalog has one (it does not today), so the key advertises nothing.
 * - gemini-cli: static Gemini CLI catalog. aistudio: static AI Studio catalog
 *   or the config `models` of the key.
 *
 * Then exclusions, OAuth model aliases, OAuth settings and the routing prefix.
 */
export function modelsForAuth(config: Config, auth: Auth): ModelInfo[] {
  const provider = registryProviderForAuth(auth);
  const isAPIKey = authKind(auth) === AuthKindAPIKey;
  const entry = resolveConfigEntry(config, auth);
  const overrides = entry?.models ?? [];
  let excluded = excludedModelsFor(config, auth);
  if (isAPIKey && entry) excluded = entry.excludedModels;
  let models: ModelInfo[];
  switch (provider) {
    case "claude":
      models = overrides.length > 0 ? buildConfigModels(overrides, "anthropic", "claude") : getClaudeModels();
      break;
    case "codex":
      if (isAPIKey) {
        models = entry ? buildCodexConfigModels(overrides) : [];
      } else {
        models = getCodexModelsForPlan(codexPlanType(auth));
      }
      break;
    case "openai":
      models = overrides.length > 0 ? buildConfigModels(overrides, "openai", "openai") : (getStaticModelDefinitionsByChannel("openai") ?? []);
      break;
    case "gemini-cli":
      models = getGeminiCLIModels();
      break;
    case "aistudio":
      models = overrides.length > 0 ? buildConfigModels(overrides, "google", "gemini") : getAIStudioModels();
      break;
    default:
      models = getStaticModelDefinitionsByChannel(provider) ?? [];
  }
  models = applyExcludedModels(models, excluded);
  const channel = oauthModelAliasChannel(provider, isAPIKey);
  if (channel !== "") {
    models = applyModelAliases(models, oauthModelAliasesForAuth(config, channel, auth));
    models = applyOAuthSettings(config, channel, models);
  }
  return applyModelPrefixes(models, auth.prefix ?? "");
}

/**
 * Codex API-key models (Go: buildCodexConfigModels): the configured models with their
 * display names and per-model configuration_update support, or the Pro catalog with
 * configuration_update turned off when the key configures none.
 */
export function buildCodexConfigModels(overrides: ReadonlyArray<ModelOverride>): ModelInfo[] {
  if (overrides.length === 0) return getCodexProModels().map(withoutConfigurationUpdate);
  const models = buildConfigModels(overrides, "openai", "openai");
  const configurationUpdates = new Map<string, boolean>();
  for (const override of overrides) {
    const alias = override.alias.trim() || override.name.trim();
    if (alias === "") continue;
    const key = alias.toLowerCase();
    if (!configurationUpdates.has(key)) configurationUpdates.set(key, override.supportConfigurationUpdate === true);
  }
  for (const model of models) model.supportConfigurationUpdate = configurationUpdates.get(model.id.toLowerCase()) === true;
  return models;
}

/**
 * Exclusion patterns for an auth: the credential's own patterns win; otherwise
 * oauth-excluded-models for the auth's provider applies to OAuth credentials, so a
 * global change takes effect on the next registration (Go: oauthExcludedModelsForConfig
 * plus the excluded_models attribute override).
 */
export function excludedModelsFor(config: Config, auth: Auth): string[] {
  const own = excludedModelsOf(auth);
  if (own.length > 0) return own;
  if (authKind(auth) === AuthKindAPIKey) return [];
  const global = config.oauthExcludedModels ?? {};
  const registryProvider = registryProviderForAuth(auth);
  const rawProvider = (auth.provider ?? "").trim().toLowerCase();
  return global[registryProvider] ?? global[rawProvider] ?? [];
}

/** The oauth-model-alias / oauth-settings channel of an auth; "" for API keys (Go: OAuthModelAliasChannel). */
export function oauthModelAliasChannel(registryProvider: string, isAPIKey: boolean): string {
  if (isAPIKey) return "";
  return registryProvider.trim().toLowerCase();
}

/**
 * Per-auth aliases (attribute `model_aliases` as JSON, or metadata `model_aliases`)
 * followed by the channel's global aliases; a later entry with an alias already taken
 * is dropped (Go: oauthModelAliasesForAuth).
 */
export function oauthModelAliasesForAuth(config: Config, channel: string, auth: Auth): OAuthModelAlias[] {
  const perAuth = perAuthModelAliases(auth);
  const global = config.oauthModelAlias?.[channel] ?? [];
  if (perAuth.length === 0) return global;
  if (global.length === 0) return perAuth;
  const out: OAuthModelAlias[] = [];
  const seen = new Set<string>();
  for (const entry of [...perAuth, ...global]) {
    const alias = entry.alias.trim();
    if (alias === "" || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    out.push(entry);
  }
  return out;
}

function perAuthModelAliases(auth: Auth): OAuthModelAlias[] {
  let raw: unknown = auth.metadata?.model_aliases;
  const attr = (auth.attributes?.model_aliases ?? "").trim();
  if (attr !== "") {
    try {
      raw = JSON.parse(attr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const entries = raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      alias: typeof item.alias === "string" ? item.alias : "",
      fork: item.fork === true,
      displayName: typeof item["display-name"] === "string" ? (item["display-name"] as string) : typeof item.display_name === "string" ? (item.display_name as string) : "",
      forceMapping: item["force-mapping"] === true || item.force_mapping === true,
    }));
  return sanitizeOAuthModelAlias({ auth: entries }).auth ?? [];
}

/** Applies oauth-settings context-length overrides to a channel's models (Go: applyOAuthSettingEntries). */
export function applyOAuthSettings(config: Config, channel: string, models: ReadonlyArray<ModelInfo>): ModelInfo[] {
  const settings = config.oauthSettings?.[channel] ?? [];
  if (settings.length === 0 || models.length === 0 || channel === "") return [...models];
  return models.map((model) => {
    const setting = resolveOAuthModelSetting(settings, model.id, model.metadataModelId ?? "", model.name ?? "");
    if (!setting || setting.maxContextLength <= 0) return model;
    const clone = cloneModelInfo(model);
    clone.contextLength = setting.maxContextLength;
    return clone;
  });
}

function withoutConfigurationUpdate(model: ModelInfo): ModelInfo {
  const clone = cloneModelInfo(model);
  clone.supportConfigurationUpdate = false;
  return clone;
}

/** ChatGPT plan type recorded by the Codex login (metadata or attributes). */
export function codexPlanType(auth: Auth): string {
  const fromMetadata = auth.metadata?.plan_type;
  if (typeof fromMetadata === "string" && fromMetadata.trim() !== "") return fromMetadata.trim();
  return (auth.attributes?.plan_type ?? "").trim();
}

/** Exclusion patterns stored on the auth by the config synthesiser / login (comma separated, lower-cased). */
export function excludedModelsOf(auth: Auth): string[] {
  const raw = auth.attributes?.excluded_models ?? "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed !== "") out.push(trimmed);
  }
  const fromMetadata = auth.metadata?.excluded_models;
  if (Array.isArray(fromMetadata)) {
    for (const entry of fromMetadata) {
      if (typeof entry === "string" && entry.trim() !== "") out.push(entry.trim().toLowerCase());
    }
  }
  return out;
}

/**
 * Builds user-defined ModelInfos from a credential's configured models: the id
 * is the alias (or the name), metadataModelId the upstream name, and the
 * thinking support that of the upstream name's catalog entry unless the model
 * configures its own (Go: buildConfigModels / buildConfiguredModelInfo /
 * modelconfig.ResolveModelInfo).
 */
export function buildConfigModels(models: ReadonlyArray<ModelOverride>, ownedBy: string, modelType: string, nowSeconds = Math.floor(Date.now() / 1000)): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const name = model.name.trim();
    let alias = model.alias.trim();
    if (alias === "") alias = name;
    if (alias === "") continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let displayName = model.displayName.trim();
    if (displayName === "") displayName = name;
    if (displayName === "") displayName = alias;
    const info: ModelInfo = {
      id: alias,
      metadataModelId: name !== "" ? name : alias,
      object: "model",
      created: nowSeconds,
      ownedBy,
      type: modelType,
      displayName,
      userDefined: true,
    };
    if (model.maxContextLength > 0) info.contextLength = model.maxContextLength;
    if (model.isCompat) info.isCompat = true;
    const resolved = resolveModelInfo(name, modelType, model.thinking);
    if (resolved.thinking) info.thinking = resolved.thinking;
    const modalities = normalizeModalities(model.inputModalities);
    if (modalities.length > 0) info.supportedInputModalities = modalities;
    out.push(info);
  }
  return out;
}

/**
 * Adds a "<prefix>/<id>" copy of every model next to the original so clients
 * can route to this credential explicitly (Go: applyModelPrefixes without
 * force-model-prefix).
 */
export function applyModelPrefixes(models: ReadonlyArray<ModelInfo>, prefix: string): ModelInfo[] {
  const trimmedPrefix = prefix.trim();
  if (trimmedPrefix === "" || models.length === 0) return [...models];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  const add = (model: ModelInfo) => {
    const id = model.id.trim();
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    out.push(model);
  };
  for (const model of models) {
    const baseID = model.id.trim();
    if (baseID === "") continue;
    add(model);
    const clone = cloneModelInfo(model);
    clone.id = `${trimmedPrefix}/${baseID}`;
    if (!clone.metadataModelId) clone.metadataModelId = baseID;
    if (clone.name) clone.name = rewriteModelInfoName(clone.name, baseID, clone.id);
    add(clone);
  }
  return out;
}

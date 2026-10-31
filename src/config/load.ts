// YAML config loader. Port of the kept parts of internal/config/config_load.go,
// parse.go, config_normalization.go and weight.go (CLIProxyAPI), on top of a
// single simplified layout (see types.ts). Unknown top-level keys only warn.
import { homedir } from "node:os";
import { isAbsolute, normalize, join } from "node:path";
import { log, type LogLevel } from "../log.ts";
import type { ClaudeHeaderDefaults } from "../executor/claude/device_profile.ts";
import type { ThinkingSupport } from "../registry/types.ts";
import { isObject } from "../util/json.ts";
import {
  DefaultAuthDir,
  DefaultCodexBaseURL,
  DefaultMaxRetryIntervalSeconds,
  DefaultOpenAIBaseURL,
  DefaultPort,
  DefaultRequestRetry,
  DefaultVaultMount,
  DefaultVaultPathPrefix,
  type ApiKeyCredential,
  type Config,
  type ModelOverride,
  type OAuthModelAlias,
  type OAuthModelSetting,
  type RoutingStrategy,
  type StoreKind,
} from "./types.ts";

/** Largest positive credential routing weight (internal/credentialweight.Max). */
export const MaxCredentialWeight = 1_000_000;

export interface LoadOptions {
  /** Environment used for VAULT_* overrides (default process.env). */
  env?: Record<string, string | undefined>;
  /** Home directory used for "~" expansion (default os.homedir()). */
  home?: string;
  /** Receives warnings about unknown keys and ignored values (default log.warn). */
  warn?: (message: string) => void;
}

export interface LoadFileOptions extends LoadOptions {
  /** When true a missing file yields the default config instead of an error. */
  optional?: boolean;
}

/** Returns a Config with every default applied and no credentials. */
export function defaultConfig(): Config {
  return {
    server: { host: "", port: DefaultPort, maxRequestBodyBytes: 0 },
    access: { apiKeys: [] },
    auth: {
      store: "file",
      authDir: DefaultAuthDir,
      vault: { address: "", namespace: "", mount: DefaultVaultMount, pathPrefix: DefaultVaultPathPrefix, token: "" },
    },
    routing: {
      strategy: "round-robin",
      retry: { maxAttempts: DefaultRequestRetry, maxRetryCredentials: 0, maxRetryIntervalSeconds: DefaultMaxRetryIntervalSeconds },
      cooldown: { disabled: false, transientErrorSeconds: 0 },
    },
    requests: { proxyUrl: "", passthroughHeaders: false, requestRetry: DefaultRequestRetry },
    quotaExceeded: { switchProject: true, switchPreviewModel: true },
    upstream: {
      codex: { disableCloaking: false, streamBootstrapBuffering: false, streamBootstrapTimeoutMs: 0, modelLevelCooling: false },
      claude: { modelLevelCooling: false, disableCloakMode: false, sessionDatePinDays: 7, toolSearch: false },
    },
    usage: { statisticsEnabled: false },
    multimedia: { disableImageGeneration: false },
    client: { codex: { webSearchResultCache: { enabled: false, ttlMs: 24 * 3_600_000, limit: 1024 } } },
    debug: false,
    loggingLevel: "info",
    claudeApiKeys: [],
    openaiApiKeys: [],
    codexApiKeys: [],
    geminiApiKeys: [],
    oauthModelAlias: {},
    oauthExcludedModels: {},
    oauthSettings: {},
  };
}

/** Deep copy of a config (upstream CloneForRuntime). */
export function cloneConfig(cfg: Config): Config {
  return structuredClone(cfg);
}

/**
 * Reads and parses the YAML file at `path` (upstream LoadConfigOptional). With
 * `optional`, a missing, unreadable (e.g. a directory), empty or invalid file
 * yields the default config instead of an error, as upstream's cloud-deploy
 * standby mode does.
 */
export async function loadConfig(path: string, options: LoadFileOptions = {}): Promise<Config> {
  const fallback = (): Config => {
    const cfg = parseConfig("", options);
    cfg.sourcePath = path;
    return cfg;
  };
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (options.optional) return fallback();
    throw new Error(`failed to read config file: ${path} does not exist`);
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    if (options.optional) return fallback();
    throw new Error(`failed to read config file: ${(err as Error).message}`);
  }
  if (options.optional && text.trim() === "") return fallback();
  let cfg: Config;
  try {
    cfg = parseConfig(text, options);
  } catch (err) {
    if (options.optional) {
      (options.warn ?? ((message: string) => log.warn(message)))(`config: ${(err as Error).message}; using defaults`);
      return fallback();
    }
    throw err;
  }
  cfg.sourcePath = path;
  return cfg;
}

/** Parses a YAML document into a Config (upstream ParseConfigBytes). */
export function parseConfig(text: string, options: LoadOptions = {}): Config {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const home = options.home ?? homedir();
  const warn = options.warn ?? ((message: string) => log.warn(message));

  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : Bun.YAML.parse(text);
  } catch (err) {
    throw new Error(`failed to parse config file: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isObject(raw)) throw new Error("failed to parse config file: top level must be a mapping");
  const root = raw;
  const cfg = defaultConfig();

  const unknown = Object.keys(root).filter((key) => !KnownTopLevelKeys.has(key));
  if (unknown.length > 0) warn(`config: ignoring unknown top-level keys: ${unknown.join(", ")}`);

  // ---- server --------------------------------------------------------------
  const server = section(root, "server");
  cfg.server.host = str(first(server.host, root.host), "server.host");
  cfg.server.port = int(first(server.port, root.port), "server.port", DefaultPort);
  cfg.server.maxRequestBodyBytes = Math.max(
    0,
    int(first(server["max-request-body-bytes"], root["max-request-body-bytes"]), "server.max-request-body-bytes", 0),
  );
  if (isObject(server["response-compression"])) cfg.server.responseCompression = { enabled: bool(section(server, "response-compression").enabled, "server.response-compression.enabled", true), minBytes: int(section(server, "response-compression")["min-bytes"], "server.response-compression.min-bytes", 0) };

  // ---- access --------------------------------------------------------------
  const access = section(root, "access");
  cfg.access.apiKeys = stringList(first(access["api-keys"], root["api-keys"]), "access.api-keys", warn);

  // ---- auth ----------------------------------------------------------------
  const auth = section(root, "auth");
  const authDir = str(first(auth["auth-dir"], root["auth-dir"]), "auth.auth-dir") || DefaultAuthDir;
  cfg.auth.authDir = resolveAuthDir(authDir, home);
  const vault = section(auth, "vault");
  const approle = section(vault, "approle");
  const envStr = (name: string): string => (env[name] ?? "").trim();
  cfg.auth.vault.address = envStr("VAULT_ADDR") || str(vault.address, "auth.vault.address");
  cfg.auth.vault.namespace = envStr("VAULT_NAMESPACE") || str(vault.namespace, "auth.vault.namespace");
  cfg.auth.vault.mount = str(vault.mount, "auth.vault.mount") || DefaultVaultMount;
  cfg.auth.vault.pathPrefix = str(vault["path-prefix"], "auth.vault.path-prefix") || DefaultVaultPathPrefix;
  cfg.auth.vault.token = envStr("VAULT_TOKEN") || str(vault.token, "auth.vault.token");
  const roleId = envStr("VAULT_ROLE_ID") || str(approle["role-id"], "auth.vault.approle.role-id");
  const secretId = envStr("VAULT_SECRET_ID") || str(approle["secret-id"], "auth.vault.approle.secret-id");
  if (roleId !== "") cfg.auth.vault.approle = { roleId, secretId };
  const storeRaw = str(auth.store, "auth.store").toLowerCase();
  if (storeRaw === "" || storeRaw === "file") cfg.auth.store = "file";
  else if (storeRaw === "vault") cfg.auth.store = "vault";
  else {
    warn(`config: unknown auth.store ${JSON.stringify(storeRaw)} (expected "file" or "vault"); using "file"`);
    cfg.auth.store = "file" satisfies StoreKind;
  }

  // ---- routing / requests --------------------------------------------------
  const routing = section(root, "routing");
  const strategyRaw = str(routing.strategy, "routing.strategy").trim().toLowerCase();
  if (strategyRaw === "" || strategyRaw === "round-robin" || strategyRaw === "roundrobin" || strategyRaw === "rr") cfg.routing.strategy = "round-robin";
  else if (strategyRaw === "fill-first" || strategyRaw === "fillfirst" || strategyRaw === "ff") cfg.routing.strategy = "fill-first";
  else if (strategyRaw === "weighted-round-robin" || strategyRaw === "weightedroundrobin" || strategyRaw === "wrr") cfg.routing.strategy = "weighted-round-robin";
  else {
    warn(`config: unknown routing.strategy ${JSON.stringify(strategyRaw)}; using "round-robin"`);
    cfg.routing.strategy = "round-robin" satisfies RoutingStrategy;
  }
  const retry = section(routing, "retry");
  const requests = section(root, "requests");
  const requestRetry = int(
    first(retry["max-attempts"], requests["request-retry"], root["request-retry"]),
    "routing.retry.max-attempts",
    DefaultRequestRetry,
  );
  cfg.routing.retry.maxAttempts = Math.max(0, requestRetry);
  cfg.requests.requestRetry = cfg.routing.retry.maxAttempts;
  cfg.routing.retry.maxRetryCredentials = Math.max(
    0,
    int(first(retry["max-retry-credentials"], root["max-retry-credentials"]), "routing.retry.max-retry-credentials", 0),
  );
  cfg.routing.retry.maxRetryIntervalSeconds = int(
    first(retry["max-retry-interval"], root["max-retry-interval"]),
    "routing.retry.max-retry-interval",
    DefaultMaxRetryIntervalSeconds,
  );
  const cooldown = section(routing, "cooldown");
  cfg.routing.cooldown.disabled = bool(first(cooldown.disabled, cooldown["disable-cooling"], root["disable-cooling"]), "routing.cooldown.disabled", false);
  cfg.routing.cooldown.transientErrorSeconds = int(
    first(cooldown["transient-error-seconds"], root["transient-error-cooldown-seconds"]),
    "routing.cooldown.transient-error-seconds",
    0,
  );

  cfg.requests.proxyUrl = str(first(requests["proxy-url"], root["proxy-url"]), "requests.proxy-url");
  cfg.requests.passthroughHeaders = bool(first(requests["passthrough-headers"], root["passthrough-headers"]), "requests.passthrough-headers", false);

  // ---- quota-exceeded ------------------------------------------------------
  const quota = section(root, "quota-exceeded");
  cfg.quotaExceeded.switchProject = bool(quota["switch-project"], "quota-exceeded.switch-project", true);
  cfg.quotaExceeded.switchPreviewModel = bool(quota["switch-preview-model"], "quota-exceeded.switch-preview-model", true);

  // ---- upstream / observability / multimedia ------------------------------
  const upstream = section(root, "upstream");
  const codex = section(upstream, "codex");
  cfg.upstream.codex.disableCloaking = bool(codex["disable-codex-cloaking"], "upstream.codex.disable-codex-cloaking", false);
  cfg.upstream.codex.streamBootstrapBuffering = bool(codex["stream-bootstrap-buffering"], "upstream.codex.stream-bootstrap-buffering", false);
  cfg.upstream.codex.streamBootstrapTimeoutMs = durationMs(codex["stream-bootstrap-timeout"], "upstream.codex.stream-bootstrap-timeout", 0);
  cfg.upstream.codex.modelLevelCooling = bool(codex["model-level-cooling"], "upstream.codex.model-level-cooling", false);
  const claude = section(upstream, "claude");
  cfg.upstream.claude.modelLevelCooling = bool(claude["model-level-cooling"], "upstream.claude.model-level-cooling", false);
  cfg.upstream.claude.disableCloakMode = bool(claude["disable-claude-cloak-mode"], "upstream.claude.disable-claude-cloak-mode", false);
  cfg.upstream.claude.sessionDatePinDays = Math.max(0, int(claude["session-date-pin-days"], "upstream.claude.session-date-pin-days", 7));
  cfg.upstream.claude.toolSearch = bool(claude["tool-search"], "upstream.claude.tool-search", false);
  const headerDefaults = parseClaudeHeaderDefaults(first(claude["header-defaults"], root["claude-header-defaults"]), "upstream.claude.header-defaults", warn);
  if (headerDefaults) cfg.upstream.claude.headerDefaults = headerDefaults;
  const observability = section(root, "observability");
  const usage = section(observability, "usage");
  cfg.usage.statisticsEnabled = bool(first(usage["usage-statistics-enabled"], root["usage-statistics-enabled"]), "observability.usage.usage-statistics-enabled", false);
  const multimedia = section(root, "multimedia");
  cfg.multimedia.disableImageGeneration = bool(multimedia["disable-image-generation"], "multimedia.disable-image-generation", false);

  const client = section(root, "client");
  const clientCodex = section(client, "codex");
  cfg.client.codex.webSearchResultCache = parseWebSearchResultCache(clientCodex["web-search-result-cache"]);

  // ---- logging -------------------------------------------------------------
  cfg.debug = bool(root.debug, "debug", false);
  const level = str(root["logging-level"], "logging-level").toLowerCase();
  if (level === "") cfg.loggingLevel = cfg.debug ? "debug" : "info";
  else if (isLogLevel(level)) cfg.loggingLevel = level;
  else {
    warn(`config: unknown logging-level ${JSON.stringify(level)}; using "info"`);
    cfg.loggingLevel = cfg.debug ? "debug" : "info";
  }

  // ---- OAuth model aliases / exclusions / settings ------------------------
  const oauth = section(root, "oauth");
  cfg.oauthModelAlias = parseOAuthModelAliases(first(oauth["model-alias"], root["oauth-model-alias"]), "oauth.model-alias", warn);
  cfg.oauthExcludedModels = parseOAuthExcludedModels(first(oauth["excluded-models"], root["oauth-excluded-models"]), "oauth.excluded-models", warn);
  cfg.oauthSettings = parseOAuthSettings(first(oauth.settings, root["oauth-settings"]), "oauth.settings", warn);

  // ---- API-key credential lists -------------------------------------------
  cfg.claudeApiKeys = parseCredentialList(root["claude-api-key"], "claude-api-key", warn).map((entry) => sanitizeCredential(entry, ""));
  cfg.openaiApiKeys = parseCredentialList(root["openai-api-key"], "openai-api-key", warn)
    .map((entry) => sanitizeCredential(entry, DefaultOpenAIBaseURL))
    .filter((entry) => entry.apiKey !== "" || entry.baseUrl !== DefaultOpenAIBaseURL);
  cfg.codexApiKeys = parseCredentialList(root["codex-api-key"], "codex-api-key", warn).map((entry) => sanitizeCredential(entry, DefaultCodexBaseURL));
  cfg.geminiApiKeys = sanitizeGeminiKeys([
    ...parseCredentialList(root["gemini-api-key"], "gemini-api-key", warn),
    ...legacyGeminiKeys(root["generative-language-api-key"], warn),
  ]);

  return cfg;
}

const KnownTopLevelKeys = new Set([
  "server",
  "access",
  "auth",
  "routing",
  "requests",
  "quota-exceeded",
  "upstream",
  "observability",
  "multimedia",
  "client",
  "usage-statistics-enabled",
  "debug",
  "logging-level",
  "claude-api-key",
  "openai-api-key",
  "codex-api-key",
  "gemini-api-key",
  "generative-language-api-key",
  "oauth",
  // Upstream layout marker; this port reads one layout, so the value is ignored.
  "config-version",
  // Upstream flat spellings accepted for convenience.
  "oauth-model-alias",
  "oauth-excluded-models",
  "oauth-settings",
  "claude-header-defaults",
  "host",
  "port",
  "max-request-body-bytes",
  "api-keys",
  "auth-dir",
  "proxy-url",
  "passthrough-headers",
  "request-retry",
  "max-retry-credentials",
  "max-retry-interval",
  "disable-cooling",
  "transient-error-cooldown-seconds",
]);

// ---- path helpers -----------------------------------------------------------

/** Expands a leading "~" to the home directory (upstream util.ResolveAuthDir). */
export function expandHome(path: string, home: string = homedir()): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("~")) return trimmed;
  const remainder = trimmed.slice(1).replace(/^[\\/]+/, "");
  if (remainder === "") return normalize(home);
  return normalize(join(home, remainder.split("\\").join("/")));
}

/** Resolves the auth directory: default, "~" expansion and path normalisation. */
export function resolveAuthDir(authDir: string, home: string = homedir()): string {
  const value = authDir.trim() === "" ? DefaultAuthDir : authDir.trim();
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? normalize(expanded) : normalize(expanded);
}

// ---- credential parsing -----------------------------------------------------

function parseCredentialList(raw: unknown, family: string, warn: (m: string) => void): ApiKeyCredential[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn(`config: ${family} must be a list; ignoring`);
    return [];
  }
  const out: ApiKeyCredential[] = [];
  raw.forEach((item, index) => {
    const path = `${family}[${index}]`;
    if (typeof item === "string" || typeof item === "number") {
      out.push(emptyCredential({ apiKey: String(item) }));
      return;
    }
    if (!isObject(item)) {
      warn(`config: ${path} must be a mapping or a string; ignoring`);
      return;
    }
    const weight = parseWeight(item.weight, `${path}.weight`);
    const entry = emptyCredential({
      apiKey: str(item["api-key"], `${path}.api-key`),
      baseUrl: str(item["base-url"], `${path}.base-url`),
      proxyUrl: str(item["proxy-url"], `${path}.proxy-url`),
      prefix: str(item.prefix, `${path}.prefix`),
      label: str(item.label, `${path}.label`),
      headers: parseHeaders(item.headers, `${path}.headers`, warn),
      priority: int(item.priority, `${path}.priority`, 0),
      excludedModels: stringList(item["excluded-models"], `${path}.excluded-models`, warn),
      models: parseModels(item.models, `${path}.models`, warn),
    });
    if (weight !== undefined) entry.weight = weight;
    if (item["disable-cooling"] !== undefined && item["disable-cooling"] !== null) {
      entry.disableCooling = bool(item["disable-cooling"], `${path}.disable-cooling`, false);
    }
    if (item["request-retry"] !== undefined && item["request-retry"] !== null) {
      entry.requestRetry = int(item["request-retry"], `${path}.request-retry`, 0);
    }
    if (item.websockets !== undefined && item.websockets !== null) {
      entry.websockets = bool(item.websockets, `${path}.websockets`, false);
    }
    if (item["native-tool-search"] !== undefined && item["native-tool-search"] !== null) {
      entry.nativeToolSearch = bool(item["native-tool-search"], `${path}.native-tool-search`, false);
    }
    out.push(entry);
  });
  return out;
}

function emptyCredential(partial: Partial<ApiKeyCredential>): ApiKeyCredential {
  return {
    apiKey: "",
    baseUrl: "",
    models: [],
    proxyUrl: "",
    prefix: "",
    label: "",
    headers: {},
    priority: 0,
    excludedModels: [],
    ...partial,
  };
}

function parseModels(raw: unknown, path: string, warn: (m: string) => void): ModelOverride[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn(`config: ${path} must be a list; ignoring`);
    return [];
  }
  const out: ModelOverride[] = [];
  raw.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) {
      warn(`config: ${itemPath} must be a mapping; ignoring`);
      return;
    }
    const name = str(item.name, `${itemPath}.name`).trim();
    const model: ModelOverride = {
      name,
      alias: str(item.alias, `${itemPath}.alias`).trim(),
      displayName: str(item["display-name"], `${itemPath}.display-name`).trim(),
      maxContextLength: Math.max(0, int(item["max-context-length"], `${itemPath}.max-context-length`, 0)),
      isCompat: bool(item["is-compat"], `${itemPath}.is-compat`, false),
      forceMapping: bool(item["force-mapping"], `${itemPath}.force-mapping`, false),
    };
    if (item["support-configuration-update"] !== undefined && item["support-configuration-update"] !== null) {
      model.supportConfigurationUpdate = bool(item["support-configuration-update"], `${itemPath}.support-configuration-update`, false);
    }
    if (item["use-max-completion-tokens"] !== undefined && item["use-max-completion-tokens"] !== null) {
      model.useMaxCompletionTokens = bool(item["use-max-completion-tokens"], `${itemPath}.use-max-completion-tokens`, false);
    }
    const modalities = normalizeModalities(stringList(item["input-modalities"], `${itemPath}.input-modalities`, warn));
    if (modalities.length > 0) model.inputModalities = modalities;
    const thinking = parseThinking(item.thinking, `${itemPath}.thinking`, warn);
    if (thinking) model.thinking = thinking;
    out.push(model);
  });
  return out;
}

function parseThinking(raw: unknown, path: string, warn: (m: string) => void): ThinkingSupport | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    warn(`config: ${path} must be a mapping; ignoring`);
    return undefined;
  }
  const out: ThinkingSupport = {};
  if (raw.min !== undefined && raw.min !== null) out.min = int(raw.min, `${path}.min`, 0);
  if (raw.max !== undefined && raw.max !== null) out.max = int(raw.max, `${path}.max`, 0);
  if (raw["zero-allowed"] !== undefined && raw["zero-allowed"] !== null) out.zeroAllowed = bool(raw["zero-allowed"], `${path}.zero-allowed`, false);
  if (raw["dynamic-allowed"] !== undefined && raw["dynamic-allowed"] !== null) out.dynamicAllowed = bool(raw["dynamic-allowed"], `${path}.dynamic-allowed`, false);
  if (raw["disable-type"] !== undefined && raw["disable-type"] !== null) out.disableType = str(raw["disable-type"], `${path}.disable-type`);
  if (raw.levels !== undefined && raw.levels !== null) out.levels = stringList(raw.levels, `${path}.levels`, warn);
  return out;
}

function parseHeaders(raw: unknown, path: string, warn: (m: string) => void): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    warn(`config: ${path} must be a mapping; ignoring`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    out[key] = str(value, `${path}.${key}`);
  }
  return out;
}

/** Validates one optional credential weight (upstream validateWeightMappingNode). */
export function parseWeight(raw: unknown, path: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || Math.trunc(raw) !== raw) {
    throw new Error(`${path}: weight must be an integer`);
  }
  if (raw > MaxCredentialWeight) throw new Error(`${path}: weight must not exceed ${MaxCredentialWeight}`);
  if (!Number.isSafeInteger(raw)) throw new Error(`${path}: weight must be an integer`);
  return raw;
}

/** Validates an in-memory credential weight (upstream ValidateCredentialWeight). */
export function validateCredentialWeight(weight: number | undefined): void {
  if (weight === undefined) return;
  if (!Number.isInteger(weight)) throw new Error("weight must be an integer");
  if (weight > MaxCredentialWeight) throw new Error(`weight must not exceed ${MaxCredentialWeight}`);
}

/** Throws when any configured credential carries an invalid weight. */
export function validateCredentialWeights(cfg: Config): void {
  const families: [string, ApiKeyCredential[]][] = [
    ["gemini-api-key", cfg.geminiApiKeys],
    ["claude-api-key", cfg.claudeApiKeys],
    ["codex-api-key", cfg.codexApiKeys],
    ["openai-api-key", cfg.openaiApiKeys],
  ];
  for (const [family, entries] of families) {
    entries.forEach((entry, index) => {
      try {
        validateCredentialWeight(entry.weight);
      } catch (err) {
        throw new Error(`${family}[${index}].weight: ${(err as Error).message}`);
      }
    });
  }
}

// ---- client / upstream sections ---------------------------------------------

/** Default client.codex.web-search-result-cache values (upstream DefaultCodexWebSearchResultCache*). */
export const DefaultWebSearchResultCacheTTLMs = 24 * 3_600_000;
export const DefaultWebSearchResultCacheLimit = 1024;

/**
 * Parses client.codex.web-search-result-cache (upstream CodexWebSearchResultCacheConfig).
 * Null fields keep the defaults; a non-mapping section, a negative or invalid ttl and a
 * negative or invalid limit are rejected like upstream's validator.
 */
function parseWebSearchResultCache(raw: unknown): Config["client"]["codex"]["webSearchResultCache"] {
  const path = "client.codex.web-search-result-cache";
  const out = { enabled: false, ttlMs: DefaultWebSearchResultCacheTTLMs, limit: DefaultWebSearchResultCacheLimit };
  if (raw === undefined || raw === null) return out;
  if (!isObject(raw)) throw new Error(`config: ${path} must be a mapping`);
  out.enabled = bool(raw.enabled, `${path}.enabled`, false);
  if (raw.ttl !== undefined && raw.ttl !== null && raw.ttl !== "") {
    if (typeof raw.ttl === "boolean") throw new Error(`config: ${path}.ttl must be a duration such as "30m"`);
    if (typeof raw.ttl === "number" && raw.ttl < 0) throw new Error(`config: ${path}.ttl must not be negative`);
    const ttl = durationMs(raw.ttl, `${path}.ttl`, DefaultWebSearchResultCacheTTLMs);
    out.ttlMs = ttl > 0 ? ttl : DefaultWebSearchResultCacheTTLMs;
  }
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    const limit = int(raw.limit, `${path}.limit`, DefaultWebSearchResultCacheLimit);
    if (limit < 0) throw new Error(`config: ${path}.limit must not be negative`);
    out.limit = limit > 0 ? limit : DefaultWebSearchResultCacheLimit;
  }
  return out;
}

/**
 * Parses upstream.claude.header-defaults (legacy top-level claude-header-defaults):
 * trimmed strings, beta lists trimmed and de-duplicated in order, and an unknown
 * client-request-id mode reset to the default (upstream SanitizeClaudeHeaderDefaults).
 * stabilize-device-profile is accepted and ignored (device-profile learning is not ported).
 */
export function parseClaudeHeaderDefaults(raw: unknown, path: string, warn: (m: string) => void = (m) => log.warn(m)): ClaudeHeaderDefaults | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    warn(`config: ${path} must be a mapping; ignoring`);
    return undefined;
  }
  const out: ClaudeHeaderDefaults = {};
  const text = (key: string): string => str(raw[key], `${path}.${key}`).trim();
  const setText = (key: string, field: "userAgent" | "packageVersion" | "runtimeVersion" | "os" | "arch" | "timeout" | "timezone") => {
    const value = text(key);
    if (value !== "") out[field] = value;
  };
  setText("user-agent", "userAgent");
  setText("package-version", "packageVersion");
  setText("runtime-version", "runtimeVersion");
  setText("os", "os");
  setText("arch", "arch");
  setText("timeout", "timeout");
  setText("timezone", "timezone");
  const strip = normalizeBetaNames(rawStringList(raw["anthropic-beta-strip"], `${path}.anthropic-beta-strip`, warn));
  if (strip.length > 0) out.anthropicBetaStrip = strip;
  const append = normalizeBetaNames(rawStringList(raw["anthropic-beta-append"], `${path}.anthropic-beta-append`, warn));
  if (append.length > 0) out.anthropicBetaAppend = append;
  if (raw["inject-diagnostics"] !== undefined && raw["inject-diagnostics"] !== null) {
    out.injectDiagnostics = bool(raw["inject-diagnostics"], `${path}.inject-diagnostics`, true);
  }
  const mode = text("client-request-id").toLowerCase();
  if (mode === "passthrough" || mode === "off") out.clientRequestId = mode;
  else if (mode !== "" && mode !== "on") {
    warn(`config: unrecognized ${path}.client-request-id ${JSON.stringify(mode)} (supported: on, off, passthrough); falling back to on`);
  }
  return out;
}

function normalizeBetaNames(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Lower-cases, trims and de-duplicates modality names (upstream normalizeCompatConfigModalities). */
export function normalizeModalities(raw: ReadonlyArray<string> | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    const modality = item.trim().toLowerCase();
    if (modality === "" || seen.has(modality)) continue;
    seen.add(modality);
    out.push(modality);
  }
  return out;
}

// ---- OAuth aliases / exclusions / settings -----------------------------------

function parseOAuthModelAliases(raw: unknown, path: string, warn: (m: string) => void): Record<string, OAuthModelAlias[]> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    warn(`config: ${path} must be a mapping of channel -> list; ignoring`);
    return {};
  }
  const parsed: Record<string, OAuthModelAlias[]> = {};
  for (const [channel, list] of Object.entries(raw)) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      warn(`config: ${path}.${channel} must be a list; ignoring`);
      continue;
    }
    parsed[channel] = list.flatMap((item, index) => {
      const itemPath = `${path}.${channel}[${index}]`;
      if (!isObject(item)) {
        warn(`config: ${itemPath} must be a mapping; ignoring`);
        return [];
      }
      return [
        {
          name: str(item.name, `${itemPath}.name`),
          alias: str(item.alias, `${itemPath}.alias`),
          fork: bool(item.fork, `${itemPath}.fork`, false),
          displayName: str(item["display-name"], `${itemPath}.display-name`),
          forceMapping: bool(item["force-mapping"], `${itemPath}.force-mapping`, false),
        },
      ];
    });
  }
  return sanitizeOAuthModelAlias(parsed);
}

/**
 * Normalises OAuth model aliases (upstream SanitizeOAuthModelAlias): channel keys are
 * trimmed and lower-cased, entries without a name or alias, aliases equal to their
 * name and repeated aliases (case-insensitive) are dropped; several aliases for the
 * same name are kept.
 */
export function sanitizeOAuthModelAlias(input: Record<string, ReadonlyArray<Partial<OAuthModelAlias>>> | undefined): Record<string, OAuthModelAlias[]> {
  const out: Record<string, OAuthModelAlias[]> = {};
  for (const [rawChannel, aliases] of Object.entries(input ?? {})) {
    const channel = rawChannel.trim().toLowerCase();
    if (channel === "" || !aliases || aliases.length === 0) continue;
    const seen = new Set<string>();
    const clean: OAuthModelAlias[] = out[channel] ?? [];
    for (const entry of clean) seen.add(entry.alias.toLowerCase());
    for (const entry of aliases) {
      const name = (entry.name ?? "").trim();
      const alias = (entry.alias ?? "").trim();
      if (name === "" || alias === "" || name.toLowerCase() === alias.toLowerCase()) continue;
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ name, alias, fork: entry.fork === true, displayName: (entry.displayName ?? "").trim(), forceMapping: entry.forceMapping === true });
    }
    if (clean.length > 0) out[channel] = clean;
  }
  return out;
}

function parseOAuthExcludedModels(raw: unknown, path: string, warn: (m: string) => void): Record<string, string[]> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    warn(`config: ${path} must be a mapping of provider -> list; ignoring`);
    return {};
  }
  const parsed: Record<string, string[]> = {};
  for (const [provider, list] of Object.entries(raw)) parsed[provider] = stringList(list, `${path}.${provider}`, warn);
  return normalizeOAuthExcludedModels(parsed);
}

/** Lower-cases provider keys and normalises each pattern list (upstream NormalizeOAuthExcludedModels). */
export function normalizeOAuthExcludedModels(entries: Record<string, ReadonlyArray<string>> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(entries ?? {})) {
    const key = provider.trim().toLowerCase();
    if (key === "") continue;
    const normalized = normalizeExcludedModels([...(models ?? [])]);
    if (normalized.length === 0) continue;
    out[key] = normalized;
  }
  return out;
}

function parseOAuthSettings(raw: unknown, path: string, warn: (m: string) => void): Record<string, OAuthModelSetting[]> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    warn(`config: ${path} must be a mapping of channel -> list; ignoring`);
    return {};
  }
  const parsed: Record<string, OAuthModelSetting[]> = {};
  for (const [channel, list] of Object.entries(raw)) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      warn(`config: ${path}.${channel} must be a list; ignoring`);
      continue;
    }
    parsed[channel] = list.flatMap((item, index) => {
      const itemPath = `${path}.${channel}[${index}]`;
      if (!isObject(item)) {
        warn(`config: ${itemPath} must be a mapping; ignoring`);
        return [];
      }
      return [
        {
          name: str(item.name, `${itemPath}.name`),
          alias: str(item.alias, `${itemPath}.alias`),
          maxContextLength: Math.max(0, int(item["max-context-length"], `${itemPath}.max-context-length`, 0)),
        },
      ];
    });
  }
  return sanitizeOAuthSettings(parsed);
}

/**
 * Normalises OAuth settings (upstream SanitizeOAuthSettings): channel keys lower-cased,
 * entries without a name dropped, and for a repeated name/alias pair the later entry
 * wins while the survivors keep the order of their last occurrence.
 */
export function sanitizeOAuthSettings(input: Record<string, ReadonlyArray<Partial<OAuthModelSetting>>> | undefined): Record<string, OAuthModelSetting[]> {
  const out: Record<string, OAuthModelSetting[]> = {};
  for (const [rawChannel, settings] of Object.entries(input ?? {})) {
    const channel = rawChannel.trim().toLowerCase();
    if (channel === "" || !settings || settings.length === 0) continue;
    const seen = new Set<string>();
    const reversed: OAuthModelSetting[] = [];
    for (let i = settings.length - 1; i >= 0; i--) {
      const entry = settings[i]!;
      const name = (entry.name ?? "").trim();
      if (name === "") continue;
      const alias = (entry.alias ?? "").trim();
      const key = `${name.toLowerCase()}->${alias.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reversed.push({ name, alias, maxContextLength: entry.maxContextLength ?? 0 });
    }
    if (reversed.length > 0) out[channel] = reversed.reverse();
  }
  return out;
}

/**
 * The setting that applies to a registered model (upstream ResolveOAuthModelSetting):
 * an entry whose alias equals the model id wins; otherwise the last entry whose name
 * matches the id, the upstream id (metadataModelId) or the model name and whose alias
 * is empty or equals the id.
 */
export function resolveOAuthModelSetting(settings: ReadonlyArray<OAuthModelSetting> | undefined, modelId: string, metadataModelId = "", modelName = ""): OAuthModelSetting | undefined {
  if (!settings || settings.length === 0) return undefined;
  const id = modelId.trim().toLowerCase();
  const metaId = metadataModelId.trim().toLowerCase();
  const name = modelName.trim().toLowerCase();
  let aliasMatch: OAuthModelSetting | undefined;
  let nameMatch: OAuthModelSetting | undefined;
  for (const entry of settings) {
    const entryName = entry.name.trim().toLowerCase();
    if (entryName === "") continue;
    const entryAlias = entry.alias.trim().toLowerCase();
    if (entryAlias !== "" && id !== "" && id === entryAlias) aliasMatch = entry;
    else if ((entryAlias === "" || entryAlias === id) && (id === entryName || (metaId !== "" && metaId === entryName) || (name !== "" && name === entryName))) nameMatch = entry;
  }
  return aliasMatch ?? nameMatch;
}

// ---- normalisation (config_normalization.go) --------------------------------

/** Trims and strips slashes; multi-segment prefixes are rejected (""). */
export function normalizeModelPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed.includes("/")) return "";
  return trimmed;
}

/** Trims header names and values and drops empty pairs. */
export function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    const val = (value ?? "").trim();
    if (name === "" || val === "") continue;
    out[name] = val;
  }
  return out;
}

/** Trims, lower-cases and de-duplicates exclusion patterns (first occurrence order). */
export function normalizeExcludedModels(models: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models ?? []) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Serialises headers deterministically (sorted, NUL separated). */
export function formatSortedHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  const keys = Object.keys(headers).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}\0${headers[k]}\0`).join("");
}

function sanitizeCredential(entry: ApiKeyCredential, defaultBaseUrl: string): ApiKeyCredential {
  const out: ApiKeyCredential = {
    ...entry,
    apiKey: entry.apiKey.trim(),
    baseUrl: entry.baseUrl.trim() || defaultBaseUrl,
    proxyUrl: entry.proxyUrl.trim(),
    prefix: normalizeModelPrefix(entry.prefix),
    label: entry.label.trim(),
    headers: normalizeHeaders(entry.headers),
    excludedModels: normalizeExcludedModels(entry.excludedModels),
    models: entry.models.filter((m) => m.name !== ""),
  };
  return out;
}

/** Drops empty Gemini entries and de-duplicates on key/base/proxy/prefix/headers (SanitizeGeminiKeys). */
export function sanitizeGeminiKeys(entries: ApiKeyCredential[]): ApiKeyCredential[] {
  const seen = new Set<string>();
  const out: ApiKeyCredential[] = [];
  for (const raw of entries) {
    const entry = sanitizeCredential(raw, "");
    if (entry.apiKey === "" && entry.baseUrl === "") continue;
    const dedup = [entry.apiKey, entry.baseUrl, entry.proxyUrl, entry.prefix, formatSortedHeaders(entry.headers)].join("\0");
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(entry);
  }
  return out;
}

/** Legacy `generative-language-api-key: [string]` entries (v7 migrateLegacyGeminiKeys). */
function legacyGeminiKeys(raw: unknown, warn: (m: string) => void): ApiKeyCredential[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn("config: generative-language-api-key must be a list of strings; ignoring");
    return [];
  }
  return raw
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map((item) => emptyCredential({ apiKey: String(item) }));
}

// ---- scalar helpers ---------------------------------------------------------

function section(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return isObject(value) ? value : {};
}

function first(...values: unknown[]): unknown {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function str(value: unknown, path: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`config: ${path} must be a string`);
}

function int(value: unknown, path: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`config: ${path} must be an integer`);
    return value;
  }
  if (typeof value === "string" && /^[-+]?\d+$/.test(value.trim())) return Number(value.trim());
  throw new Error(`config: ${path} must be an integer`);
}

/** Parses a Go-style duration ("20s", "1m30s", "500ms") or a bare number of seconds into milliseconds. */
function durationMs(value: unknown, path: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value * 1000));
  if (typeof value !== "string") throw new Error(`config: ${path} must be a duration such as "20s"`);
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let rest = text;
  const re = /^(\d+(?:\.\d+)?)(ms|s|m|h)/;
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) throw new Error(`config: ${path} must be a duration such as "20s"`);
    total += Number(m[1]) * units[m[2]!]!;
    rest = rest.slice(m[0].length);
  }
  return Math.round(total);
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(lowered)) return true;
    if (["false", "no", "off", "0"].includes(lowered)) return false;
  }
  if (typeof value === "number") return value !== 0;
  throw new Error(`config: ${path} must be a boolean`);
}

function stringList(value: unknown, path: string, warn: (m: string) => void): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (!Array.isArray(value)) {
    warn(`config: ${path} must be a list; ignoring`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (item === null || item === undefined) continue;
    if (typeof item !== "string" && typeof item !== "number") {
      warn(`config: ${path} entries must be strings; ignoring one entry`);
      continue;
    }
    const text = String(item).trim();
    if (text !== "") out.push(text);
  }
  return out;
}

/** Like stringList but keeps blank entries so callers can apply their own normalisation. */
function rawStringList(value: unknown, path: string, warn: (m: string) => void): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    warn(`config: ${path} must be a list; ignoring`);
    return [];
  }
  return value.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map(String);
}

function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

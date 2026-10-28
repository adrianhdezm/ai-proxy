// YAML configuration types for this port. A simplified single layout derived
// from internal/config/config.go, config_types.go and sdk_config.go in
// CLIProxyAPI, reduced to the sections the three kept upstreams need. The
// v8/legacy dual-layout migration of upstream is intentionally not reproduced.
import type { ThinkingSupport } from "../registry/types.ts";
import type { LogLevel } from "../log.ts";

export interface ServerConfig {
  /** Interface to bind; "" binds all interfaces. */
  host: string;
  /** Listening port (default 8317). */
  port: number;
  /** Maximum inbound request body size in bytes; 0 disables the limit. */
  maxRequestBodyBytes: number;
}

export interface AccessConfig {
  /** Inbound API keys clients must present (x-api-key / Authorization: Bearer). */
  apiKeys: string[];
}

export interface VaultAppRoleConfig {
  roleId: string;
  secretId: string;
}

export interface VaultConfig {
  /** Vault address (VAULT_ADDR). */
  address: string;
  /** Enterprise namespace (VAULT_NAMESPACE), "" when unused. */
  namespace: string;
  /** KV v2 mount (default "secret"). */
  mount: string;
  /** Path under the mount holding the records (default "ai-proxy/auths"). */
  pathPrefix: string;
  /** Static token (VAULT_TOKEN), "" when AppRole is used. */
  token: string;
  /** AppRole login credentials (VAULT_ROLE_ID / VAULT_SECRET_ID). */
  approle?: VaultAppRoleConfig;
}

export type StoreKind = "file" | "vault";

export interface AuthConfig {
  /** Which token store persists OAuth credentials. */
  store: StoreKind;
  /** Directory for the file store, with ~ already expanded. */
  authDir: string;
  /** Vault settings, only consulted when store is "vault". */
  vault: VaultConfig;
}

export type RoutingStrategy = "round-robin" | "fill-first";

export interface RetryConfig {
  /**
   * Additional credential retry rounds after the first round exhausted its
   * eligible credentials (upstream `request-retry`). Kept in sync with
   * requests.requestRetry by the loader.
   */
  maxAttempts: number;
  /** Max distinct credentials per round; 0 = all (upstream max-retry-credentials). */
  maxRetryCredentials: number;
  /** Max seconds to wait for a cooling credential before the next round (upstream max-retry-interval). */
  maxRetryIntervalSeconds: number;
}

export interface CooldownConfig {
  /** Disable credential/model cooldown scheduling globally (upstream disable-cooling). */
  disabled: boolean;
  /**
   * Cooldown for transient upstream errors (408/500/502/503/504/52x) in seconds.
   * 0 keeps the executor default, negative disables (upstream transient-error-cooldown-seconds).
   */
  transientErrorSeconds: number;
}

export interface RoutingConfig {
  strategy: RoutingStrategy;
  retry: RetryConfig;
  cooldown: CooldownConfig;
}

export interface RequestsConfig {
  /** Global outbound proxy URL (socks5/http/https), "" for direct. */
  proxyUrl: string;
  /** Forward filtered upstream response headers to clients. */
  passthroughHeaders: boolean;
  /** Same value as routing.retry.maxAttempts (upstream top-level request-retry). */
  requestRetry: number;
}

export interface QuotaExceededConfig {
  /** Gemini CLI: switch to another project when the quota is exceeded. */
  switchProject: boolean;
  /** Gemini CLI: fall back to a preview model when the quota is exceeded. */
  switchPreviewModel: boolean;
}

/** Per-credential model override (upstream ClaudeModel / CodexModel / GeminiModel). */
export interface ModelOverride {
  /** Upstream model name. */
  name: string;
  /** Client-facing alias mapped to `name` ("" = same as name). */
  alias: string;
  /** Optional display name shown in model listings. */
  displayName: string;
  /** Optional context window override. */
  maxContextLength: number;
  /** Route requests for an OpenAI-compatible model that is not a native one. */
  isCompat: boolean;
  /** Force requests for the alias to the upstream model even when it exists natively. */
  forceMapping: boolean;
  /** Optional thinking capability override. */
  thinking?: ThinkingSupport;
}

/** An API-key credential from one of the *-api-key lists. */
export interface ApiKeyCredential {
  apiKey: string;
  /** Upstream base URL ("" = provider default). */
  baseUrl: string;
  /** Model overrides / aliases for this credential. */
  models: ModelOverride[];
  /** Per-credential proxy override ("" = global proxy). */
  proxyUrl: string;
  /** Routing prefix (clients call "<prefix>/<model>"). */
  prefix: string;
  /** Human readable label for logs. */
  label: string;
  /** Extra headers sent upstream. */
  headers: Record<string, string>;
  /** Routing weight; undefined = default (1). Non-positive excludes the credential from weighted routing. */
  weight?: number;
  /** Routing priority; 0 = unset. */
  priority: number;
  /** Per-credential cooldown override. */
  disableCooling?: boolean;
  /** Per-credential retry rounds override; undefined = global. */
  requestRetry?: number;
  /** Lower-cased exclusion patterns ("*" wildcards). */
  excludedModels: string[];
}

export type ClaudeApiKey = ApiKeyCredential;
export type OpenAIApiKey = ApiKeyCredential;
export type CodexApiKey = ApiKeyCredential;
export type GeminiApiKey = ApiKeyCredential;

export interface Config {
  server: ServerConfig;
  access: AccessConfig;
  auth: AuthConfig;
  routing: RoutingConfig;
  requests: RequestsConfig;
  quotaExceeded: QuotaExceededConfig;
  /** Debug mode: implies loggingLevel "debug" and verbose request logging. */
  debug: boolean;
  loggingLevel: LogLevel;
  /** Anthropic API keys (provider "claude"). */
  claudeApiKeys: ClaudeApiKey[];
  /** OpenAI platform API keys (provider "openai", default base URL https://api.openai.com/v1). */
  openaiApiKeys: OpenAIApiKey[];
  /** Codex Responses API keys (provider "codex", default base URL https://chatgpt.com/backend-api/codex). */
  codexApiKeys: CodexApiKey[];
  /** Google AI Studio API keys (provider "aistudio"). */
  geminiApiKeys: GeminiApiKey[];
  /** Path the config was loaded from (unset when parsed from a string). */
  sourcePath?: string;
}

export const DefaultPort = 8317;
export const DefaultAuthDir = "~/.ai-proxy";
export const DefaultVaultMount = "secret";
export const DefaultVaultPathPrefix = "ai-proxy/auths";
export const DefaultRequestRetry = 3;
export const DefaultMaxRetryIntervalSeconds = 30;
export const DefaultOpenAIBaseURL = "https://api.openai.com/v1";
export const DefaultCodexBaseURL = "https://chatgpt.com/backend-api/codex";

// Auth record types. Port of the relevant parts of sdk/cliproxy/auth/types.go,
// status.go and errors.go from CLIProxyAPI, reduced to what the three kept
// providers (claude, codex, gemini) need.

/** Lifecycle status managed by the auth manager. */
export type AuthStatus = "unknown" | "active" | "pending" | "refreshing" | "disabled" | "error";

export const StatusActive: AuthStatus = "active";
export const StatusPending: AuthStatus = "pending";
export const StatusDisabled: AuthStatus = "disabled";
export const StatusError: AuthStatus = "error";
export const StatusRefreshing: AuthStatus = "refreshing";
export const StatusUnknown: AuthStatus = "unknown";

/** Provider keys served by this proxy. */
export type ProviderKey = "claude" | "codex" | "gemini" | "gemini-cli" | "aistudio" | "openai";

/** Structured error recorded on an auth or model state. */
export interface AuthError {
  /** Short machine readable identifier. */
  code?: string;
  /** Human readable description of the failure. */
  message: string;
  /** Whether a retry might fix the issue automatically. */
  retryable: boolean;
  /** Optional HTTP-like status code for the error. */
  httpStatus?: number;
}

/** Limiter tracking data for a credential or a (credential, model) pair. */
export interface QuotaState {
  /** The credential recently hit a quota error. */
  exceeded: boolean;
  /** Optional provider specific human readable description. */
  reason?: string;
  /** When the credential may become available again (epoch ms, 0 = unset). */
  nextRecoverAt: number;
  /** Progressive cooldown exponent used for rate limits. */
  backoffLevel?: number;
}

/** Execution state for a specific model under an auth entry. */
export interface ModelState {
  status: AuthStatus;
  statusMessage?: string;
  unavailable: boolean;
  /** Per-model retry time (epoch ms, 0 = unset). */
  nextRetryAfter: number;
  lastError?: AuthError;
  quota: QuotaState;
  /** Last update timestamp (epoch ms). */
  updatedAt: number;
}

/**
 * Auth encapsulates the runtime state and metadata associated with a single
 * credential: an OAuth token set or an API key.
 *
 * - `attributes` is immutable configuration (api_key, base_url, path, ...).
 * - `metadata` is the mutable token material (access_token, refresh_token,
 *   expired, email, account_id, project_id, ...). This is what gets persisted
 *   to the token store.
 */
export interface Auth {
  /** Uniquely identifies the auth record across restarts (file name or store key). */
  id: string;
  /** Upstream provider key (claude, codex, gemini, gemini-cli, aistudio, openai). */
  provider: ProviderKey | string;
  /** Optional model prefix for routing (e.g. "teamA/"). */
  prefix?: string;
  /** Optional human readable label for logging. */
  label?: string;
  status: AuthStatus;
  statusMessage?: string;
  /** Intentionally disabled by operator. */
  disabled: boolean;
  /** Transient provider unavailability (e.g. quota exceeded). */
  unavailable: boolean;
  /** Overrides the global proxy setting for this auth. */
  proxyUrl?: string;
  /** Provider specific immutable configuration needed by executors. */
  attributes: Record<string, string>;
  /** Runtime mutable provider state (tokens, cookies, ...). */
  metadata: Record<string, unknown>;
  quota: QuotaState;
  lastError?: AuthError;
  /** Timestamps in epoch milliseconds (0 = unset). */
  createdAt: number;
  updatedAt: number;
  lastRefreshedAt: number;
  nextRefreshAfter: number;
  nextRetryAfter: number;
  /** Consecutive refresh failures for exponential backoff (in-memory only). */
  refreshFailures?: number;
  /** Per-model runtime availability data. */
  modelStates?: Record<string, ModelState>;
  /** Non-serialisable data used during execution (in-memory only). */
  runtime?: unknown;
}

/** Attribute keys shared across the code base (sdk/cliproxy/auth/classification.go). */
export const AttributeAPIKey = "api_key";
export const AttributeBaseURL = "base_url";
export const AttributeAuthKind = "auth_kind";
export const AttributeConfigIndex = "config_index";
export const AttributePath = "path";
export const AttributeRuntimeOnly = "runtime_only";
export const AttributeSource = "source";
export const AttributeSourceBackend = "source_backend";
export const AttributeWeight = "weight";
export const AttributePriority = "priority";

export const AuthSourceFile = "file";
export const AuthSourceVault = "vault";
export const AuthSourceConfig = "config";

export function emptyQuotaState(): QuotaState {
  return { exceeded: false, nextRecoverAt: 0 };
}

/** Creates an Auth with every required field populated. */
export function newAuth(partial: Partial<Auth> & Pick<Auth, "id" | "provider">): Auth {
  const now = Date.now();
  return {
    status: StatusActive,
    disabled: false,
    unavailable: false,
    attributes: {},
    metadata: {},
    quota: emptyQuotaState(),
    createdAt: now,
    updatedAt: now,
    lastRefreshedAt: 0,
    nextRefreshAfter: 0,
    nextRetryAfter: 0,
    ...partial,
  };
}

/** Deep clones an Auth (runtime field is copied by reference). */
export function cloneAuth(auth: Auth): Auth {
  const { runtime, ...rest } = auth;
  const copy = structuredClone(rest) as Auth;
  if (runtime !== undefined) copy.runtime = runtime;
  return copy;
}

/** Returns true when the auth is backed by an API key rather than OAuth tokens. */
export function isAPIKeyAuth(auth: Auth): boolean {
  const kind = (auth.attributes[AttributeAuthKind] ?? "").trim().toLowerCase();
  if (kind === "apikey" || kind === "api_key" || kind === "api-key") return true;
  return !!auth.attributes[AttributeAPIKey]?.trim();
}

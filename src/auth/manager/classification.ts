// Credential classification helpers over the Auth record. Port of
// sdk/cliproxy/auth/classification.go, priority.go, config_apikey.go and the
// Auth methods of types.go (DisableCoolingOverride, RequestRetryOverride,
// ToolPrefixDisabled, AccountInfo, ExpirationTime, AccessTokenExpirationTime,
// HasValidAccessToken) plus canonicalModelKey from selector.go.
//
// Dropped from upstream: Codex SIWC nested sections, plugin virtual auths,
// file snapshot bindings and the stable Index derivation.
import {
  AttributeAPIKey,
  AttributeAuthKind,
  AttributePath,
  AttributePriority,
  AttributeRuntimeOnly,
  AttributeSource,
  AttributeSourceBackend,
  type Auth,
} from "../types.ts";
import { parseSuffix } from "../../thinking/suffix.ts";

export const AuthKindAPIKey = "apikey";
export const AuthKindOAuth = "oauth";

export const AuthSourceConfig = "config";
export const AuthSourceFile = "file";
export const AuthSourceGit = "git";
export const AuthSourceMemory = "memory";
export const AuthSourceObjectStore = "objectstore";
export const AuthSourcePostgres = "postgres";

/** Marks priority values inherited from a physical auth file (Go: AttributeFilePriority). */
export const AttributeFilePriority = "file_priority";

/** Proactive refresh lead before the nominal Codex OAuth JWT expiry (Go: CodexOuterRefreshLead). */
export const CodexOuterRefreshLeadMs = 96 * 60 * 60 * 1000;
/** Claude Code OAuth refresh lead (sdk/auth/claude.go RefreshLead). */
export const ClaudeRefreshLeadMs = 4 * 60 * 60 * 1000;

export function authAttribute(auth: Auth | undefined, key: string): string {
  if (!auth || !auth.attributes) return "";
  return (auth.attributes[key] ?? "").trim();
}

export function authMetadataString(auth: Auth | undefined, key: string): string {
  if (!auth || !auth.metadata) return "";
  const value = auth.metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAuthKind(kind: string): string {
  switch (kind.trim().toLowerCase()) {
    case AuthKindAPIKey:
    case "api_key":
    case "api-key":
      return AuthKindAPIKey;
    case AuthKindOAuth:
    case "oauth2":
      return AuthKindOAuth;
    default:
      return "";
  }
}

function normalizeAuthSourceKind(source: string): string {
  switch (source.trim().toLowerCase()) {
    case AuthSourceConfig:
      return AuthSourceConfig;
    case AuthSourceFile:
    case "filesystem":
      return AuthSourceFile;
    case AuthSourceGit:
      return AuthSourceGit;
    case AuthSourceMemory:
    case "runtime":
    case "runtime_only":
      return AuthSourceMemory;
    case AuthSourceObjectStore:
    case "object-store":
      return AuthSourceObjectStore;
    case AuthSourcePostgres:
    case "postgresql":
    case "database":
    case "db":
      return AuthSourcePostgres;
    default:
      return "";
  }
}

function authHasOAuthMetadata(auth: Auth): boolean {
  if (!auth.metadata || Object.keys(auth.metadata).length === 0) return false;
  for (const key of ["access_token", "refresh_token", "id_token", "email", "token_type", "expires_at", "expired"]) {
    if (authMetadataString(auth, key) !== "") return true;
  }
  for (const nested of ["token", "service_account"]) {
    const value = auth.metadata[nested];
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0) return true;
  }
  return false;
}

/** Credential kind using explicit metadata first and legacy field-shape fallbacks second (Go: Auth.AuthKind). */
export function authKind(auth: Auth | undefined): string {
  if (!auth) return "";
  const explicit = normalizeAuthKind(authAttribute(auth, AttributeAuthKind));
  if (explicit !== "") return explicit;
  const fromMetadata = normalizeAuthKind(authMetadataString(auth, AttributeAuthKind));
  if (fromMetadata !== "") return fromMetadata;
  if (authAttribute(auth, AttributeAPIKey) !== "") return AuthKindAPIKey;
  if (authHasOAuthMetadata(auth)) return AuthKindOAuth;
  return "";
}

/** Where the Auth entry came from at runtime (Go: Auth.AuthSourceKind). */
export function authSourceKind(auth: Auth | undefined): string {
  if (!auth) return "";
  if (authAttribute(auth, AttributeRuntimeOnly).toLowerCase() === "true") return AuthSourceMemory;
  const backend = normalizeAuthSourceKind(authAttribute(auth, AttributeSourceBackend));
  if (backend !== "") return backend;
  const source = authAttribute(auth, AttributeSource);
  if (source !== "") {
    if (source.toLowerCase().startsWith(AuthSourceConfig + ":")) return AuthSourceConfig;
    const normalized = normalizeAuthSourceKind(source);
    if (normalized !== "") return normalized;
    return AuthSourceFile;
  }
  if (authAttribute(auth, AttributePath) !== "") return AuthSourceFile;
  return "";
}

/** True for API-key credentials declared through the config file (Go: IsConfigAPIKeyAuth). */
export function isConfigAPIKeyAuth(auth: Auth | undefined): boolean {
  if (!auth) return false;
  if (authKind(auth) !== AuthKindAPIKey) return false;
  return authSourceKind(auth) === AuthSourceConfig;
}

/** Human readable identity for logs: ["oauth", email] or ["api_key", key] (Go: Auth.AccountInfo). */
export function accountInfo(auth: Auth | undefined): [string, string] {
  if (!auth) return ["", ""];
  switch (authKind(auth)) {
    case AuthKindOAuth: {
      const email = authMetadataString(auth, "email");
      if (email !== "") return ["oauth", email];
      const sa = auth.metadata?.service_account;
      if (sa && typeof sa === "object") {
        const clientEmail = (sa as Record<string, unknown>).client_email;
        if (typeof clientEmail === "string" && clientEmail.trim() !== "") return ["oauth", clientEmail.trim()];
      }
      return ["oauth", ""];
    }
    case AuthKindAPIKey:
      return ["api_key", authAttribute(auth, AttributeAPIKey)];
    default:
      return ["", ""];
  }
}

export function parseBoolAny(value: unknown): [boolean, boolean] {
  switch (typeof value) {
    case "boolean":
      return [value, true];
    case "number":
      return [value !== 0, true];
    case "string": {
      const trimmed = value.trim().toLowerCase();
      if (trimmed === "") return [false, false];
      if (["1", "t", "true"].includes(trimmed)) return [true, true];
      if (["0", "f", "false"].includes(trimmed)) return [false, true];
      return [false, false];
    }
    default:
      return [false, false];
  }
}

export function parseIntAny(value: unknown): [number, boolean] {
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? [Math.trunc(value), true] : [0, false];
    case "string": {
      const trimmed = value.trim();
      if (trimmed === "" || !/^[+-]?\d+$/.test(trimmed)) return [0, false];
      return [Number(trimmed), true];
    }
    default:
      return [0, false];
  }
}

/**
 * The auth-scoped disable_cooling override when present; the second value
 * distinguishes explicit false from an absent override (Go: Auth.DisableCoolingOverride).
 */
export function disableCoolingOverride(auth: Auth | undefined): [boolean, boolean] {
  if (!auth || !auth.metadata) return [false, false];
  for (const key of ["disable_cooling", "disable-cooling"]) {
    if (key in auth.metadata) {
      const [parsed, ok] = parseBoolAny(auth.metadata[key]);
      if (ok) return [parsed, true];
    }
  }
  return [false, false];
}

/** Whether the proxy_ tool name prefix should be skipped for this auth (Go: Auth.ToolPrefixDisabled). */
export function toolPrefixDisabled(auth: Auth | undefined): boolean {
  if (!auth || !auth.metadata) return false;
  for (const key of ["tool_prefix_disabled", "tool-prefix-disabled"]) {
    if (key in auth.metadata) {
      const [parsed, ok] = parseBoolAny(auth.metadata[key]);
      if (ok) return parsed;
    }
  }
  return false;
}

/** The auth-scoped request_retry override; negatives count as unset (Go: Auth.RequestRetryOverride). */
export function requestRetryOverride(auth: Auth | undefined): [number, boolean] {
  if (!auth || !auth.metadata) return [0, false];
  for (const key of ["request_retry", "request-retry"]) {
    if (key in auth.metadata) {
      const [parsed, ok] = parseIntAny(auth.metadata[key]);
      if (ok) {
        if (parsed < 0) return [0, false];
        return [parsed, true];
      }
    }
  }
  return [0, false];
}

/** Routing priority from the attributes; higher wins, invalid values are 0 (Go: authPriority). */
export function authPriority(auth: Auth | undefined): number {
  const raw = authAttribute(auth, AttributePriority);
  if (raw === "" || !/^[+-]?\d+$/.test(raw)) return 0;
  return Number(raw);
}

/** Copies a valid file priority into metadata and routing attributes (Go: ApplyAuthPriorityMetadata). */
export function applyAuthPriorityMetadata(auth: Auth, metadata: Record<string, unknown>): void {
  if (!auth.attributes) auth.attributes = {};
  delete auth.attributes[AttributeFilePriority];
  if (!("priority" in metadata)) return;
  const raw = metadata.priority;
  let priority = "";
  if (typeof raw === "number") {
    priority = String(Math.trunc(raw));
  } else if (typeof raw === "string") {
    priority = raw.trim();
    if (!/^[+-]?\d+$/.test(priority)) return;
  } else {
    return;
  }
  if (!auth.metadata) auth.metadata = {};
  auth.metadata.priority = raw;
  auth.attributes.priority = priority;
  auth.attributes[AttributeFilePriority] = "true";
}

/** Model key without a thinking suffix: "model(high)" -> "model" (Go: canonicalModelKey). */
export function canonicalModelKey(model: string): string {
  const trimmed = (model ?? "").trim();
  if (trimmed === "") return "";
  const parsed = parseSuffix(trimmed);
  const name = parsed.modelName.trim();
  return name === "" ? trimmed : name;
}

export function authAccessToken(auth: Auth | undefined): string {
  const token = authMetadataString(auth, "access_token");
  return token !== "" ? token : authMetadataString(auth, "accessToken");
}

export function authRefreshToken(auth: Auth | undefined): string {
  const token = authMetadataString(auth, "refresh_token");
  return token !== "" ? token : authMetadataString(auth, "refreshToken");
}

/** Whether the credential can be refreshed at all (Go: authHasRefreshCredential, without SIWC/Meta). */
export function authHasRefreshCredential(auth: Auth | undefined): boolean {
  return authRefreshToken(auth) !== "";
}

/**
 * Whether the authentication material changed between two records
 * (Go: CredentialsChanged, without the SIWC section).
 */
export function credentialsChanged(existing: Auth | undefined, incoming: Auth | undefined): boolean {
  if (!existing || !incoming) return false;
  if (authAccessToken(existing) !== authAccessToken(incoming)) return true;
  if (authRefreshToken(existing) !== authRefreshToken(incoming)) return true;
  const idToken = (auth: Auth) => {
    const value = authMetadataString(auth, "id_token");
    return value !== "" ? value : authMetadataString(auth, "idToken");
  };
  if (idToken(existing) !== idToken(incoming)) return true;
  const apiKey = (auth: Auth) => {
    const value = authAttribute(auth, AttributeAPIKey);
    return value !== "" ? value : authMetadataString(auth, "api_key");
  };
  return apiKey(existing) !== apiKey(incoming);
}

// ---------------------------------------------------------------------------
// Expiry helpers (Go: expirationFromMap, parseJWTExp, ExpirationTime, ...)
// ---------------------------------------------------------------------------

const expireKeys = ["expired", "expire", "expires_at", "expiresAt", "expiry", "expires"];

/** Normalises a unix timestamp in seconds or milliseconds into epoch ms (Go: normaliseUnix). */
export function normaliseUnix(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw > 1_000_000_000_000) return Math.trunc(raw);
  return Math.trunc(raw * 1000);
}

/** Parses RFC3339 strings, "YYYY-MM-DD HH:MM[:SS]" and unix numbers into epoch ms (Go: parseTimeValue). */
export function parseTimeValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    const ts = normaliseUnix(value);
    return ts > 0 ? ts : undefined;
  }
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (s === "") return undefined;
  if (/^-?\d+$/.test(s)) {
    const ts = normaliseUnix(Number(s));
    return ts > 0 ? ts : undefined;
  }
  let candidate = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) candidate = s.replace(" ", "T") + "Z";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(candidate)) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(candidate)) candidate += "Z";
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function base64UrlDecode(segment: string): string | undefined {
  let normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  switch (normalized.length % 4) {
    case 2:
      normalized += "==";
      break;
    case 3:
      normalized += "=";
      break;
    default:
      break;
  }
  try {
    const bin = atob(normalized);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** The "exp" claim of a JWT as epoch ms without signature verification (Go: parseJWTExp). */
export function parseJWTExp(token: string): number | undefined {
  const trimmed = (token ?? "").trim();
  if (trimmed === "") return undefined;
  const parts = trimmed.split(".");
  if (parts.length !== 3) return undefined;
  const payload = base64UrlDecode(parts[1]!);
  if (payload === undefined) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== "object") return undefined;
  const exp = (claims as Record<string, unknown>).exp;
  if (typeof exp === "number") return exp > 0 ? normaliseUnix(exp) : undefined;
  if (typeof exp === "string" && /^\d+$/.test(exp.trim())) {
    const seconds = Number(exp.trim());
    return seconds > 0 ? normaliseUnix(seconds) : undefined;
  }
  return undefined;
}

function parseRelativeExpirySeconds(meta: Record<string, unknown>): number | undefined {
  for (const key of ["expires_in", "expiresIn"]) {
    if (key in meta) {
      const [seconds, ok] = parseIntAny(meta[key]);
      if (ok && seconds > 0) return seconds;
    }
  }
  return undefined;
}

function parseRelativeExpiryTimestamp(meta: Record<string, unknown>): number | undefined {
  for (const key of ["timestamp", "issued_at", "issuedAt"]) {
    if (key in meta) {
      const ts = parseTimeValue(meta[key]);
      if (ts !== undefined && ts > 0) return ts;
    }
  }
  return undefined;
}

/** Expiry timestamp (epoch ms) found in the token metadata (Go: expirationFromMap). */
export function expirationFromMetadata(meta: Record<string, unknown> | undefined): number | undefined {
  if (!meta) return undefined;
  for (const key of expireKeys) {
    if (key in meta) {
      const ts = parseTimeValue(meta[key]);
      if (ts !== undefined) return ts;
    }
  }
  const expiresIn = parseRelativeExpirySeconds(meta);
  if (expiresIn !== undefined) {
    const issued = parseRelativeExpiryTimestamp(meta);
    if (issued !== undefined) return issued + expiresIn * 1000;
  }
  for (const nestedKey of ["token", "Token"]) {
    const nested = meta[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const ts = expirationFromMetadata(nested as Record<string, unknown>);
      if (ts !== undefined) return ts;
    }
  }
  return undefined;
}

/**
 * The credential expiration timestamp: the access token's JWT exp when it is one,
 * otherwise the expiry metadata (Go: Auth.ExpirationTime / OuterExpirationTime).
 */
export function expirationTime(auth: Auth | undefined): number | undefined {
  if (!auth) return undefined;
  const token = authAccessToken(auth);
  if (token !== "") {
    const exp = parseJWTExp(token);
    if (exp !== undefined) return exp;
  }
  return expirationFromMetadata(auth.metadata);
}

/** Expiry of the access token; undefined when there is no access token (Go: Auth.AccessTokenExpirationTime). */
export function accessTokenExpirationTime(auth: Auth | undefined): number | undefined {
  if (!auth) return undefined;
  const token = authAccessToken(auth);
  if (token === "") return undefined;
  const exp = parseJWTExp(token);
  if (exp !== undefined) return exp;
  return expirationTime(auth);
}

/** Whether the auth has a non-empty access token that is unexpired at `nowMs` (Go: Auth.HasValidAccessToken). */
export function hasValidAccessToken(auth: Auth | undefined, nowMs: number): boolean {
  if (!auth || authAccessToken(auth) === "") return false;
  const exp = accessTokenExpirationTime(auth);
  if (exp === undefined) return true;
  return exp > nowMs;
}

function durationFromAny(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.trunc(value * 1000) : 0;
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (!match) return 0;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return Math.trunc(amount);
    case "s":
      return Math.trunc(amount * 1000);
    case "m":
      return Math.trunc(amount * 60_000);
    default:
      return Math.trunc(amount * 3_600_000);
  }
}

/** Operator supplied refresh interval in ms, 0 when unset (Go: authPreferredInterval). */
export function authPreferredRefreshIntervalMs(auth: Auth | undefined): number {
  if (!auth) return 0;
  const keys = ["refresh_interval_seconds", "refreshIntervalSeconds", "refresh_interval", "refreshInterval"];
  for (const key of keys) {
    const value = auth.metadata?.[key];
    if (value !== undefined) {
      const d = durationFromAny(value);
      if (d > 0) return d;
    }
  }
  for (const key of keys) {
    const value = auth.attributes?.[key];
    if (value !== undefined) {
      const d = durationFromAny(value);
      if (d > 0) return d;
    }
  }
  return 0;
}

/** Timestamp of the last refresh recorded in metadata (Go: authLastRefreshTimestamp). */
export function authLastRefreshTimestamp(auth: Auth | undefined): number | undefined {
  if (!auth || !auth.metadata) return undefined;
  for (const key of ["last_refresh", "lastRefresh", "last_refreshed_at", "lastRefreshedAt"]) {
    if (key in auth.metadata) {
      const ts = parseTimeValue(auth.metadata[key]);
      if (ts !== undefined && ts > 0) return ts;
    }
  }
  return undefined;
}

// Shared helpers for turning a stored JSON credential document into an Auth and
// back. Port of the metadata handling spread across sdk/auth/filestore.go,
// sdk/cliproxy/auth/metadata_keys.go, weight.go, priority.go and
// custom_headers.go, reduced to the three kept providers. Both the file store
// and the Vault store persist exactly this document shape so records can be
// migrated between backends by copying.
import {
  AttributeAPIKey,
  AttributeBaseURL,
  AttributePath,
  AttributePriority,
  AttributeSource,
  AttributeSourceBackend,
  AttributeWeight,
  StatusActive,
  StatusDisabled,
  newAuth,
  type Auth,
} from "../auth/types.ts";
import type { TokenStore } from "./types.ts";
import { isObject } from "../util/json.ts";

/** Options accepted by the concrete stores' save() beyond the TokenStore contract. */
export interface SaveOptions {
  /**
   * Allow creating a record for a disabled credential that does not exist yet.
   * Runtime updates (token refreshes) must not recreate a disabled credential
   * whose record was deliberately removed; login and migration set this flag.
   * Port of cliproxyauth.WithAuthCreationIntent.
   */
  createDisabled?: boolean;
}

/** TokenStore whose save() also accepts SaveOptions (both built-in stores do). */
export interface PersistingTokenStore extends TokenStore {
  save(auth: Auth, options?: SaveOptions): Promise<string>;
}

/** Largest positive credential routing weight (internal/credentialweight). */
export const MaxCredentialWeight = 1_000_000;
/** Weight used when a credential does not define one. */
export const DefaultCredentialWeight = 1;

/**
 * Returns the canonical snake_case name for credential metadata keys that
 * previously also accepted config-style (kebab-case) aliases.
 */
export function canonicalCredentialMetadataKey(key: string): string {
  switch (key) {
    case "api-key":
      return "api_key";
    case "base-url":
      return "base_url";
    case "disable-cooling":
      return "disable_cooling";
    case "excluded-models":
      return "excluded_models";
    case "model-aliases":
      return "model_aliases";
    case "proxy-url":
      return "proxy_url";
    case "request-retry":
      return "request_retry";
    case "request-scoped-errors":
      return "request_scoped_errors";
    case "tool-prefix-disabled":
      return "tool_prefix_disabled";
    default:
      return key;
  }
}

/**
 * Rewrites recognised legacy keys to their canonical snake_case names in place.
 * An explicitly present canonical value wins over the legacy spelling.
 */
export function normalizeCredentialMetadata(metadata: Record<string, unknown> | undefined | null): void {
  if (!metadata) return;
  for (const key of Object.keys(metadata)) {
    const canonical = canonicalCredentialMetadataKey(key);
    if (canonical === key) continue;
    if (!(canonical in metadata)) metadata[canonical] = metadata[key];
    delete metadata[key];
  }
}

/** Validates and normalises an explicit weight; non-positive values become 0. */
export function normalizeWeight(weight: number): number {
  if (!Number.isFinite(weight) || Math.trunc(weight) !== weight) {
    throw new Error("weight must be an integer");
  }
  if (weight <= 0) return 0;
  if (weight > MaxCredentialWeight) throw new Error(`weight must not exceed ${MaxCredentialWeight}`);
  return weight;
}

/** Parses a scheduler attribute string; empty uses the default weight. */
export function parseWeightString(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return DefaultCredentialWeight;
  if (!/^[-+]?\d+$/.test(trimmed)) throw new Error("weight must be an integer");
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error("weight must be an integer: value out of range");
  return normalizeWeight(value);
}

/** Parses a JSON-compatible auth-file metadata weight value. */
export function parseWeightValue(value: unknown): number {
  if (typeof value === "number") return normalizeWeight(value);
  if (typeof value === "string") return parseWeightString(value);
  throw new Error("weight must be an integer");
}

/** Throws when the auth carries an invalid weight in attributes or metadata. */
export function validateAuthWeight(auth: Pick<Auth, "attributes" | "metadata"> | undefined): void {
  if (!auth) return;
  const attrWeight = auth.attributes?.[AttributeWeight];
  if (attrWeight !== undefined) {
    try {
      parseWeightString(attrWeight);
    } catch (err) {
      throw new Error(`invalid attributes weight: ${(err as Error).message}`);
    }
  }
  if (auth.metadata && AttributeWeight in auth.metadata) {
    try {
      parseWeightValue(auth.metadata[AttributeWeight]);
    } catch (err) {
      throw new Error(`invalid metadata weight: ${(err as Error).message}`);
    }
  }
}

/** Copies a valid metadata weight onto the weight attribute. */
export function applyAuthWeightMetadata(auth: Auth, metadata: Record<string, unknown>): void {
  validateAuthWeight(auth);
  if (!(AttributeWeight in metadata)) return;
  const weight = parseWeightValue(metadata[AttributeWeight]);
  auth.attributes[AttributeWeight] = String(weight);
}

/** Copies a metadata priority (number or numeric string) onto the priority attribute. */
export function applyAuthPriorityMetadata(auth: Auth, metadata: Record<string, unknown>): void {
  if (!("priority" in metadata)) return;
  const raw = metadata.priority;
  let priority = "";
  if (typeof raw === "number" && Number.isFinite(raw)) priority = String(Math.trunc(raw));
  else if (typeof raw === "string") {
    priority = raw.trim();
    if (!/^[-+]?\d+$/.test(priority)) return;
  } else return;
  auth.metadata.priority = raw;
  auth.attributes[AttributePriority] = priority;
}

/** Extracts non-empty string headers from a metadata "headers" object. */
export function extractCustomHeadersFromMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = metadata.headers;
  if (!isObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim();
    if (name === "" || typeof value !== "string") continue;
    const val = value.trim();
    if (val === "") continue;
    out[name] = val;
  }
  return out;
}

/** Stores metadata headers as "header:<name>" attributes. */
export function applyCustomHeadersFromMetadata(auth: Auth): void {
  const headers = extractCustomHeadersFromMetadata(auth.metadata);
  for (const [name, value] of Object.entries(headers)) auth.attributes[`header:${name}`] = value;
}

/** Reads access_token from top level or nested token.access_token. */
export function extractAccessToken(metadata: Record<string, unknown>): string {
  const top = metadata.access_token;
  if (typeof top === "string" && top.trim() !== "") return top.trim();
  const token = metadata.token;
  if (isObject(token)) {
    const nested = token.access_token;
    if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
  }
  return "";
}

/**
 * Maps the `type` field of a stored credential document to an Auth provider.
 * Gemini CLI OAuth files are written with type "gemini" (v7.0.12 layout) and
 * are served by the "gemini-cli" provider.
 */
export function providerFromRecordType(type: string): string {
  const normalized = type.trim().toLowerCase();
  switch (normalized) {
    case "":
      return "unknown";
    case "gemini":
    case "gemini-cli":
      return "gemini-cli";
    case "claude":
    case "anthropic":
      return "claude";
    case "codex":
      return "codex";
    default:
      return normalized;
  }
}

/** Inverse of providerFromRecordType, used when a record lacks `type`. */
export function recordTypeFromProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "gemini-cli") return "gemini";
  return normalized;
}

/** Picks a human readable label from stored metadata (label, email, project_id). */
export function labelFor(metadata: Record<string, unknown>): string {
  for (const key of ["label", "email", "project_id"]) {
    const value = metadata[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** Prefix as stored in metadata: trimmed, without surrounding slashes, single segment only. */
export function prefixFromMetadata(metadata: Record<string, unknown>): string {
  const raw = metadata.prefix;
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed.includes("/")) return "";
  return trimmed;
}

export interface RecordLocation {
  /** Store specific location (file path or Vault data path). */
  path: string;
  /** AuthSourceFile or AuthSourceVault. */
  sourceBackend: string;
  /** Record modification time in epoch ms (0 = unknown). */
  modifiedAt: number;
}

/**
 * Builds the runtime Auth for a stored credential document. The document
 * (already parsed) becomes Auth.metadata as-is after key normalisation.
 * Returns undefined when the document must be skipped (empty or invalid weight).
 */
export function authFromStoredRecord(id: string, document: Record<string, unknown>, location: RecordLocation): Auth | undefined {
  const metadata = document;
  normalizeCredentialMetadata(metadata);
  try {
    validateAuthWeight({ attributes: {}, metadata });
  } catch {
    return undefined;
  }
  const type = typeof metadata.type === "string" ? metadata.type : "";
  const provider = providerFromRecordType(type);
  const disabled = metadata.disabled === true;
  const proxyUrl = typeof metadata.proxy_url === "string" ? metadata.proxy_url.trim() : "";
  const auth = newAuth({
    id,
    provider,
    label: labelFor(metadata),
    prefix: prefixFromMetadata(metadata),
    proxyUrl,
    status: disabled ? StatusDisabled : StatusActive,
    disabled,
    attributes: {
      [AttributePath]: location.path,
      [AttributeSource]: location.path,
      [AttributeSourceBackend]: location.sourceBackend,
    },
    metadata,
    createdAt: location.modifiedAt,
    updatedAt: location.modifiedAt,
  });
  const email = metadata.email;
  if (typeof email === "string" && email !== "") auth.attributes.email = email;
  if (typeof metadata.api_key === "string" && metadata.api_key !== "") auth.attributes[AttributeAPIKey] = metadata.api_key;
  if (typeof metadata.base_url === "string" && metadata.base_url !== "") auth.attributes[AttributeBaseURL] = metadata.base_url;
  applyAuthWeightMetadata(auth, metadata);
  applyAuthPriorityMetadata(auth, metadata);
  applyCustomHeadersFromMetadata(auth);
  return auth;
}

/**
 * Builds the JSON document persisted for an Auth: its metadata plus the
 * `type` / `disabled` flags and, when the Auth carries them but the metadata
 * does not, the routing fields (proxy_url, prefix, label).
 */
export function recordFromAuth(auth: Auth): Record<string, unknown> {
  normalizeCredentialMetadata(auth.metadata);
  const document = auth.metadata;
  if (typeof document.type !== "string" || document.type.trim() === "") {
    const type = recordTypeFromProvider(auth.provider);
    if (type !== "" && type !== "unknown") document.type = type;
  }
  document.disabled = auth.disabled;
  if (auth.proxyUrl && !("proxy_url" in document)) document.proxy_url = auth.proxyUrl;
  if (auth.prefix && !("prefix" in document)) document.prefix = auth.prefix;
  if (auth.label && !("label" in document) && labelFor(document) === "") document.label = auth.label;
  return document;
}

/** Deep JSON equality (object key order insensitive). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    return keysA.every((key) => key in b && jsonEqual(a[key], b[key]));
  }
  return false;
}

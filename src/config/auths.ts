// Synthesises Auth records from the API-key lists of the config. Port of the
// config half of internal/watcher/synthesizer/config.go and helpers.go
// (CLIProxyAPI), reduced to the four kept credential families.
import {
  AttributeAPIKey,
  AttributeAuthKind,
  AttributeBaseURL,
  AttributeConfigIndex,
  AttributePriority,
  AttributeRuntimeOnly,
  AttributeSource,
  AttributeSourceBackend,
  AttributeWeight,
  AuthSourceConfig,
  StatusActive,
  newAuth,
  type Auth,
} from "../auth/types.ts";
import { formatSortedHeaders, validateCredentialWeights } from "./load.ts";
import type { ApiKeyCredential, Config, ModelOverride } from "./types.ts";

/**
 * Generates stable, deterministic ids for auth entries: `<kind>:<12 hex of
 * sha256(kind, NUL part, ...)>`, with a `-N` suffix on collisions within one
 * generator. Not safe for concurrent use (same as upstream).
 */
export class StableIDGenerator {
  private readonly counters = new Map<string, number>();

  /** Returns [id, short] where id = `${kind}:${short}`. */
  next(kind: string, ...parts: string[]): [string, string] {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(kind);
    for (const part of parts) {
      hasher.update(new Uint8Array([0]));
      hasher.update(part.trim());
    }
    let digest = hasher.digest("hex");
    if (digest.length < 12) digest = digest.padStart(12, "0");
    let short = digest.slice(0, 12);
    const key = `${kind}:${short}`;
    const index = this.counters.get(key) ?? 0;
    this.counters.set(key, index + 1);
    if (index > 0) short = `${short}-${index}`;
    return [`${kind}:${short}`, short];
  }
}

export interface SynthesizeOptions {
  /** Clock for createdAt/updatedAt (epoch ms). */
  now?: () => number;
  /** Id generator; a fresh one is used per call when omitted. */
  idGenerator?: StableIDGenerator;
}

interface Family {
  entries: ApiKeyCredential[];
  /** Auth.provider value. */
  provider: string;
  /** Id kind and source tag, e.g. "claude" -> "claude:apikey" / "config:claude[...]". */
  tag: string;
}

/**
 * Builds one Auth per configured API key. Ids are deterministic (hash of
 * provider, key, base URL, proxy, prefix and headers) so restarts and config
 * reloads keep the same identity for unchanged credentials.
 */
export function synthesizeApiKeyAuths(cfg: Config | undefined | null, options: SynthesizeOptions = {}): Auth[] {
  const out: Auth[] = [];
  if (!cfg) return out;
  validateCredentialWeights(cfg);
  const now = options.now ?? Date.now;
  const idGen = options.idGenerator ?? new StableIDGenerator();
  const families: Family[] = [
    { entries: cfg.geminiApiKeys, provider: "aistudio", tag: "gemini" },
    { entries: cfg.claudeApiKeys, provider: "claude", tag: "claude" },
    { entries: cfg.codexApiKeys, provider: "codex", tag: "codex" },
    { entries: cfg.openaiApiKeys, provider: "openai", tag: "openai" },
  ];
  for (const family of families) out.push(...synthesizeFamily(family, now(), idGen));
  return out;
}

function synthesizeFamily(family: Family, now: number, idGen: StableIDGenerator): Auth[] {
  const out: Auth[] = [];
  family.entries.forEach((entry, index) => {
    const key = entry.apiKey.trim();
    const base = entry.baseUrl.trim();
    if (key === "" && base === "") return;
    const prefix = entry.prefix.trim();
    const proxyUrl = entry.proxyUrl.trim();
    const [id, token] = idGen.next(`${family.tag}:apikey`, key, base, proxyUrl, prefix, formatSortedHeaders(entry.headers));
    const attrs: Record<string, string> = {
      [AttributeSource]: `config:${family.tag}[${token}]`,
      [AttributeSourceBackend]: AuthSourceConfig,
      [AttributeConfigIndex]: String(index),
      [AttributeRuntimeOnly]: "true",
    };
    if (key !== "") attrs[AttributeAPIKey] = key;
    if (base !== "") attrs[AttributeBaseURL] = base;
    if (entry.priority !== 0) attrs[AttributePriority] = String(entry.priority);
    addWeightToAttrs(entry.weight, attrs);
    const modelsHash = computeModelsHash(entry.models);
    if (modelsHash !== "") attrs.models_hash = modelsHash;
    addConfigHeadersToAttrs(entry.headers, attrs);

    const metadata: Record<string, unknown> = {};
    if (entry.disableCooling !== undefined) metadata.disable_cooling = entry.disableCooling;
    addRequestRetryToMetadata(entry.requestRetry, metadata);

    const auth = newAuth({
      id,
      provider: family.provider,
      label: entry.label.trim() || `${family.tag}-apikey`,
      prefix,
      status: StatusActive,
      proxyUrl,
      attributes: attrs,
      metadata,
      createdAt: now,
      updatedAt: now,
    });
    applyAuthExcludedModelsMeta(auth, entry.excludedModels, "apikey");
    out.push(auth);
  });
  return out;
}

/** Writes a non-negative weight attribute when the credential sets one. */
export function addWeightToAttrs(weight: number | undefined, attrs: Record<string, string>): void {
  if (weight === undefined) return;
  attrs[AttributeWeight] = String(weight <= 0 ? 0 : weight);
}

/** Copies headers into "header:<name>" attributes, skipping blank names/values. */
export function addConfigHeadersToAttrs(headers: Record<string, string> | undefined | null, attrs: Record<string, string> | undefined | null): void {
  if (!headers || !attrs) return;
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    const value = (rawValue ?? "").trim();
    if (key === "" || value === "") continue;
    attrs[`header:${key}`] = value;
  }
}

/** Copies a per-credential request-retry override; undefined/negative are unset. */
export function addRequestRetryToMetadata(requestRetry: number | undefined, metadata: Record<string, unknown> | undefined | null): void {
  if (requestRetry === undefined || requestRetry < 0 || !metadata) return;
  metadata.request_retry = requestRetry;
}

/**
 * Stores the credential's own excluded-model patterns (lower-cased, sorted,
 * comma joined) and their hash on the auth, and marks the auth kind.
 */
export function applyAuthExcludedModelsMeta(auth: Auth, perKey: string[] | undefined, authKind: string): void {
  const seen = new Set<string>();
  for (const entry of perKey ?? []) {
    const trimmed = entry.trim();
    if (trimmed !== "") seen.add(trimmed.toLowerCase());
  }
  const combined = [...seen].sort();
  const hash = computeExcludedModelsHash(combined);
  if (hash !== "") auth.attributes.excluded_models_hash = hash;
  if (combined.length > 0) auth.attributes.excluded_models = combined.join(",");
  if (authKind !== "") auth.attributes[AttributeAuthKind] = authKind;
}

/** Stable hash of exclusion patterns ("" when empty). */
export function computeExcludedModelsHash(excluded: string[]): string {
  const normalized = excluded.map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  if (normalized.length === 0) return "";
  return sha256Hex(normalized.sort().join("\n"));
}

/** Stable hash of a credential's model overrides ("" when none). */
export function computeModelsHash(models: ModelOverride[] | undefined): string {
  if (!models || models.length === 0) return "";
  const canonical = models.map((m) => ({
    name: m.name,
    alias: m.alias,
    displayName: m.displayName,
    maxContextLength: m.maxContextLength,
    isCompat: m.isCompat,
    forceMapping: m.forceMapping,
    thinking: m.thinking ?? null,
  }));
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * Returns the model overrides configured for a synthesized API-key auth
 * (looked up by provider and config_index), or [] for OAuth auths.
 */
export function modelOverridesFor(cfg: Config, auth: Auth): ModelOverride[] {
  if (auth.attributes[AttributeSourceBackend] !== AuthSourceConfig) return [];
  const index = Number(auth.attributes[AttributeConfigIndex]);
  if (!Number.isInteger(index) || index < 0) return [];
  const list = entriesForProvider(cfg, auth.provider);
  return list[index]?.models ?? [];
}

function entriesForProvider(cfg: Config, provider: string): ApiKeyCredential[] {
  switch (provider) {
    case "aistudio":
      return cfg.geminiApiKeys;
    case "claude":
      return cfg.claudeApiKeys;
    case "codex":
      return cfg.codexApiKeys;
    case "openai":
      return cfg.openaiApiKeys;
    default:
      return [];
  }
}

function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

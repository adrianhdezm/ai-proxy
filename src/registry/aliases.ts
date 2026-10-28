// Model alias and exclusion helpers. Port of applyOAuthModelAliasEntries, applyExcludedModels,
// matchWildcard and rewriteModelInfoName from sdk/cliproxy/service_models.go.
//
// A credential's model list is post-processed with these before it is registered:
//   models = applyExcludedModels(applyModelAliases(models, aliases), excluded)
import type { ModelInfo } from "./types.ts";
import { cloneModelInfo } from "./model_definitions.ts";

/** One configured alias (Go: config.OAuthModelAlias). */
export interface ModelAlias {
  /** Upstream model id the alias points at. */
  name: string;
  /** Public id clients use. */
  alias: string;
  /** Keep the original id listed alongside the alias instead of renaming it. */
  fork?: boolean;
  /** Optional display name for the alias entry; defaults to the upstream display name. */
  displayName?: string;
}

/**
 * Rewrites or forks model ids according to alias entries (Go: applyOAuthModelAliasEntries).
 * Alias entries carry `metadataModelId` = the upstream id so executors can resolve them.
 */
export function applyModelAliases(models: ReadonlyArray<ModelInfo>, aliases: ReadonlyArray<ModelAlias>): ModelInfo[] {
  if (models.length === 0 || aliases.length === 0) return [...models];

  const forward = new Map<string, Array<{ alias: string; displayName: string; fork: boolean }>>();
  for (const entry of aliases) {
    const name = entry.name.trim();
    const alias = entry.alias.trim();
    if (name === "" || alias === "") continue;
    if (name.toLowerCase() === alias.toLowerCase()) continue;
    const key = name.toLowerCase();
    const list = forward.get(key) ?? [];
    list.push({ alias, displayName: (entry.displayName ?? "").trim(), fork: entry.fork === true });
    forward.set(key, list);
  }
  if (forward.size === 0) return [...models];

  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model) continue;
    const id = model.id.trim();
    if (id === "") continue;
    const key = id.toLowerCase();
    const entries = forward.get(key);
    if (!entries || entries.length === 0) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
      continue;
    }

    const keepOriginal = entries.some((e) => e.fork);
    if (keepOriginal && !seen.has(key)) {
      seen.add(key);
      out.push(model);
    }

    let addedAlias = false;
    for (const entry of entries) {
      const mappedId = entry.alias;
      if (mappedId === "" || mappedId.toLowerCase() === id.toLowerCase()) continue;
      const aliasKey = mappedId.toLowerCase();
      if (seen.has(aliasKey)) continue;
      seen.add(aliasKey);
      const clone = cloneModelInfo(model);
      clone.id = mappedId;
      clone.metadataModelId = model.metadataModelId || id;
      if (entry.displayName !== "") clone.displayName = entry.displayName;
      if (clone.name) clone.name = rewriteModelInfoName(clone.name, id, mappedId);
      out.push(clone);
      addedAlias = true;
    }

    if (!keepOriginal && !addedAlias) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
  }
  return out;
}

/** Rewrites a Gemini-style "models/<id>" name when the id is aliased (Go: rewriteModelInfoName). */
export function rewriteModelInfoName(name: string, oldId: string, newId: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return name;
  oldId = oldId.trim();
  newId = newId.trim();
  if (oldId === "" || newId === "") return name;
  if (oldId.toLowerCase() === newId.toLowerCase()) return name;
  if (trimmed.toLowerCase() === oldId.toLowerCase()) return newId;
  if (trimmed.endsWith("/" + oldId)) return trimmed.slice(0, trimmed.length - oldId.length) + newId;
  if (trimmed === "models/" + oldId) return "models/" + newId;
  return name;
}

/**
 * Drops models whose id matches an exclusion pattern (Go: applyExcludedModels).
 * Patterns are case-insensitive and may contain `*` wildcards.
 */
export function applyExcludedModels(models: ReadonlyArray<ModelInfo>, excluded: ReadonlyArray<string>): ModelInfo[] {
  if (models.length === 0 || excluded.length === 0) return [...models];
  const patterns = excluded.map((p) => p.trim().toLowerCase()).filter((p) => p !== "");
  if (patterns.length === 0) return [...models];
  return models.filter((model) => {
    if (!model) return false;
    const modelId = model.id.trim().toLowerCase();
    return !patterns.some((pattern) => matchWildcard(pattern, modelId));
  });
}

/** Simple `*` wildcard matcher (Go: matchWildcard). */
export function matchWildcard(pattern: string, value: string): boolean {
  if (pattern === "") return false;
  if (!pattern.includes("*")) return pattern === value;
  const parts = pattern.split("*");
  const prefix = parts[0]!;
  if (prefix !== "") {
    if (!value.startsWith(prefix)) return false;
    value = value.slice(prefix.length);
  }
  const suffix = parts[parts.length - 1]!;
  if (suffix !== "") {
    if (!value.endsWith(suffix)) return false;
    value = value.slice(0, value.length - suffix.length);
  }
  for (let i = 1; i < parts.length - 1; i++) {
    const segment = parts[i]!;
    if (segment === "") continue;
    const idx = value.indexOf(segment);
    if (idx < 0) return false;
    value = value.slice(idx + segment.length);
  }
  return true;
}

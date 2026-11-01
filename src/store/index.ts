// Token store factory and migration helper.
import type { Auth } from "../auth/types.ts";
import type { AuthConfig } from "../config/types.ts";
import { log } from "../log.ts";
import { FileTokenStore } from "./file.ts";
import type { PersistingTokenStore, SaveOptions } from "./record.ts";
import type { TokenStore } from "./types.ts";
import { VaultTokenStore, type FetchLike, type VaultStoreOptions } from "./vault.ts";

export { FileTokenStore } from "./file.ts";
export { VaultTokenStore, VaultError } from "./vault.ts";
export type { VaultStoreOptions, VaultAppRole, FetchLike } from "./vault.ts";
export type { SaveOptions, PersistingTokenStore } from "./record.ts";
export type { TokenStore } from "./types.ts";

export interface TokenStoreDeps {
  /** fetch used by the Vault store (tests inject a fake). */
  fetch?: FetchLike;
  /** Clock used by the Vault store for token lease expiry. */
  now?: () => number;
}

/** Builds the Vault store options from the auth config section. */
export function vaultOptionsFromConfig(auth: AuthConfig, deps: TokenStoreDeps = {}): VaultStoreOptions {
  const vault = auth.vault;
  const options: VaultStoreOptions = {
    address: vault.address,
    namespace: vault.namespace || undefined,
    mount: vault.mount,
    pathPrefix: vault.pathPrefix,
    token: vault.token || undefined,
    fetch: deps.fetch,
    now: deps.now,
  };
  if (vault.approle && vault.approle.roleId !== "") {
    options.approle = { roleId: vault.approle.roleId, secretId: vault.approle.secretId };
  }
  return options;
}

/** Creates the token store selected by `auth.store` ("file" or "vault"). */
export function createTokenStore(auth: AuthConfig, deps: TokenStoreDeps = {}): PersistingTokenStore {
  switch (auth.store) {
    case "file":
      if (auth.authDir.trim() === "") throw new Error("auth.auth-dir is required for the file store");
      return new FileTokenStore({ baseDir: auth.authDir });
    case "vault":
      if (auth.vault.address.trim() === "") throw new Error("auth.vault.address (or VAULT_ADDR) is required for the vault store");
      return new VaultTokenStore(vaultOptionsFromConfig(auth, deps));
    default:
      throw new Error(`unknown auth store ${JSON.stringify(auth.store)}; expected "file" or "vault"`);
  }
}

export interface MigrateOptions {
  /** Only list what would be copied. */
  dryRun?: boolean;
  /** Called for each record after it was copied (or would be, in a dry run). */
  onRecord?: (auth: Auth, targetId: string) => void;
  /** Copy ids matching this predicate only. */
  filter?: (auth: Auth) => boolean;
}

export interface MigrateResult {
  /** Ids copied (or that would be copied in a dry run). */
  copied: string[];
  /** Ids skipped by the filter. */
  skipped: string[];
  /** Ids that failed, with the error message (secrets are never included). */
  failed: { id: string; error: string }[];
}

/**
 * Copies every record from one store to another. Records keep their id so a
 * file `teamA/claude.json` becomes Vault key `<prefix>/teamA/claude.json` and
 * vice versa. Store-specific attributes (path, source, source_backend) are
 * dropped before saving so the target assigns its own.
 */
export async function migrate(from: TokenStore, to: TokenStore, options: MigrateOptions = {}): Promise<MigrateResult> {
  const result: MigrateResult = { copied: [], skipped: [], failed: [] };
  const records = await from.list();
  for (const record of records) {
    if (options.filter && !options.filter(record)) {
      result.skipped.push(record.id);
      continue;
    }
    const copy: Auth = structuredClone({ ...record, runtime: undefined });
    delete copy.attributes.path;
    delete copy.attributes.source;
    delete copy.attributes.source_backend;
    if (options.dryRun) {
      result.copied.push(record.id);
      options.onRecord?.(copy, record.id);
      continue;
    }
    try {
      const saveOptions: SaveOptions = { createDisabled: true };
      const targetId = await (to as PersistingTokenStore).save(copy, saveOptions);
      result.copied.push(record.id);
      options.onRecord?.(copy, targetId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("migrate: failed to copy record", { id: record.id, to: to.kind, error: message });
      result.failed.push({ id: record.id, error: message });
    }
  }
  return result;
}

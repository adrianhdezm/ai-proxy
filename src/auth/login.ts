// Login orchestration: maps a provider key to its authenticator, runs the
// login, merges settings from an existing record, optionally persists through
// a TokenStore, and exposes the refresh entry point used by executors and the
// auto-refresh loop. Port of sdk/auth/manager.go (Manager) and
// sdk/auth/refresh_registry.go (provider refresh leads), reduced to the three
// kept providers.
import type { TokenStore } from "../store/types.ts";
import { ClaudeAuthenticator } from "./claude/authenticator.ts";
import { findMatchingLegacyCredentialIn } from "./claude/filename.ts";
import { CodexAuthenticator } from "./codex/authenticator.ts";
import { GeminiAuthenticator } from "./gemini/authenticator.ts";
import { mergeExistingAuthMetadata } from "./oauth/metadata.ts";
import type { Authenticator, LoginOptions, RefreshOptions } from "./oauth/types.ts";
import type { Auth } from "./types.ts";

export type { Authenticator, LoginHooks, LoginOptions, PromptFn, RefreshOptions } from "./oauth/types.ts";
export { authExpirationTime, authNeedsRefresh, expirationFromMetadata, isAuthExpired, parseJWTExp } from "./oauth/expiry.ts";

/** Returned by authenticators that cannot refresh (port of ErrRefreshNotSupported). */
export class RefreshNotSupportedError extends Error {
  constructor(provider: string) {
    super(`cliproxy auth: refresh not supported for ${provider}`);
    this.name = "RefreshNotSupportedError";
  }
}

// Provider refresh-lead registry (refresh_registry.go). Values are ms;
// undefined means no proactive refresh.
const refreshLeadFactories = new Map<string, () => number | undefined>();

export function registerRefreshLead(provider: string, factory: () => number | undefined): void {
  refreshLeadFactories.set(provider.trim().toLowerCase(), factory);
}

/** Refresh lead for a provider key, in ms; undefined when none is registered. */
export function providerRefreshLead(provider: string): number | undefined {
  return refreshLeadFactories.get(provider.trim().toLowerCase())?.();
}

registerRefreshLead("codex", () => new CodexAuthenticator().refreshLead());
registerRefreshLead("claude", () => new ClaudeAuthenticator().refreshLead());
registerRefreshLead("gemini-cli", () => new GeminiAuthenticator().refreshLead());

/** The authenticators for the kept providers. */
export function defaultAuthenticators(): Authenticator[] {
  return [new ClaudeAuthenticator(), new CodexAuthenticator(), new GeminiAuthenticator()];
}

export interface LoginResult {
  /** The record produced by the authenticator (settings from an existing record merged in). */
  auth: Auth;
  /** Storage id returned by the TokenStore, or undefined when no store is attached. */
  savedId?: string;
}

export interface LoginManagerOptions {
  /** When set, login results are persisted and legacy Claude records migrated. */
  store?: TokenStore;
  authenticators?: Authenticator[];
}

/** Port of sdk/auth Manager. */
export class LoginManager {
  private readonly authenticators = new Map<string, Authenticator>();
  private store: TokenStore | undefined;

  constructor(opts: LoginManagerOptions = {}) {
    this.store = opts.store;
    for (const a of opts.authenticators ?? []) this.register(a);
  }

  /** Adds or replaces an authenticator keyed by its provider identifier. */
  register(authenticator: Authenticator): void {
    this.authenticators.set(authenticator.provider, authenticator);
  }

  setStore(store: TokenStore | undefined): void {
    this.store = store;
  }

  authenticator(provider: string): Authenticator | undefined {
    return this.authenticators.get(provider);
  }

  providers(): string[] {
    return [...this.authenticators.keys()];
  }

  /**
   * Runs the provider login. With a store attached: settings of an existing
   * record with the same id are inherited (never token payload keys), a
   * matching legacy Claude record is migrated, the record is saved and the
   * legacy record deleted.
   */
  async login(provider: string, opts?: LoginOptions): Promise<LoginResult> {
    const authenticator = this.authenticators.get(provider);
    if (!authenticator) throw new Error(`cliproxy auth: authenticator ${provider} not registered`);
    const record = await authenticator.login(opts);
    if (!record) throw new Error(`cliproxy auth: authenticator ${provider} returned nil record`);
    if (!this.store) return { auth: record };

    const existing = await this.store.list();
    const sameId = existing.find((a) => a.id === record.id);
    if (sameId) mergeExistingAuthMetadata(record, sameId.metadata);

    const legacy = findMatchingLegacyCredentialIn(existing, record);
    if (legacy) mergeExistingAuthMetadata(record, legacy.metadata);

    const savedId = await this.store.save(record);
    if (legacy) {
      if (savedId.trim() === "") throw new Error("cliproxy auth: canonical Claude credential was not persisted; legacy credential retained");
      try {
        await this.store.delete(legacy.id);
      } catch (err) {
        throw new Error(`cliproxy auth: canonical Claude credential saved but legacy credential cleanup failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return { auth: record, savedId };
  }

  /** Refreshes the credential through its provider's authenticator. */
  async refresh(provider: string, auth: Auth, opts?: RefreshOptions): Promise<Auth> {
    const authenticator = this.authenticators.get(provider) ?? this.authenticators.get(auth.provider);
    if (!authenticator) throw new RefreshNotSupportedError(provider);
    return authenticator.refresh(auth, opts);
  }

  /** Refresh lead (ms) of a registered provider; falls back to the global registry. */
  refreshLead(provider: string): number | undefined {
    const authenticator = this.authenticators.get(provider);
    if (authenticator) return authenticator.refreshLead();
    return providerRefreshLead(provider);
  }
}

/** A manager with the three kept providers registered. */
export function newLoginManager(store?: TokenStore): LoginManager {
  return new LoginManager({ store, authenticators: defaultAuthenticators() });
}

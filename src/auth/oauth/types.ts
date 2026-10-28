// Login contracts shared by the provider authenticators and the LoginManager.
// Port of LoginOptions / Authenticator from sdk/auth/interfaces.go. Kept in
// its own module so provider modules and login.ts avoid an import cycle.
import type { Auth } from "../types.ts";
import type { FetchLike } from "./http.ts";
import type { Clock, Sleep } from "./time.ts";

/** Interactive prompt used for the manual callback paste and project selection. */
export type PromptFn = (prompt: string) => Promise<string> | string;

/**
 * Hooks that make the interactive flows testable and embeddable. Everything
 * is optional; defaults are the real fetch, clock, browser and console.
 */
export interface LoginHooks {
  /** fetch used for every upstream call (token, profile, Code Assist). */
  fetch?: FetchLike;
  /** Clock for expiry stamps. */
  now?: Clock;
  /** Delay used by retry/poll loops. */
  sleep?: Sleep;
  /** Browser opener; returns false when nothing could be opened. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Console output; the authorization URL and progress lines go here. */
  print?: (line: string) => void;
  /** Called with the authorization URL and the bound callback port. */
  onAuthorizationUrl?: (url: string, callbackPort: number) => void;
  /** How long to wait for the browser callback (default 5 minutes). */
  callbackTimeoutMs?: number;
  /** Delay before the manual paste prompt is offered (default 15 seconds). */
  manualPromptDelayMs?: number;
  /** Interface the callback server binds (default all interfaces like upstream). */
  callbackHostname?: string;
}

/** Port of sdk/auth LoginOptions. */
export interface LoginOptions {
  /** Do not try to open a browser; only print the URL. */
  noBrowser?: boolean;
  /** Gemini: explicitly configured Google Cloud project id. */
  projectId?: string;
  /** Overrides the provider's default callback port (0 = ephemeral). */
  callbackPort?: number;
  /** Provider specific knobs (e.g. codex_login_mode=device). */
  metadata?: Record<string, string>;
  /** Interactive prompt; enables the paste-the-callback-URL fallback. */
  prompt?: PromptFn;
  /** Proxy for the upstream OAuth calls (Bun fetch `proxy`). */
  proxyUrl?: string;
  /** Cancels the login. */
  signal?: AbortSignal;
  hooks?: LoginHooks;
}

/** Options for a token refresh performed outside of login. */
export interface RefreshOptions {
  /** Overrides auth.proxyUrl. */
  proxyUrl?: string;
  fetch?: FetchLike;
  now?: Clock;
  sleep?: Sleep;
  signal?: AbortSignal;
}

/** Port of sdk/auth Authenticator plus the executor-side refresh entry point. */
export interface Authenticator {
  /** Provider key stored in Auth.provider ("claude", "codex", "gemini-cli"). */
  readonly provider: string;
  /** Runs the interactive login and returns the Auth to persist. */
  login(opts?: LoginOptions): Promise<Auth>;
  /** Refreshes the credential's tokens and returns the updated Auth. */
  refresh(auth: Auth, opts?: RefreshOptions): Promise<Auth>;
  /**
   * How long before expiry a proactive refresh should run, in ms.
   * undefined means the provider has no proactive refresh schedule.
   */
  refreshLead(): number | undefined;
}

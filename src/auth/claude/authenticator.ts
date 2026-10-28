// Claude Code OAuth login and refresh producing Auth records. Port of
// sdk/auth/claude.go (ClaudeAuthenticator) and the refresh part of
// internal/runtime/executor/claude_executor_auth.go.
//
// Auth record written by this module (Auth.provider = "claude", Auth.id = the
// upstream file name from credentialFileName). Auth.metadata keys match the
// Go auth JSON file (ClaudeTokenStorage) so files are interchangeable:
//   type               "claude"
//   access_token       OAuth access token
//   refresh_token      OAuth refresh token
//   expired            RFC3339 access token expiry
//   last_refresh       RFC3339 timestamp of the last exchange/refresh
//   email              account email
//   account_uuid       Anthropic account uuid (omitted when unknown)
//   organization_uuid  Anthropic organization uuid (omitted when unknown)
//   organization_name  organization display name (omitted when unknown)
//   claude_device_ids  single-entry device id pool (64 lowercase hex)
//   id_token           always "" (kept for file compatibility)
import { type Auth, cloneAuth, newAuth } from "../types.ts";
import { ErrCallbackTimeout, ErrCodeExchangeFailed, ErrInvalidState, ErrPortInUse, ErrServerStartFailed, newAuthenticationError, newOAuthError } from "../oauth/errors.ts";
import { announceAuthorizationUrl, isCallbackTimeout, waitForOAuthResult } from "../oauth/flow.ts";
import { metadataString, storeMetadataString } from "../oauth/metadata.ts";
import { generatePKCECodes, generateRandomState } from "../oauth/pkce.ts";
import { OAuthCallbackServer } from "../oauth/server.ts";
import { formatRFC3339 } from "../oauth/time.ts";
import type { Authenticator, LoginOptions, RefreshOptions } from "../oauth/types.ts";
import { ClaudeAuth } from "./claude_auth.ts";
import { credentialFileName } from "./filename.ts";
import { type ClaudeTokenStorage, claudeStorageToMetadata } from "./token.ts";

export const ClaudeDefaultCallbackPort = 54545;
/** Proactive refresh lead (4 hours). */
export const ClaudeRefreshLeadMs = 4 * 60 * 60_000;

/** Builds the Auth record persisted after a Claude login. */
export function buildClaudeAuthRecord(storage: ClaudeTokenStorage, nowMs: number = Date.now()): Auth {
  if (!storage.email) throw new Error("claude token storage missing account information");
  const fileName = credentialFileName(storage.email, storage.organization_uuid ?? "", storage.account_uuid ?? "");
  const auth = newAuth({ id: fileName, provider: "claude", label: storage.email, metadata: claudeStorageToMetadata(storage) });
  auth.createdAt = nowMs;
  auth.updatedAt = nowMs;
  auth.lastRefreshedAt = nowMs;
  return auth;
}

export class ClaudeAuthenticator implements Authenticator {
  readonly provider = "claude";
  callbackPort: number;

  constructor(opts: { callbackPort?: number } = {}) {
    this.callbackPort = opts.callbackPort ?? ClaudeDefaultCallbackPort;
  }

  refreshLead(): number | undefined {
    return ClaudeRefreshLeadMs;
  }

  async login(opts: LoginOptions = {}): Promise<Auth> {
    const hooks = opts.hooks ?? {};
    const callbackPort = opts.callbackPort !== undefined && opts.callbackPort >= 0 ? opts.callbackPort : this.callbackPort;
    const pkceCodes = generatePKCECodes();
    let state = generateRandomState();

    const server = new OAuthCallbackServer({
      port: callbackPort,
      callbackPath: "/callback",
      hostname: hooks.callbackHostname,
      platformUrl: "https://console.anthropic.com/",
      productName: "Claude",
    });
    try {
      server.start();
    } catch (err) {
      if ((err as Error).message.includes("already in use")) throw newAuthenticationError(ErrPortInUse, err);
      throw newAuthenticationError(ErrServerStartFailed, err);
    }

    try {
      const authSvc = new ClaudeAuth({ fetch: hooks.fetch, proxyUrl: opts.proxyUrl, now: hooks.now, sleep: hooks.sleep });
      const generated = authSvc.generateAuthURL(state, pkceCodes);
      state = generated.state;

      await announceAuthorizationUrl({ productName: "Claude", authUrl: generated.url, callbackPort: server.port, noBrowser: opts.noBrowser ?? false, hooks });

      let result;
      try {
        result = await waitForOAuthResult({ server, productName: "Claude", prompt: opts.prompt, hooks, signal: opts.signal });
      } catch (err) {
        if (isCallbackTimeout(err)) throw newAuthenticationError(ErrCallbackTimeout, err);
        throw err;
      }

      if (result.error !== "") throw newOAuthError(result.error, result.errorDescription, 400);
      if (result.state !== state) throw newAuthenticationError(ErrInvalidState, new Error("state mismatch"));

      let bundle;
      try {
        bundle = await authSvc.exchangeCodeForTokens(result.code, state, pkceCodes, opts.signal);
      } catch (err) {
        throw newAuthenticationError(ErrCodeExchangeFailed, err);
      }
      const storage = authSvc.createTokenStorage(bundle);
      if (!storage.email) throw new Error("claude token storage missing account information");
      (hooks.print ?? console.log)("Claude authentication successful");
      return buildClaudeAuthRecord(storage, (hooks.now ?? Date.now)());
    } finally {
      await server.stop();
    }
  }

  /**
   * Refreshes the access token with the stored refresh token and returns an
   * updated copy of the auth. Identity fields are only overwritten when the
   * refresh resolved them; an auth without a refresh token is returned as is.
   */
  async refresh(auth: Auth, opts: RefreshOptions = {}): Promise<Auth> {
    let refreshToken = metadataString(auth.metadata, "refresh_token");
    if (refreshToken === "") refreshToken = metadataString(auth.metadata, "refreshToken");
    if (refreshToken === "") return auth;
    const now = opts.now ?? Date.now;
    const svc = new ClaudeAuth({ fetch: opts.fetch, proxyUrl: opts.proxyUrl ?? auth.proxyUrl, now, sleep: opts.sleep });
    const td = await svc.refreshTokensWithRetry(refreshToken, 3, opts.signal);
    const updated = cloneAuth(auth);
    const md = updated.metadata;
    md.access_token = td.accessToken;
    storeMetadataString(md, "refresh_token", td.refreshToken);
    storeMetadataString(md, "email", td.email);
    storeMetadataString(md, "account_uuid", td.accountUUID);
    storeMetadataString(md, "organization_uuid", td.organizationUUID);
    storeMetadataString(md, "organization_name", td.organizationName);
    md.expired = td.expire;
    md.type = "claude";
    md.last_refresh = formatRFC3339(now());
    updated.lastRefreshedAt = now();
    updated.updatedAt = now();
    return updated;
  }
}

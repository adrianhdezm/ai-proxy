// Gemini CLI OAuth login and refresh producing Auth records. Port of v7.0.12
// sdk/auth/gemini.go, the onboarding part of internal/cmd/login.go
// (DoLogin / updateAuthRecord) and the token refresh/persist logic of
// internal/runtime/executor/gemini_cli_executor.go (buildGeminiTokenFields).
//
// Auth record written by this module (Auth.provider = "gemini-cli", Auth.id =
// "gemini-<email>-<project_id>.json" from credentialFileName). Auth.metadata
// keys match the Go auth JSON file (GeminiTokenStorage):
//   type        "gemini"
//   token       { access_token, token_type, refresh_token, expiry (RFC3339),
//                 expires_in, id_token?, token_uri, client_id, client_secret,
//                 scopes, universe_domain }
//   project_id  Google Cloud project used for Code Assist
//   email       Google account email
//   auto        false after a CLI login (upstream forces it)
//   checked     true once cloudaicompanion.googleapis.com was verified enabled
// After a refresh the executor-side keys access_token, token_type,
// refresh_token and expiry are also written at the top level, as upstream does.
import { type Auth, cloneAuth, newAuth } from "../types.ts";
import { ErrCallbackTimeout, ErrInvalidState, ErrPortInUse, ErrServerStartFailed, newAuthenticationError } from "../oauth/errors.ts";
import { announceAuthorizationUrl, isCallbackTimeout, waitForOAuthResult } from "../oauth/flow.ts";
import { authRefreshToken } from "../oauth/expiry.ts";
import { metadataString } from "../oauth/metadata.ts";
import { generateRandomState } from "../oauth/pkce.ts";
import { OAuthCallbackServer } from "../oauth/server.ts";
import type { Authenticator, LoginOptions, RefreshOptions } from "../oauth/types.ts";
import { type CodeAssistClient, checkCloudAPIIsEnabled, performGeminiCLISetup } from "./code_assist.ts";
import { DefaultCallbackPort, GeminiAuth, type GeminiEndpoints, type GeminiOAuthClient, type GoogleToken, callbackUrlFor, resolveGeminiOAuthClient } from "./gemini_auth.ts";
import { type GeminiTokenMap, type GeminiTokenStorage, credentialFileName, geminiStorageToMetadata } from "./token.ts";
import { resolveFetch } from "../oauth/http.ts";

export const GeminiCLIProvider = "gemini-cli";

export interface GeminiAuthenticatorOptions {
  callbackPort?: number;
  /**
   * OAuth client id/secret. When omitted they are read from
   * GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET at login/refresh time
   * (resolveGeminiOAuthClient).
   */
  client?: GeminiOAuthClient;
  /** Endpoint overrides (tests). */
  endpoints?: Partial<GeminiEndpoints>;
  /** Run the Service Usage check after onboarding (default true, like upstream). */
  checkCloudAPI?: boolean;
}

/** Builds the Auth record persisted after a Gemini CLI login. */
export function buildGeminiAuthRecord(storage: GeminiTokenStorage, nowMs: number = Date.now()): Auth {
  const fileName = credentialFileName(storage.email, storage.project_id, true);
  const auth = newAuth({ id: fileName, provider: GeminiCLIProvider, label: storage.email, metadata: geminiStorageToMetadata(storage) });
  auth.createdAt = nowMs;
  auth.updatedAt = nowMs;
  auth.lastRefreshedAt = nowMs;
  return auth;
}

/** Port of buildGeminiTokenFields: the metadata keys rewritten after a refresh. */
export function geminiTokenFields(token: GoogleToken, merged: GeminiTokenMap): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (token.accessToken !== "") fields.access_token = token.accessToken;
  if (token.tokenType !== "") fields.token_type = token.tokenType;
  if (token.refreshToken !== "") fields.refresh_token = token.refreshToken;
  if (token.expiry !== "") fields.expiry = token.expiry;
  if (Object.keys(merged).length > 0) fields.token = { ...merged };
  return fields;
}

export class GeminiAuthenticator implements Authenticator {
  readonly provider = GeminiCLIProvider;
  callbackPort: number;
  private readonly endpoints: Partial<GeminiEndpoints> | undefined;
  private readonly checkCloudAPI: boolean;
  private readonly client: GeminiOAuthClient | undefined;

  constructor(opts: GeminiAuthenticatorOptions = {}) {
    this.callbackPort = opts.callbackPort ?? DefaultCallbackPort;
    this.endpoints = opts.endpoints;
    this.checkCloudAPI = opts.checkCloudAPI ?? true;
    this.client = opts.client;
  }

  /** The configured OAuth client, or the one from the environment. */
  private oauthClient(): GeminiOAuthClient {
    return this.client ?? resolveGeminiOAuthClient();
  }

  /** Upstream returns nil: no proactive refresh schedule; the executor refreshes at expiry. */
  refreshLead(): number | undefined {
    return undefined;
  }

  async login(opts: LoginOptions = {}): Promise<Auth> {
    const hooks = opts.hooks ?? {};
    const now = hooks.now ?? Date.now;
    const callbackPort = opts.callbackPort !== undefined && opts.callbackPort >= 0 ? opts.callbackPort : this.callbackPort;
    const state = generateRandomState();

    const server = new OAuthCallbackServer({
      port: callbackPort,
      callbackPath: "/oauth2callback",
      hostname: hooks.callbackHostname,
      requireState: false,
      productName: "Gemini",
    });
    try {
      server.start();
    } catch (err) {
      if ((err as Error).message.includes("already in use")) throw newAuthenticationError(ErrPortInUse, err);
      throw newAuthenticationError(ErrServerStartFailed, err);
    }

    try {
      const geminiAuth = new GeminiAuth({ client: this.oauthClient(), fetch: hooks.fetch, proxyUrl: opts.proxyUrl, now, endpoints: this.endpoints });
      const redirectUri = callbackUrlFor(server.port);
      const authUrl = geminiAuth.generateAuthURL(redirectUri, state);
      await announceAuthorizationUrl({ productName: "Gemini", authUrl, callbackPort: server.port, noBrowser: opts.noBrowser ?? false, hooks });

      let result;
      try {
        result = await waitForOAuthResult({ server, productName: "Gemini", prompt: opts.prompt, hooks, signal: opts.signal });
      } catch (err) {
        if (isCallbackTimeout(err)) throw new Error("oauth flow timed out", { cause: err });
        throw err;
      }
      if (result.error !== "") throw new Error(`authentication failed via callback: ${result.error}`);
      if (result.code === "") throw new Error("code not found in callback");
      if (result.state !== "" && result.state !== state) throw newAuthenticationError(ErrInvalidState, new Error("state mismatch"));

      const token = await geminiAuth.exchangeCode(result.code, redirectUri, opts.signal);
      const userInfo = await geminiAuth.fetchUserInfo(token.accessToken, opts.signal);
      const print = hooks.print ?? console.log;
      if (userInfo.email !== "") print(`Authenticated user email: ${userInfo.email}`);
      else print("Failed to get user email from token");

      const client: CodeAssistClient = { fetch: resolveFetch(hooks), accessToken: token.accessToken, endpoints: geminiAuth.endpoints, proxyUrl: opts.proxyUrl };
      const requestedProject = (opts.projectId ?? "").trim();
      const projectId = await performGeminiCLISetup(client, requestedProject, { signal: opts.signal, sleep: hooks.sleep, now });

      let checked = false;
      if (this.checkCloudAPI) {
        checked = await checkCloudAPIIsEnabled(client, projectId, opts.signal);
      }

      const storage: GeminiTokenStorage = {
        token: geminiAuth.buildTokenMap(token),
        project_id: projectId,
        email: userInfo.email,
        auto: false,
        checked,
        type: "gemini",
      };
      print("Gemini authentication successful");
      return buildGeminiAuthRecord(storage, now());
    } finally {
      await server.stop();
    }
  }

  /**
   * Refreshes the Google token with the stored refresh token (nested `token`
   * or top-level) and returns an updated copy of the auth. An auth without a
   * refresh token is returned as is.
   */
  async refresh(auth: Auth, opts: RefreshOptions = {}): Promise<Auth> {
    const refreshToken = authRefreshToken(auth);
    if (refreshToken === "") return auth;
    const now = opts.now ?? Date.now;
    const geminiAuth = new GeminiAuth({ client: this.oauthClient(), fetch: opts.fetch, proxyUrl: opts.proxyUrl ?? auth.proxyUrl, now, endpoints: this.endpoints });
    const token = await geminiAuth.refreshToken(refreshToken, opts.signal);

    const updated = cloneAuth(auth);
    const base = updated.metadata.token;
    const baseMap = base && typeof base === "object" && !Array.isArray(base) ? (base as Record<string, unknown>) : {};
    const merged = geminiAuth.buildTokenMap(token, baseMap);
    if (merged.refresh_token === undefined && metadataString(auth.metadata, "refresh_token") !== "") merged.refresh_token = refreshToken;
    for (const [k, v] of Object.entries(geminiTokenFields(token, merged))) updated.metadata[k] = v;
    updated.lastRefreshedAt = now();
    updated.updatedAt = now();
    return updated;
  }
}

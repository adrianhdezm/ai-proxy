// Google OAuth for the Gemini CLI: authorize URL, code exchange, refresh and
// the userinfo lookup. Port of v7.0.12 internal/auth/gemini/gemini_auth.go,
// which relied on golang.org/x/oauth2 for the HTTP parts; those are done
// here with fetch against the standard Google endpoints.
//
// The OAuth client id/secret of the Gemini CLI are deliberately NOT embedded
// in this repository. They are supplied by the operator (see
// resolveGeminiOAuthClient) from the values published in the Gemini CLI
// source, packages/core/src/code_assist/oauth2.ts.
import { type FetchLike, type HttpOptions, HttpStatusError, readBodyText, resolveFetch, withProxy } from "../oauth/http.ts";
import { type Clock, formatRFC3339Nano } from "../oauth/time.ts";
import type { GeminiTokenMap } from "./token.ts";

export const DefaultCallbackPort = 8085;
export const Scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

/** Environment variables the operator sets with the Gemini CLI OAuth client. */
export const GeminiOAuthClientIdEnv = "GEMINI_OAUTH_CLIENT_ID";
export const GeminiOAuthClientSecretEnv = "GEMINI_OAUTH_CLIENT_SECRET";

/** OAuth client used for the Google authorization-code and refresh grants. */
export interface GeminiOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Options accepted by every Gemini OAuth entry point. */
export interface GeminiOAuthOptions extends GeminiOAuthClient {
  proxyUrl?: string;
}

/**
 * Reads the Gemini CLI OAuth client from the environment. Throws a clear
 * error when either variable is missing: the values are the ones the Gemini
 * CLI ships in packages/core/src/code_assist/oauth2.ts.
 */
export function resolveGeminiOAuthClient(env: Record<string, string | undefined> = process.env): GeminiOAuthClient {
  const clientId = (env[GeminiOAuthClientIdEnv] ?? "").trim();
  const clientSecret = (env[GeminiOAuthClientSecretEnv] ?? "").trim();
  if (clientId === "" || clientSecret === "") {
    throw new Error(
      `gemini-cli oauth: set ${GeminiOAuthClientIdEnv} and ${GeminiOAuthClientSecretEnv} to the OAuth client id and secret published in the Gemini CLI source (packages/core/src/code_assist/oauth2.ts)`,
    );
  }
  return { clientId, clientSecret };
}

/** Endpoints used by the flow; tests point them at a fake server. */
export interface GeminiEndpoints {
  /** google.Endpoint.AuthURL */
  authUrl: string;
  /** google.Endpoint.TokenURL (also written as token_uri into the auth file) */
  tokenUrl: string;
  userInfoUrl: string;
  /** cloudcode-pa base, see code_assist.ts */
  codeAssistEndpoint: string;
  /** serviceusage base, see code_assist.ts */
  serviceUsageUrl: string;
}

export const defaultGeminiEndpoints: GeminiEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
  codeAssistEndpoint: "https://cloudcode-pa.googleapis.com",
  serviceUsageUrl: "https://serviceusage.googleapis.com",
};

export function callbackUrlFor(port: number): string {
  return `http://localhost:${port}/oauth2callback`;
}

/** A Google OAuth token in the shape golang.org/x/oauth2 marshals it. */
export interface GoogleToken {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  /** RFC3339 expiry; "" when the response carried no expires_in. */
  expiry: string;
  expiresIn?: number;
  idToken?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}

export interface GeminiAuthOptions extends HttpOptions {
  /** OAuth client; see resolveGeminiOAuthClient. */
  client: GeminiOAuthClient;
  now?: Clock;
  endpoints?: Partial<GeminiEndpoints>;
}

/** Port of GeminiAuth (the OAuth half; onboarding lives in code_assist.ts). */
export class GeminiAuth {
  readonly endpoints: GeminiEndpoints;
  readonly client: GeminiOAuthClient;
  private readonly fetchFn: FetchLike;
  private readonly proxyUrl: string | undefined;
  private readonly now: Clock;

  constructor(opts: GeminiAuthOptions) {
    if (!opts.client || opts.client.clientId.trim() === "" || opts.client.clientSecret.trim() === "") {
      throw new Error("gemini-cli oauth: client id and secret are required");
    }
    this.client = { clientId: opts.client.clientId.trim(), clientSecret: opts.client.clientSecret.trim() };
    this.fetchFn = resolveFetch(opts);
    this.proxyUrl = opts.proxyUrl;
    this.now = opts.now ?? Date.now;
    this.endpoints = { ...defaultGeminiEndpoints, ...(opts.endpoints ?? {}) };
  }

  /** conf.AuthCodeURL(state, AccessTypeOffline, prompt=consent). */
  generateAuthURL(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      access_type: "offline",
      client_id: this.client.clientId,
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: Scopes.join(" "),
      state,
    });
    return `${this.endpoints.authUrl}?${params.toString()}`;
  }

  private async postToken(form: Record<string, string>, label: string, signal?: AbortSignal): Promise<GoogleTokenResponse> {
    let resp: Response;
    try {
      resp = await this.fetchFn(
        this.endpoints.tokenUrl,
        withProxy({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form).toString(), signal }, this.proxyUrl),
      );
    } catch (err) {
      throw new Error(`${label} request failed: ${(err as Error).message}`);
    }
    const body = await readBodyText(resp);
    if (resp.status < 200 || resp.status >= 300) throw new HttpStatusError(`${label} failed`, resp.status, body, resp.status >= 500);
    try {
      return JSON.parse(body) as GoogleTokenResponse;
    } catch (err) {
      throw new Error(`failed to parse ${label} response: ${(err as Error).message}`);
    }
  }

  private toToken(resp: GoogleTokenResponse, fallbackRefresh: string): GoogleToken {
    const expiresIn = typeof resp.expires_in === "number" ? resp.expires_in : undefined;
    const token: GoogleToken = {
      accessToken: resp.access_token ?? "",
      tokenType: resp.token_type ?? "",
      refreshToken: (resp.refresh_token ?? "").trim() !== "" ? resp.refresh_token! : fallbackRefresh,
      expiry: expiresIn !== undefined ? formatRFC3339Nano(this.now() + expiresIn * 1000) : "",
      expiresIn,
    };
    if (resp.id_token) token.idToken = resp.id_token;
    if (token.accessToken === "") throw new Error("oauth2: server response missing access_token");
    return token;
  }

  /** conf.Exchange: authorization code -> token. */
  async exchangeCode(code: string, redirectUri: string, signal?: AbortSignal): Promise<GoogleToken> {
    const resp = await this.postToken(
      { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: this.client.clientId, client_secret: this.client.clientSecret },
      "failed to exchange token",
      signal,
    );
    return this.toToken(resp, "");
  }

  /** Refresh grant; the refresh token is kept when Google omits it from the response. */
  async refreshToken(refreshToken: string, signal?: AbortSignal): Promise<GoogleToken> {
    if (refreshToken.trim() === "") throw new Error("refresh token is required");
    const resp = await this.postToken(
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.client.clientId, client_secret: this.client.clientSecret },
      "token refresh",
      signal,
    );
    return this.toToken(resp, refreshToken);
  }

  /** GET userinfo; returns the email ("" when the response has none). */
  async fetchUserInfo(accessToken: string, signal?: AbortSignal): Promise<{ email: string; raw: Record<string, unknown> }> {
    let resp: Response;
    try {
      resp = await this.fetchFn(
        this.endpoints.userInfoUrl,
        withProxy({ method: "GET", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }, signal }, this.proxyUrl),
      );
    } catch (err) {
      throw new Error(`failed to execute request: ${(err as Error).message}`);
    }
    const body = await readBodyText(resp);
    if (resp.status < 200 || resp.status >= 300) throw new Error(`get user info request failed with status ${resp.status}: ${body}`);
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(body) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const email = typeof raw.email === "string" ? raw.email : "";
    return { email, raw };
  }

  /**
   * Builds the `token` object of the auth file: the oauth2 token fields plus
   * token_uri, client_id, client_secret, scopes and universe_domain
   * (createTokenStorage in the Go source).
   */
  buildTokenMap(token: GoogleToken, base?: Record<string, unknown>): GeminiTokenMap {
    const map: GeminiTokenMap = { ...(base ?? {}), access_token: token.accessToken } as GeminiTokenMap;
    if (token.tokenType) map.token_type = token.tokenType;
    if (token.refreshToken) map.refresh_token = token.refreshToken;
    if (token.expiry) map.expiry = token.expiry;
    if (token.expiresIn !== undefined) map.expires_in = token.expiresIn;
    if (token.idToken) map.id_token = token.idToken;
    map.token_uri = this.endpoints.tokenUrl;
    map.client_id = this.client.clientId;
    map.client_secret = this.client.clientSecret;
    map.scopes = [...Scopes];
    map.universe_domain = "googleapis.com";
    return map;
  }
}

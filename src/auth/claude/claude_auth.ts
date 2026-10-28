// Claude Code OAuth service: authorize URL, code exchange, refresh and the
// profile/roles lookups. Port of internal/auth/claude/anthropic_auth.go.
// utls_transport.go (Firefox TLS fingerprint) is Go-only and not ported.
import { log } from "../../log.ts";
import { type FetchLike, type HttpOptions, resolveFetch, withProxy } from "../oauth/http.ts";
import { SingleFlight } from "../oauth/singleflight.ts";
import { type Clock, type Sleep, formatRFC3339, realSleep } from "../oauth/time.ts";
import type { PKCECodes } from "../oauth/pkce.ts";
import { generateDeviceIDPool } from "./identity.ts";
import { readClaudeOAuthResponseBody } from "./oauth_response.ts";
import { type ClaudeAuthBundle, type ClaudeTokenData, type ClaudeTokenStorage, createTokenStorage, updateTokenStorage } from "./token.ts";

// OAuth configuration constants for Claude/Anthropic (copied verbatim).
export const AuthURL = "https://claude.ai/oauth/authorize";
/** Claude Code 2.1.220 posts the code exchange to platform.claude.com. */
export const TokenURL = "https://platform.claude.com/v1/oauth/token";
export const RefreshTokenURL = "https://platform.claude.com/v1/oauth/token";
export const ProfileURL = "https://api.anthropic.com/api/oauth/profile";
/** claude_cli role endpoint the native client queries right after the exchange. */
export const RolesURL = "https://api.anthropic.com/api/oauth/claude_cli/roles";
export const ClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const RedirectURI = "http://localhost:54545/callback";
export const ClaudeOAuthScope = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const claudeRefreshMinBackoffMs = 5_000;
const claudeRefreshMaxBackoffMs = 5 * 60_000;
const claudeRefreshTimeoutMs = 30_000;

/** Refresh failure carrying the upstream status. Only explicit 5xx responses are retryable. */
export class RefreshHTTPError extends Error {
  status: number;
  body: string;
  retryable: boolean;
  constructor(status: number, message: string, retryable: boolean) {
    super(`token refresh failed with status ${status}: ${message}`);
    this.name = "RefreshHTTPError";
    this.status = status;
    this.body = message;
    this.retryable = retryable;
  }
}

// Module-level refresh coordination shared by every ClaudeAuth instance, like
// the package-level singleflight group and block map in Go.
const claudeRefreshGroup = new SingleFlight<ClaudeTokenData>();
let claudeRefreshBlock = new Map<string, number>();

/** Tests: clears the singleflight group and the 429 block map. */
export function resetClaudeRefreshState(): void {
  claudeRefreshGroup.reset();
  claudeRefreshBlock = new Map();
}

/** Epoch ms until which refreshes with this token are blocked (0 when not blocked). */
export function claudeRefreshBlockedUntil(refreshToken: string): number {
  return claudeRefreshBlock.get(refreshToken) ?? 0;
}

function clampClaudeRefreshBackoff(ms: number): number {
  if (!Number.isFinite(ms) || ms < claudeRefreshMinBackoffMs) return claudeRefreshMinBackoffMs;
  if (ms > claudeRefreshMaxBackoffMs) return claudeRefreshMaxBackoffMs;
  return ms;
}

/** Port of parseClaudeRetryAfter: Retry-After seconds or HTTP date, then Retry-After-Ms. */
export function parseClaudeRetryAfterMs(headers: Headers, now: number): number {
  const raw = (headers.get("Retry-After") ?? "").trim();
  if (raw !== "") {
    if (/^\d+(\.\d+)?$/.test(raw)) return clampClaudeRefreshBackoff(Number(raw) * 1000);
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) return clampClaudeRefreshBackoff(when - now);
  }
  const rawMs = (headers.get("Retry-After-Ms") ?? "").trim();
  if (rawMs !== "" && /^\d+(\.\d+)?$/.test(rawMs)) return clampClaudeRefreshBackoff(Number(rawMs));
  return claudeRefreshMinBackoffMs;
}

/**
 * A transport or decoding error is ambiguous: Anthropic may have consumed the
 * single-use refresh token even though the response was lost, so replaying it
 * can turn a transient fault into invalid_grant. Only explicit retryable HTTP
 * responses are replayed.
 */
export function isClaudeRefreshRetryable(err: unknown): boolean {
  return err instanceof RefreshHTTPError && err.retryable;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  organization?: { uuid?: string; name?: string };
  account?: { uuid?: string; email_address?: string };
}

/** Account identity returned by the OAuth profile endpoint. */
export interface OAuthProfile {
  account: { uuid: string; email: string };
  organization: { uuid: string; name: string };
}

/** Headers of the native client's axios requests (applyClaudeOAuthAxiosHeaders). */
export function claudeOAuthAxiosHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": "axios/1.15.2",
    "Accept-Encoding": "gzip, compress, deflate, br",
    Connection: "close",
  };
}

export interface ClaudeAuthOptions extends HttpOptions {
  /** Clock used for expiry stamps and the 429 block map. */
  now?: Clock;
  /** Delay used between retries. */
  sleep?: Sleep;
}

/** Port of ClaudeAuth. */
export class ClaudeAuth {
  private readonly fetchFn: FetchLike;
  private readonly proxyUrl: string | undefined;
  private readonly now: Clock;
  private readonly sleep: Sleep;

  constructor(opts: ClaudeAuthOptions = {}) {
    this.fetchFn = resolveFetch(opts);
    this.proxyUrl = opts.proxyUrl;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  private request(url: string, init: RequestInit & { decompress?: boolean }): Promise<Response> {
    return this.fetchFn(url, withProxy({ ...init, decompress: false }, this.proxyUrl));
  }

  /** Builds the PKCE authorize URL; the state is returned unchanged. */
  generateAuthURL(state: string, pkce: PKCECodes | undefined): { url: string; state: string } {
    if (!pkce) throw new Error("PKCE codes are required");
    const params = new URLSearchParams({
      code: "true",
      client_id: ClientID,
      response_type: "code",
      redirect_uri: RedirectURI,
      scope: ClaudeOAuthScope,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    return { url: `${AuthURL}?${params.toString()}`, state };
  }

  /** The callback code may carry "#state" appended (parseCodeAndState). */
  private parseCodeAndState(code: string): { code: string; state: string } {
    const idx = code.indexOf("#");
    if (idx < 0) return { code, state: "" };
    return { code: code.slice(0, idx), state: code.slice(idx + 1) };
  }

  private async fetchOAuthControlPlaneJSON(endpoint: string, accessToken: string, label: string, signal?: AbortSignal): Promise<string> {
    accessToken = accessToken.trim();
    if (accessToken === "") throw new Error(`fetch Claude OAuth ${label}: access token is empty`);
    let resp: Response;
    try {
      resp = await this.request(endpoint, {
        method: "GET",
        headers: { ...claudeOAuthAxiosHeaders(), Authorization: `Bearer ${accessToken}`, "Cache-Control": "no-cache" },
        signal,
      });
    } catch (err) {
      throw new Error(`fetch Claude OAuth ${label}: ${(err as Error).message}`);
    }
    let body: string;
    try {
      body = await readClaudeOAuthResponseBody(resp);
    } catch (err) {
      throw new Error(`read Claude OAuth ${label} response: ${(err as Error).message}`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`fetch Claude OAuth ${label} failed with status ${resp.status}`);
    }
    return body;
  }

  /** Retrieves the account identity associated with an access token. */
  async fetchOAuthProfile(accessToken: string, signal?: AbortSignal): Promise<OAuthProfile> {
    const body = await this.fetchOAuthControlPlaneJSON(ProfileURL, accessToken, "profile", signal);
    let parsed: { account?: { uuid?: string; email?: string }; organization?: { uuid?: string; name?: string } };
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`parse Claude OAuth profile response: ${(err as Error).message}`);
    }
    const profile: OAuthProfile = {
      account: { uuid: parsed.account?.uuid ?? "", email: parsed.account?.email ?? "" },
      organization: { uuid: parsed.organization?.uuid ?? "", name: parsed.organization?.name ?? "" },
    };
    if (profile.account.uuid.trim() === "") throw new Error("fetch Claude OAuth profile: response account UUID is empty");
    return profile;
  }

  /** The claude_cli roles lookup; the payload is opaque and returned raw. */
  async fetchOAuthRoles(accessToken: string, signal?: AbortSignal): Promise<string> {
    const body = await this.fetchOAuthControlPlaneJSON(RolesURL, accessToken, "claude_cli roles", signal);
    try {
      JSON.parse(body);
    } catch {
      throw new Error("parse Claude OAuth claude_cli roles response: body is not valid JSON");
    }
    return body;
  }

  /** Profile then roles, both advisory: failures are logged and never fail the login. */
  private async inspectOAuthAccount(accessToken: string, signal?: AbortSignal): Promise<OAuthProfile | undefined> {
    let profile: OAuthProfile | undefined;
    try {
      profile = await this.fetchOAuthProfile(accessToken, signal);
    } catch (err) {
      log.warn(`fetch Claude OAuth profile after token exchange: ${(err as Error).message}`);
    }
    try {
      await this.fetchOAuthRoles(accessToken, signal);
    } catch (err) {
      log.warn(`fetch Claude OAuth claude_cli roles after token exchange: ${(err as Error).message}`);
    }
    return profile;
  }

  /** Exchanges the authorization code for tokens (PKCE) and resolves the account identity. */
  async exchangeCodeForTokens(code: string, state: string, pkce: PKCECodes | undefined, signal?: AbortSignal): Promise<ClaudeAuthBundle> {
    if (!pkce) throw new Error("PKCE codes are required for token exchange");
    const parsed = this.parseCodeAndState(code);
    // Key order mirrors the native Claude Code 2.1.220 exchange body.
    const reqBody = {
      grant_type: "authorization_code",
      code: parsed.code,
      redirect_uri: RedirectURI,
      client_id: ClientID,
      code_verifier: pkce.codeVerifier,
      state: parsed.state !== "" ? parsed.state : state,
    };

    let resp: Response;
    try {
      resp = await this.request(TokenURL, { method: "POST", headers: claudeOAuthAxiosHeaders(), body: JSON.stringify(reqBody), signal });
    } catch (err) {
      throw new Error(`token exchange request failed: ${(err as Error).message}`);
    }
    let body: string;
    try {
      body = await readClaudeOAuthResponseBody(resp);
    } catch (err) {
      throw new Error(`failed to read token response: ${(err as Error).message}`);
    }
    if (resp.status !== 200) throw new Error(`token exchange failed with status ${resp.status}: ${body}`);

    let tokenResp: TokenResponse;
    try {
      tokenResp = JSON.parse(body) as TokenResponse;
    } catch (err) {
      throw new Error(`failed to parse token response: ${(err as Error).message}`);
    }

    const deviceIDs = generateDeviceIDPool();
    const now = this.now();
    const tokenData: ClaudeTokenData = {
      accessToken: tokenResp.access_token ?? "",
      refreshToken: tokenResp.refresh_token ?? "",
      email: tokenResp.account?.email_address ?? "",
      accountUUID: tokenResp.account?.uuid ?? "",
      organizationUUID: tokenResp.organization?.uuid ?? "",
      organizationName: tokenResp.organization?.name ?? "",
      expire: formatRFC3339(now + (tokenResp.expires_in ?? 0) * 1000),
    };

    // The profile response wins where it carries identity the token response omitted.
    const profile = await this.inspectOAuthAccount(tokenData.accessToken, signal);
    if (profile) {
      if (profile.account.uuid.trim() !== "") tokenData.accountUUID = profile.account.uuid.trim();
      if (profile.account.email.trim() !== "") tokenData.email = profile.account.email.trim();
      if (profile.organization.uuid.trim() !== "") tokenData.organizationUUID = profile.organization.uuid.trim();
      if (profile.organization.name.trim() !== "") tokenData.organizationName = profile.organization.name.trim();
    }

    return { apiKey: "", tokenData, deviceIDs, lastRefresh: formatRFC3339(now) };
  }

  /**
   * Refreshes the access token. Concurrent refreshes of the same token share
   * one upstream call; a 429 blocks further attempts for the Retry-After window.
   * The request runs with its own 30s timeout, independent of the caller.
   */
  refreshTokens(refreshToken: string): Promise<ClaudeTokenData> {
    if (refreshToken === "") return Promise.reject(new Error("refresh token is required"));
    const blockedUntil = claudeRefreshBlockedUntil(refreshToken);
    if (blockedUntil > this.now()) {
      return Promise.reject(new RefreshHTTPError(429, `refresh temporarily blocked until ${formatRFC3339(blockedUntil)}`, false));
    }
    return claudeRefreshGroup.do(refreshToken, () => this.refreshTokensSingleFlight(refreshToken, AbortSignal.timeout(claudeRefreshTimeoutMs)));
  }

  private async refreshTokensSingleFlight(refreshToken: string, signal: AbortSignal): Promise<ClaudeTokenData> {
    const blockedUntil = claudeRefreshBlockedUntil(refreshToken);
    if (blockedUntil > this.now()) {
      throw new RefreshHTTPError(429, `refresh temporarily blocked until ${formatRFC3339(blockedUntil)}`, false);
    }
    const reqBody = { client_id: ClientID, grant_type: "refresh_token", refresh_token: refreshToken, scope: ClaudeOAuthScope };

    let resp: Response;
    try {
      resp = await this.request(RefreshTokenURL, { method: "POST", headers: claudeOAuthAxiosHeaders(), body: JSON.stringify(reqBody), signal });
    } catch (err) {
      throw new Error(`token refresh request failed: ${(err as Error).message}`);
    }
    let body: string;
    try {
      body = await readClaudeOAuthResponseBody(resp);
    } catch (err) {
      throw new Error(`failed to read refresh response: ${(err as Error).message}`);
    }

    if (resp.status !== 200) {
      if (resp.status === 429) {
        const retryAfter = parseClaudeRetryAfterMs(resp.headers, this.now());
        claudeRefreshBlock.set(refreshToken, this.now() + retryAfter);
        throw new RefreshHTTPError(resp.status, body, false);
      }
      throw new RefreshHTTPError(resp.status, body, resp.status >= 500);
    }

    let tokenResp: TokenResponse;
    try {
      tokenResp = JSON.parse(body) as TokenResponse;
    } catch (err) {
      throw new Error(`failed to parse token response: ${(err as Error).message}`);
    }

    claudeRefreshBlock.delete(refreshToken);
    const tokenData: ClaudeTokenData = {
      accessToken: tokenResp.access_token ?? "",
      refreshToken: (tokenResp.refresh_token ?? "").trim() !== "" ? tokenResp.refresh_token! : refreshToken,
      email: "",
      accountUUID: "",
      organizationUUID: "",
      organizationName: "",
      expire: formatRFC3339(this.now() + (tokenResp.expires_in ?? 0) * 1000),
    };
    try {
      const profile = await this.fetchOAuthProfile(tokenData.accessToken, signal);
      tokenData.email = profile.account.email;
      tokenData.accountUUID = profile.account.uuid;
      tokenData.organizationUUID = profile.organization.uuid;
      tokenData.organizationName = profile.organization.name;
    } catch (err) {
      log.warn(`fetch Claude OAuth profile after refresh: ${(err as Error).message}`);
    }
    return tokenData;
  }

  /** Refresh with linear backoff; stops early on non-retryable failures. */
  async refreshTokensWithRetry(refreshToken: string, maxRetries: number, signal?: AbortSignal): Promise<ClaudeTokenData> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(attempt * 1000, signal);
      try {
        return await this.refreshTokens(refreshToken);
      } catch (err) {
        lastErr = err;
        log.warn(`Token refresh attempt ${attempt + 1} failed: ${(err as Error).message}`);
        if (!isClaudeRefreshRetryable(err)) break;
      }
    }
    throw new Error(`token refresh failed after ${maxRetries} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`, { cause: lastErr });
  }

  createTokenStorage(bundle: ClaudeAuthBundle): ClaudeTokenStorage {
    return createTokenStorage(bundle);
  }

  updateTokenStorage(storage: ClaudeTokenStorage, tokenData: ClaudeTokenData): void {
    updateTokenStorage(storage, tokenData, this.now());
  }
}

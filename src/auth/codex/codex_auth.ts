// ChatGPT/Codex OAuth service: authorize URL, code exchange and refresh.
// Port of internal/auth/codex/openai_auth.go (siwc_auth.go is not ported).
import { log } from "../../log.ts";
import { type FetchLike, type HttpOptions, HttpStatusError, readBodyText, resolveFetch, withProxy } from "../oauth/http.ts";
import type { PKCECodes } from "../oauth/pkce.ts";
import { SingleFlight } from "../oauth/singleflight.ts";
import { type Clock, type Sleep, formatRFC3339, realSleep } from "../oauth/time.ts";
import { DefaultPlanType, type JWTClaims, getAccountID, getPlanType, getUserEmail, parseJWTToken } from "./jwt_parser.ts";
import { type CodexAuthBundle, type CodexTokenData, type CodexTokenStorage, createTokenStorage, updateTokenStorage } from "./token.ts";

// OAuth configuration constants for OpenAI Codex (copied verbatim).
export const AuthURL = "https://auth.openai.com/oauth/authorize";
export const TokenURL = "https://auth.openai.com/oauth/token";
export const ClientID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const RedirectURI = "http://localhost:1455/auth/callback";
const codexRefreshTimeoutMs = 30_000;

const codexRefreshGroup = new SingleFlight<CodexTokenData>();

/** Tests: drops the shared singleflight group. */
export function resetCodexRefreshGroupForTest(): void {
  codexRefreshGroup.reset();
}

/** refresh_token_reused means the token is burnt; retrying cannot help. */
export function isNonRetryableRefreshErr(err: unknown): boolean {
  if (!err) return false;
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return text.includes("refresh_token_reused");
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface CodexAuthOptions extends HttpOptions {
  now?: Clock;
  sleep?: Sleep;
}

/** Port of CodexAuth. */
export class CodexAuth {
  private readonly fetchFn: FetchLike;
  private readonly proxyUrl: string | undefined;
  private readonly now: Clock;
  private readonly sleep: Sleep;

  constructor(opts: CodexAuthOptions = {}) {
    this.fetchFn = resolveFetch(opts);
    this.proxyUrl = opts.proxyUrl;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return this.fetchFn(url, withProxy(init, this.proxyUrl));
  }

  /** Builds the PKCE authorize URL with the Codex CLI parameters. */
  generateAuthURL(state: string, pkce: PKCECodes | undefined): string {
    if (!pkce) throw new Error("PKCE codes are required");
    const params = new URLSearchParams({
      client_id: ClientID,
      response_type: "code",
      redirect_uri: RedirectURI,
      scope: "openid email profile offline_access",
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    });
    return `${AuthURL}?${params.toString()}`;
  }

  exchangeCodeForTokens(code: string, pkce: PKCECodes | undefined, signal?: AbortSignal): Promise<CodexAuthBundle> {
    return this.exchangeCodeForTokensWithRedirect(code, RedirectURI, pkce, signal);
  }

  /** Exchanges the code with a caller-provided redirect URI (device flow uses a different one). */
  async exchangeCodeForTokensWithRedirect(code: string, redirectURI: string, pkce: PKCECodes | undefined, signal?: AbortSignal): Promise<CodexAuthBundle> {
    if (!pkce) throw new Error("PKCE codes are required for token exchange");
    if (redirectURI.trim() === "") throw new Error("redirect URI is required for token exchange");
    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ClientID,
      code,
      redirect_uri: redirectURI.trim(),
      code_verifier: pkce.codeVerifier,
    });
    let resp: Response;
    try {
      resp = await this.request(TokenURL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: data.toString(),
        signal,
      });
    } catch (err) {
      throw new Error(`token exchange request failed: ${(err as Error).message}`);
    }
    const body = await readBodyText(resp).catch((err) => {
      throw new Error(`failed to read token response: ${(err as Error).message}`);
    });
    if (resp.status !== 200) throw new HttpStatusError("token exchange failed", resp.status, body);

    let tokenResp: TokenResponse;
    try {
      tokenResp = JSON.parse(body) as TokenResponse;
    } catch (err) {
      throw new Error(`failed to parse token response: ${(err as Error).message}`);
    }
    const claims = this.parseClaims(tokenResp.id_token ?? "", "Failed to parse ID token");
    const now = this.now();
    const tokenData: CodexTokenData = {
      idToken: tokenResp.id_token ?? "",
      accessToken: tokenResp.access_token ?? "",
      refreshToken: tokenResp.refresh_token ?? "",
      accountID: getAccountID(claims),
      email: getUserEmail(claims),
      planType: getPlanType(claims),
      expire: formatRFC3339(now + (tokenResp.expires_in ?? 0) * 1000),
    };
    return { apiKey: "", tokenData, lastRefresh: formatRFC3339(now) };
  }

  private parseClaims(idToken: string, label: string): JWTClaims | undefined {
    try {
      return parseJWTToken(idToken);
    } catch (err) {
      log.warn(`${label}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Refreshes the access token; concurrent refreshes of one token share a single upstream call. */
  refreshTokens(refreshToken: string): Promise<CodexTokenData> {
    if (refreshToken === "") return Promise.reject(new Error("refresh token is required"));
    return codexRefreshGroup.do(refreshToken, () => this.refreshTokensSingleFlight(refreshToken, AbortSignal.timeout(codexRefreshTimeoutMs)));
  }

  private async refreshTokensSingleFlight(refreshToken: string, signal: AbortSignal): Promise<CodexTokenData> {
    const data = new URLSearchParams({
      client_id: ClientID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    });
    let resp: Response;
    try {
      resp = await this.request(TokenURL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: data.toString(),
        signal,
      });
    } catch (err) {
      throw new Error(`token refresh request failed: ${(err as Error).message}`);
    }
    const body = await readBodyText(resp).catch((err) => {
      throw new Error(`failed to read refresh response: ${(err as Error).message}`);
    });
    if (resp.status !== 200) throw new HttpStatusError("token refresh failed", resp.status, body, resp.status >= 500);

    let tokenResp: TokenResponse;
    try {
      tokenResp = JSON.parse(body) as TokenResponse;
    } catch (err) {
      throw new Error(`failed to parse refresh response: ${(err as Error).message}`);
    }
    const claims = this.parseClaims(tokenResp.id_token ?? "", "Failed to parse refreshed ID token");
    return {
      idToken: tokenResp.id_token ?? "",
      accessToken: tokenResp.access_token ?? "",
      refreshToken: tokenResp.refresh_token ?? "",
      accountID: getAccountID(claims),
      email: claims?.email ?? "",
      planType: getPlanType(claims),
      expire: formatRFC3339(this.now() + (tokenResp.expires_in ?? 0) * 1000),
    };
  }

  /** Refresh with linear backoff; a refresh_token_reused error stops immediately. */
  async refreshTokensWithRetry(refreshToken: string, maxRetries: number, signal?: AbortSignal): Promise<CodexTokenData> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(attempt * 1000, signal);
      try {
        return await this.refreshTokens(refreshToken);
      } catch (err) {
        if (isNonRetryableRefreshErr(err)) {
          log.warn(`Token refresh attempt ${attempt + 1} failed with non-retryable error: ${(err as Error).message}`);
          throw err;
        }
        lastErr = err;
        log.warn(`Token refresh attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }
    }
    throw new Error(`token refresh failed after ${maxRetries} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`, { cause: lastErr });
  }

  createTokenStorage(bundle: CodexAuthBundle): CodexTokenStorage {
    return createTokenStorage(bundle);
  }

  updateTokenStorage(storage: CodexTokenStorage, tokenData: CodexTokenData): void {
    updateTokenStorage(storage, tokenData, this.now());
  }
}

export { DefaultPlanType };

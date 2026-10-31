// Codex (ChatGPT subscription) OAuth login and refresh producing Auth records.
// Port of sdk/auth/codex.go, buildAuthRecord from sdk/auth/codex_device.go and
// the outer (non-SIWC) refresh branch of internal/runtime/executor/codex_executor_auth.go.
//
// Auth record written by this module (Auth.provider = "codex", Auth.id = the
// upstream file name from credentialFileName, Auth.attributes.plan_type set).
// Auth.metadata keys match the Go auth JSON file (CodexTokenStorage):
//   type           "codex"
//   id_token       OpenID JWT (account id, email and plan type are read from it)
//   access_token   OAuth access token
//   refresh_token  OAuth refresh token
//   expired        RFC3339 access token expiry
//   last_refresh   RFC3339 timestamp of the last exchange/refresh
//   email          account email
//   account_id     ChatGPT account id
//   plan_type      ChatGPT plan ("free" when the token has none)
// Sign-in-with-ChatGPT keys (`siwc`, `use_siwc`) are preserved but not produced.
import { type Auth, cloneAuth, newAuth } from "../types.ts";
import { ErrCallbackTimeout, ErrCodeExchangeFailed, ErrInvalidState, ErrPortInUse, ErrServerStartFailed, newAuthenticationError, newOAuthError } from "../oauth/errors.ts";
import { announceAuthorizationUrl, isCallbackTimeout, waitForOAuthResult } from "../oauth/flow.ts";
import { metadataString } from "../oauth/metadata.ts";
import { generatePKCECodes, generateRandomState } from "../oauth/pkce.ts";
import { OAuthCallbackServer } from "../oauth/server.ts";
import { formatRFC3339 } from "../oauth/time.ts";
import type { Authenticator, LoginOptions, RefreshOptions } from "../oauth/types.ts";
import { CodexAuth } from "./codex_auth.ts";
import { loginWithCodexDeviceFlow, shouldUseCodexDeviceFlow } from "./device.ts";
import { credentialFileName, hashAccountID } from "./filename.ts";
import { DefaultPlanType, getPlanType, parseJWTToken } from "./jwt_parser.ts";
import { type CodexAuthBundle, type CodexTokenStorage, codexStorageToMetadata } from "./token.ts";

export const CodexDefaultCallbackPort = 1455;
/** Conservative proactive refresh lead for the outer Codex token (96 hours). */
export const CodexOuterRefreshLeadMs = 96 * 60 * 60_000;

/** Port of CodexAuthenticator.buildAuthRecord. */
export function buildCodexAuthRecord(authSvc: CodexAuth, bundle: CodexAuthBundle, nowMs: number = Date.now()): { auth: Auth; storage: CodexTokenStorage } {
  const storage = authSvc.createTokenStorage(bundle);
  if (!storage.email) throw new Error("codex token storage missing account information");

  let planType = storage.plan_type ?? "";
  let accountHash = "";
  if (storage.id_token !== "") {
    try {
      const claims = parseJWTToken(storage.id_token);
      const pt = claims.codexAuthInfo.chatgpt_plan_type.trim();
      if (pt !== "") planType = pt;
      accountHash = hashAccountID(claims.codexAuthInfo.chatgpt_account_id);
    } catch {
      // Unparseable ID token: keep the plan type already resolved.
    }
  }
  if (planType === "") planType = DefaultPlanType;
  storage.plan_type = planType;

  const fileName = credentialFileName(storage.email, planType, accountHash, true);
  const auth = newAuth({
    id: fileName,
    provider: "codex",
    label: storage.email,
    attributes: { plan_type: planType },
    metadata: codexStorageToMetadata(storage),
  });
  auth.createdAt = nowMs;
  auth.updatedAt = nowMs;
  auth.lastRefreshedAt = nowMs;
  return { auth, storage };
}

export class CodexAuthenticator implements Authenticator {
  readonly provider = "codex";
  callbackPort: number;

  constructor(opts: { callbackPort?: number } = {}) {
    this.callbackPort = opts.callbackPort ?? CodexDefaultCallbackPort;
  }

  refreshLead(): number | undefined {
    return CodexOuterRefreshLeadMs;
  }

  async login(opts: LoginOptions = {}): Promise<Auth> {
    const hooks = opts.hooks ?? {};
    const now = hooks.now ?? Date.now;
    const authSvc = new CodexAuth({ fetch: hooks.fetch, proxyUrl: opts.proxyUrl, now, sleep: hooks.sleep });

    if (shouldUseCodexDeviceFlow(opts)) {
      let bundle: CodexAuthBundle;
      try {
        bundle = await loginWithCodexDeviceFlow(authSvc, { fetch: hooks.fetch, proxyUrl: opts.proxyUrl, now, sleep: hooks.sleep, signal: opts.signal, noBrowser: opts.noBrowser, hooks });
      } catch (err) {
        if ((err as Error).message.startsWith("token exchange failed")) throw newAuthenticationError(ErrCodeExchangeFailed, err);
        throw err;
      }
      const built = buildCodexAuthRecord(authSvc, bundle, now());
      (hooks.print ?? console.log)("Codex authentication successful");
      return built.auth;
    }

    const callbackPort = opts.callbackPort !== undefined && opts.callbackPort >= 0 ? opts.callbackPort : this.callbackPort;
    const pkceCodes = generatePKCECodes();
    const state = generateRandomState();

    const server = new OAuthCallbackServer({
      port: callbackPort,
      callbackPath: "/auth/callback",
      hostname: hooks.callbackHostname,
      platformUrl: "https://platform.openai.com",
      productName: "Codex",
    });
    try {
      server.start();
    } catch (err) {
      if ((err as Error).message.includes("already in use")) throw newAuthenticationError(ErrPortInUse, err);
      throw newAuthenticationError(ErrServerStartFailed, err);
    }

    try {
      const authUrl = authSvc.generateAuthURL(state, pkceCodes);
      await announceAuthorizationUrl({ productName: "Codex", authUrl, callbackPort: server.port, noBrowser: opts.noBrowser ?? false, hooks });

      let result;
      try {
        result = await waitForOAuthResult({ server, productName: "Codex", prompt: opts.prompt, hooks, signal: opts.signal });
      } catch (err) {
        if (isCallbackTimeout(err)) throw newAuthenticationError(ErrCallbackTimeout, err);
        throw err;
      }
      if (result.error !== "") throw newOAuthError(result.error, result.errorDescription, 400);
      if (result.state !== state) throw newAuthenticationError(ErrInvalidState, new Error("state mismatch"));

      let bundle: CodexAuthBundle;
      try {
        bundle = await authSvc.exchangeCodeForTokens(result.code, pkceCodes, opts.signal);
      } catch (err) {
        throw newAuthenticationError(ErrCodeExchangeFailed, err);
      }
      const built = buildCodexAuthRecord(authSvc, bundle, now());
      (hooks.print ?? console.log)("Codex authentication successful");
      return built.auth;
    } finally {
      await server.stop();
    }
  }

  /**
   * Refreshes the outer Codex token and returns an updated copy of the auth.
   * An auth without a refresh token is returned as is.
   */
  async refresh(auth: Auth, opts: RefreshOptions = {}): Promise<Auth> {
    const refreshToken = metadataString(auth.metadata, "refresh_token");
    if (refreshToken === "") return auth;
    const now = opts.now ?? Date.now;
    const svc = new CodexAuth({ fetch: opts.fetch, proxyUrl: opts.proxyUrl ?? auth.proxyUrl, now, sleep: opts.sleep });
    const td = await svc.refreshTokensWithRetry(refreshToken, 3, opts.signal);

    const updated = cloneAuth(auth);
    const md = updated.metadata;
    md.id_token = td.idToken;
    md.access_token = td.accessToken;
    if (td.refreshToken !== "") md.refresh_token = td.refreshToken;
    if (td.accountID !== "") md.account_id = td.accountID;
    md.email = td.email;
    md.expired = td.expire;
    md.type = "codex";
    md.last_refresh = formatRFC3339(now());

    let planType = td.planType.trim();
    if (planType === "" && td.idToken !== "") {
      try {
        planType = getPlanType(parseJWTToken(td.idToken));
      } catch {
        // keep default
      }
    }
    if (planType === "") planType = DefaultPlanType;
    md.plan_type = planType;
    updated.attributes = { ...updated.attributes, plan_type: planType };
    updated.lastRefreshedAt = now();
    updated.updatedAt = now();
    return updated;
  }
}

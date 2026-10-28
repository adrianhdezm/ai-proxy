// Ported from: internal/auth/codex/openai_auth_test.go
// Skipped cases: TestNewCodexAuthDoesNotSetRequestTimeout (Go http.Client field),
//   TestNewCodexAuthWithProxyURL_OverrideDirectDisablesProxy / _OverrideProxyTakesPrecedence (inspect http.Transport; adapted to the fetch `proxy` option below)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClientID, CodexAuth, RedirectURI, TokenURL, resetCodexRefreshGroupForTest } from "../../../src/auth/codex/codex_auth.ts";
import { deferred, fakeFetch, fixedNow, jsonResponse, makeTestJWT, noopSleep, settle } from "../helpers.ts";

beforeEach(() => resetCodexRefreshGroupForTest());
afterEach(() => resetCodexRefreshGroupForTest());

describe("RefreshTokens", () => {
  test("uses an independent timeout signal", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = fakeFetch((req) => {
      signal = req.init?.signal;
      return jsonResponse(`{"error":"probe"}`, 400);
    });
    await expect(new CodexAuth({ fetch }).refreshTokens("independent-timeout-token")).rejects.toThrow("status 400");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  test("deduplicates concurrent refreshes across instances", async () => {
    let calls = 0;
    const release = deferred();
    const fetch = fakeFetch(async () => {
      calls++;
      await release.promise;
      return jsonResponse(`{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":3600}`);
    });
    const a = new CodexAuth({ fetch, now: fixedNow });
    const b = new CodexAuth({ fetch, now: fixedNow });
    const p1 = a.refreshTokens("shared-refresh-token");
    const p2 = b.refreshTokens("shared-refresh-token");
    await settle();
    expect(calls).toBe(1);
    release.resolve();
    for (const td of await Promise.all([p1, p2])) {
      expect(td.accessToken).toBe("new-access");
      expect(td.refreshToken).toBe("new-refresh");
    }
    expect(calls).toBe(1);
  });

  test("sends the form body with the codex client id", async () => {
    const fetch = fakeFetch((req) => {
      expect(req.url).toBe(TokenURL);
      expect(req.method).toBe("POST");
      expect(req.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
      expect(req.headers.get("Accept")).toBe("application/json");
      const form = new URLSearchParams(req.body);
      expect(form.get("client_id")).toBe(ClientID);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("rt");
      expect(form.get("scope")).toBe("openid profile email");
      return jsonResponse(`{"access_token":"at","refresh_token":"rt2","expires_in":3600}`);
    });
    const td = await new CodexAuth({ fetch, now: fixedNow }).refreshTokens("rt");
    expect(td.expire).toBe("2026-10-28T13:00:00Z");
    expect(td.planType).toBe("free");
  });

  test("plan type defaults to free when missing", async () => {
    const idToken = makeTestJWT({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acc-12345" } });
    const fetch = fakeFetch(() => jsonResponse(`{"access_token":"at-1","refresh_token":"rt-1","id_token":"${idToken}","token_type":"Bearer","expires_in":3600}`));
    const td = await new CodexAuth({ fetch }).refreshTokens("dummy-refresh");
    expect(td.planType).toBe("free");
    expect(td.accountID).toBe("acc-12345");
    expect(td.email).toBe("user@example.com");
  });

  test("extracts plan type when present", async () => {
    const idToken = makeTestJWT({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acc-12345", chatgpt_plan_type: "pro" } });
    const fetch = fakeFetch(() => jsonResponse(`{"access_token":"at-1","refresh_token":"rt-1","id_token":"${idToken}","token_type":"Bearer","expires_in":3600}`));
    const td = await new CodexAuth({ fetch }).refreshTokens("dummy-refresh");
    expect(td.planType).toBe("pro");
  });
});

describe("RefreshTokensWithRetry", () => {
  test("non-retryable error only attempts once", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      return jsonResponse(`{"error":"invalid_grant","code":"refresh_token_reused"}`, 400);
    });
    const err = await new CodexAuth({ fetch, sleep: noopSleep }).refreshTokensWithRetry("dummy_refresh_token", 3).catch((e) => e as Error);
    expect(err.message.toLowerCase()).toContain("refresh_token_reused");
    expect(calls).toBe(1);
  });

  test("other failures are retried up to maxRetries", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      return jsonResponse(`{"error":"server_error"}`, 500);
    });
    await expect(new CodexAuth({ fetch, sleep: noopSleep }).refreshTokensWithRetry("rt", 3)).rejects.toThrow("token refresh failed after 3 attempts");
    expect(calls).toBe(3);
  });
});

describe("ExchangeCodeForTokens", () => {
  test("posts the PKCE form and derives identity from the id token", async () => {
    const idToken = makeTestJWT({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "plus" } });
    const fetch = fakeFetch((req) => {
      const form = new URLSearchParams(req.body);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("client_id")).toBe(ClientID);
      expect(form.get("code")).toBe("code-1");
      expect(form.get("redirect_uri")).toBe(RedirectURI);
      expect(form.get("code_verifier")).toBe("verifier");
      return jsonResponse(`{"access_token":"at","refresh_token":"rt","id_token":"${idToken}","expires_in":600}`);
    });
    const bundle = await new CodexAuth({ fetch, now: fixedNow }).exchangeCodeForTokens("code-1", { codeVerifier: "verifier", codeChallenge: "c" });
    expect(bundle.tokenData).toMatchObject({ accessToken: "at", refreshToken: "rt", idToken, accountID: "acc-1", email: "user@example.com", planType: "plus", expire: "2026-10-28T12:10:00Z" });
    expect(bundle.lastRefresh).toBe("2026-10-28T12:00:00Z");
  });

  test("fails on a non-200 exchange", async () => {
    const fetch = fakeFetch(() => jsonResponse(`{"error":"invalid_grant"}`, 400));
    await expect(new CodexAuth({ fetch }).exchangeCodeForTokens("x", { codeVerifier: "v", codeChallenge: "c" })).rejects.toThrow("token exchange failed with status 400");
    await expect(new CodexAuth({ fetch }).exchangeCodeForTokens("x", undefined)).rejects.toThrow("PKCE codes are required");
    await expect(new CodexAuth({ fetch }).exchangeCodeForTokensWithRedirect("x", " ", { codeVerifier: "v", codeChallenge: "c" })).rejects.toThrow("redirect URI is required");
  });
});

describe("proxy option", () => {
  test("direct disables the proxy and an explicit proxy is passed to fetch", async () => {
    const seen: Array<string | undefined> = [];
    const fetch = fakeFetch((req) => {
      seen.push(req.init?.proxy);
      return jsonResponse(`{"access_token":"at","expires_in":1}`);
    });
    await new CodexAuth({ fetch, proxyUrl: "direct" }).refreshTokens("rt-a");
    await new CodexAuth({ fetch, proxyUrl: "http://override.example.com:8081" }).refreshTokens("rt-b");
    expect(seen).toEqual([undefined, "http://override.example.com:8081"]);
  });
});

describe("CreateAndUpdateTokenStorage", () => {
  test("plan type defaults and updates", () => {
    const auth = new CodexAuth({ fetch: fakeFetch(() => jsonResponse("{}")), now: fixedNow });
    const storage = auth.createTokenStorage({ apiKey: "", lastRefresh: "", tokenData: { idToken: "id-tok", accessToken: "acc-tok", refreshToken: "", accountID: "", email: "", expire: "", planType: "" } });
    expect(storage.plan_type).toBe("free");
    auth.updateTokenStorage(storage, { idToken: "id-tok-2", accessToken: "acc-tok-2", refreshToken: "", accountID: "", email: "", expire: "", planType: "team" });
    expect(storage.plan_type).toBe("team");
    expect(storage.last_refresh).toBe("2026-10-28T12:00:00Z");
    auth.updateTokenStorage(storage, { idToken: "id-tok-3", accessToken: "acc-tok-3", refreshToken: "", accountID: "", email: "", expire: "", planType: "" });
    expect(storage.plan_type).toBe("free");
  });
});

describe("GenerateAuthURL", () => {
  test("includes the Codex CLI parameters", () => {
    const url = new URL(new CodexAuth({ fetch: fakeFetch(() => jsonResponse("{}")) }).generateAuthURL("st", { codeVerifier: "v", codeChallenge: "chal" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(ClientID);
    expect(url.searchParams.get("redirect_uri")).toBe(RedirectURI);
    expect(url.searchParams.get("scope")).toBe("openid email profile offline_access");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

// Ported from: internal/auth/claude/anthropic_auth_test.go
// Skipped cases: TestNewAnthropicHttpClientDoesNotSetRequestTimeout (Go http.Client field; fetch has no client-level timeout)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ClaudeAuth,
  ClaudeDevicePoolSize,
  ClaudeOAuthScope,
  ClientID,
  ProfileURL,
  RedirectURI,
  RefreshTokenURL,
  RolesURL,
  TokenURL,
  claudeRefreshBlockedUntil,
  resetClaudeRefreshState,
  updateTokenStorage,
  type ClaudeTokenStorage,
} from "../../../src/auth/claude/index.ts";
import { deferred, erroringBodyResponse, fakeFetch, fixedNow, fixedNowMs, jsonResponse, noopSleep, settle } from "../helpers.ts";

const profileJSON = `{
  "account":{"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"user@example.com"},
  "organization":{"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Example Org"}
}`;

const axiosHeaders: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": "axios/1.15.2",
  "Accept-Encoding": "gzip, compress, deflate, br",
  Connection: "close",
};

beforeEach(() => resetClaudeRefreshState());
afterEach(() => resetClaudeRefreshState());

describe("RefreshTokens", () => {
  test("uses an independent timeout signal on the refresh request", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = fakeFetch((req) => {
      signal = req.init?.signal;
      return jsonResponse(`{"error":"probe"}`, 400);
    });
    const auth = new ClaudeAuth({ fetch, now: fixedNow });
    await expect(auth.refreshTokens("independent-timeout-token")).rejects.toThrow("status 400");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  test("deduplicates concurrent refreshes of the same token", async () => {
    let tokenCalls = 0;
    let profileCalls = 0;
    const release = deferred();
    const fetch = fakeFetch(async (req) => {
      if (req.url === RefreshTokenURL) {
        tokenCalls++;
        await release.promise;
        return jsonResponse(`{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":3600,"scope":"user:profile user:inference"}`);
      }
      if (req.url === ProfileURL) {
        profileCalls++;
        return jsonResponse(`{"account":{"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"shared@example.com"},"organization":{"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Shared Org"}}`);
      }
      throw new Error(`unexpected OAuth request URL ${req.url}`);
    });
    const auth = new ClaudeAuth({ fetch, now: fixedNow });
    const p1 = auth.refreshTokens("shared-refresh-token");
    const p2 = auth.refreshTokens("shared-refresh-token");
    await settle();
    expect(tokenCalls).toBe(1);
    release.resolve();
    for (const td of await Promise.all([p1, p2])) {
      expect(td.accessToken).toBe("new-access");
      expect(td.accountUUID).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(td.organizationUUID).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(td.organizationName).toBe("Shared Org");
    }
    expect(tokenCalls).toBe(1);
    expect(profileCalls).toBe(1);
  });

  test("uses the native 2.1.220 control-plane shape and keeps the refresh token on fallback", async () => {
    const refreshToken = "placeholder-refresh";
    const fetch = fakeFetch((req) => {
      if (req.url === RefreshTokenURL) {
        expect(req.method).toBe("POST");
        expect(req.body).toBe(`{"client_id":"${ClientID}","grant_type":"refresh_token","refresh_token":"${refreshToken}","scope":"${ClaudeOAuthScope}"}`);
        for (const [name, want] of Object.entries(axiosHeaders)) expect(req.headers.get(name)).toBe(want);
        expect(req.init?.decompress).toBe(false);
        return jsonResponse(`{"access_token":"new-access","expires_in":3600}`);
      }
      if (req.url === ProfileURL) {
        return jsonResponse(`{"account":{"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"shared@example.com"},"organization":{"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Shared Org"}}`);
      }
      throw new Error(`unexpected OAuth request URL ${req.url}`);
    });
    const td = await new ClaudeAuth({ fetch, now: fixedNow }).refreshTokens(refreshToken);
    expect(td.refreshToken).toBe(refreshToken);
    expect(td.accountUUID).not.toBe("");
    expect(td.email).not.toBe("");
    expect(td.organizationUUID).not.toBe("");
    expect(td.expire).toBe("2026-10-28T13:00:00Z");
  });
});

describe("ExchangeCodeForTokens", () => {
  test("persists upstream account and device pool", async () => {
    const fetch = fakeFetch((req) => {
      switch (req.url) {
        case TokenURL:
          expect(req.method).toBe("POST");
          return jsonResponse(`{"access_token":"access","refresh_token":"refresh","token_type":"Bearer","expires_in":3600,"account":{"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email_address":"user@example.com"},"organization":{"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Example Org"}}`);
        case ProfileURL:
          return jsonResponse(profileJSON);
        case RolesURL:
          return jsonResponse(`{"roles":[]}`);
        default:
          throw new Error(`unexpected OAuth request URL ${req.url}`);
      }
    });
    const auth = new ClaudeAuth({ fetch, now: fixedNow });
    const bundle = await auth.exchangeCodeForTokens("code", "state", { codeVerifier: "verifier", codeChallenge: "" });
    expect(bundle.tokenData.accountUUID).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(bundle.tokenData.organizationUUID).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(bundle.tokenData.organizationName).toBe("Example Org");
    expect(bundle.deviceIDs).toHaveLength(ClaudeDevicePoolSize);
    const storage = auth.createTokenStorage(bundle);
    expect(storage.account_uuid).toBe(bundle.tokenData.accountUUID);
    expect(storage.organization_uuid).toBe(bundle.tokenData.organizationUUID);
    expect(storage.claude_device_ids).toHaveLength(ClaudeDevicePoolSize);
    expect(storage.expired).toBe("2026-10-28T13:00:00Z");
    expect(storage.last_refresh).toBe("2026-10-28T12:00:00Z");
  });

  test("uses the native 2.1.220 control-plane shape", async () => {
    const order: string[] = [];
    const headers = new Map<string, Headers>();
    let tokenBody = "";
    const fetch = fakeFetch((req) => {
      order.push(req.url);
      headers.set(req.url, req.headers);
      switch (req.url) {
        case TokenURL:
          expect(new URL(req.url).host).toBe("platform.claude.com");
          tokenBody = req.body;
          return jsonResponse(`{"access_token":"access","refresh_token":"refresh","expires_in":28800}`);
        case ProfileURL:
          expect(req.method).toBe("GET");
          return jsonResponse(profileJSON);
        case RolesURL:
          expect(req.method).toBe("GET");
          return jsonResponse(`{"roles":["claude_code_user"]}`);
        default:
          throw new Error(`unexpected OAuth request URL ${req.url}`);
      }
    });
    const bundle = await new ClaudeAuth({ fetch, now: fixedNow }).exchangeCodeForTokens("auth-code", "state-value", { codeVerifier: "verifier", codeChallenge: "" });
    expect(order).toEqual([TokenURL, ProfileURL, RolesURL]);
    expect(tokenBody).toBe(`{"grant_type":"authorization_code","code":"auth-code","redirect_uri":"${RedirectURI}","client_id":"${ClientID}","code_verifier":"verifier","state":"state-value"}`);
    for (const endpoint of order) {
      for (const [name, want] of Object.entries(axiosHeaders)) expect(headers.get(endpoint)!.get(name)).toBe(want);
    }
    expect(headers.get(TokenURL)!.get("Authorization")).toBeNull();
    for (const endpoint of [ProfileURL, RolesURL]) {
      expect(headers.get(endpoint)!.get("Authorization")).toBe("Bearer access");
      expect(headers.get(endpoint)!.get("Cache-Control")).toBe("no-cache");
    }
    expect(bundle.tokenData.accountUUID).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(bundle.tokenData.organizationUUID).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(bundle.tokenData.organizationName).toBe("Example Org");
    expect(bundle.tokenData.email).toBe("user@example.com");
  });

  test("a state fragment appended to the code wins", async () => {
    let tokenBody = "";
    const fetch = fakeFetch((req) => {
      if (req.url === TokenURL) {
        tokenBody = req.body;
        return jsonResponse(`{"access_token":"access","refresh_token":"refresh","expires_in":1}`);
      }
      return jsonResponse(`{"error":"unavailable"}`, 503);
    });
    await new ClaudeAuth({ fetch, now: fixedNow }).exchangeCodeForTokens("code#frag-state", "state", { codeVerifier: "v", codeChallenge: "" });
    const parsed = JSON.parse(tokenBody);
    expect(parsed.code).toBe("code");
    expect(parsed.state).toBe("frag-state");
  });

  test("survives companion lookup failure", async () => {
    const fetch = fakeFetch((req) => {
      if (req.url === TokenURL) {
        return jsonResponse(`{"access_token":"access","refresh_token":"refresh","expires_in":28800,"account":{"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email_address":"token@example.com"},"organization":{"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","name":"Token Org"}}`);
      }
      return jsonResponse(`{"error":"unavailable"}`, 503);
    });
    const bundle = await new ClaudeAuth({ fetch, now: fixedNow }).exchangeCodeForTokens("code", "state", { codeVerifier: "verifier", codeChallenge: "" });
    expect(bundle.tokenData.accountUUID).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(bundle.tokenData.email).toBe("token@example.com");
    expect(bundle.tokenData.organizationName).toBe("Token Org");
  });

  test("requires PKCE codes", async () => {
    const fetch = fakeFetch(() => jsonResponse("{}"));
    await expect(new ClaudeAuth({ fetch }).exchangeCodeForTokens("code", "state", undefined)).rejects.toThrow("PKCE codes are required");
  });
});

describe("RefreshTokensWithRetry", () => {
  test("does not replay after a response read error", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      return erroringBodyResponse(200);
    });
    await expect(new ClaudeAuth({ fetch, sleep: noopSleep }).refreshTokensWithRetry("single-use-refresh-token", 3)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("does not replay after a JSON decode error", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      return new Response("invalid json payload", { status: 200 });
    });
    await expect(new ClaudeAuth({ fetch, sleep: noopSleep }).refreshTokensWithRetry("single-use-refresh-token", 3)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("does not replay after a transport error", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      throw new Error("connection reset by peer");
    });
    await expect(new ClaudeAuth({ fetch, sleep: noopSleep }).refreshTokensWithRetry("single-use-refresh-token", 3)).rejects.toThrow("connection reset by peer");
    expect(calls).toBe(1);
  });

  test("retries 5xx responses and gives up after maxRetries", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      return jsonResponse(`{"error":"upstream"}`, 503);
    });
    await expect(new ClaudeAuth({ fetch, sleep: noopSleep }).refreshTokensWithRetry("retryable-token", 3)).rejects.toThrow("token refresh failed after 3 attempts");
    expect(calls).toBe(3);
  });

  test("429 blocks an immediate replay", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      return jsonResponse(`{"error":"rate_limited"}`, 429, { "Retry-After": "60" });
    });
    const auth = new ClaudeAuth({ fetch, now: fixedNow, sleep: noopSleep });
    await expect(auth.refreshTokensWithRetry("dummy_refresh_token", 3)).rejects.toThrow("status 429");
    expect(calls).toBe(1);
    await expect(auth.refreshTokensWithRetry("dummy_refresh_token", 3)).rejects.toThrow("blocked");
    expect(calls).toBe(1);
    expect(claudeRefreshBlockedUntil("dummy_refresh_token")).toBe(fixedNowMs + 60_000);
  });
});

describe("FetchOAuthProfile", () => {
  test("sends the axios headers with the bearer token", async () => {
    const fetch = fakeFetch((req) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe(ProfileURL);
      expect(req.headers.get("Authorization")).toBe("Bearer test-access");
      for (const [name, want] of Object.entries({ ...axiosHeaders, "Cache-Control": "no-cache" })) expect(req.headers.get(name)).toBe(want);
      return jsonResponse(profileJSON);
    });
    const profile = await new ClaudeAuth({ fetch }).fetchOAuthProfile("test-access");
    expect(profile.account).toEqual({ uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "user@example.com" });
    expect(profile.organization).toEqual({ uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Example Org" });
  });

  test("rejects a profile without account uuid", async () => {
    const fetch = fakeFetch(() => jsonResponse(`{"account":{"email":"x@example.com"}}`));
    await expect(new ClaudeAuth({ fetch }).fetchOAuthProfile("test-access")).rejects.toThrow("account UUID is empty");
  });
});

describe("UpdateTokenStorage", () => {
  test("preserves account when refresh omits it", () => {
    const storage: ClaudeTokenStorage = {
      id_token: "",
      access_token: "",
      refresh_token: "",
      last_refresh: "",
      email: "user@example.com",
      account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organization_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      organization_name: "Example Org",
      type: "claude",
      expired: "",
    };
    updateTokenStorage(storage, { accessToken: "new-access", refreshToken: "new-refresh", email: "", accountUUID: "", organizationUUID: "", organizationName: "", expire: "2099-01-01T00:00:00Z" }, fixedNowMs);
    expect(storage.email).toBe("user@example.com");
    expect(storage.account_uuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(storage.organization_uuid).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(storage.organization_name).toBe("Example Org");
    expect(storage.access_token).toBe("new-access");
    expect(storage.expired).toBe("2099-01-01T00:00:00Z");
    expect(storage.last_refresh).toBe("2026-10-28T12:00:00Z");
  });
});

describe("GenerateAuthURL", () => {
  test("builds the Claude Code authorize URL", () => {
    const { url, state } = new ClaudeAuth({ fetch: fakeFetch(() => jsonResponse("{}")) }).generateAuthURL("st", { codeVerifier: "v", codeChallenge: "chal" });
    const parsed = new URL(url);
    expect(state).toBe("st");
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(parsed.searchParams.get("code")).toBe("true");
    expect(parsed.searchParams.get("client_id")).toBe(ClientID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(RedirectURI);
    expect(parsed.searchParams.get("scope")).toBe(ClaudeOAuthScope);
    expect(parsed.searchParams.get("code_challenge")).toBe("chal");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("st");
  });
});

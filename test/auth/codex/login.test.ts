// New (no upstream test): end-to-end CodexAuthenticator.login through the local
// callback server and through the device-code flow with fake endpoints, plus refresh().
import { afterEach, describe, expect, test } from "bun:test";
import { CodexAuthenticator, CodexOuterRefreshLeadMs, TokenURL, codexDeviceTokenExchangeRedirectURI, codexDeviceTokenURL, codexDeviceUserCodeURL, isAuthenticationError, resetCodexRefreshGroupForTest } from "../../../src/auth/codex/index.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { fakeFetch, fixedNow, jsonResponse, makeTestCodexJWT, noopSleep } from "../helpers.ts";

afterEach(() => resetCodexRefreshGroupForTest());

const idToken = makeTestCodexJWT("plus", "acc-12345");
const quiet = { print: () => undefined, now: fixedNow, sleep: noopSleep, callbackHostname: "127.0.0.1" };

function browser(query: (state: string) => string) {
  return (url: string, port: number) => {
    const state = new URL(url).searchParams.get("state") ?? "";
    void fetch(`http://127.0.0.1:${port}/auth/callback?${query(state)}`, { redirect: "manual" }).catch(() => undefined);
  };
}

describe("CodexAuthenticator.login (browser)", () => {
  test("produces the upstream-compatible auth record", async () => {
    const fetchFn = fakeFetch((req) => {
      expect(req.url).toBe(TokenURL);
      return jsonResponse({ access_token: "at", refresh_token: "rt", id_token: idToken, expires_in: 3600 });
    });
    const auth = await new CodexAuthenticator().login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, fetch: fetchFn, onAuthorizationUrl: browser((s) => `code=c1&state=${s}`) } });
    expect(auth.provider).toBe("codex");
    const hash = new Bun.CryptoHasher("sha256").update("acc-12345").digest("hex").slice(0, 8);
    expect(auth.id).toBe(`codex-${hash}-user@example.com-plus.json`);
    expect(auth.attributes.plan_type).toBe("plus");
    expect(auth.metadata).toEqual({
      type: "codex",
      id_token: idToken,
      access_token: "at",
      refresh_token: "rt",
      account_id: "acc-12345",
      email: "user@example.com",
      plan_type: "plus",
      expired: "2026-10-28T13:00:00Z",
      last_refresh: "2026-10-28T12:00:00Z",
    });
    expect(new URLSearchParams(fetchFn.calls[0]!.body).get("code")).toBe("c1");
  });

  test("rejects a state mismatch", async () => {
    const err = await new CodexAuthenticator()
      .login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, fetch: fakeFetch(() => jsonResponse("{}")), onAuthorizationUrl: browser(() => "code=c&state=nope") } })
      .catch((e) => e);
    expect(isAuthenticationError(err)).toBe(true);
    expect(err.type).toBe("invalid_state");
  });

  test("wraps exchange failures as code_exchange_failed", async () => {
    const err = await new CodexAuthenticator()
      .login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, fetch: fakeFetch(() => jsonResponse({ error: "bad" }, 400)), onAuthorizationUrl: browser((s) => `code=c&state=${s}`) } })
      .catch((e) => e);
    expect(isAuthenticationError(err)).toBe(true);
    expect(err.type).toBe("code_exchange_failed");
  });
});

describe("CodexAuthenticator.login (device flow)", () => {
  test("polls until approved and exchanges with the device redirect URI", async () => {
    let polls = 0;
    const fetchFn = fakeFetch((req) => {
      switch (req.url) {
        case codexDeviceUserCodeURL:
          expect(JSON.parse(req.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
          return jsonResponse({ device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "1" });
        case codexDeviceTokenURL:
          polls++;
          expect(JSON.parse(req.body)).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-EFGH" });
          if (polls < 3) return jsonResponse({ error: "pending" }, 403);
          return jsonResponse({ authorization_code: "auth-code", code_verifier: "ver", code_challenge: "chal" });
        case TokenURL: {
          const form = new URLSearchParams(req.body);
          expect(form.get("code")).toBe("auth-code");
          expect(form.get("redirect_uri")).toBe(codexDeviceTokenExchangeRedirectURI);
          expect(form.get("code_verifier")).toBe("ver");
          return jsonResponse({ access_token: "at", refresh_token: "rt", id_token: idToken, expires_in: 60 });
        }
        default:
          throw new Error(`unexpected ${req.url}`);
      }
    });
    const printed: string[] = [];
    const auth = await new CodexAuthenticator().login({ noBrowser: true, metadata: { codex_login_mode: "device" }, hooks: { ...quiet, print: (l) => printed.push(l), fetch: fetchFn } });
    expect(polls).toBe(3);
    expect(auth.metadata.access_token).toBe("at");
    expect(printed.some((l) => l.includes("ABCD-EFGH"))).toBe(true);
  });

  test("fails when the device endpoint is unavailable", async () => {
    const fetchFn = fakeFetch(() => jsonResponse("", 404));
    await expect(new CodexAuthenticator().login({ noBrowser: true, metadata: { codex_login_mode: "device" }, hooks: { ...quiet, fetch: fetchFn } })).rejects.toThrow("device endpoint is unavailable");
  });
});

describe("CodexAuthenticator.refresh", () => {
  test("rewrites the outer token metadata and plan type", async () => {
    const fetchFn = fakeFetch(() => jsonResponse({ access_token: "new-at", refresh_token: "new-rt", id_token: idToken, expires_in: 120 }));
    const auth = newAuth({ id: "codex-x.json", provider: "codex", attributes: { plan_type: "free" }, metadata: { type: "codex", refresh_token: "old-rt", access_token: "old", prefix: "p", use_siwc: false } });
    const updated = await new CodexAuthenticator().refresh(auth, { fetch: fetchFn, now: fixedNow, sleep: noopSleep });
    expect(updated.metadata).toMatchObject({ access_token: "new-at", refresh_token: "new-rt", id_token: idToken, account_id: "acc-12345", email: "user@example.com", plan_type: "plus", expired: "2026-10-28T12:02:00Z", last_refresh: "2026-10-28T12:00:00Z", type: "codex", prefix: "p", use_siwc: false });
    expect(updated.attributes.plan_type).toBe("plus");
    expect(auth.metadata.access_token).toBe("old");
    expect(new URLSearchParams(fetchFn.calls[0]!.body).get("refresh_token")).toBe("old-rt");
  });

  test("returns the auth unchanged without a refresh token", async () => {
    const auth = newAuth({ id: "codex-x.json", provider: "codex", metadata: { access_token: "a" } });
    expect(await new CodexAuthenticator().refresh(auth, { fetch: fakeFetch(() => jsonResponse("{}")) })).toBe(auth);
  });

  test("refresh lead is 96 hours", () => {
    expect(new CodexAuthenticator().refreshLead()).toBe(CodexOuterRefreshLeadMs);
    expect(CodexOuterRefreshLeadMs).toBe(96 * 60 * 60 * 1000);
  });
});

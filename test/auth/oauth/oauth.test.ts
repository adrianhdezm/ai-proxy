// New (no upstream test): shared OAuth helpers - PKCE/state, callback URL
// parsing (misc.ParseOAuthCallback), the local callback server, expiry
// helpers and the metadata merge.
import { describe, expect, test } from "bun:test";
import { parseOAuthCallback } from "../../../src/auth/oauth/callback.ts";
import { authExpirationTime, authNeedsRefresh, expirationFromMetadata, isAuthExpired, parseJWTExp } from "../../../src/auth/oauth/expiry.ts";
import { getUserFriendlyMessage, newAuthenticationError, ErrPortInUse, OAuthError } from "../../../src/auth/oauth/errors.ts";
import { isAuthTokenPayloadKey, mergeExistingAuthMetadata } from "../../../src/auth/oauth/metadata.ts";
import { generateCodeChallenge, generatePKCECodes, generateRandomState } from "../../../src/auth/oauth/pkce.ts";
import { OAuthCallbackServer } from "../../../src/auth/oauth/server.ts";
import { formatRFC3339, parseTimeValue } from "../../../src/auth/oauth/time.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { fixedNowMs, makeTestJWT } from "../helpers.ts";

describe("pkce", () => {
  test("verifier is 128 base64url chars and the challenge is its S256 hash", () => {
    const codes = generatePKCECodes();
    expect(codes.codeVerifier).toMatch(/^[A-Za-z0-9_-]{128}$/);
    expect(codes.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeChallenge(codes.codeVerifier)).toBe(codes.codeChallenge);
    // RFC 7636 appendix B vector
    expect(generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(generateRandomState()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateRandomState()).not.toBe(generateRandomState());
  });
});

describe("parseOAuthCallback", () => {
  test("accepts full URLs, bare queries, fragments and code#state", () => {
    expect(parseOAuthCallback("")).toBeUndefined();
    expect(parseOAuthCallback("http://localhost:54545/callback?code=abc&state=st")).toMatchObject({ code: "abc", state: "st" });
    expect(parseOAuthCallback("?code=abc&state=st")).toMatchObject({ code: "abc", state: "st" });
    expect(parseOAuthCallback("code=abc&state=st")).toMatchObject({ code: "abc", state: "st" });
    expect(parseOAuthCallback("localhost:1455/auth/callback?code=x&state=y&client_id=cid")).toMatchObject({ code: "x", state: "y", clientId: "cid" });
    expect(parseOAuthCallback("http://localhost/cb#code=f&state=s")).toMatchObject({ code: "f", state: "s" });
    expect(parseOAuthCallback("http://localhost/cb?code=abc%23st")).toMatchObject({ code: "abc", state: "st" });
    expect(parseOAuthCallback("http://localhost/cb?error=access_denied&error_description=nope")).toMatchObject({ error: "access_denied", errorDescription: "nope" });
    expect(parseOAuthCallback("http://localhost/cb?error_description=only")).toMatchObject({ error: "only", errorDescription: "" });
  });

  test("rejects garbage and callbacks without a code", () => {
    expect(() => parseOAuthCallback("hello")).toThrow("invalid callback URL");
    expect(() => parseOAuthCallback("http://localhost/cb?state=only")).toThrow("callback URL missing code");
  });
});

describe("OAuthCallbackServer", () => {
  test("captures the first callback and serves the success page", async () => {
    const server = new OAuthCallbackServer({ port: 0, hostname: "127.0.0.1", callbackPath: "/callback", productName: "Test" });
    server.start();
    try {
      expect(server.isRunning).toBe(true);
      const wait = server.waitForCallback(5000);
      const resp = await fetch(`http://127.0.0.1:${server.port}/callback?code=c&state=s`, { redirect: "manual" });
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBe("/success");
      expect(await wait).toEqual({ code: "c", state: "s", clientId: "", error: "" });
      const success = await fetch(`http://127.0.0.1:${server.port}/success`);
      expect(success.status).toBe(200);
      expect(await success.text()).toContain("Authentication Successful - Test");
      expect((await fetch(`http://127.0.0.1:${server.port}/callback`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
      // A second result is dropped; the first one stays.
      expect(await server.waitForCallback(10)).toEqual({ code: "c", state: "s", clientId: "", error: "" });
    } finally {
      await server.stop();
    }
    expect(server.isRunning).toBe(false);
  });

  test("reports missing code/state and errors, and honours requireState=false", async () => {
    const strict = new OAuthCallbackServer({ port: 0, hostname: "127.0.0.1", callbackPath: "/cb" });
    strict.start();
    try {
      const wait = strict.waitForCallback(5000);
      expect((await fetch(`http://127.0.0.1:${strict.port}/cb?code=c`)).status).toBe(400);
      expect((await wait).error).toBe("no_state");
    } finally {
      await strict.stop();
    }
    const lenient = new OAuthCallbackServer({ port: 0, hostname: "127.0.0.1", callbackPath: "/cb", requireState: false });
    lenient.start();
    try {
      const wait = lenient.waitForCallback(5000);
      await fetch(`http://127.0.0.1:${lenient.port}/cb?code=c`, { redirect: "manual" });
      expect(await wait).toMatchObject({ code: "c", state: "" });
    } finally {
      await lenient.stop();
    }
    const erroring = new OAuthCallbackServer({ port: 0, hostname: "127.0.0.1", callbackPath: "/cb" });
    erroring.start();
    try {
      const wait = erroring.waitForCallback(5000);
      expect((await fetch(`http://127.0.0.1:${erroring.port}/cb?error=access_denied`)).status).toBe(400);
      expect((await wait).error).toBe("access_denied");
    } finally {
      await erroring.stop();
    }
  });

  test("times out, aborts and detects a port in use", async () => {
    const server = new OAuthCallbackServer({ port: 0, hostname: "127.0.0.1", callbackPath: "/cb" });
    server.start();
    try {
      await expect(server.waitForCallback(10)).rejects.toThrow("timeout waiting for OAuth callback");
      const ac = new AbortController();
      const wait = server.waitForCallback(5000, ac.signal);
      ac.abort(new Error("stop"));
      await expect(wait).rejects.toThrow("stop");
      const second = new OAuthCallbackServer({ port: server.port, hostname: "127.0.0.1", callbackPath: "/cb" });
      expect(() => second.start()).toThrow(`port ${server.port} is already in use`);
      expect(() => server.start()).toThrow("already running");
    } finally {
      await server.stop();
    }
  });
});

describe("expiry helpers", () => {
  test("parseTimeValue and formatRFC3339", () => {
    expect(formatRFC3339(fixedNowMs)).toBe("2026-10-28T12:00:00Z");
    expect(parseTimeValue("2026-10-28T12:00:00Z")).toBe(fixedNowMs);
    expect(parseTimeValue("2026-10-28T12:00:00.5+02:00")).toBe(fixedNowMs - 2 * 3600_000 + 500);
    expect(parseTimeValue("2026-10-28 12:00:00")).toBe(fixedNowMs);
    expect(parseTimeValue("2026-10-28 12:00")).toBe(fixedNowMs);
    expect(parseTimeValue(String(fixedNowMs / 1000))).toBe(fixedNowMs);
    expect(parseTimeValue(fixedNowMs)).toBe(fixedNowMs);
    expect(parseTimeValue("")).toBeUndefined();
    expect(parseTimeValue("soon")).toBeUndefined();
  });

  test("expirationFromMetadata looks at expiry keys, expires_in and nested token", () => {
    expect(expirationFromMetadata({ expired: "2026-10-28T12:00:00Z" })).toBe(fixedNowMs);
    expect(expirationFromMetadata({ expires_at: fixedNowMs / 1000 })).toBe(fixedNowMs);
    expect(expirationFromMetadata({ expires_in: 60, timestamp: "2026-10-28T12:00:00Z" })).toBe(fixedNowMs + 60_000);
    expect(expirationFromMetadata({ token: { expiry: "2026-10-28T12:00:00Z" } })).toBe(fixedNowMs);
    expect(expirationFromMetadata({})).toBeUndefined();
  });

  test("JWT exp wins over metadata and drives isAuthExpired / authNeedsRefresh", () => {
    const jwt = makeTestJWT({ exp: fixedNowMs / 1000 + 600 });
    expect(parseJWTExp(jwt)).toBe(fixedNowMs + 600_000);
    expect(parseJWTExp("not-a-jwt")).toBeUndefined();
    const auth = newAuth({ id: "a", provider: "codex", metadata: { access_token: jwt, refresh_token: "rt", expired: "2000-01-01T00:00:00Z" } });
    expect(authExpirationTime(auth)).toBe(fixedNowMs + 600_000);
    expect(isAuthExpired(auth, fixedNowMs)).toBe(false);
    expect(isAuthExpired(auth, fixedNowMs, 600_000)).toBe(true);
    expect(authNeedsRefresh(auth, 300_000, fixedNowMs)).toEqual({ dueAt: fixedNowMs + 300_000, hasRefresh: true, needsRefresh: false });
    expect(authNeedsRefresh(auth, 900_000, fixedNowMs)).toEqual({ dueAt: fixedNowMs, hasRefresh: true, needsRefresh: true });
    expect(authNeedsRefresh(auth, 0, fixedNowMs)).toEqual({ dueAt: fixedNowMs + 600_000, hasRefresh: true, needsRefresh: false });
    expect(authNeedsRefresh(auth, undefined, fixedNowMs)).toEqual({ hasRefresh: false, needsRefresh: false });
    const noExpiry = newAuth({ id: "b", provider: "claude", metadata: { access_token: "opaque", refresh_token: "rt", last_refresh: "2026-10-28T11:00:00Z" } });
    expect(authNeedsRefresh(noExpiry, 4 * 3600_000, fixedNowMs)).toEqual({ dueAt: fixedNowMs + 3 * 3600_000, hasRefresh: true, needsRefresh: false });
    const noToken = newAuth({ id: "c", provider: "claude", metadata: { refresh_token: "rt" } });
    expect(authNeedsRefresh(noToken, 1, fixedNowMs).needsRefresh).toBe(true);
    expect(isAuthExpired(noToken)).toBe(true);
    expect(authNeedsRefresh(newAuth({ id: "d", provider: "claude", metadata: {} }), 1, fixedNowMs).hasRefresh).toBe(false);
  });
});

describe("metadata merge and errors", () => {
  test("mergeExistingAuthMetadata never inherits token payload keys", () => {
    expect(isAuthTokenPayloadKey("Access_Token")).toBe(true);
    expect(isAuthTokenPayloadKey("prefix")).toBe(false);
    const target = newAuth({ id: "x", provider: "demo", metadata: { access_token: "new", prefix: "mine" } });
    mergeExistingAuthMetadata(target, { access_token: "old", refresh_token: "old-rt", prefix: "theirs", note: "n", disabled: true });
    expect(target.metadata).toEqual({ access_token: "new", prefix: "mine", note: "n", disabled: true });
    expect(target.disabled).toBe(true);
  });

  test("user friendly messages", () => {
    expect(getUserFriendlyMessage(newAuthenticationError(ErrPortInUse, new Error("x")))).toContain("already in use");
    expect(getUserFriendlyMessage(new OAuthError("access_denied"))).toBe("Authentication was cancelled or denied.");
    expect(getUserFriendlyMessage(new OAuthError("weird", "desc"))).toBe("Authentication failed: desc");
    expect(getUserFriendlyMessage(new Error("other"))).toBe("An unexpected error occurred. Please try again.");
    const err = newAuthenticationError(ErrPortInUse, new Error("boom"));
    expect(err.message).toBe("port_in_use: OAuth callback port is already in use (caused by: boom)");
    expect(err.baseMessage).toBe("OAuth callback port is already in use");
    expect(err.code).toBe(13);
  });
});

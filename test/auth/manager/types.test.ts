// Ported from: sdk/cliproxy/auth/types_test.go
// Skipped cases: TestEnsureIndexUsesCredentialIdentity / TestEnsureIndexUsesOAuthTypeAndAbsolutePath (stable Index not ported),
// TestRecentRequestsSnapshot* (recent request ring not ported).
import { expect, test } from "bun:test";
import { accessTokenExpirationTime, expirationTime, hasValidAccessToken, requestRetryOverride, toolPrefixDisabled } from "../../../src/auth/manager/index.ts";
import { cloneAuth } from "../../../src/auth/types.ts";
import { makeTestJWT } from "../helpers.ts";
import { Hour, auth, baseNow } from "./helpers.ts";

test("RequestRetryOverride", () => {
  expect(requestRetryOverride(undefined)).toEqual([0, false]);
  expect(requestRetryOverride(auth({ id: "a" }))).toEqual([0, false]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { request_retry: 0 } }))).toEqual([0, true]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { request_retry: 3 } }))).toEqual([3, true]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { request_retry: -1 } }))).toEqual([0, false]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { "request-retry": 2 } }))).toEqual([2, true]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { "request-retry": -2 } }))).toEqual([0, false]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { request_retry: 0, "request-retry": 2 } }))).toEqual([0, true]);
  expect(requestRetryOverride(auth({ id: "a", metadata: { request_retry: "0" } }))).toEqual([0, true]);
});

test("ToolPrefixDisabled", () => {
  expect(toolPrefixDisabled(undefined)).toBe(false);
  expect(toolPrefixDisabled(auth({ id: "a" }))).toBe(false);
  expect(toolPrefixDisabled(auth({ id: "a", metadata: { tool_prefix_disabled: true } }))).toBe(true);
  expect(toolPrefixDisabled(auth({ id: "a", metadata: { tool_prefix_disabled: "true" } }))).toBe(true);
  expect(toolPrefixDisabled(auth({ id: "a", metadata: { "tool-prefix-disabled": true } }))).toBe(true);
  expect(toolPrefixDisabled(auth({ id: "a", metadata: { tool_prefix_disabled: false } }))).toBe(false);
});

test("Auth_ExpirationTime_JWTExp", () => {
  const now = baseNow;
  const futureTime = now + 48 * Hour;
  const pastTime = now - 24 * Hour;
  const futureJWT = makeTestJWT({ exp: Math.floor(futureTime / 1000) });
  const pastJWT = makeTestJWT({ exp: Math.floor(pastTime / 1000) });

  // 1. When expired is missing, the exp claim of the access token wins.
  expect(expirationTime(auth({ id: "a", metadata: { access_token: futureJWT } }))).toBe(futureTime);

  // 2. A stale "expired" value loses against a future JWT exp.
  expect(expirationTime(auth({ id: "a", metadata: { expired: new Date(pastTime).toISOString(), access_token: futureJWT } }))).toBe(futureTime);

  // 3. Both in the past: a past time comes back.
  const expPast = expirationTime(auth({ id: "a", metadata: { expired: new Date(pastTime).toISOString(), access_token: pastJWT } }));
  expect(expPast).toBeDefined();
  expect(expPast!).toBeLessThan(now);

  // 4. Expired access token with a future id_token: the access token is invalid.
  const expiredAccess = auth({ id: "a", metadata: { access_token: pastJWT, id_token: futureJWT } });
  expect(hasValidAccessToken(expiredAccess, now)).toBe(false);
  const exp = accessTokenExpirationTime(expiredAccess);
  expect(exp).toBeDefined();
  expect(exp!).toBeLessThan(now);

  // 5. No access token: never valid.
  expect(hasValidAccessToken(auth({ id: "a", metadata: { id_token: futureJWT, expired: new Date(futureTime).toISOString() } }), now)).toBe(false);
});

test("AuthClone_EmptyMapsIsolation", () => {
  const orig = auth({ id: "a", attributes: {}, metadata: {}, modelStates: {} });
  const cloned = cloneAuth(orig);
  cloned.attributes.test = "val";
  cloned.metadata.test = 123;
  cloned.modelStates!.test = { status: "active", unavailable: false, nextRetryAfter: 0, quota: { exceeded: false, nextRecoverAt: 0 }, updatedAt: 0 };
  expect(Object.keys(orig.attributes)).toHaveLength(0);
  expect(Object.keys(orig.metadata)).toHaveLength(0);
  expect(Object.keys(orig.modelStates!)).toHaveLength(0);
});

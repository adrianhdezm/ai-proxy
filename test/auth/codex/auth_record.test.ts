// Ported from: sdk/auth/codex_auth_record_test.go
// Skipped cases: none (the Go Auth.Storage assertions map to Auth.metadata here)
import { describe, expect, test } from "bun:test";
import { buildCodexAuthRecord } from "../../../src/auth/codex/authenticator.ts";
import { CodexAuth } from "../../../src/auth/codex/codex_auth.ts";
import { fakeFetch, fixedNowMs, jsonResponse, makeTestCodexJWT } from "../helpers.ts";

const authSvc = new CodexAuth({ fetch: fakeFetch(() => jsonResponse("{}")) });

describe("buildCodexAuthRecord", () => {
  test("plan type defaults to free when missing", () => {
    const idToken = makeTestCodexJWT("", "acc-12345");
    const { auth, storage } = buildCodexAuthRecord(authSvc, {
      apiKey: "",
      lastRefresh: "2026-10-28T12:00:00Z",
      tokenData: { idToken, accessToken: "mock-access-token", refreshToken: "mock-refresh-token", email: "user@example.com", accountID: "", expire: "", planType: "" },
    }, fixedNowMs);
    expect(auth.attributes.plan_type).toBe("free");
    expect(auth.metadata.plan_type).toBe("free");
    expect(storage.plan_type).toBe("free");
    expect(auth.id.endsWith("-free.json")).toBe(true);
    expect(auth.provider).toBe("codex");
  });

  test("plan type extracted when present", () => {
    const idToken = makeTestCodexJWT("plus", "acc-12345");
    const { auth, storage } = buildCodexAuthRecord(authSvc, {
      apiKey: "",
      lastRefresh: "2026-10-28T12:00:00Z",
      tokenData: { idToken, accessToken: "mock-access-token", refreshToken: "mock-refresh-token", email: "user@example.com", accountID: "", expire: "", planType: "plus" },
    });
    expect(auth.attributes.plan_type).toBe("plus");
    expect(auth.metadata.plan_type).toBe("plus");
    expect(storage.plan_type).toBe("plus");
    expect(auth.id.endsWith("-plus.json")).toBe(true);
    const hash = new Bun.CryptoHasher("sha256").update("acc-12345").digest("hex").slice(0, 8);
    expect(auth.id).toBe(`codex-${hash}-user@example.com-plus.json`);
    expect(Object.keys(auth.metadata).sort()).toEqual(["access_token", "account_id", "email", "expired", "id_token", "last_refresh", "plan_type", "refresh_token", "type"]);
    expect(auth.metadata.type).toBe("codex");
  });

  test("requires an email", () => {
    expect(() =>
      buildCodexAuthRecord(authSvc, { apiKey: "", lastRefresh: "", tokenData: { idToken: "", accessToken: "a", refreshToken: "", email: "", accountID: "", expire: "", planType: "" } }),
    ).toThrow("missing account information");
  });
});

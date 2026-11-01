// Ported from: internal/auth/codex/jwt_parser_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { DefaultPlanType, getAccountID, getPlanType, getUserEmail, parseJWTToken, type JWTClaims } from "../../../src/auth/codex/jwt_parser.ts";
import { makeTestJWT } from "../helpers.ts";

describe("getPlanType", () => {
  test("defaults to free for missing, empty or blank plan types", () => {
    expect(getPlanType(undefined)).toBe(DefaultPlanType);
    const empty = parseJWTToken(makeTestJWT({}));
    expect(getPlanType(empty)).toBe(DefaultPlanType);
    const whitespace: JWTClaims = { ...empty, codexAuthInfo: { ...empty.codexAuthInfo, chatgpt_plan_type: "   " } };
    expect(getPlanType(whitespace)).toBe(DefaultPlanType);
    const pro: JWTClaims = { ...empty, codexAuthInfo: { ...empty.codexAuthInfo, chatgpt_plan_type: "pro" } };
    expect(getPlanType(pro)).toBe("pro");
  });
});

describe("parseJWTToken", () => {
  test("missing plan type defaults to free", () => {
    const claims = parseJWTToken(makeTestJWT({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acc-12345" } }));
    expect(getPlanType(claims)).toBe("free");
    expect(getAccountID(claims)).toBe("acc-12345");
    expect(getUserEmail(claims)).toBe("user@example.com");

    const team = parseJWTToken(makeTestJWT({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acc-12345", chatgpt_plan_type: "team" } }));
    expect(getPlanType(team)).toBe("team");
  });

  test("rejects malformed tokens", () => {
    expect(() => parseJWTToken("a.b")).toThrow("expected 3 parts, got 2");
    expect(() => parseJWTToken("a.!!!.c")).toThrow(/failed to (decode|unmarshal) JWT claims/);
  });
});

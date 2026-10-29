// Ported from: sdk/cliproxy/auth/classification_test.go
// Skipped cases: TestAuthSourceKind/"filename fallback" (the TS Auth has no FileName field; the path attribute covers it).
import { expect, test } from "bun:test";
import { AuthKindAPIKey, AuthKindOAuth, AuthSourceConfig, AuthSourceFile, AuthSourceMemory, AuthSourceObjectStore, AuthSourcePostgres, accountInfo, authKind, authSourceKind } from "../../../src/auth/manager/index.ts";
import { AttributeAPIKey, AttributeAuthKind, AttributePath, AttributeRuntimeOnly, AttributeSource, AttributeSourceBackend } from "../../../src/auth/types.ts";
import { auth } from "./helpers.ts";

test("AuthKind", () => {
  const cases: Array<{ name: string; attributes?: Record<string, string>; metadata?: Record<string, unknown>; want: string }> = [
    { name: "explicit api key attribute", attributes: { [AttributeAuthKind]: "api_key" }, want: AuthKindAPIKey },
    { name: "explicit oauth attribute wins over api key fallback", attributes: { [AttributeAuthKind]: "oauth", [AttributeAPIKey]: "k" }, want: AuthKindOAuth },
    { name: "explicit oauth metadata", metadata: { [AttributeAuthKind]: "oauth" }, want: AuthKindOAuth },
    { name: "legacy api key attribute", attributes: { [AttributeAPIKey]: "k" }, want: AuthKindAPIKey },
    { name: "legacy oauth metadata", metadata: { access_token: "token" }, want: AuthKindOAuth },
    { name: "unknown metadata shape", metadata: { type: "test" }, want: "" },
  ];
  for (const tc of cases) {
    expect(authKind(auth({ id: tc.name, attributes: tc.attributes ?? {}, metadata: tc.metadata ?? {} }))).toBe(tc.want);
  }
});

test("AuthSourceKind", () => {
  const cases: Array<{ name: string; attributes: Record<string, string>; want: string }> = [
    { name: "runtime only memory", attributes: { [AttributeRuntimeOnly]: "true", [AttributeSourceBackend]: AuthSourcePostgres }, want: AuthSourceMemory },
    { name: "backend postgres", attributes: { [AttributeSourceBackend]: "postgresql", [AttributePath]: "/tmp/auth.json" }, want: AuthSourcePostgres },
    { name: "backend object store", attributes: { [AttributeSourceBackend]: "object-store", [AttributePath]: "/tmp/auth.json" }, want: AuthSourceObjectStore },
    { name: "config source", attributes: { [AttributeSource]: "config:codex[abc]" }, want: AuthSourceConfig },
    { name: "path source", attributes: { [AttributeSource]: "/tmp/auth.json" }, want: AuthSourceFile },
    { name: "path attribute", attributes: { [AttributePath]: "/tmp/auth.json" }, want: AuthSourceFile },
  ];
  for (const tc of cases) expect(authSourceKind(auth({ id: tc.name, attributes: tc.attributes }))).toBe(tc.want);
});

test("AccountInfoUsesAuthKind", () => {
  expect(accountInfo(auth({ id: "a", attributes: { [AttributeAuthKind]: "api-key", [AttributeAPIKey]: "k" } }))).toEqual(["api_key", "k"]);
  expect(accountInfo(auth({ id: "a", attributes: { [AttributeAuthKind]: AuthKindOAuth, [AttributeAPIKey]: "k" }, metadata: { email: "user@example.com" } }))).toEqual(["oauth", "user@example.com"]);
  expect(accountInfo(auth({ id: "a", metadata: { access_token: "token" } }))).toEqual(["oauth", ""]);
});

// Ported from: internal/auth/claude/filename_test.go
// Skipped cases: none (the credentialListStore fake is an in-memory TokenStore list)
import { describe, expect, test } from "bun:test";
import { credentialFileName, findMatchingLegacyCredential } from "../../../src/auth/claude/filename.ts";
import { metadataString } from "../../../src/auth/oauth/metadata.ts";
import { type Auth, newAuth } from "../../../src/auth/types.ts";

describe("credentialFileName", () => {
  const cases = [
    { name: "organization hash keeps organizations with the same email distinct", email: "user@example.com", org: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", account: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: "claude-00f765af-user@example.com.json" },
    { name: "different organization produces a different filename", email: "user@example.com", org: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", account: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", want: "claude-50d86b12-user@example.com.json" },
    { name: "account hash is used without organization", email: " user@example.com ", org: "", account: " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ", want: "claude-303617b9-user@example.com.json" },
    { name: "missing identities fall back to legacy email filename", email: " user@example.com ", org: "", account: "", want: "claude-user@example.com.json" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(credentialFileName(tt.email, tt.org, tt.account)).toBe(tt.want);
    });
  }
});

describe("findMatchingLegacyCredential", () => {
  const email = "user@example.com";
  const legacyFileName = credentialFileName(email, "", "");
  const cases: Array<{ name: string; target: Record<string, unknown>; legacy: Record<string, unknown>; candidateFileName?: string; wantMatch?: boolean }> = [
    { name: "matching organization", target: { email, organization_uuid: "organization-a", account_uuid: "shared-account" }, legacy: { email, organization_uuid: "organization-a", account_uuid: "shared-account" }, wantMatch: true },
    { name: "different organization with shared account", target: { email, organization_uuid: "organization-b", account_uuid: "shared-account" }, legacy: { email, organization_uuid: "organization-a", account_uuid: "shared-account" } },
    { name: "missing legacy organization remains ambiguous", target: { email, organization_uuid: "organization-a", account_uuid: "shared-account" }, legacy: { email, account_uuid: "shared-account" } },
    { name: "matching account when neither has organization", target: { email, account_uuid: "account-a" }, legacy: { email, account_uuid: "account-a" }, wantMatch: true },
    { name: "matching account-hashed predecessor when target gains organization", target: { email, organization_uuid: "organization-a", account_uuid: "account-a" }, legacy: { email, account_uuid: "account-a" }, candidateFileName: credentialFileName(email, "", "account-a"), wantMatch: true },
    { name: "different account-hashed predecessor", target: { email, organization_uuid: "organization-a", account_uuid: "account-a" }, legacy: { email, account_uuid: "account-b" }, candidateFileName: credentialFileName(email, "", "account-b") },
    { name: "account-hashed predecessor associated with another organization", target: { email, organization_uuid: "organization-a", account_uuid: "shared-account" }, legacy: { email, organization_uuid: "organization-b", account_uuid: "shared-account" }, candidateFileName: credentialFileName(email, "", "shared-account") },
  ];
  for (const tt of cases) {
    test(tt.name, async () => {
      const targetName = credentialFileName(email, metadataString(tt.target, "organization_uuid"), metadataString(tt.target, "account_uuid"));
      const target: Auth = newAuth({ id: targetName, provider: "claude", metadata: tt.target });
      const legacy: Auth = newAuth({ id: tt.candidateFileName ?? legacyFileName, provider: "claude", metadata: tt.legacy });
      const store = { list: async () => [legacy] };
      const got = await findMatchingLegacyCredential(store, target);
      expect(got !== undefined).toBe(tt.wantMatch ?? false);
    });
  }

  test("non-claude or non-hashed targets never match", async () => {
    const legacy = newAuth({ id: legacyFileName, provider: "claude", metadata: { email, account_uuid: "a" } });
    const store = { list: async () => [legacy] };
    expect(await findMatchingLegacyCredential(store, newAuth({ id: legacyFileName, provider: "claude", metadata: { email } }))).toBeUndefined();
    expect(await findMatchingLegacyCredential(undefined, newAuth({ id: "x", provider: "claude", metadata: { email, account_uuid: "a" } }))).toBeUndefined();
  });
});

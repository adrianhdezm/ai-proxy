// Ported from: internal/auth/codex/filename_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { credentialFileName, hashAccountID } from "../../../src/auth/codex/filename.ts";

describe("credentialFileName", () => {
  const cases = [
    { name: "team includes account hash", email: "user@example.com", plan: "team", hash: "abc12345", prefix: true, want: "codex-abc12345-user@example.com-team.json" },
    { name: "k12 includes account hash", email: "user@example.com", plan: "k12", hash: "def67890", prefix: true, want: "codex-def67890-user@example.com-k12.json" },
    { name: "k12 without account hash falls back to email and plan", email: "user@example.com", plan: "k12", hash: "", prefix: true, want: "codex-user@example.com-k12.json" },
    { name: "plus includes account hash", email: " user@example.com ", plan: "Plus", hash: " abc12345 ", prefix: true, want: "codex-abc12345-user@example.com-plus.json" },
    { name: "plus without account hash falls back to email and plan", email: "user@example.com", plan: "plus", hash: "", prefix: true, want: "codex-user@example.com-plus.json" },
    { name: "plan is normalized", email: "user@example.com", plan: " Team Plan ", hash: "abc12345", prefix: true, want: "codex-abc12345-user@example.com-team-plan.json" },
    { name: "account hash is used without plan", email: "user@example.com", plan: "", hash: "abc12345", prefix: true, want: "codex-abc12345-user@example.com.json" },
    { name: "missing plan and account hash falls back to email", email: "user@example.com", plan: "", hash: "", prefix: true, want: "codex-user@example.com.json" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      expect(credentialFileName(tt.email, tt.plan, tt.hash, tt.prefix)).toBe(tt.want);
    });
  }

  test("hashAccountID is the first 8 hex chars of sha256", () => {
    expect(hashAccountID("")).toBe("");
    expect(hashAccountID(" acc-12345 ")).toBe(new Bun.CryptoHasher("sha256").update("acc-12345").digest("hex").slice(0, 8));
  });
});

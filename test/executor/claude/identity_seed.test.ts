// Ported from: internal/runtime/executor/helps/claude_cli_identity_seed_test.go
// Ported from: internal/runtime/executor/helps/claude_json_prefilter_test.go
// Skipped cases: claude_cli_identity_seed_test.go: the "auth index" and "auth file" rows of
// TestClaudeCLIAuthIdentitySeedPrefersStableAuthIdentity (the Auth record has no Index / FileName fields; id is the file
// name or store key), TestPrepareClaudeCLIFingerprintAuthIsolatesUnlockedMetadataReaders (goroutine race),
// TestEnsureClaudeCLIFingerprintIdentityNoopWithoutSynthesize (there is no separate Ensure step: identity is applied
// per request by applyClaudeCLIIdentity, and real OAuth credentials without an account get a derived one instead of an
// error). EnsureClaudeCLIFingerprintIdentity + ApplyClaudeCredentialMetadata are exercised through
// applyClaudeCLIIdentity(…, synthesize=true), which writes the synthesized identity to a clone (Go:
// PrepareClaudeCLIFingerprintAuth), so "second call must not rotate identity" compares two applications.
// claude_json_prefilter_test.go: TestJSONMayContainASCII (a Go byte-scan shortcut ahead of gjson; this port parses the
// JSON, so \u escapes are decoded before any comparison and there is no pre-filter to test);
// BenchmarkIsClaudeProbeOrHelperRequestLarge, BenchmarkClaudePayloadHas1hTTLLarge* (Go benchmarks).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { isValidUserID } from "../../../src/executor/claude/client_detection.ts";
import {
  applyClaudeCLIIdentity,
  claudeCLIAuthIdentitySeed,
  claudeCredentialAccountUUID,
  stableClaudeCLIAccountUUID,
  stableClaudeCLIDeviceID,
} from "../../../src/executor/claude/identity.ts";
import { claudePayloadHas1hTTL, isClaudeTitleHelperRequest } from "../../../src/executor/claude/request_shape.ts";

const sessionID = "11111111-2222-4333-8444-555555555555";
const userIDOf = (body: string) => JSON.parse(JSON.parse(body).metadata.user_id);

describe("helps/claude_cli_identity_seed.go", () => {
  test("EnsureClaudeCLIFingerprintIdentitySynthesizesStableSources", () => {
    const auth = newAuth({ id: "", provider: "claude" });
    const first = userIDOf(applyClaudeCLIIdentity(`{"messages":[]}`, auth, "key-a", sessionID, true));
    expect(first.account_uuid).not.toBe("");
    expect(first.account_uuid).toBe(stableClaudeCLIAccountUUID("key-a"));
    expect(first.device_id).toBe(stableClaudeCLIDeviceID("key-a"));
    // A second application must not rotate the identity.
    const updated = applyClaudeCLIIdentity(`{"messages":[]}`, auth, "key-a", sessionID, true);
    const second = userIDOf(updated);
    expect(second.account_uuid).toBe(first.account_uuid);
    expect(second.device_id).toBe(first.device_id);
    expect(isValidUserID(JSON.parse(updated).metadata.user_id)).toBe(true);
    expect(second.session_id).toBe(sessionID);
  });

  test("ClaudeCLIAuthIdentitySeedPrefersStableAuthIdentity", () => {
    expect(claudeCLIAuthIdentitySeed(newAuth({ id: "kimi-auth", provider: "claude" }))).toBe("auth-id|kimi-auth");
    expect(claudeCLIAuthIdentitySeed(newAuth({ id: "", provider: "claude" }))).toBe("");
  });

  test("PrepareClaudeCLIFingerprintAuthDoesNotMutateSharedMetadata", () => {
    const shared = newAuth({ id: "kimi-shared", provider: "claude", metadata: { access_token: "token-1" } });
    const prepared = userIDOf(applyClaudeCLIIdentity(`{"messages":[]}`, shared, "seed", sessionID, true));
    expect(prepared.account_uuid).not.toBe("");
    expect(claudeCredentialAccountUUID(shared)).toBe("");
    expect(shared.metadata.claude_device_ids).toBeUndefined();
  });

  test("EnsureClaudeCLIFingerprintIdentityPreservesExistingOAuthSources", () => {
    const auth = newAuth({
      id: "",
      provider: "claude",
      metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["b".repeat(64)] },
    });
    const got = userIDOf(applyClaudeCLIIdentity(`{"messages":[]}`, auth, "key-a", sessionID, true));
    expect(got.account_uuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(got.device_id).toBe("b".repeat(64));
    expect(auth.metadata.claude_device_ids).toEqual(["b".repeat(64)]);
  });
});

describe("helps/claude_json_prefilter.go", () => {
  test("PrefilteredClassifiersKeepEscapedMatches", () => {
    const escapedTitle = String.raw`{"model":"m","system":[{"type":"text","text":"You are naming a coding session."}],"messages":[{"role":"user","content":"hi"}]}`;
    expect(isClaudeTitleHelperRequest(escapedTitle)).toBe(true);
    expect(isClaudeTitleHelperRequest(`{"model":"m","system":"Return a short title for this.","messages":[{"role":"user","content":"hi"}]}`)).toBe(true);
    expect(isClaudeTitleHelperRequest(`{"model":"m","output_config":{"format":{"schema":{"properties":{"title":{"type":"string"}}}}},"messages":[{"role":"user","content":"<session>x</session>"}]}`)).toBe(
      true,
    );
    expect(isClaudeTitleHelperRequest(`{"model":"m","system":"You are Claude Code.","messages":[{"role":"user","content":"Return a short answer"}]}`)).toBe(false);
    expect(claudePayloadHas1hTTL(String.raw`{"messages":[{"role":"user","content":[{"type":"text","text":"x","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`)).toBe(true);
    expect(claudePayloadHas1hTTL(`{"messages":[{"role":"user","content":[{"type":"text","text":"took 11h","cache_control":{"type":"ephemeral","ttl":"5m"}}]}]}`)).toBe(false);
  });
});

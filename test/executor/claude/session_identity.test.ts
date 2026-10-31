// Ported from: internal/runtime/executor/helps/claude_code_session_test.go
// Ported from: internal/runtime/executor/helps/claude_credential_identity_test.go
// Ported from: internal/runtime/executor/helps/claude_device_profile_test.go
// Skipped cases: claude_code_session_test.go: TestClaudeCodePromptCacheStableAcrossRequests,
// TestClaudeCodePromptCacheDeterministicAndAgentScoped (Codex prompt_cache_key derivation, not part of the Claude
// executor). claude_credential_identity_test.go: TestEnsureClaudeCredentialDevicePoolRequiredMigratesHomeKVToOne (Home
// KV), TestApplyClaudeCredentialMetadataRequiresAccountUUID (this port synthesizes a stable account UUID instead of
// failing), the "duplicate metadata user ID" and "duplicate encoded account UUID" rows of
// TestApplyClaudeCredentialMetadataRejectsDuplicateIdentityContainers (only duplicate top-level metadata is detected);
// the "derived session" row of TestClaudeAgentSessionUUIDUsesExecutionAndDerivedIdentity uses session_id metadata.
// claude_device_profile_test.go: TestResolveClaudeDeviceProfile* (per-credential device-profile cache and learning
// not ported), *Home* (Home KV), TestApplyClaudeLegacyDeviceHeadersKeepNewerVersionsUsesConfiguredBaseline
// (keep-newer-versions switch not ported).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { applyClaudeLegacyDeviceHeaders, defaultClaudeDeviceProfile, defaultClaudeFingerprintPackageVersion, defaultClaudeFingerprintRuntimeVersion } from "../../../src/executor/claude/device_profile.ts";
import { applyClaudeCLIIdentity, claudeAgentSessionUUIDForRequest, validateClaudeMetadataUnique } from "../../../src/executor/claude/identity.ts";
import { claudeCodeExecutionScope, extractClaudeCodeSessionID } from "../../../src/executor/claude/session.ts";
import { StatusError } from "../../../src/executor/types.ts";

describe("claude code session (helps/claude_code_session.go)", () => {
  test("ExtractClaudeCodeSessionIDFromPayloadJSON", () => {
    expect(extractClaudeCodeSessionID(`{"metadata":{"user_id":"{\\"device_id\\":\\"d\\",\\"session_id\\":\\"cache-session-1\\"}"}}`, undefined)).toBe("cache-session-1");
  });

  test("ExtractClaudeCodeSessionIDFromHeader", () => {
    expect(extractClaudeCodeSessionID(`{"model":"gpt-5.4"}`, new Headers({ "X-Claude-Code-Session-Id": "header-session-1" }))).toBe("header-session-1");
  });

  test("ExtractClaudeCodeSessionIDPrefersHeaderOverPayload", () => {
    const payload = `{"metadata":{"user_id":"{"session_id":"payload-session"}"}}`;
    expect(extractClaudeCodeSessionID(payload, new Headers({ "X-Claude-Code-Session-Id": "header-session" }))).toBe("header-session");
  });

  test("ClaudeCodeExecutionScopeAcceptsLowercaseHeaderMapKeys", () => {
    const headers = new Headers({ "x-claude-code-session-id": "lower-session", "x-claude-code-agent-id": "lower-agent" });
    expect(claudeCodeExecutionScope("", headers)).toBe("claude:lower-session:agent:lower-agent");
  });

  test("ClaudeCodeExecutionScopeIsolatesAgents", () => {
    const root = claudeCodeExecutionScope("", new Headers({ "X-Claude-Code-Session-Id": "session-agents" }));
    const a = claudeCodeExecutionScope("", new Headers({ "X-Claude-Code-Session-Id": "session-agents", "X-Claude-Code-Agent-Id": "agent-a" }));
    const b = claudeCodeExecutionScope("", new Headers({ "X-Claude-Code-Session-Id": "session-agents", "X-Claude-Code-Agent-Id": "agent-b" }));
    expect(root).toBe("claude:session-agents:agent:main");
    expect(a).toBe("claude:session-agents:agent:agent-a");
    expect(b).toBe("claude:session-agents:agent:agent-b");
  });
});

describe("credential identity (helps/claude_credential_identity.go)", () => {
  test("AgentSessionUUIDPreservesNativeSession", () => {
    const sessionID = "11111111-2222-4333-8444-555555555555";
    expect(claudeAgentSessionUUIDForRequest(new Headers({ "X-Claude-Code-Session-Id": sessionID }), "", "", true)).toBe(sessionID);
  });

  test("AgentSessionUUIDIgnoresUnconfirmedClaudeSignals", () => {
    const native = "11111111-2222-4333-8444-555555555555";
    const metadata = { execution_session_id: "non-native-conversation" };
    const got = claudeAgentSessionUUIDForRequest(
      new Headers({ "X-Claude-Code-Session-Id": native }),
      `{"metadata":{"user_id":"{\\"device_id\\":\\"${"0".repeat(64)}\\",\\"session_id\\":\\"${native}\\"}"}}`,
      "",
      false,
      metadata,
    );
    expect(got).not.toBe(native);
    expect(claudeAgentSessionUUIDForRequest(undefined, "", "", false, metadata)).toBe(got);
  });

  test("AgentSessionUUIDUsesExecutionAndDerivedIdentity", () => {
    for (const metadata of [{ execution_session_id: "agent-run-1" }, { session_id: "ctx:v1:conversation-root" }]) {
      const first = claudeAgentSessionUUIDForRequest(undefined, "", "", false, metadata);
      expect(first).not.toBe("");
      expect(claudeAgentSessionUUIDForRequest(undefined, "", "", false, metadata)).toBe(first);
    }
  });

  test("explicit session headers give distinct stable sessions", () => {
    const a = claudeAgentSessionUUIDForRequest(new Headers({ "X-Session-ID": "s-1" }), `{"messages":[]}`, "", false);
    expect(claudeAgentSessionUUIDForRequest(new Headers({ "X-Session-ID": "s-1" }), `{"messages":[]}`, "", false)).toBe(a);
    expect(claudeAgentSessionUUIDForRequest(new Headers({ "X-Session-ID": "s-2" }), `{"messages":[]}`, "", false)).not.toBe(a);
  });

  test("ApplyClaudeCredentialMetadataUsesCredentialDeviceAndPreservesExtras", () => {
    const auth = newAuth({ id: "", provider: "claude", metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] } });
    const sessionID = "11111111-2222-4333-8444-555555555555";
    const body = `{"messages":[{"role":"user","content":"x"}],"metadata":{"user_id":"{\\"device_id\\":\\"${"f".repeat(64)}\\",\\"account_uuid\\":\\"downstream-account\\",\\"session_id\\":\\"downstream-session\\",\\"parent_session_id\\":\\"parent-1\\",\\"extra\\":true}"}}`;
    const userID = JSON.parse(applyClaudeCLIIdentity(body, auth, "sk-ant-oat-x", sessionID, false)).metadata.user_id as string;
    const parsed = JSON.parse(userID);
    expect(parsed.device_id).toBe("0".repeat(64));
    expect(parsed.account_uuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(parsed.session_id).toBe(sessionID);
    expect(parsed.parent_session_id).toBe("parent-1");
    expect(parsed.extra).toBe(true);
    expect(userID.startsWith(`{"device_id":"${"0".repeat(64)}","account_uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"${sessionID}"`)).toBe(true);
  });

  test("ApplyClaudeCredentialMetadataRejectsDuplicateIdentityContainers (reduced)", () => {
    const auth = newAuth({ id: "", provider: "claude", metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] } });
    expect(() => applyClaudeCLIIdentity(`{"messages":[],"metadata":`, auth, "k", "s", false)).toThrow(StatusError);
    try {
      validateClaudeMetadataUnique(`{"messages":[],"metadata":{"user_id":"{}"},"metadata":{"user_id":"{}"}}`);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(StatusError);
      expect((err as StatusError).statusCode).toBe(400);
      expect((err as StatusError).requestScoped).toBe(true);
    }
  });
});

describe("device profile (helps/claude_device_profile.go)", () => {
  const deviceHeaders = (ua: string) =>
    new Headers({ "User-Agent": ua, "X-Stainless-Package-Version": defaultClaudeFingerprintPackageVersion, "X-Stainless-Runtime-Version": defaultClaudeFingerprintRuntimeVersion, "X-Stainless-Os": "Windows", "X-Stainless-Arch": "x64" });

  test("ApplyClaudeLegacyDeviceHeadersReplacesInvalidNativeSoftwareSignals", () => {
    const incoming = deviceHeaders("claude-cli/999.0.0 (external, cli)");
    incoming.set("X-Stainless-Package-Version", "999.0.0");
    incoming.set("X-Stainless-Runtime-Version", "v999.0.0");
    const out = new Headers();
    applyClaudeLegacyDeviceHeaders(out, incoming, undefined, true);
    const baseline = defaultClaudeDeviceProfile(undefined);
    expect(out.get("User-Agent")).toBe(baseline.userAgent);
    expect(out.get("X-Stainless-Package-Version")).toBe(baseline.packageVersion);
    expect(out.get("X-Stainless-Runtime-Version")).toBe(baseline.runtimeVersion);
  });

  test("ApplyClaudeLegacyDeviceHeadersAcceptsConfiguredMeasuredBaseline", () => {
    const hd = { userAgent: "claude-cli/2.2.0 (external, cli)", packageVersion: "0.95.0", runtimeVersion: "v26.4.0", os: "MacOS", arch: "arm64" };
    const incoming = deviceHeaders("claude-cli/2.2.0 (external, cli)");
    incoming.set("X-Stainless-Package-Version", "0.95.0");
    incoming.set("X-Stainless-Runtime-Version", "v26.4.0");
    const out = new Headers();
    applyClaudeLegacyDeviceHeaders(out, incoming, hd, true);
    expect(out.get("User-Agent")).toBe("claude-cli/2.2.0 (external, cli)");
    expect(out.get("X-Stainless-Package-Version")).toBe("0.95.0");
    expect(out.get("X-Stainless-Runtime-Version")).toBe("v26.4.0");
  });
});

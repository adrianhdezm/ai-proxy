// Ported from: internal/runtime/executor/helps/claude_client_detection_test.go
// Skipped cases: TestDetectClaudeCodeRequestRecognizesMeasuredHaikuHelpers, RejectsExtendedHaikuHelperBetas,
// RejectsCrossMismatchedHaikuHelperBetaAndBody, RejectsMalformedStructuredHaikuHelpers, RejectsNearMissHaikuHelpers,
// AcceptsHelperSubagentParentSessionID, RejectsHelperIdentityWithUnknownKeys, AcceptsHelperFromNonBaselinePlatform,
// RejectsHelperWithoutPlatformHeaders, RejectsHelperWithForeignSoftwareTuple, MeasuredHelperProfileIgnoresConfiguredStainlessTimeout,
// RecognizesAgentSDKHaiku55Helpers (measured Haiku helper profiles not ported), TestNormalizedClaudeBetaHeaderIsDeterministic
// (Headers already normalises repeated entries).
import { describe, expect, test } from "bun:test";
import { detectClaudeCodeRequest } from "../../../src/executor/claude/client_detection.ts";

const validClaudeCodeMetadataUserID = `{"device_id":"0000000000000000000000000000000000000000000000000000000000000000","account_uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","session_id":"11111111-2222-4333-8444-555555555555"}`;

function claudeCodeDetectionPayload(userID: string): string {
  return `{"metadata":{"user_id":${JSON.stringify(userID)}}}`;
}

function confirmedClaudeCodeHeaders(): Headers {
  return new Headers({
    "User-Agent": "claude-cli/2.1.280 (external, cli)",
    "X-App": "cli",
    "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
  });
}

test("DetectClaudeCodeRequest requires all four message signals", () => {
  const detection = detectClaudeCodeRequest(confirmedClaudeCodeHeaders(), claudeCodeDetectionPayload(validClaudeCodeMetadataUserID), false);
  expect(detection.confirmed && detection.strongSignals && detection.nativeClient).toBe(true);
  expect(detection.xAppCLI && detection.userAgent && detection.betasPresent && detection.metadataUserID).toBe(true);
});

test("DetectClaudeCodeRequest accepts newer patch in measured release line", () => {
  const headers = confirmedClaudeCodeHeaders();
  headers.set("User-Agent", "claude-cli/2.1.281 (external, cli)");
  const detection = detectClaudeCodeRequest(headers, claudeCodeDetectionPayload(validClaudeCodeMetadataUserID), false);
  expect(detection.confirmed && detection.strongSignals && detection.nativeClient).toBe(true);
});

test("DetectClaudeCodeRequest accepts configured measured baseline", () => {
  const headers = confirmedClaudeCodeHeaders();
  headers.set("User-Agent", "claude-cli/2.2.0 (external, cli)");
  const payload = claudeCodeDetectionPayload(validClaudeCodeMetadataUserID);
  expect(detectClaudeCodeRequest(headers, payload, false).confirmed).toBe(false);
  const hd = { userAgent: "claude-cli/2.2.0 (external, cli)", packageVersion: "0.95.0", runtimeVersion: "v26.4.0" };
  expect(detectClaudeCodeRequest(headers, payload, false, hd).confirmed).toBe(true);
});

describe("DetectClaudeCodeRequest rejects each missing message signal", () => {
  const payload = claudeCodeDetectionPayload(validClaudeCodeMetadataUserID);
  const cases = [
    { name: "x-app", headers: new Headers({ "User-Agent": "claude-cli/2.1.280 (external, cli)", "Anthropic-Beta": "claude-code-20250219" }), body: payload },
    { name: "user-agent", headers: new Headers({ "User-Agent": "curl/8.7.1", "X-App": "cli", "Anthropic-Beta": "claude-code-20250219" }), body: payload },
    { name: "betas", headers: new Headers({ "User-Agent": "claude-cli/2.1.280 (external, cli)", "X-App": "cli" }), body: payload },
    { name: "metadata", headers: confirmedClaudeCodeHeaders(), body: `{"messages":[]}` },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(detectClaudeCodeRequest(tc.headers, tc.body, false).confirmed).toBe(false);
    });
  }
});

describe("DetectClaudeCodeRequest classifies entrypoints", () => {
  const payload = claudeCodeDetectionPayload(validClaudeCodeMetadataUserID);
  const cases = [
    { name: "cli", userAgent: "claude-cli/2.1.280 (external, cli)", entrypoint: "cli", subclient: "claude-code-cli", agentSDKVersion: "", native: true },
    { name: "vscode-agent-sdk", userAgent: "claude-cli/2.1.280 (external, claude-vscode, agent-sdk/0.3.220)", entrypoint: "claude-vscode", subclient: "claude-code-vscode", agentSDKVersion: "0.3.220", native: true },
    { name: "sdk-cli", userAgent: "claude-cli/2.1.280 (external, sdk-cli)", entrypoint: "sdk-cli", subclient: "claude-code-cli-sdk", agentSDKVersion: "", native: true },
    { name: "sdk-ts", userAgent: "claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.220)", entrypoint: "sdk-ts", subclient: "claude-code-sdk-ts", agentSDKVersion: "0.3.220", native: true },
    { name: "sdk-py", userAgent: "claude-cli/2.1.280 (external, sdk-py, agent-sdk/0.1.0)", entrypoint: "sdk-py", subclient: "claude-code-sdk-py", agentSDKVersion: "0.1.0", native: false },
    { name: "desktop", userAgent: "claude-cli/2.1.280 (external, claude-desktop)", entrypoint: "claude-desktop", subclient: "claude-desktop", agentSDKVersion: "", native: false },
    { name: "desktop-third-party-inference", userAgent: "claude-cli/2.1.280 (external, claude-desktop-3p)", entrypoint: "claude-desktop-3p", subclient: "claude-desktop-3p", agentSDKVersion: "", native: false },
    { name: "remote", userAgent: "claude-cli/2.1.280 (external, remote)", entrypoint: "remote", subclient: "claude-remote", agentSDKVersion: "", native: false },
    { name: "github-action", userAgent: "claude-cli/2.1.280 (external, claude-code-github-action)", entrypoint: "claude-code-github-action", subclient: "claude-code-gh-action", agentSDKVersion: "", native: false },
    { name: "unknown", userAgent: "claude-cli/2.1.280 (external, copied-client)", entrypoint: "copied-client", subclient: "", agentSDKVersion: "", native: false },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const headers = confirmedClaudeCodeHeaders();
      headers.set("User-Agent", tc.userAgent);
      const detection = detectClaudeCodeRequest(headers, payload, false);
      expect(detection.strongSignals).toBe(true);
      expect(detection.confirmed).toBe(tc.native);
      expect(detection.nativeClient).toBe(tc.native);
      expect(detection.entrypoint).toBe(tc.entrypoint);
      expect(detection.subclient).toBe(tc.subclient);
      expect(detection.agentSDKVersion).toBe(tc.agentSDKVersion);
    });
  }
});

test("DetectClaudeCode count_tokens allows missing metadata", () => {
  const headers = confirmedClaudeCodeHeaders();
  headers.set("User-Agent", "claude-cli/2.1.280 (external, claude-vscode, agent-sdk/0.3.220)");
  const detection = detectClaudeCodeRequest(headers, `{"messages":[]}`, true);
  expect(detection.confirmed).toBe(true);
  expect(detection.metadataUserID).toBe(false);
  expect(detection.subclient).toBe("claude-code-vscode");
  expect(detection.agentSDKVersion).toBe("0.3.220");
});

describe("DetectClaudeCodeRequest rejects malformed native signals", () => {
  const uaHeaders = (ua: string, beta = "claude-code-20250219") => new Headers({ "User-Agent": ua, "X-App": "cli", "Anthropic-Beta": beta });
  const cases = [
    { name: "legacy metadata", headers: confirmedClaudeCodeHeaders(), userID: "user_abc_account__session_session" },
    { name: "short device", headers: confirmedClaudeCodeHeaders(), userID: `{"device_id":"abc","account_uuid":"","session_id":"11111111-2222-4333-8444-555555555555"}` },
    { name: "uppercase device", headers: confirmedClaudeCodeHeaders(), userID: `{"device_id":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","account_uuid":"","session_id":"11111111-2222-4333-8444-555555555555"}` },
    { name: "invalid session", headers: confirmedClaudeCodeHeaders(), userID: `{"device_id":"0000000000000000000000000000000000000000000000000000000000000000","account_uuid":"","session_id":"session"}` },
    { name: "malformed user agent", headers: uaHeaders("claude-cli/not-a-version (external, cli)"), userID: validClaudeCodeMetadataUserID },
    { name: "older patch user agent", headers: uaHeaders("claude-cli/2.1.257 (external, cli)"), userID: validClaudeCodeMetadataUserID },
    { name: "unmeasured next-minor user agent", headers: uaHeaders("claude-cli/2.2.0 (external, cli)"), userID: validClaudeCodeMetadataUserID },
    { name: "implausible future user agent", headers: uaHeaders("claude-cli/999.0.0 (external, cli)"), userID: validClaudeCodeMetadataUserID },
    { name: "unrelated beta", headers: uaHeaders("claude-cli/2.1.280 (external, cli)", "anything"), userID: validClaudeCodeMetadataUserID },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(detectClaudeCodeRequest(tc.headers, claudeCodeDetectionPayload(tc.userID), false).confirmed).toBe(false);
    });
  }
});

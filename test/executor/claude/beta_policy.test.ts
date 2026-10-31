// Ported from: internal/runtime/executor/claude_executor_beta_policy_test.go
// Skipped cases: TestApplyClaudeHeaders_StructuredHelperBetaOrderPreservedWithAdvisor (measured Haiku helper native
// profile not ported).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import {
  claudeCacheDiagnosisBeta,
  claudeCodeBeta,
  claudeContext1MBeta,
  claudeEffortBeta,
  claudeExtendedCacheTTLBeta,
  claudeFastModeBeta,
  claudeOAuthBeta,
  claudeThinkingBindingBeta,
} from "../../../src/executor/claude/betas.ts";
import { classifyClaudeUpstreamError } from "../../../src/executor/claude/errors.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { isAnthropicUpstreamBase } from "../../../src/executor/claude/upstream.ts";
import { anthropicMessagesURL, claudeOAuthTestMetadata, claudeOpts, headersFor, jsonResponse, startUpstream } from "./helpers.ts";

const claudeRaceProbeOAuthKey = "sk-ant-oat-beta-policy";
const oauthAuth = () => newAuth({ id: "claude-beta-policy", provider: "claude", metadata: { access_token: claudeRaceProbeOAuthKey } });
const keyAuth = (key: string, extra: Record<string, string> = {}) => newAuth({ id: `claude-${key}`, provider: "claude", attributes: { api_key: key, ...extra } });
const betaHeaders = (v: string) => new Headers({ "Anthropic-Beta": v });

function order(got: string): { adv: number; mid: number; tool: number } {
  const parts = got.split(",").map((p) => p.trim());
  return { adv: parts.indexOf("advisor-tool-2026-03-01"), mid: parts.indexOf("mid-conversation-system-2026-04-07"), tool: parts.indexOf("advanced-tool-use-2025-11-20") };
}

function expectAdvisorPlacement(got: string): void {
  const { adv, mid, tool } = order(got);
  expect(adv).not.toBe(-1);
  if (mid !== -1) expect(adv).toBeGreaterThan(mid);
  if (tool !== -1) expect(adv).toBeLessThan(tool);
}

describe("claude beta policy", () => {
  test("ConfirmedClientKeepsOAuthCredentialBetas", () => {
    const h = headersFor({
      url: anthropicMessagesURL,
      auth: oauthAuth(),
      apiKey: claudeRaceProbeOAuthKey,
      stream: false,
      body: `{"model":"claude-opus-5"}`,
      incomingHeaders: betaHeaders(`${claudeCodeBeta},interleaved-thinking-2025-05-14,${claudeEffortBeta}`),
      confirmedClaudeCode: true,
    });
    const got = h.get("Anthropic-Beta") ?? "";
    const parts = got.split(",");
    expect(parts[0]).toBe(claudeCodeBeta);
    expect(parts[1]).toBe(claudeOAuthBeta);
    expect(parts[parts.length - 1]).toBe(claudeExtendedCacheTTLBeta);
    expect(got).not.toContain("advisor-tool-2026-03-01");
    expect(got).not.toContain(claudeCacheDiagnosisBeta);
    for (const want of ["interleaved-thinking-2025-05-14", claudeEffortBeta]) expect(got).toContain(want);
  });

  test("ConfirmedAPIKeyClientKeepsPurePassthrough", () => {
    const h = headersFor({
      url: anthropicMessagesURL,
      auth: keyAuth("key-passthrough"),
      apiKey: "key-passthrough",
      stream: false,
      body: `{"model":"claude-opus-5"}`,
      incomingHeaders: betaHeaders(`${claudeCodeBeta},${claudeEffortBeta}`),
      confirmedClaudeCode: true,
    });
    expect(h.get("Anthropic-Beta")).toBe(`${claudeCodeBeta},${claudeEffortBeta}`);
  });

  test("UnknownBodyBetaPreservedOnAnthropic", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth("key-body-beta"), apiKey: "key-body-beta", stream: false, extraBetas: ["unknown-body-probe-2099-01-01"], body: `{"model":"claude-opus-5"}`, confirmedClaudeCode: false });
    expect(h.get("Anthropic-Beta")).toBe("unknown-body-probe-2099-01-01");
  });

  test("KnownBodyBetaStillPlacedOnAnthropic", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth("key-known-body-beta"), apiKey: "key-known-body-beta", stream: false, extraBetas: [claudeContext1MBeta], body: `{"model":"claude-opus-5"}`, confirmedClaudeCode: false });
    expect(h.get("Anthropic-Beta")).toBe(claudeContext1MBeta);
  });

  test("CustomHeadersCannotOverrideAnthropicIdentity", () => {
    const auth = keyAuth("key-custom-headers", { "header:Anthropic-Beta": "attacker-controlled-2099-01-01", "header:Accept-Encoding": "identity" });
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth, apiKey: "key-custom-headers", stream, body: `{"model":"claude-opus-5"}`, confirmedClaudeCode: false });
      expect(h.get("Anthropic-Beta")).not.toBe("attacker-controlled-2099-01-01");
      expect(h.get("Accept-Encoding")).toBe("gzip, deflate, br, zstd");
    }
  });

  test("ContextManagementNeverLeaksToOtherUpstreams", async () => {
    const upstream = startUpstream(() =>
      jsonResponse(`{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`),
    );
    try {
      const auth = newAuth({ id: "claude-non-anthropic-upstream", provider: "claude", attributes: { api_key: "sk-ant-oat-non-anthropic", base_url: upstream.url }, metadata: claudeOAuthTestMetadata() });
      const payload = `{"model":"claude-opus-5","system":"p","messages":[{"role":"user","content":"hi"}]}`;
      await createClaudeExecutor().execute(auth, { model: "claude-opus-5", payload, format: "claude" }, claudeOpts());
      expect(JSON.parse(upstream.requests[0]!.body).context_management).toBeUndefined();
    } finally {
      upstream.stop();
    }
  });

  test("IsAnthropicUpstreamBase", () => {
    const cases: Record<string, boolean> = {
      "https://api.anthropic.com": true,
      "https://API.Anthropic.com": true,
      "https://api.anthropic.com:443": true,
      "https://api.anthropic.com:8443": false,
      "https://user@api.anthropic.com": false,
      "https://api.kimi.com": false,
      "http://api.anthropic.com": false,
      "https://api.anthropic.com.evil": false,
      "https://gateway.example.com": false,
      "": false,
    };
    for (const [base, want] of Object.entries(cases)) expect(isAnthropicUpstreamBase(base)).toBe(want);
  });

  test("FastModeBetaMatchesAcrossStreamModes", () => {
    const seen: string[] = [];
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth("key-fast-parity"), apiKey: "key-fast-parity", stream, body: `{"model":"claude-opus-5","speed":"fast"}`, confirmedClaudeCode: false });
      const got = h.get("Anthropic-Beta") ?? "";
      expect(got).toContain(claudeFastModeBeta);
      seen.push(got);
    }
    expect(seen[0]).toBe(seen[1]!);
  });

  test("FastModePrecedesOAuthTrailer", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream: true, body: `{"model":"claude-opus-5","speed":"fast"}`, confirmedClaudeCode: false });
    const got = h.get("Anthropic-Beta") ?? "";
    const parts = got.split(",");
    expect(parts[parts.length - 1]).toBe(claudeExtendedCacheTTLBeta);
    expect(parts[parts.length - 2]).toBe(claudeFastModeBeta);
    expect(got).not.toContain(claudeCacheDiagnosisBeta);
  });

  test("DiagnosticsBetaFollowsBodyInNativeOrder", () => {
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream, body: `{"model":"claude-opus-5","diagnostics":{"previous_message_id":null}}`, confirmedClaudeCode: false });
      expect((h.get("Anthropic-Beta") ?? "").endsWith(`${claudeExtendedCacheTTLBeta},${claudeCacheDiagnosisBeta}`)).toBe(true);
    }
  });

  test("ClassifyClaudeUpstreamError fast-mode credits is request-scoped", () => {
    const bodies = [
      `{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}`,
      `{"type":"error","error":{"type":"rate_limit_error","message":"Fast mode requires usage credits"}}`,
    ];
    for (const body of bodies) {
      const err = classifyClaudeUpstreamError(429, undefined, body);
      expect(err.requestScoped).toBe(true);
      expect(err.credentialScoped).toBe(false);
      expect(err.statusCode).toBe(429);
      expect(err.message).toBe(body);
      expect(err.responseBody()).toBe(body);
    }
  });

  test("ClassifyClaudeUpstreamError real rate limit stays failover-eligible", () => {
    for (const body of [
      `{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}}`,
      `{"type":"error","error":{"type":"rate_limit_error","message":"This organization has exceeded its usage limit."}}`,
    ]) {
      expect(classifyClaudeUpstreamError(429, undefined, body).requestScoped).toBe(false);
    }
  });

  test("ClassifyClaudeUpstreamError other statuses unaffected", () => {
    expect(classifyClaudeUpstreamError(500, undefined, `{"error":{"message":"Usage credits are required for fast mode."}}`).requestScoped).toBe(false);
  });

  test("AdvisorToolBetaPreservedWhenRequested", () => {
    const incoming = betaHeaders(
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24",
    );
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream, body: `{"model":"claude-opus-5","tools":[{"type":"advisor_20260301","name":"advisor"}]}`, incomingHeaders: incoming, confirmedClaudeCode: false });
      expectAdvisorPlacement(h.get("Anthropic-Beta") ?? "");
    }
  });

  test("AdvisorToolBetaInjectedWhenBodyHasTool_ConfirmedClient", () => {
    const incoming = betaHeaders("claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24");
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream, body: `{"model":"claude-opus-5","tools":[{"type":"advisor_20260301","name":"advisor"}]}`, incomingHeaders: incoming, confirmedClaudeCode: true });
      expectAdvisorPlacement(h.get("Anthropic-Beta") ?? "");
    }
  });

  test("AdvisorToolBetaInjectedWhenBodyHasTool_APIKeyPassthrough", () => {
    const incoming = betaHeaders(`${claudeCodeBeta},mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,${claudeEffortBeta}`);
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth("key-passthrough"), apiKey: "key-passthrough", stream, body: `{"model":"claude-opus-5","tools":[{"type":"advisor_20260301","name":"advisor"}]}`, incomingHeaders: incoming, confirmedClaudeCode: false });
      expectAdvisorPlacement(h.get("Anthropic-Beta") ?? "");
    }
  });

  test("AdvisorToolBetaPreservedWhenLiftedFromBodyBetas_ConfirmedClient", () => {
    const incoming = betaHeaders(`${claudeCodeBeta},interleaved-thinking-2025-05-14,${claudeEffortBeta}`);
    for (const stream of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream, extraBetas: ["advisor-tool-2026-03-01"], body: `{"model":"claude-opus-5"}`, incomingHeaders: incoming, confirmedClaudeCode: true });
      expect(h.get("Anthropic-Beta")).toContain("advisor-tool-2026-03-01");
    }
  });

  test("AdvisorToolBetaPreservedWhenCountTokens", () => {
    const incoming = betaHeaders("claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01");
    const h = headersFor({ url: "https://api.anthropic.com/v1/messages/count_tokens", auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream: false, body: `{"model":"claude-opus-5","tools":[{"type":"advisor_20260301","name":"advisor"}]}`, incomingHeaders: incoming, confirmedClaudeCode: false });
    expect(h.get("Anthropic-Beta")).toContain("advisor-tool-2026-03-01");
  });

  test("AdvisorToolBetaRepositionedWhenOutOfOrder", () => {
    const incoming = betaHeaders("claude-code-20250219,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,advisor-tool-2026-03-01");
    for (const confirmed of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: oauthAuth(), apiKey: claudeRaceProbeOAuthKey, stream: false, body: `{"model":"claude-opus-5","tools":[{"type":"advisor_20260301","name":"advisor"}]}`, incomingHeaders: incoming, confirmedClaudeCode: confirmed });
      expectAdvisorPlacement(h.get("Anthropic-Beta") ?? "");
    }
  });

  test("BlockBindingBodyAlwaysGetsBindingBeta", () => {
    const body = `{"model":"claude-haiku-5-5","thinking":{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"messages":[{"role":"user","content":"hi"}]}`;
    for (const confirmed of [false, true]) {
      const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth("key-binding-beta"), apiKey: "key-binding-beta", stream: false, body, confirmedClaudeCode: confirmed });
      expect(h.get("Anthropic-Beta")).toContain(claudeThinkingBindingBeta);
    }
  });
});

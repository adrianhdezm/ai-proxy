// Ported from: internal/runtime/executor/claude_executor_test.go
// Skipped cases: this file holds the header and beta-assembly cases. TestClaudeExecutor_CacheTTLIsPairedWithExtendedCacheTTLBeta
// is ported in full. Dropped:
// TestApplyClaudeHeaders_UsesConfiguredBaselineFingerprint, RejectsUnmeasuredClaudeCLIFingerprints,
// DoesNotDowngradeConfiguredBaselineOnFirstClaudeClient, UpgradesCachedSoftwareFingerprintWhenBaselineAdvances,
// LearnsOfficialFingerprintAfterCustomBaselineFallback, ThirdPartyBaselineThenOfficialUpgradeKeepsPinnedPlatform,
// DisableDeviceProfileStabilization, LegacyModePreservesConfiguredUserAgentOverrideForClaudeClients,
// LegacyThirdPartyUsesStableConfiguredOSArch, UnsetStabilizationUsesStableConfiguredOSArch,
// TestResolveClaudeDeviceProfile_RechecksCacheBeforeStoringCandidate, TestClaudeDeviceProfileStabilizationEnabled_DefaultFalse
// (device-profile learning/stabilisation not ported); the PrepareRequest half of TestApplyClaudeHeaders_EmptyAPIKey_OmitsAuthHeaders
// (no PrepareRequest API).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import {
  claudeAdvancedToolUseBeta,
  claudeAdvisorToolBeta,
  claudeAFKModeBeta,
  claudeCodeCLIBetas,
  claudeContext1MBeta,
  claudeCountTokensBetasForCredential,
  claudeExtendedCacheTTLBeta,
  claudeFallbackCreditBeta,
  claudeFastModeBeta,
  claudeServerSideFallbackBeta,
  claudeStructuredOutputsBeta,
  claudeThinkingResumptionBeta,
  extractAndRemoveBetas,
  withClaudeAdvisorToolBeta,
  withClaudeCountTokensOAuthBeta,
} from "../../../src/executor/claude/betas.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { anthropicMessagesURL, claudeOAuthTestMetadata, claudeOpts, headersFor, jsonResponse, lastBody, lastHeaders, okMessage, withUpstream } from "./helpers.ts";


const keyAuth = (attrs: Record<string, string>, id = "k") => newAuth({ id, provider: "claude", attributes: attrs });

describe("applyClaudeHeaders", () => {
  const baseline = claudeCodeCLIBetas(`{"model":"claude-opus-5"}`, undefined, false);
  for (const tt of [
    { name: "omitted speed excludes fast mode beta", body: `{"model":"claude-opus-5"}`, want: baseline },
    { name: "fast speed appends fast mode beta", body: `{"model":"claude-opus-5","speed":"fast"}`, want: `${baseline},${claudeFastModeBeta}` },
    { name: "explicit body beta appends fast mode beta", body: `{"model":"claude-opus-5","betas":["fast-mode-2026-02-01"]}`, want: `${baseline},${claudeFastModeBeta}` },
  ]) {
    test(`FastModeBetaIsConditional/${tt.name}`, () => {
      const lifted = extractAndRemoveBetas(tt.body);
      const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth({ api_key: "key-fast-mode-beta", cloak_mode: "always" }), apiKey: "key-fast-mode-beta", stream: false, extraBetas: lifted.betas, body: lifted.body, confirmedClaudeCode: false });
      expect(h.get("Anthropic-Beta")).toBe(tt.want);
    });
  }

  test("UsesOAuthAuthorizationAndBrowserFingerprint", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: keyAuth({ api_key: "sk-ant-oat-header-test" }), apiKey: "sk-ant-oat-header-test", stream: false, body: "", confirmedClaudeCode: false, sessionID: "11111111-2222-4333-8444-555555555555" });
    expect(h.get("Authorization")).toBe("Bearer sk-ant-oat-header-test");
    expect(h.get("x-api-key")).toBeNull();
    expect(h.get("Anthropic-Dangerous-Direct-Browser-Access")).toBe("true");
    expect(h.get("Anthropic-Beta") ?? "").toContain("oauth-2025-04-20");
  });

  test("API key on api.anthropic.com uses x-api-key; on another base it uses Bearer", () => {
    const direct = headersFor({ url: anthropicMessagesURL, auth: keyAuth({ api_key: "key-direct" }), apiKey: "key-direct", stream: false, body: `{"model":"claude-opus-5"}`, confirmedClaudeCode: false });
    expect(direct.get("x-api-key")).toBe("key-direct");
    expect(direct.get("Authorization")).toBeNull();
    const gateway = headersFor({ url: "https://gateway.example.com/v1/messages?beta=true", auth: keyAuth({ api_key: "key-gw" }), apiKey: "key-gw", stream: false, body: `{"model":"claude-opus-5"}`, confirmedClaudeCode: false });
    expect(gateway.get("Authorization")).toBe("Bearer key-gw");
    expect(gateway.get("x-api-key")).toBeNull();
  });

  test("EmptyAPIKey_OmitsAuthHeaders", () => {
    const headers = new Headers({ Authorization: "Bearer preexisting-bearer", "x-api-key": "preexisting-key" });
    const auth = keyAuth({ auth_kind: "apikey", base_url: "https://custom-claude.example.com", "header:Custom-Token": "custom-secret" });
    headersFor({ headers, url: "https://custom-claude.example.com/v1/messages", auth, apiKey: "", stream: false, body: "", confirmedClaudeCode: false });
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("Custom-Token")).toBe("custom-secret");
  });

  test("StreamTransportNegotiation", () => {
    const auth = keyAuth({ api_key: "key-stream-accept" });
    const body = `{"model":"claude-opus-4-6","stream":true}`;
    const direct = headersFor({ url: "https://api.anthropic.com/v1/messages", auth, apiKey: "key-stream-accept", stream: true, body, incomingHeaders: new Headers(), confirmedClaudeCode: false });
    expect(direct.get("Accept")).toBe("application/json");
    expect(direct.get("Accept-Encoding")).toBe("gzip, deflate, br, zstd");
    const gateway = headersFor({ url: "https://api.kimi.com/coding/v1/messages", auth, apiKey: "key-stream-accept", stream: true, body, incomingHeaders: new Headers(), confirmedClaudeCode: false });
    expect(gateway.get("Accept")).toBe("text/event-stream");
    expect(gateway.get("Accept-Encoding")).toBe("identity");
  });

  test("DefaultPreservesCallerBetas", () => {
    const incoming = new Headers({ "Anthropic-Beta": "caller-only-beta" });
    const auth = keyAuth({ api_key: "key-caller-betas" });
    const body = `{"model":"claude-opus-4-6"}`;
    expect(headersFor({ url: "https://api.anthropic.com/v1/messages", auth, apiKey: "key-caller-betas", stream: false, body, incomingHeaders: incoming, confirmedClaudeCode: false }).get("Anthropic-Beta")).toBe("caller-only-beta");
    expect(headersFor({ url: "https://api.kimi.com/coding/v1/messages", auth, apiKey: "key-caller-betas", stream: false, body, incomingHeaders: incoming, confirmedClaudeCode: false }).get("Anthropic-Beta") ?? "").toContain("caller-only-beta");
  });
});

describe("beta assembly", () => {
  const constants = "claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05";
  const matrix: Array<{ name: string; body: string; requested?: Set<string>; oauth?: boolean; want: string }> = [
    {
      name: "legacy model without tools omits both conditional betas",
      body: `{"model":"claude-opus-4-6"}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name:      "context 1m sits right after claude-code, not at the end",
      body:      `{"model":"claude-opus-4-6"}`,
      requested: new Set([claudeContext1MBeta]),
      want: "claude-code-20250219,context-1m-2025-08-07," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,effort-2025-11-24",
    },
    {
      name: "opus-5 1m variant reproduces the full observed order",
      body: `{"model":"claude-opus-5","tools":[{"name":"Read","defer_loading":true}]}`,
      requested: new Set([claudeContext1MBeta, claudeServerSideFallbackBeta, claudeFallbackCreditBeta]),
      want: "claude-code-20250219,context-1m-2025-08-07," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01," +
        "advanced-tool-use-2025-11-20,effort-2025-11-24," +
        "server-side-fallback-2026-06-01,fallback-credit-2026-06-01",
    },
    {
      name:      "structured outputs trails effort",
      body:      `{"model":"claude-opus-4-6"}`,
      requested: new Set([claudeStructuredOutputsBeta]),
      want:      constants + ",effort-2025-11-24,structured-outputs-2025-12-15",
    },
    {
      name:      "unknown caller beta is not smuggled into the baseline",
      body:      `{"model":"claude-opus-4-6"}`,
      requested: new Set(["totally-made-up-2030-01-01"]),
      want:      constants + ",effort-2025-11-24",
    },
    {
      name: "claude-sonnet-5 accepts role=system",
      body: `{"model":"claude-sonnet-5"}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24",
    },
    {
      name: "claude-sonnet-5-5 carries tool changes beta unlike sonnet-5",
      body: `{"model":"claude-sonnet-5-5"}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24",
    },
    {
      name: "claude-opus-4-8 accepts role=system",
      body: `{"model":"claude-opus-4-8"}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24",
    },
    {
      name: "claude-fable-5 accepts role=system",
      body: `{"model":"claude-fable-5"}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24",
    },
    {
      name: "opus-5-5 carries capability betas without optional body fields",
      body: `{"model":"claude-opus-5-5","thinking":{"type":"adaptive"}}`,
      want: constants + ",mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01",
    },
    {
      name: "opus-5-5 without thinking still carries clear-at capability",
      body: `{"model":"claude-opus-5-5"}`,
      want: constants + ",mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24",
    },
    {
      name: "fable-5-1 carries per-turn-control but not timing unless the body asks",
      body: `{"model":"claude-fable-5-1"}`,
      want: constants + ",mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24",
    },
    {
      name: "opus-5-5 timing and the other 2.1.280 gated betas keep wire order",
      body: `{"model":"claude-opus-5-5","safeguards":[{}],"thinking":{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"omit"}},"messages":[{"role":"system","clear_at":"next_user_message","content":[{"type":"tool_addition","tool":{"definition":{"name":"bash"}}}]},{"role":"user","content":"x","output_config":{"timing":{"now":"2026-09-23T00:00:00Z"}}}],"cache_control":{"type":"ephemeral","evict_on_complete":true}}`,
      requested: new Set([claudeThinkingResumptionBeta]),
      want: constants + ",mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,timing-2026-09-09," +
        "mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15," +
        "mid-conversation-system-clear-at-2026-08-21,dangerous-tool-use-2026-09-03,effort-2025-11-24," +
        "thinking-binding-controls-2026-08-01,thinking-resumption-2026-07-17,prompt-caching-evict-2026-05-12",
    },
    {
      name: "claude-opus-4-7 stays on the reminder path",
      body: `{"model":"claude-opus-4-7"}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name:  "oauth uses tool search and the current cache TTL trailer",
      body:  `{"model":"claude-opus-4-6","tools":[{"name":"Read","defer_loading":true}]}`,
      oauth: true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20," +
        "effort-2025-11-24,extended-cache-ttl-2025-04-11",
    },
    {
      name:  "oauth precedes context-1m",
      body:  `{"model":"claude-opus-5","tools":[{"name":"Read","defer_loading":true}]}`,
      oauth: true,
      requested: new Set([claudeContext1MBeta, claudeServerSideFallbackBeta, claudeFallbackCreditBeta]),
      want: "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01," +
        "advanced-tool-use-2025-11-20,effort-2025-11-24," +
        "server-side-fallback-2026-06-01,fallback-credit-2026-06-01," +
        "extended-cache-ttl-2025-04-11",
    },
    {
      name: "api key path sends neither oauth beta",
      body: `{"model":"claude-opus-4-6"}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name: "claude-haiku-4-5-20251001 stays on the reminder path and omits effort",
      body: `{"model":"claude-haiku-4-5-20251001"}`,
      want: constants,
    },
    {
      name: "legacy model with inline tools no longer adds advanced tool use",
      body: `{"model":"claude-sonnet-4-6","tools":[{"name":"Read"}]}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name: "deferred tool adds advanced tool use",
      body: `{"model":"claude-sonnet-4-6","tools":[{"name":"Read","defer_loading":true}]}`,
      want: constants + ",advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name: "tool search server tool adds advanced tool use",
      body: `{"model":"claude-sonnet-4-6","tools":[{"type":"tool_search_tool_regex_20251119","name":"tool_search_tool_regex"},{"name":"Read"}]}`,
      want: constants + ",advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name: "tool use examples add advanced tool use",
      body: `{"model":"claude-sonnet-4-6","tools":[{"name":"Read","input_examples":[{"path":"a.go"}]}]}`,
      want: constants + ",advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name: "programmatic tool calling adds advanced tool use",
      body: `{"model":"claude-sonnet-4-6","tools":[{"name":"Read","allowed_callers":["code_execution_20250825"]}]}`,
      want: constants + ",advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name:      "requested advanced tool use is honored for inline tools",
      body:      `{"model":"claude-sonnet-4-6","tools":[{"name":"Read"}]}`,
      requested: new Set([claudeAdvancedToolUseBeta]),
      want:      constants + ",advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name: "role=system model without tools adds mid conversation system only",
      body: `{"model":"claude-opus-5"}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24",
    },
    {
      name: "role=system model with tool search adds both in wire order",
      body: `{"model":"claude-opus-5","tools":[{"name":"Read","defer_loading":true}]}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name: "empty tools array does not add advanced tool use",
      body: `{"model":"claude-opus-4-6","tools":[]}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name: "unknown future model keeps the optimistic role=system default",
      body: `{"model":"claude-future-9"}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24",
    },
    {
      name: "thinking display summarized drops redact-thinking",
      body: `{"model":"claude-opus-5","thinking":{"type":"adaptive","display":"summarized"}}`,
      want: "claude-code-20250219,interleaved-thinking-2025-05-14," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01," +
        "effort-2025-11-24",
    },
    {
      name: "thinking display omitted drops redact-thinking as well",
      body: `{"model":"claude-opus-4-6","thinking":{"type":"enabled","budget_tokens":2048,"display":"omitted"}}`,
      want: "claude-code-20250219,interleaved-thinking-2025-05-14," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,effort-2025-11-24",
    },
    {
      name: "thinking without display keeps redact-thinking",
      body: `{"model":"claude-opus-4-6","thinking":{"type":"adaptive"}}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name: "blank display value keeps redact-thinking",
      body: `{"model":"claude-opus-4-6","thinking":{"type":"adaptive","display":"  "}}`,
      want: constants + ",effort-2025-11-24",
    },
    {
      name:      "advisor tool beta requested placed before advanced-tool-use",
      body:      `{"model":"claude-opus-5","tools":[{"name":"Read","defer_loading":true}]}`,
      requested: new Set(["advisor-tool-2026-03-01"]),
      want:      constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24",
    },
    {
      name: "body with advisor server tool automatically adds advisor-tool beta",
      body: `{"model":"claude-opus-5","tools":[{"type":"advisor_20260301","name":"advisor"}]}`,
      want: constants + ",mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,effort-2025-11-24",
    },
    {
      // Captured 2026-09-02 from Claude Code 2.1.258 (cli entrypoint, OAuth,
      // auto mode on): 158 inline tools without tool search, advisor beta
      // enabled for the account, thinking adaptive without display.
      name:  "2.1.258 main thread capture with inline tools and afk-mode",
      body:  `{"model":"claude-fable-5-1","tools":[{"name":"Read"}],"thinking":{"type":"adaptive"}}`,
      oauth: true,
      requested: new Set([claudeAdvisorToolBeta, claudeAFKModeBeta]),
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01," +
        "advisor-tool-2026-03-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01," +
        "afk-mode-2026-01-31,extended-cache-ttl-2025-04-11",
    },
    {
      name:      "afk-mode sits between fast-mode and extended-cache-ttl",
      body:      `{"model":"claude-opus-5","speed":"fast"}`,
      oauth:     true,
      requested: new Set([claudeAFKModeBeta]),
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01," +
        "effort-2025-11-24,fast-mode-2026-02-01," +
        "afk-mode-2026-01-31,extended-cache-ttl-2025-04-11",
    },
    {
      name:  "afk-mode is not added unless the caller sent it",
      body:  `{"model":"claude-opus-5"}`,
      oauth: true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01," +
        "effort-2025-11-24,extended-cache-ttl-2025-04-11",
    },
    {
      name: "thinking display updates emits thinking-display-updates beta and drops redact-thinking",
      body: `{"model":"claude-fable-5-1","thinking":{"type":"adaptive","display":"updates"}}`,
      want: "claude-code-20250219,interleaved-thinking-2025-05-14," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01," +
        "mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,thinking-display-updates-2026-08-18",
    },
    {
      name: "body with fallbacks automatically adds server-side-fallback beta",
      body: `{"model":"claude-fable-5-1","fallbacks":[{"model":"claude-opus-5"}]}`,
      want: constants + ",mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,server-side-fallback-2026-06-01",
    },
    {
      name:  "subagent request omits extended-cache-ttl beta",
      body:  `{"model":"claude-sonnet-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258.0ab; cc_is_subagent=true;"}]}`,
      oauth: true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-system-clear-at-2026-08-21," +
        "effort-2025-11-24",
    },
    {
      name:  "probe request max_tokens=1 omits effort and extended-cache-ttl betas",
      body:  `{"model":"claude-sonnet-5","max_tokens":1}`,
      oauth: true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-system-clear-at-2026-08-21",
    },
    {
      name:      "haiku model omits effort beta even if requested",
      body:      `{"model":"claude-haiku-4-5-20251001"}`,
      requested: new Set(["effort-2025-11-24"]),
      oauth:     true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05," +
        "extended-cache-ttl-2025-04-11",
    },
    {
      name:      "disabled thinking omits effort beta even if requested",
      body:      `{"model":"claude-sonnet-5","thinking":{"type":"disabled"}}`,
      requested: new Set(["effort-2025-11-24"]),
      oauth:     true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-system-clear-at-2026-08-21," +
        "extended-cache-ttl-2025-04-11",
    },
    {
      name:  "body with fallback_credit_token automatically adds fallback-credit beta",
      body:  `{"model":"claude-sonnet-5","fallback_credit_token":"fct_12345"}`,
      oauth: true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-system-clear-at-2026-08-21," +
        "effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11",
    },
    {
      name:  "oauth body with fallbacks automatically adds fallback-credit beta",
      body:  `{"model":"claude-fable-5-1","fallbacks":[{"model":"claude-opus-5"}]}`,
      oauth: true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01," +
        "mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,server-side-fallback-2026-06-01,fallback-credit-2026-06-01," +
        "extended-cache-ttl-2025-04-11",
    },
    {
      name:      "requested fallback-credit beta is honored",
      body:      `{"model":"claude-sonnet-5"}`,
      requested: new Set([claudeFallbackCreditBeta]),
      oauth:     true,
      want: "claude-code-20250219,oauth-2025-04-20," +
        "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12," +
        "thinking-token-count-2026-05-13,context-management-2025-06-27," +
        "prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,mid-conversation-system-clear-at-2026-08-21," +
        "effort-2025-11-24,fallback-credit-2026-06-01,extended-cache-ttl-2025-04-11",
    },  ];
  for (const tt of matrix) {
    test(`ClaudeCodeCLIBetas_MatchesObservedClientMatrix/${tt.name}`, () => {
      expect(claudeCodeCLIBetas(tt.body, tt.requested, tt.oauth ?? false)).toBe(tt.want);
    });
  }

  const head = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07";
  for (const tt of [
    { name: "afk-mode only trailer", betas: `${head},afk-mode-2026-01-31,extended-cache-ttl-2025-04-11`, want: `${head},advisor-tool-2026-03-01,afk-mode-2026-01-31,extended-cache-ttl-2025-04-11` },
    {
      name: "effort ahead of afk-mode",
      betas: `${head},effort-2025-11-24,fallback-credit-2026-06-01,afk-mode-2026-01-31,extended-cache-ttl-2025-04-11`,
      want: `${head},advisor-tool-2026-03-01,effort-2025-11-24,fallback-credit-2026-06-01,afk-mode-2026-01-31,extended-cache-ttl-2025-04-11`,
    },
    { name: "already present stays put", betas: `${head},advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31`, want: `${head},advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31` },
    { name: "no trailer appends", betas: head, want: `${head},advisor-tool-2026-03-01` },
  ]) {
    test(`WithClaudeAdvisorToolBeta_InsertsBeforeTrailingBetas/${tt.name}`, () => {
      expect(withClaudeAdvisorToolBeta(tt.betas)).toBe(tt.want);
    });
  }

  test("ClaudeCountTokensBetasForCredentialMatchesNativeOAuth220", () => {
    const want = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01";
    const wantAPIKey = "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01";
    expect(claudeCountTokensBetasForCredential(true)).toBe(want);
    expect(claudeCountTokensBetasForCredential(false)).toBe(wantAPIKey);
    expect(withClaudeCountTokensOAuthBeta(wantAPIKey)).toBe(want);
  });
});

describe("executor header and cache-TTL policy", () => {
  for (const tc of [
    { name: "oauth credential selects the 1h pool", apiKey: "sk-ant-oat-cache-ttl-pairing", wantTTL: "1h", wantBeta: true },
    { name: "api key credential keeps the default pool", apiKey: "key-cache-ttl-pairing", wantTTL: undefined, wantBeta: false },
  ]) {
    test(`CacheTTLIsPairedWithExtendedCacheTTLBeta/${tc.name}`, async () => {
      await withUpstream(
        () => jsonResponse(okMessage("claude-opus-4-6")),
        async (upstream) => {
          const auth = newAuth({ id: "cache-ttl-pairing", provider: "claude", attributes: { api_key: tc.apiKey, base_url: upstream.url, cloak_mode: "always" }, metadata: claudeOAuthTestMetadata() });
          await createClaudeExecutor().execute(auth, { model: "claude-opus-4-6", payload: `{"model":"claude-opus-4-6","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}]}`, format: "claude" }, claudeOpts());
          const body = lastBody(upstream);
          const betas = lastHeaders(upstream).get("Anthropic-Beta") ?? "";
          expect(body.system[1].cache_control.ttl).toBe(tc.wantTTL);
          expect(body.system[1].cache_control.type).toBe("ephemeral");
          expect(betas.includes(claudeExtendedCacheTTLBeta)).toBe(tc.wantBeta);
        },
      );
    });
  }

  const agentCases: Array<{ name: string; incoming: Record<string, string>; want: Record<string, string>; absent: string[] }> = [
    {
      name: "preserves canonical agent and parent agent headers",
      incoming: { "X-Claude-Code-Agent-Id": "subagent-001", "X-Claude-Code-Parent-Agent-Id": "parent-agent-root" },
      want: { "X-Claude-Code-Agent-Id": "subagent-001", "X-Claude-Code-Parent-Agent-Id": "parent-agent-root" }  ,
      absent: [],
    },
    {
      name: "preserves lowercased agent and environment headers",
      incoming: { "x-claude-code-agent-id": "agent-xyz", "x-claude-remote-container-id": "container-123", "x-claude-remote-session-id": "remote-sess-456", "x-client-app": "custom-sdk", "x-anthropic-additional-protection": "true" },
      want: { "X-Claude-Code-Agent-Id": "agent-xyz", "X-Claude-Remote-Container-Id": "container-123", "X-Claude-Remote-Session-Id": "remote-sess-456", "X-Client-App": "custom-sdk", "X-Anthropic-Additional-Protection": "true" }  ,
      absent: [],
    },
    {
      name: "does not fabricate agent header when absent",
      incoming: { "User-Agent": "test-client" },
      want: {}  ,
      absent: ["X-Claude-Code-Agent-Id", "X-Claude-Code-Parent-Agent-Id", "X-Claude-Remote-Container-Id", "X-Claude-Remote-Session-Id", "X-Client-App", "X-Anthropic-Additional-Protection"],
    },
  ];
  for (const tc of agentCases) {
    test(`PreservesNativeAgentAndEnvironmentHeaders/${tc.name}`, async () => {
      await withUpstream(
        () => jsonResponse(okMessage("claude-opus-4-6")),
        async (upstream) => {
          const auth = newAuth({ id: "agent-header-test", provider: "claude", attributes: { api_key: "sk-ant-test-key", base_url: upstream.url, cloak_mode: "always" }, metadata: claudeOAuthTestMetadata() });
          await createClaudeExecutor().execute(auth, { model: "claude-opus-4-6", payload: `{"model":"claude-opus-4-6","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`, format: "claude" }, claudeOpts({ headers: new Headers(tc.incoming) }));
          const h = lastHeaders(upstream);
          for (const [k, v] of Object.entries(tc.want)) expect(h.get(k), k).toBe(v);
          for (const k of tc.absent) expect(h.get(k), k).toBeNull();
        },
      );
    });
  }

  const oauthAuthFor = (url: string, key: string) => newAuth({ id: `auth-${key}`, provider: "claude", attributes: { api_key: key, base_url: url }, metadata: claudeOAuthTestMetadata() });

  test("SubagentAndProbeOmit1hCacheTTLAndBeta", async () => {
    await withUpstream(
      () => jsonResponse(`{"id":"msg_sub1","type":"message","model":"claude-sonnet-5","role":"assistant","content":[{"type":"text","text":"ok"}]}`),
      async (upstream) => {
        const exec = createClaudeExecutor();
        const auth = oauthAuthFor(upstream.url, "sk-ant-oat-subagent-cache-test");
        const run = async (payload: string, headers?: Record<string, string>) => {
          await exec.execute(auth, { model: "claude-sonnet-5", payload, format: "claude" }, claudeOpts(headers ? { headers: new Headers(headers) } : {}));
          return { body: lastBody(upstream), betas: lastHeaders(upstream).get("Anthropic-Beta") ?? "" };
        };
        const has1h = (body: Record<string, any>) => (body.system ?? []).some((b: any) => b?.cache_control?.ttl === "1h");

        const sub = await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"do task"}]}`, { "X-Claude-Code-Agent-Id": "subagent-123" });
        expect(sub.betas).not.toContain(claudeExtendedCacheTTLBeta);
        expect(has1h(sub.body)).toBe(false);

        const probe = await run(`{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"probe"}]}`);
        expect(probe.betas).not.toContain(claudeExtendedCacheTTLBeta);
        expect(has1h(probe.body)).toBe(false);

        const main = await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hello"}]}`);
        expect(main.betas).toContain(claudeExtendedCacheTTLBeta);
        expect(has1h(main.body)).toBe(true);

        const confirmedSub = await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"task"}]}`, {
          "User-Agent": "claude-cli/2.1.280 (external, cli)",
          "X-Claude-Code-Agent-Id": "subagent-confirmed-456",
          "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24",
        });
        expect(confirmedSub.betas).not.toContain(claudeExtendedCacheTTLBeta);
      },
    );
  });

  test("ProbeStripsCaller1hTTLAndBetas", async () => {
    await withUpstream(
      () => jsonResponse(`{"id":"msg_1","type":"message","model":"claude-sonnet-5","role":"assistant","content":[{"type":"text","text":"ok"}]}`),
      async (upstream) => {
        const payload = `{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"quota","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`;
        const incoming = new Headers({ "Anthropic-Beta": "extended-cache-ttl-2025-04-11,server-side-fallback-2026-06-01,thinking-display-updates-2026-08-18,effort-2025-11-24" });
        await createClaudeExecutor().execute(oauthAuthFor(upstream.url, "sk-ant-oat-probe-ttl-test"), { model: "claude-sonnet-5", payload, format: "claude" }, claudeOpts({ headers: incoming }));
        expect(upstream.requests[0]!.body).not.toContain(`"ttl":"1h"`);
        const betas = lastHeaders(upstream).get("Anthropic-Beta") ?? "";
        for (const forbidden of ["extended-cache-ttl-2025-04-11", "server-side-fallback-2026-06-01", "thinking-display-updates-2026-08-18", "effort-2025-11-24"]) expect(betas).not.toContain(forbidden);
      },
    );
  });

  test("SubagentPreservesCaller1hTTLAndExtendedCacheBeta", async () => {
    await withUpstream(
      () => jsonResponse(`{"id":"msg_1","type":"message","model":"claude-sonnet-5","role":"assistant","content":[{"type":"text","text":"ok"}]}`),
      async (upstream) => {
        const payload = `{"model":"claude-sonnet-5","messages":[{"role":"user","content":[{"type":"text","text":"subagent work","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`;
        const incoming = new Headers({ "X-Claude-Code-Agent-Id": "agent-sub-123", "Anthropic-Beta": "extended-cache-ttl-2025-04-11" });
        await createClaudeExecutor().execute(oauthAuthFor(upstream.url, "sk-ant-oat-subagent-ttl-test"), { model: "claude-sonnet-5", payload, format: "claude" }, claudeOpts({ headers: incoming }));
        expect(upstream.requests[0]!.body).toContain(`"ttl":"1h"`);
        expect(lastHeaders(upstream).get("Anthropic-Beta") ?? "").toContain("extended-cache-ttl-2025-04-11");
      },
    );
  });

  test("DisabledThinkingStripsDisplayBeta", async () => {
    await withUpstream(
      () => jsonResponse(`{"id":"msg_1","type":"message","model":"claude-sonnet-5","role":"assistant","content":[{"type":"text","text":"ok"}]}`),
      async (upstream) => {
        const payload = `{"model":"claude-sonnet-5","thinking":{"type":"disabled"},"messages":[{"role":"user","content":"hello"}]}`;
        const incoming = new Headers({ "Anthropic-Beta": "thinking-display-updates-2026-08-18,effort-2025-11-24" });
        await createClaudeExecutor().execute(oauthAuthFor(upstream.url, "sk-ant-oat-disabled-thinking-beta-test"), { model: "claude-sonnet-5", payload, format: "claude" }, claudeOpts({ headers: incoming }));
        const betas = lastHeaders(upstream).get("Anthropic-Beta") ?? "";
        expect(betas).not.toContain("thinking-display-updates-2026-08-18");
        expect(betas).not.toContain("effort-2025-11-24");
      },
    );
  });
});

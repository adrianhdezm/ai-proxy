// Ported from: internal/runtime/executor/claude_executor_test.go
// Skipped cases: this file holds the request-pipeline cases (signature sanitising, web-search domains, sampling,
// max_tokens, mid-system rebuild, cloaking/identity, caller system validation). TestClaudeExecutor_NonClaudeRequestUses
// ClaudeCode220CLIFingerprint is ported in full here; the CCH, diagnostics, context_management and date-pin cases
// live in cch_diagnostics.test.ts. Dropped here: TestApplyClaudeToolPrefix*, TestStripClaudeToolPrefix* (tool prefix
// not ported), TestRemapOAuthToolNames*, TestReverseRemap*, TestPrepareClaudeOAuthToolNames*, TestResolveClaudeMCPAlias*,
// *MCPAlias* (MCP alias remapping not ported), TestInjectClaudeCodeCurrentDate*, TestClaudeCodeLocalDate*,
// TestClaudeCodeTimezone*, TestClaudeCallerCurrentDate*, TestApplyCloakingStringCallerReminder* (date reminder),
// TestCheckSystemInstructionsWithMode*, TestRelocateClaudeSystemPromptForCountTokens*, TestPrependClaudeSystemReminders*,
// TestInsertClaudeMidConversationSystemMessages* (system relocation not ported), TestClaudeBillingFingerprint*,
// TestCheckSystemInstructionsWithSigningMode*, TestClaudeExecutor_CustomBaseURL*CCH* (CCH signing),
// TestApplyCloaking_*Fallback*, TestApplyCloaking_Fable*, TestApplyCloaking_Sonnet*, TestClaudeExecutor_CloakedOpus55*,
// TestClaudeOpus55Fallback*, TestApplyCloaking_*Fable* (fallbacks/reporting-outcomes injection not ported),
// TestApplyCloaking_PreservesConfiguredStrictModeAndSensitiveWords* and *SensitiveWords* (obfuscation not ported),
// TestClaudeExecutor_Payload* (payload config rules not ported), TestInjectClaudeCodeContextManagement,
// TestClaudeCodeContextManagement*, TestReconcileClaudeCodeContextManagement (context_management not ported),
// TestClaudeExecutor_PreservedThinking* (thinking replay), TestClaudeExecutor_ReusesUserIDAcrossModelsWhenCacheEnabled
// (user-id cache not ported), TestClaudeExecutor_Confirmed*AgentSDK*, *VSCode*, TestClaudeExecutor_AgentSDKEntrypoint*,
// TestClaudeExecutor_CloakModeNeverUsesConfiguredHeaderDefaultsBaseline, TestApplyClaudeHeaders_*Baseline*,
// TestApplyClaudeHeaders_*Fingerprint* (other than the OAuth case), TestResolveClaudeDeviceProfile*,
// TestClaudeDeviceProfileStabilization*, TestApplyClaudeHeaders_*Stabilization*, TestApplyClaudeHeaders_Legacy*
// (fingerprint profiles / device-profile learning not ported); TestClaudeExecutor_CloakModeNeverPreservesConfirmedShape
// ClaudeCodeCallerHeaders adds claude-code-20250219 to the caller betas (the measured helper profile that confirmed the
// shape without it is not ported), TestClaudeExecutor_ExecuteStreamOAuth*Cancellation*
// (OAuth profile prefetch), TestClaudeExecutor_CountTokensCountsLocally*, TestShouldUseClaudeUpstreamTokenCount,
// TestClaudeExecutor_CountTokensExcludesInvalidOpenAIThinking, TestClaudeExecutor_CountTokensRejectsInvalidRequests
// (local token estimation not ported; countTokens always calls upstream), TestClaudeExecutor_CountTokensCloak*
// (system relocation/obfuscation), TestClaudeExecutor_LegacySystemReminderAcrossMessagesAndStream,
// TestClaudeExecutor_TitleHelperWithSystemPromptIsolated, TestClaudeExecutor_CloakModePrefersStoredPrevReqOverCallerFake,
// TestClaudeExecutor_UserTitlePromptWithoutSchemaTreatedAsNormalTurn, TestClaudeExecutor_UncloakedProbePreservesCallerBillingTags,
// TestClaudeExecutor_CallerOwnedDiagnosticsPreservedOnProbe (diagnostics/billing/previous-request state not ported),
// TestClaudeExecutor_ExecuteOpenAI*, TestClaudeExecutor_ExecuteStreamOpenAIResponse*,
// TestClaudeExecutor_ChatCompletionsDefaultMaxTokens* (no Claude->OpenAI response translator in this port),
// TestEnsureModelMaxTokens_UsesRegisteredMaxCompletionTokens (registry fixture is static; covered by the default case).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { claudeCodeCLIBetas, claudeExtendedCacheTTLBeta } from "../../../src/executor/claude/betas.ts";
import { isValidUserID } from "../../../src/executor/claude/client_detection.ts";
import { applyCloaking, claudeCodeCLIIdentity, resolveClaudeWirePolicy, validateClaudeCallerSystemBlocks } from "../../../src/executor/claude/cloaking.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { isClaudeFable51Model } from "../../../src/executor/claude/model.ts";
import {
  disableThinkingIfToolChoiceForced,
  ensureModelMaxTokens,
  normalizeClaudeSamplingForUpstream,
  sanitizeClaudeMessagesForClaudeUpstreamWithDebug,
  sanitizeClaudeWebSearchDomains,
  shouldSanitizeClaudeMessagesForUpstream,
} from "../../../src/executor/claude/request.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { apiKeyAuth, claudeOpts, expectStatusError, jsonResponse, lastBody, lastHeaders, okMessage, withUpstream } from "./helpers.ts";

const sonnet = "claude-3-5-sonnet-20241022";

async function executeAndCapture(payload: string, model = sonnet, responseModel = "claude-3-5-sonnet"): Promise<Record<string, any>> {
  return withUpstream(
    () => jsonResponse(okMessage(responseModel)),
    async (upstream) => {
      await createClaudeExecutor().execute(apiKeyAuth(upstream.url), { model, payload, format: "claude" }, claudeOpts());
      return lastBody(upstream);
    },
  );
}

describe("signature sanitising before upstream", () => {
  test("ExecuteStripsOpenAIEncryptedThinkingBeforeUpstream", async () => {
    const body = await executeAndCapture(`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"codex reasoning","signature":"gAAAAABopenai-encrypted-content"},{"type":"text","text":"Answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("gAAAAABopenai-encrypted-content");
    expect(raw).not.toContain("codex reasoning");
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0].text).toBe("Answer");
  });

  test("ExecuteStreamStripsOpenAIEncryptedThinkingBeforeUpstream", async () => {
    await withUpstream(
      () => new Response(`event: message_stop\ndata: {"type":"message_stop"}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
      async (upstream) => {
        const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"codex reasoning","signature":"gAAAAABopenai-encrypted-content"},{"type":"text","text":"Answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`;
        const result = await createClaudeExecutor().executeStream(apiKeyAuth(upstream.url), { model: sonnet, payload, format: "claude" }, claudeOpts({ stream: true }));
        for await (const _ of result.chunks) {
          // drain
        }
        const raw = upstream.requests[0]!.body;
        expect(raw).not.toContain("gAAAAABopenai-encrypted-content");
        expect(JSON.parse(raw).messages[0].content).toHaveLength(1);
      },
    );
  });

  test("ExecuteStripsForeignToolUseSignaturesBeforeUpstream", async () => {
    const body = await executeAndCapture(
      `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"},"signature":"skip_thought_signature_validator","thought_signature":"skip_thought_signature_validator","extra_content":{"google":{"thought_signature":"skip_thought_signature_validator"}}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`,
    );
    const toolUse = body.messages[0].content[0];
    expect(toolUse.type).toBe("tool_use");
    for (const path of ["signature", "thought_signature", "extra_content"]) expect(toolUse[path]).toBeUndefined();
  });

  test("ShouldSanitizeClaudeMessagesForUpstream_OnlyClaudeFamily", () => {
    const cases: Array<[string, boolean]> = [
      ["claude-sonnet-4-5", true],
      ["claude-3-5-sonnet-20241022", true],
      ["kimi-k2.5", false],
      ["mimo-v2", false],
      ["gemini-3.5-flash", false],
    ];
    for (const [model, want] of cases) expect(shouldSanitizeClaudeMessagesForUpstream(model), model).toBe(want);
  });

  test("SanitizeClaudeMessagesForClaudeUpstream_RestoresCommentaryMarkerForNonClaudeModel", () => {
    const body = `{"model":"kimi-k2.5","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"cpa:commentary:v1"},{"type":"thinking","thinking":"reason","signature":"skip_thought_signature_validator"},{"type":"text","text":"FINAL_SENTINEL"}]}]}`;
    const content = JSON.parse(sanitizeClaudeMessagesForClaudeUpstreamWithDebug(body, "kimi-k2.5")).messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "COMMENTARY_SENTINEL" });
    expect(content[1].signature).toBe("skip_thought_signature_validator");
    expect(content[2].text).toBe("FINAL_SENTINEL");
  });

  test("SanitizeClaudeMessagesForClaudeUpstream_BypassesUnknownModelSignatureMatrix", () => {
    const sig = "skip_thought_signature_validator";
    const body = `{"model":"kimi-k2.5","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"${sig}"},{"type":"text","text":"hello"},{"type":"tool_use","id":"call_123","name":"get_weather","input":{},"signature":"${sig}"}]}]}`;
    const parts = JSON.parse(sanitizeClaudeMessagesForClaudeUpstreamWithDebug(body, "kimi-k2.5")).messages[0].content;
    expect(parts).toHaveLength(3);
    expect(parts[0].signature).toBe(sig);
    expect(parts[2].signature).toBe(sig);
  });

  test("ExecuteBypassesSignatureSanitizerForUnknownModel", async () => {
    const body = await executeAndCapture(`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep reasoning","signature":""},{"type":"text","text":"Answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`, "mimo-v2", "mimo-v2");
    expect(JSON.stringify(body)).toContain("keep reasoning");
  });

  test("ExecuteStripsMalformedEPrefixThinkingBeforeUpstream", async () => {
    const malformed = Buffer.from([0x12, 0xff, 0xfe, 0xfd]).toString("base64");
    const body = await executeAndCapture(`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"bad reasoning","signature":"${malformed}"},{"type":"text","text":"Answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(malformed);
    expect(raw).not.toContain("bad reasoning");
    expect(body.messages[0].content).toEqual([{ type: "text", text: "Answer" }]);
  });

  test("ExecuteStripsInvalidBase64ThinkingBeforeUpstream", async () => {
    const body = await executeAndCapture(`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"bad reasoning","signature":"E!!!invalid!!!"},{"type":"text","text":"Answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`);
    expect(JSON.stringify(body)).not.toContain("E!!!invalid!!!");
    expect(body.messages[0].content).toHaveLength(1);
  });

  test("ExecuteStripsEmptySignatureEmptyTextThinking", async () => {
    const body = await executeAndCapture(`{"messages":[{"role":"assistant","content":[{"type":"thinking","text":"","signature":""},{"type":"text","text":"Answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]}`);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "Answer" }]);
  });
});

describe("web search domains", () => {
  test("SanitizeClaudeWebSearchDomains", () => {
    const out = JSON.parse(sanitizeClaudeWebSearchDomains(`{"tools":[{"type":"web_search_20250305","name":"web_search","allowed_domains":["anthropic.com"],"blocked_domains":[],"max_uses":8}]}`));
    expect(out.tools[0].blocked_domains).toBeUndefined();
    expect(out.tools[0].allowed_domains).toEqual(["anthropic.com"]);
    expect(out.tools[0].max_uses).toBe(8);
  });

  test("SanitizeClaudeWebSearchDomains_LeavesNonBuiltinAndNonEmpty", () => {
    const out = JSON.parse(sanitizeClaudeWebSearchDomains(`{"tools":[{"type":"custom","name":"x","blocked_domains":[]},{"type":"web_search_20250305","name":"web_search","blocked_domains":["evil.com"]}]}`));
    expect(out.tools[0].blocked_domains).toEqual([]);
    expect(out.tools[1].blocked_domains).toEqual(["evil.com"]);
  });
});

describe("max_tokens defaults", () => {
  test("EnsureModelMaxTokens_DefaultsMissingValue / SkipsUnregisteredModel / PreservesExplicitValue", () => {
    expect(JSON.parse(ensureModelMaxTokens(`{"model":"x"}`, "unregistered-model-xyz")).max_tokens).toBeUndefined();
    expect(JSON.parse(ensureModelMaxTokens(`{"max_tokens":77}`, "claude-opus-4-6")).max_tokens).toBe(77);
  });
});

describe("sampling normalisation", () => {
  const norm = (body: string, native = false) => JSON.parse(normalizeClaudeSamplingForUpstream(body, native));

  test("NormalizeClaudeSamplingForUpstream_RemovesTemperature", () => {
    expect(norm(`{"temperature":0,"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}`).temperature).toBeUndefined();
  });

  test("NormalizeClaudeSamplingForUpstream_RemovesTemperatureWithThinkingEnabled", () => {
    expect(norm(`{"temperature":0.2,"thinking":{"type":"enabled","budget_tokens":2048}}`).temperature).toBeUndefined();
  });

  test("NormalizeClaudeSamplingForUpstream_RemovesTopPAndTopKForThinking", () => {
    const out = norm(`{"temperature":0.2,"top_p":0.9,"top_k":40,"thinking":{"type":"adaptive"}}`);
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBeUndefined();
  });

  test("NormalizeClaudeSamplingForUpstream_NoThinkingRemovesTemperatureAndTopP", () => {
    const out = norm(`{"temperature":0,"top_p":0.9,"top_k":40,"messages":[{"role":"user","content":"hi"}]}`);
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBe(40);
  });

  test("NormalizeClaudeSamplingForUpstream_AfterForcedToolChoiceRemovesTemperature", () => {
    const out = JSON.parse(normalizeClaudeSamplingForUpstream(disableThinkingIfToolChoiceForced(`{"temperature":0,"thinking":{"type":"adaptive"},"output_config":{"effort":"max"},"tool_choice":{"type":"any"}}`), false));
    expect(out.thinking).toBeUndefined();
    expect(out.temperature).toBeUndefined();
  });

  test("NormalizeClaudeSamplingForUpstreamNativeKeepsMeasuredHelperTemperature", () => {
    const payload = `{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":[{"type":"text","text":"helper probe"}]}],"system":[{"type":"text","text":"Return a short title."}],"tools":[],"metadata":{"user_id":"u"},"max_tokens":32000,"thinking":{"type":"disabled"},"temperature":1,"output_config":{"format":{"type":"json_schema"}},"stream":true}`;
    expect(norm(payload, true).temperature).toBe(1);
  });

  const nativeCases: Array<{ name: string; payload: string; keep?: Record<string, number>; dropped?: string[] }> = [
    { name: "thinking off keeps every accepted knob", payload: `{"temperature":0.5,"top_k":40}`, keep: { temperature: 0.5, top_k: 40 } },
    { name: "thinking off drops top_p when temperature is also set", payload: `{"temperature":0.5,"top_p":0.9}`, keep: { temperature: 0.5 }, dropped: ["top_p"] },
    { name: "thinking off keeps a lone top_p", payload: `{"top_p":0.9}`, keep: { top_p: 0.9 } },
    { name: "thinking disabled is not thinking", payload: `{"temperature":1,"thinking":{"type":"disabled"}}`, keep: { temperature: 1 } },
    { name: "thinking enabled keeps temperature 1", payload: `{"temperature":1,"thinking":{"type":"enabled","budget_tokens":1024}}`, keep: { temperature: 1 } },
    { name: "thinking enabled drops temperature that is not 1", payload: `{"temperature":0.5,"thinking":{"type":"enabled","budget_tokens":1024}}`, dropped: ["temperature"] },
    { name: "thinking enabled keeps top_p at or above 0.95", payload: `{"top_p":0.99,"thinking":{"type":"enabled","budget_tokens":1024}}`, keep: { top_p: 0.99 } },
    { name: "thinking enabled drops top_p below 0.95", payload: `{"top_p":0.9,"thinking":{"type":"enabled","budget_tokens":1024}}`, dropped: ["top_p"] },
    { name: "thinking enabled always drops top_k", payload: `{"top_k":40,"thinking":{"type":"enabled","budget_tokens":1024}}`, dropped: ["top_k"] },
  ];
  for (const tc of nativeCases) {
    test(`NormalizeClaudeSamplingForUpstreamNativeDropsOnlyRejectedCombinations/${tc.name}`, () => {
      const out = norm(tc.payload, true);
      for (const [field, want] of Object.entries(tc.keep ?? {})) expect(out[field]).toBe(want);
      for (const field of tc.dropped ?? []) expect(out[field]).toBeUndefined();
    });
  }
});

describe("cloaking and identity", () => {
  test("NonClaudeRequestUsesClaudeCodeCLIFingerprint (reduced)", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-opus-4-6")),
      async (upstream) => {
        const auth = newAuth({ id: "a", provider: "claude", attributes: { api_key: "key-sdk-fingerprint", base_url: upstream.url, cloak_mode: "always" } });
        const payload = `{"model":"claude-opus-4-6","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}]}`;
        await createClaudeExecutor().execute(auth, { model: "claude-opus-4-6", payload, format: "claude" }, claudeOpts());
        const h = lastHeaders(upstream);
        const body = lastBody(upstream);
        expect(h.get("User-Agent")).toBe("claude-cli/2.1.280 (external, cli)");
        expect(h.get("X-Stainless-Package-Version")).toBe("0.112.1");
        expect(h.get("X-Stainless-Runtime-Version")).toBe("v26.3.0");
        expect(h.get("X-Stainless-Os")).toBe("MacOS");
        expect(h.get("X-Stainless-Arch")).toBe("arm64");
        expect(h.get("X-App")).toBe("cli");
        expect(h.get("Anthropic-Beta")).toBe(claudeCodeCLIBetas(payload, undefined, false));
        expect(h.get("Anthropic-Beta") ?? "").not.toContain(claudeExtendedCacheTTLBeta);
        expect(body.system).toHaveLength(2);
        expect(body.system[0].text).toBe("x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=cli;");
        expect(body.system[1].text).toBe(claudeCodeCLIIdentity);
        expect(body.system[1].cache_control.type).toBe("ephemeral");
        expect(body.system[1].cache_control.ttl).toBeUndefined();
        const content = body.messages[0].content;
        expect(content).toHaveLength(2);
        expect(content[0].text).toStartWith("<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ");
        expect(content[0].cache_control).toBeUndefined();
        expect(content[1]).toEqual({ type: "text", text: "x", cache_control: { type: "ephemeral" } });
        const userID = body.metadata.user_id;
        expect(isValidUserID(userID)).toBe(true);
        expect(JSON.parse(userID).session_id).toBe(h.get("X-Claude-Code-Session-Id")!);
      },
    );
  });

  test("ConfirmedNewerPatchClaudeCodeRequestPreservesInteractiveIdentity", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-opus-4-6")),
      async (upstream) => {
        const sessionID = "11111111-2222-4333-8444-555555555555";
        const userID = `{"device_id":"${"a".repeat(64)}","account_uuid":"","session_id":"${sessionID}"}`;
        const payload = `{"model":"claude-opus-4-6","system":[{"type":"text","text":"interactive-system","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"x"}],"metadata":{"user_id":${JSON.stringify(userID)}}}`;
        const incoming = new Headers({
          "User-Agent": "claude-cli/2.1.281 (external, cli)",
          "X-App": "cli",
          "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24",
          "X-Claude-Code-Session-Id": sessionID,
          "X-Stainless-Package-Version": "0.112.1",
          "X-Stainless-Runtime-Version": "v26.3.0",
          "X-Stainless-Os": "MacOS",
          "X-Stainless-Arch": "arm64",
        });
        await createClaudeExecutor().execute(apiKeyAuth(upstream.url, {}, "confirmed"), { model: "claude-opus-4-6", payload, format: "claude" }, claudeOpts({ originalRequest: payload, headers: incoming }));
        const h = lastHeaders(upstream);
        const body = lastBody(upstream);
        expect(h.get("User-Agent")).toBe("claude-cli/2.1.281 (external, cli)");
        expect(body.system).toHaveLength(1);
        expect(body.system[0].text).toBe("interactive-system");
        expect(body.metadata.user_id).toBe(userID);
        expect(h.get("Anthropic-Beta")).toBe(incoming.get("Anthropic-Beta")!);
      },
    );
  });

  for (const stream of [false, true]) {
    test(`ConfirmedClaudeCodeWithoutCacheControlPreservesContent/${stream ? "stream" : "non-stream"}`, async () => {
      await withUpstream(
        () => (stream ? new Response(`event: message_stop\ndata: {"type":"message_stop"}\n\n`, { headers: { "Content-Type": "text/event-stream" } }) : jsonResponse(okMessage("claude-opus-4-6"))),
        async (upstream) => {
          const sessionID = "11111111-2222-4333-8444-555555555555";
          const userID = `{"device_id":"${"a".repeat(64)}","account_uuid":"","session_id":"${sessionID}"}`;
          const payload = `{"model":"claude-opus-4-6","messages":[{"role":"user","content":"x"}],"metadata":{"user_id":${JSON.stringify(userID)}}}`;
          const incoming = new Headers({ "User-Agent": "claude-cli/2.1.280 (external, cli)", "X-App": "cli", "Anthropic-Beta": "claude-code-20250219", "X-Claude-Code-Session-Id": sessionID });
          const exec = createClaudeExecutor();
          const req = { model: "claude-opus-4-6", payload, format: "claude" as const };
          const o = claudeOpts({ stream, originalRequest: payload, headers: incoming });
          if (stream) {
            const result = await exec.executeStream(apiKeyAuth(upstream.url), req, o);
            for await (const _ of result.chunks) {
              // drain
            }
          } else {
            await exec.execute(apiKeyAuth(upstream.url), req, o);
          }
          const body = lastBody(upstream);
          expect(body.messages[0].content).toBe("x");
        },
      );
    });
  }

  test("CloakModeNeverPreservesConfirmedShapeClaudeCodeCallerHeaders", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-haiku-5-5")),
      async (upstream) => {
        const sessionID = "44444444-5555-4666-8777-888888888888";
        const userID = `{"account_uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","device_id":"${"d".repeat(64)}","session_id":"${sessionID}"}`;
        const callerUA = "claude-cli/2.1.304 (external, sdk-py, agent-sdk/0.3.276)";
        const payload = `{"model":"claude-haiku-5-5","max_tokens":1024,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.304.c80; cc_entrypoint=sdk-py"},{"type":"text","text":"You are a Claude agent, built on Anthropic's Claude Agent SDK."},{"type":"text","text":"You are naming a coding session."}],"tools":[],"messages":[{"role":"user","content":[{"type":"text","text":"name session"}]}],"metadata":{"user_id":${JSON.stringify(userID)}}}`;
        const incoming = new Headers({
          "User-Agent": callerUA,
          "X-App": "cli",
          "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15",
          "Anthropic-Dangerous-Direct-Browser-Access": "true",
          "X-Claude-Code-Session-Id": sessionID,
          "X-Stainless-Package-Version": "0.128.0",
          "X-Stainless-Runtime-Version": "v26.3.0",
          "X-Stainless-Os": "MacOS",
          "X-Stainless-Arch": "arm64",
        });
        const auth = newAuth({
          id: "auth-cloak-never-oauth",
          provider: "claude",
          attributes: { api_key: "sk-ant-oat-cloak-never", base_url: upstream.url },
          metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)], cloak_mode: "never" },
        });
        await createClaudeExecutor().execute(auth, { model: "claude-haiku-5-5", payload, format: "claude" }, claudeOpts({ originalRequest: payload, headers: incoming }));
        const h = lastHeaders(upstream);
        expect(h.get("User-Agent")).toBe(callerUA);
        expect(h.get("X-Stainless-Package-Version")).toBe("0.128.0");
        expect(h.get("X-Stainless-Os")).toBe("MacOS");
        expect(upstream.requests[0]!.body).not.toContain(`"cache_control"`);
      },
    );
  });

  test("DefaultDoesNotInjectUserID", async () => {
    const body = await executeAndCapture(`{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`);
    expect(body.metadata?.user_id).toBeUndefined();
  });

  test("ResolveClaudeWirePolicy", () => {
    const oauth = newAuth({ id: "o", provider: "claude", metadata: { access_token: "sk-ant-oat-x" } });
    const key = newAuth({ id: "k", provider: "claude", attributes: { api_key: "key-x" } });
    expect(resolveClaudeWirePolicy({}, oauth, "sk-ant-oat-x", false)[0].cloak).toBe(true);
    expect(resolveClaudeWirePolicy({}, oauth, "sk-ant-oat-x", true)[0].cloak).toBe(false);
    expect(resolveClaudeWirePolicy({}, key, "key-x", false)[0].cloak).toBe(false);
    expect(resolveClaudeWirePolicy({ cloakMode: "never" }, oauth, "sk-ant-oat-x", false)[0].cloak).toBe(false);
    expect(resolveClaudeWirePolicy({ cloakMode: "never" }, oauth, "sk-ant-oat-x", false)[0].explicitNever).toBe(true);
  });

  test("OAuth credential non-Claude-Code caller is cloaked with a CLI identity", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-opus-4-6")),
      async (upstream) => {
        const auth = newAuth({ id: "oauth-cloak", provider: "claude", attributes: { base_url: upstream.url }, metadata: { access_token: "sk-ant-oat-cloak", account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] } });
        const payload = `{"model":"claude-opus-4-6","system":"caller system","messages":[{"role":"user","content":"hi"}]}`;
        await createClaudeExecutor().execute(auth, { model: "claude-opus-4-6", payload, format: "claude" }, claudeOpts({ headers: new Headers({ "User-Agent": "pi (darwin; arm64)" }) }));
        const h = lastHeaders(upstream);
        const body = lastBody(upstream);
        expect(h.get("Authorization")).toBe("Bearer sk-ant-oat-cloak");
        expect(h.get("x-api-key")).toBeNull();
        expect(h.get("User-Agent")).toStartWith("claude-cli/");
        expect(h.get("Anthropic-Beta") ?? "").toContain("oauth-2025-04-20");
        expect(body.system[0].text).toStartWith("x-anthropic-billing-header: cc_version=2.1.280.");
        expect(body.system[0].text).toMatch(/ cch=[0-9a-f]{5};/);
        expect(body.system[1].text).toBe(claudeCodeCLIIdentity);
        expect(body.system.some((b: { text: string }) => b.text === "caller system")).toBe(true);
        const userID = JSON.parse(body.metadata.user_id);
        expect(userID.account_uuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        expect(userID.device_id).toBe("0".repeat(64));
        expect(userID.session_id).toBe(h.get("X-Claude-Code-Session-Id")!);
      },
    );
  });

  test("cloak_mode never passes an OAuth body through unchanged", () => {
    const auth = newAuth({ id: "n", provider: "claude", attributes: { api_key: "sk-ant-oat-direct", cloak_mode: "never" } });
    const payload = `{"model":"claude-opus-5-5","system":[{"type":"text","text":"caller system"}],"messages":[{"role":"user","content":"hello"}]}`;
    const result = applyCloaking({}, auth, payload, "sk-ant-oat-direct", false);
    expect(result.cloaked).toBe(false);
    expect(result.payload).toBe(payload);
  });
});

describe("mid-conversation system messages", () => {
  const payload = `{"model":"claude-opus-4-6","system":"top","messages":[{"role":"user","content":"a"},{"role":"system","content":"mid"},{"role":"user","content":"b"}]}`;

  test("RebuildMidSystemMessageDisabledByDefault", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-opus-4-6")),
      async (upstream) => {
        await createClaudeExecutor().execute(apiKeyAuth(upstream.url), { model: "claude-opus-4-6", payload, format: "claude" }, claudeOpts());
        const body = lastBody(upstream);
        expect(body.messages.some((m: { role: string }) => m.role === "system")).toBe(true);
      },
    );
  });

  test("RebuildMidSystemMessageOptInMovesSystemMessages", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-opus-4-6")),
      async (upstream) => {
        await createClaudeExecutor({ rebuildMidSystemMessage: true }).execute(apiKeyAuth(upstream.url), { model: "claude-opus-4-6", payload, format: "claude" }, claudeOpts());
        const body = lastBody(upstream);
        expect(body.messages.some((m: { role: string }) => m.role === "system")).toBe(false);
        expect(JSON.stringify(body.system)).toContain("mid");
        expect(JSON.stringify(body.system)).toContain("top");
      },
    );
  });
});

describe("caller system block validation", () => {
  test("ValidateClaudeCallerSystemBlocksAcceptsTextOnly", () => {
    expect(() => validateClaudeCallerSystemBlocks([{ type: "text", text: "a" }])).not.toThrow();
    expect(() => validateClaudeCallerSystemBlocks("plain")).not.toThrow();
    expect(() => validateClaudeCallerSystemBlocks(undefined)).not.toThrow();
  });

  test("ValidateClaudeCallerSystemBlocksRejectsNonTextBlock", () => {
    let err: unknown;
    try {
      validateClaudeCallerSystemBlocks([{ type: "text", text: "a" }, { type: "image", source: {} }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StatusError);
    expect((err as StatusError).statusCode).toBe(400);
    expect((err as StatusError).requestScoped).toBe(true);
    expect((err as StatusError).message).toContain("system.1.type");
  });

  test("ApplyCloakingRejectsNonTextCallerSystemBlock", () => {
    const auth = newAuth({ id: "o", provider: "claude", metadata: { access_token: "sk-ant-oat-x" } });
    expect(() => applyCloaking({}, auth, `{"model":"claude-opus-4-6","system":[{"type":"image","source":{}}],"messages":[]}`, "sk-ant-oat-x", false)).toThrow(StatusError);
  });

  test("ApplyCloakingStrictModeIgnoresNonTextCallerSystemBlock", () => {
    const auth = newAuth({ id: "o", provider: "claude", attributes: { cloak_strict_mode: "true" }, metadata: { access_token: "sk-ant-oat-x" } });
    const out = applyCloaking({ strictMode: true } as never, auth, `{"model":"claude-opus-4-6","system":[{"type":"image","source":{}}],"messages":[]}`, "sk-ant-oat-x", false);
    expect(JSON.parse(out.payload).system).toEqual([
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=cli;" },
      { type: "text", text: claudeCodeCLIIdentity, cache_control: { type: "ephemeral" } },
    ]);
  });

  test("ExecuteRejectsNonTextCallerSystemBlockWithoutUpstream", async () => {
    await withUpstream(
      () => jsonResponse(okMessage()),
      async (upstream) => {
        const auth = newAuth({ id: "o", provider: "claude", attributes: { base_url: upstream.url }, metadata: { access_token: "sk-ant-oat-x" } });
        const err = await expectStatusError(createClaudeExecutor().execute(auth, { model: "claude-opus-4-6", payload: `{"system":[{"type":"image","source":{}}],"messages":[{"role":"user","content":"hi"}]}`, format: "claude" }, claudeOpts()));
        expect(err.statusCode).toBe(400);
        expect(err.requestScoped).toBe(true);
        expect(upstream.requests).toHaveLength(0);
      },
    );
  });
});

test("IsClaudeFable51Model_DigitBoundary", () => {
  const cases: Array<[string, boolean]> = [
    ["claude-fable-5-1", true],
    ["claude-fable-5-1-20260101", true],
    ["claude-fable-5-10", false],
    ["claude-fable-5", false],
  ];
  for (const [model, want] of cases) expect(isClaudeFable51Model(model), model).toBe(want);
});

describe("count_tokens", () => {
  test("CountTokensUpstreamCloakNeverPreservesCustomTool", async () => {
    await withUpstream(
      () => jsonResponse(`{"input_tokens":7}`),
      async (upstream) => {
        const auth = newAuth({
          id: "oauth-never-count-tokens",
          provider: "claude",
          attributes: { api_key: "sk-ant-oat-never-count-tokens", base_url: upstream.url },
          metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)], cloak_mode: "never" },
        });
        const payload = `{"model":"claude-opus-4-6","messages":[{"role":"user","content":"search"}],"tools":[{"name":"search_web","input_schema":{"type":"object"}}],"metadata":{"user_id":"x"}}`;
        const resp = await createClaudeExecutor().countTokens(auth, { model: "claude-opus-4-6", payload, format: "claude" }, claudeOpts());
        expect(JSON.parse(resp.payload).input_tokens).toBe(7);
        expect(upstream.requests[0]!.path).toBe("/v1/messages/count_tokens");
        const body = lastBody(upstream);
        const h = lastHeaders(upstream);
        expect(body.tools[0].name).toBe("search_web");
        // count_tokens carries no metadata (Anthropic rejects it there); the session travels on the header.
        expect(body.metadata).toBeUndefined();
        expect(h.get("X-Claude-Code-Session-Id") ?? "").not.toBe("");
        expect(h.get("Anthropic-Beta") ?? "").toContain("token-counting-2024-11-01");
        expect(h.get("Authorization")).toBe("Bearer sk-ant-oat-never-count-tokens");
      },
    );
  });

  test("API-key count_tokens on api.anthropic.com uses x-api-key and the caller betas plus token counting", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const exec = createClaudeExecutor({
      fetch: async (url, init) => {
        seen.push({ url, headers: new Headers(init?.headers) });
        return jsonResponse(`{"input_tokens":3}`);
      },
    });
    const resp = await exec.countTokens(apiKeyAuth(undefined), { model: sonnet, payload: `{"messages":[{"role":"user","content":"hi"}]}`, format: "claude" }, claudeOpts({ headers: new Headers({ "Anthropic-Beta": "caller-beta" }) }));
    expect(JSON.parse(resp.payload)).toEqual({ input_tokens: 3 });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(seen[0]!.headers.get("x-api-key")).toBe("key-123");
    expect(seen[0]!.headers.get("Anthropic-Beta")).toBe("caller-beta,token-counting-2024-11-01");
  });
});

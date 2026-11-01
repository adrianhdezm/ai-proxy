// Ported from: internal/runtime/executor/claude_executor_test.go
// Skipped cases: this file holds the CCH, currentDate / date-pin, diagnostics and context_management cases:
// TestClaudeBillingFingerprintUsesFirstUserText, TestClaudeCodeLocalDateMatchesNativeLocalCalendarAlgorithm,
// TestClaudeCodeTimezoneUsesCredentialThenConfiguredProfile, TestInjectClaudeCodeCurrentDate* (all six),
// TestClaudeCallerCurrentDateSeedsOnlyFirstAnchor, TestApplyCloakingStringCallerReminderPreservesUserText,
// TestCheckSystemInstructionsWithSigningMode_LongPromptIsExactAndIdempotent (reduced: caller system blocks stay
// top-level in this port, so only the idempotence and CCH re-finalisation are asserted),
// TestClaudeExecutor_CustomBaseURLPreservesBodyByDefault, TestClaudeExecutor_CustomBaseURLAPIKeyDoesNotEnableCCHSigning,
// TestClaudeExecutor_CustomBaseURLOAuthGeneratesMissingCCH, TestClaudeExecutor_CallerOwnedDiagnosticsPreservedOnProbe,
// TestClaudeExecutor_UncloakedProbePreservesCallerBillingTags, TestInjectClaudeCodeContextManagement,
// TestClaudeCodeContextManagementNeverOutlivesEligibleThinking, TestReconcileClaudeCodeContextManagement,
// TestClaudeExecutor_CloakModePrefersStoredPrevReqOverCallerFake. Config-level ClaudeKey cloak / cch settings are
// expressed as credential attributes (cloak_mode). Dropped: TestClaudeExecutorPayloadOverride*,
// TestClaudeExecutor_PayloadOverride* (payload config rules not ported), TestClaudeExecutor_SensitiveWordsDoNotCorrupt
// BillingHeaderTags (sensitive-word obfuscation not ported), TestApplyCloaking_FableInjectsFallbacksAndDisplayUpdates
// (fallbacks injection not ported).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import {
  type ClaudeRequestContext,
  claudeBillingFingerprintMessageText,
  claudeCallerCurrentDateReminderDate,
  claudeCodeCurrentDateReminder,
  claudeCodeLocalDate,
  claudeCodeTimezone,
  computeFingerprint,
  injectClaudeCodeCurrentDate,
  resolveClaudeSessionPinnedDate,
  stripFirstUserClaudeCodeCurrentDateReminder,
} from "../../../src/executor/claude/billing.ts";
import { applyCloaking } from "../../../src/executor/claude/cloaking.ts";
import { claudeCodeContextManagement, injectClaudeCodeContextManagement, reconcileClaudeCodeContextManagement } from "../../../src/executor/claude/context_management.ts";
import { ClaudeContinuityStore, newClaudeContinuityContext } from "../../../src/executor/claude/diagnostics.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { disableThinkingIfToolChoiceForced } from "../../../src/executor/claude/request.ts";
import { claudeBillingCCHDigitsOffset, finalizeAnthropicMessagesBodyCCH } from "../../../src/executor/claude/signing.ts";
import { claudeOAuthTestMetadata, claudeOpts, jsonResponse, lastBody, okMessage, withUpstream } from "./helpers.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function assertEphemeralUserTextBlock(block: Record<string, any>, text: string): void {
  expect(block.text).toBe(text);
  expect(block.cache_control).toEqual({ type: "ephemeral" });
}

function assertCurrentDateBlock(block: Record<string, any>, date: string): void {
  expect(block.text).toBe(claudeCodeCurrentDateReminder(date));
  expect(block.cache_control).toBeUndefined();
}

function rcWith(store: ClaudeContinuityStore, now: () => number, retentionMs: number): ClaudeRequestContext {
  return { store, sessionID: "", hasExecutionMetadata: false, continuity: newClaudeContinuityContext(), workload: "", now, sessionDatePinRetentionMs: retentionMs, timezone: "" };
}

describe("billing fingerprint and currentDate", () => {
  test("BillingFingerprintUsesFirstUserText", () => {
    const prompt = "CPA_OFFICIAL_BASEURL_CLI_SYSTEM_EMPTY_b82d4e";
    const payload = `{"system":"must not seed the build hash","messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>date</system-reminder>"},{"type":"text","text":"${prompt}"}]},{"role":"assistant","content":"answer"},{"role":"user","content":"turn2"}]}`;
    expect(claudeBillingFingerprintMessageText(payload)).toBe(prompt);
    expect(computeFingerprint(prompt, "2.1.258")).toBe("1f4");
  });

  test("LocalDateMatchesNativeLocalCalendarAlgorithm", () => {
    const instant = Date.UTC(2026, 6, 31, 15, 30);
    expect(claudeCodeLocalDate(instant, "Pacific/Kiritimati")).toBe("2026-08-01");
    expect(claudeCodeLocalDate(instant, "Etc/GMT+12")).toBe("2026-07-31");
    const want =
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-08-01.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n";
    expect(claudeCodeCurrentDateReminder(claudeCodeLocalDate(instant, "Pacific/Kiritimati"))).toBe(want);
  });

  test("TimezoneUsesCredentialThenConfiguredProfile", () => {
    const instant = Date.UTC(2026, 7, 2, 1, 30);
    const auth = newAuth({ id: "tz", provider: "claude", metadata: { timezone: "Pacific/Honolulu" } });
    expect(claudeCodeLocalDate(instant, claudeCodeTimezone("Asia/Tokyo", auth))).toBe("2026-08-01");
    expect(claudeCodeLocalDate(instant, claudeCodeTimezone("Asia/Tokyo", undefined))).toBe("2026-08-02");
    const invalidAuth = newAuth({ id: "tz2", provider: "claude", metadata: { timezone: "not/a-timezone" } });
    expect(claudeCodeTimezone("Asia/Tokyo", invalidAuth)).toBe("Asia/Tokyo");
    expect(claudeCodeTimezone("not/a-timezone", undefined)).toBeUndefined();
  });

  const fixedDate = "2026-08-01";

  test("InjectCurrentDateIsIdempotentAndAlignsFirstUserCache", () => {
    const payload = `{"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`;
    const first = injectClaudeCodeCurrentDate(payload, fixedDate);
    expect(first).toContain("<system-reminder>");
    expect(first).not.toContain("\\u003csystem-reminder");
    expect(injectClaudeCodeCurrentDate(first, fixedDate)).toBe(first);
    const content = JSON.parse(first).messages[0].content;
    expect(content).toHaveLength(2);
    assertCurrentDateBlock(content[0], fixedDate);
    assertEphemeralUserTextBlock(content[1], "hello");
  });

  test("CallerCurrentDateSeedsOnlyFirstAnchor", () => {
    let t = Date.UTC(2026, 7, 2, 12);
    const store = new ClaudeContinuityStore(() => t);
    const rc = rcWith(store, () => t, 7 * DAY);
    rc.timezone = "UTC";
    const auth = newAuth({ id: "caller-date-cred", provider: "claude" });
    const callerPayload = (date: string) => JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: claudeCodeCurrentDateReminder(date) }, { type: "text", text: "hello" }] }] });
    const keyA = store.beginDiagnostics("id:caller-date-cred", "caller-date-session").key;
    expect(resolveClaudeSessionPinnedDate(rc, auth, callerPayload("2026-08-01"), keyA, "caller-date-session")).toBe("2026-08-01");
    const keyB = store.beginDiagnostics("id:other-cred", "caller-date-session").key;
    expect(resolveClaudeSessionPinnedDate(rc, auth, callerPayload("2026-08-02"), keyB, "caller-date-session")).toBe("2026-08-01");
    store.expireForTest(true, 1000);
    const before = store.sessionDatePinExpiryForTest("caller-date-session");
    expect(before - t).toBeLessThanOrEqual(2000);
    const keyC = store.beginDiagnostics("id:caller-date-cred", "caller-date-session").key;
    expect(resolveClaudeSessionPinnedDate(rc, auth, callerPayload("2026-08-02"), keyC, "caller-date-session")).toBe("2026-08-01");
    expect(store.sessionDatePinExpiryForTest("caller-date-session") - t).toBeGreaterThanOrEqual(6 * DAY);
    t += HOUR;
  });

  test("InjectCurrentDateStripsCallerReminderFromStringContent", () => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: claudeCodeCurrentDateReminder("2026-08-01") + "hello" }] });
    expect(claudeCallerCurrentDateReminderDate(payload)).toBe("2026-08-01");
    const legacy = injectClaudeCodeCurrentDate(payload, "2026-08-01");
    expect(legacy.split("Today's date is").length - 1).toBe(2);
    const stripped = injectClaudeCodeCurrentDate(stripFirstUserClaudeCodeCurrentDateReminder(payload), "2026-08-01");
    expect(stripped.split("Today's date is").length - 1).toBe(1);
    expect(JSON.parse(stripped).messages[0].content[1].text).toBe("hello");
    const noTrailer = JSON.stringify({ messages: [{ role: "user", content: claudeCodeCurrentDateReminder("2026-08-01").replace(/\n+$/, "") + "hello" }] });
    const strippedNoTrailer = injectClaudeCodeCurrentDate(stripFirstUserClaudeCodeCurrentDateReminder(noTrailer), "2026-08-01");
    expect(strippedNoTrailer.split("Today's date is").length - 1).toBe(1);
    expect(JSON.parse(strippedNoTrailer).messages[0].content[1].text).toBe("hello");
  });

  test("ApplyCloakingStringCallerReminderPreservesUserText", () => {
    const store = new ClaudeContinuityStore();
    const rc = rcWith(store, () => Date.now(), 7 * DAY);
    rc.sessionID = "apply-cloaking-string-session";
    const auth = newAuth({ id: "apply-cloaking-string-reminder", provider: "claude", metadata: { cloak_mode: "always" } });
    const payload = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: claudeCodeCurrentDateReminder("2026-08-01") + "hello" }] });
    const out = applyCloaking({}, auth, payload, "sk-ant-oat-test", false, { rc });
    expect(out.cloaked).toBe(true);
    expect(out.payload.split("Today's date is").length - 1).toBe(1);
    expect(JSON.parse(out.payload).messages[0].content.some((b: { text: string }) => b.text === "hello")).toBe(true);
  });

  test("InjectCurrentDateMovesExistingCopyToFirstBlock", () => {
    const dateBlock = JSON.stringify({ type: "text", text: claudeCodeCurrentDateReminder(fixedDate) });
    const out = injectClaudeCodeCurrentDate(`{"messages":[{"role":"user","content":[{"type":"text","text":"hello"},${dateBlock}]}]}`, fixedDate);
    const content = JSON.parse(out).messages[0].content;
    expect(content).toHaveLength(2);
    assertCurrentDateBlock(content[0], fixedDate);
    assertEphemeralUserTextBlock(content[1], "hello");
  });

  test("InjectCurrentDatePrecedesExistingReminder", () => {
    const reminder = "<system-reminder>\ncaller instructions\n</system-reminder>";
    const payload = `{"messages":[{"role":"user","content":[${JSON.stringify({ type: "text", text: reminder })},{"type":"text","text":"continue","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`;
    const content = JSON.parse(injectClaudeCodeCurrentDate(payload, fixedDate)).messages[0].content;
    expect(content).toHaveLength(3);
    assertCurrentDateBlock(content[0], fixedDate);
    expect(content[1].text).toBe(reminder);
    assertEphemeralUserTextBlock(content[2], "continue");
  });

  test("InjectCurrentDateFollowsLeadingToolResults", () => {
    const payload = `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"},{"type":"text","text":"continue"}]}]}`;
    const first = injectClaudeCodeCurrentDate(payload, fixedDate);
    expect(injectClaudeCodeCurrentDate(first, fixedDate)).toBe(first);
    const content = JSON.parse(first).messages[1].content;
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("tool_result");
    expect(content[0].tool_use_id).toBe("toolu_1");
    assertCurrentDateBlock(content[1], fixedDate);
    assertEphemeralUserTextBlock(content[2], "continue");
  });

  test("InjectCurrentDateFollowsAllLeadingToolResults", () => {
    const payload = `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"},{"type":"tool_result","tool_use_id":"toolu_2","content":"ok"}]}]}`;
    const content = JSON.parse(injectClaudeCodeCurrentDate(payload, fixedDate)).messages[1].content;
    expect(content).toHaveLength(3);
    expect(content[0].tool_use_id).toBe("toolu_1");
    expect(content[1].tool_use_id).toBe("toolu_2");
    assertCurrentDateBlock(content[2], fixedDate);
  });

  test("CheckSystemInstructionsWithSigningMode_LongPromptIsExactAndIdempotent (reduced)", () => {
    const wantSystem = "\nPI_SYSTEM_BEGIN\nEmbedded reference: # currentDate\nToday's date is caller-owned text.\n" + "Preserve tools, policies, and caller semantics exactly.\n".repeat(560) + "PI_SYSTEM_END  \n";
    const payload = JSON.stringify({ model: "claude-opus-5", system: wantSystem, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "acknowledged" }, { role: "user", content: "follow-up" }] });
    const auth = newAuth({ id: "long", provider: "claude", metadata: { cloak_mode: "always" } });
    const first = applyCloaking({}, auth, payload, "sk-ant-oat-x", false, { cchSigning: true, billingVersion: "2.1.258" }).payload;
    const root = JSON.parse(first);
    expect(root.system.some((b: { text: string }) => b.text === wantSystem)).toBe(true);
    const content = root.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].text).toStartWith("<system-reminder>\nAs you answer");
    assertEphemeralUserTextBlock(content[1], "hello");
    expect(first).toContain("<system-reminder>");
    expect(first).not.toContain("\\u003csystem-reminder");
    const signed = finalizeAnthropicMessagesBodyCCH(first, "");
    expect(finalizeAnthropicMessagesBodyCCH(signed, "")).toBe(signed);
  });
});

describe("CCH on the executor", () => {
  test("CustomBaseURLPreservesBodyByDefault", async () => {
    await withUpstream(
      () => jsonResponse(okMessage()),
      async (upstream) => {
        const auth = newAuth({ id: "k", provider: "claude", attributes: { api_key: "key-123", base_url: upstream.url } });
        await createClaudeExecutor().execute(auth, { model: "claude-3-5-sonnet-20241022", payload: `{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`, format: "claude" }, claudeOpts());
        const raw = upstream.requests[0]!.body;
        expect(raw).not.toContain("x-anthropic-billing-header:");
        expect(raw).not.toContain("cch=");
      },
    );
  });

  test("CustomBaseURLAPIKeyDoesNotEnableCCHSigning", async () => {
    await withUpstream(
      () => jsonResponse(okMessage()),
      async (upstream) => {
        const auth = newAuth({ id: "k", provider: "claude", attributes: { api_key: "key-123", base_url: upstream.url } });
        const text = "please keep literal cch=00000 in this message";
        await createClaudeExecutor().execute(auth, { model: "claude-3-5-sonnet-20241022", payload: `{"messages":[{"role":"user","content":[{"type":"text","text":"${text}"}]}]}`, format: "claude" }, claudeOpts());
        const body = lastBody(upstream);
        expect(body.messages[0].content[0].text).toBe(text);
        expect(upstream.requests[0]!.body).not.toContain("x-anthropic-billing-header:");
      },
    );
  });

  test("CustomBaseURLOAuthGeneratesMissingCCH", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-opus-4-6")),
      async (upstream) => {
        const auth = newAuth({ id: "o", provider: "claude", attributes: { api_key: "sk-ant-oat-custom-cch", base_url: upstream.url, cloak_mode: "never" }, metadata: claudeOAuthTestMetadata() });
        await createClaudeExecutor().execute(auth, { model: "claude-opus-4-6", payload: `{"model":"claude-opus-4-6","system":"keep original system","messages":[{"role":"user","content":"hello"}],"max_tokens":64}`, format: "claude" }, claudeOpts());
        const raw = upstream.requests[0]!.body;
        expect(claudeBillingCCHDigitsOffset(raw)).toBeDefined();
        expect(JSON.parse(raw).system[1].text).toBe("keep original system");
      },
    );
  });

  test("CallerOwnedDiagnosticsPreservedOnProbe", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-haiku-4-5-20251001")),
      async (upstream) => {
        const auth = newAuth({ id: "d", provider: "claude", attributes: { api_key: "sk-ant-api-caller-diagnostics-test", base_url: upstream.url, cloak_mode: "never" } });
        const payload = `{"model":"claude-haiku-4-5-20251001","max_tokens":1,"diagnostics":{"caller_custom_key":"val123"},"messages":[{"role":"user","content":"quota"}]}`;
        await createClaudeExecutor().execute(auth, { model: "claude-haiku-4-5-20251001", payload, format: "claude" }, claudeOpts());
        expect(lastBody(upstream).diagnostics.caller_custom_key).toBe("val123");
      },
    );
  });

  test("UncloakedProbePreservesCallerBillingTags", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-haiku-4-5-20251001")),
      async (upstream) => {
        const auth = newAuth({ id: "u", provider: "claude", attributes: { api_key: "sk-ant-api03-uncloaked-test", base_url: upstream.url } });
        const billing = "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=cli; cch=abc12; cc_prompt_id=00000000-0000-4000-8000-000000000001;";
        const payload = `{"model":"claude-haiku-4-5-20251001","max_tokens":1,"system":[{"type":"text","text":${JSON.stringify(billing)}}],"messages":[{"role":"user","content":"quota"}]}`;
        await createClaudeExecutor().execute(auth, { model: "claude-haiku-4-5-20251001", payload, format: "claude" }, claudeOpts());
        expect(lastBody(upstream).system[0].text).toContain("cc_prompt_id=00000000-0000-4000-8000-000000000001");
      },
    );
  });

  test("CloakModePrefersStoredPrevReqOverCallerFake", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-sonnet-5"), 200, { "request-id": "req_real_upstream_001" }),
      async (upstream) => {
        const auth = newAuth({ id: "auth-cloak-prev-req-test", provider: "claude", metadata: claudeOAuthTestMetadata(), attributes: { api_key: "sk-ant-oat-cloak-prev-req-test", base_url: upstream.url, cloak_mode: "auto" } });
        const exec = createClaudeExecutor({ continuityStore: new ClaudeContinuityStore() });
        const opts = claudeOpts({ headers: new Headers({ "Session-Id": "sess-test-001" }) });
        await exec.execute(auth, { model: "claude-sonnet-5", payload: `{"model":"claude-sonnet-5","messages":[{"role":"user","content":"turn 1"}]}`, format: "claude" }, opts);
        const fake = `{"model":"claude-sonnet-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258.000; cc_entrypoint=cli; cch=00000; cc_prev_req=req_fake_caller_999; cc_prompt_id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee;"},{"type":"text","text":"custom instructions"}],"messages":[{"role":"user","content":"turn 1"},{"role":"assistant","content":"ok"},{"role":"user","content":"turn 2"}]}`;
        await exec.execute(auth, { model: "claude-sonnet-5", payload: fake, format: "claude" }, opts);
        const turn2 = JSON.parse(upstream.requests[1]!.body).system[0].text as string;
        expect(turn2).toContain("cc_prev_req=req_real_upstream_001");
        expect(turn2).not.toContain("req_fake_caller_999");
      },
    );
  });
});

describe("context_management", () => {
  test("InjectClaudeCodeContextManagement", () => {
    for (const payload of [`{"model":"claude-opus-5","thinking":{"type":"enabled"}}`, `{"model":"claude-opus-5","thinking":{"type":"adaptive"}}`]) {
      const got = injectClaudeCodeContextManagement(payload);
      expect(got.injected).toBe(true);
      expect(JSON.stringify(JSON.parse(got.payload).context_management)).toBe(claudeCodeContextManagement);
    }
    const callerOwned = `{"model":"claude-opus-4-6","context_management":{"edits":[]}}`;
    const owned = injectClaudeCodeContextManagement(callerOwned);
    expect(owned.injected).toBe(false);
    expect(owned.payload).toBe(callerOwned);
    for (const payload of [`{"model":"claude-opus-5","thinking":{"type":"disabled"}}`, `{"model":"claude-opus-4-6"}`, `{"model":"claude-opus-5","thinking":{"type":"unexpected"}}`]) {
      const got = injectClaudeCodeContextManagement(payload);
      expect(got.injected).toBe(false);
      expect(got.payload).toBe(payload);
    }
  });

  for (const tc of [
    { name: "thinking omitted from the start", payload: `{"model":"claude-opus-5","messages":[]}`, wantCM: false },
    { name: "forced tool_choice strips thinking after injection", payload: `{"model":"claude-opus-5","thinking":{"type":"enabled","budget_tokens":1024},"tool_choice":{"type":"any"},"messages":[]}`, wantCM: false },
    { name: "thinking survives without forced tool_choice", payload: `{"model":"claude-opus-5","thinking":{"type":"enabled","budget_tokens":1024},"messages":[]}`, wantCM: true },
  ]) {
    test(`ContextManagementNeverOutlivesEligibleThinking/${tc.name}`, () => {
      const injected = injectClaudeCodeContextManagement(tc.payload);
      let body = disableThinkingIfToolChoiceForced(injected.payload);
      body = reconcileClaudeCodeContextManagement(body, { eligible: true, callerOwned: false, automaticallyInjected: injected.injected });
      const root = JSON.parse(body);
      const eligible = root.thinking?.type === "enabled" || root.thinking?.type === "adaptive";
      if (root.context_management !== undefined) expect(eligible).toBe(true);
      expect(root.context_management !== undefined).toBe(tc.wantCM);
    });
  }

  const withAutomatic = (type: string) => `{"thinking":{"type":"${type}"},"context_management":${claudeCodeContextManagement}}`;
  const st = (s: Partial<{ eligible: boolean; callerOwned: boolean; automaticallyInjected: boolean }>) => ({ eligible: false, callerOwned: false, automaticallyInjected: false, ...s });
  for (const tc of [
    { name: "removes unchanged automatic object when disabled", payload: withAutomatic("disabled"), state: st({ eligible: true, automaticallyInjected: true }), want: undefined },
    { name: "preserves changed automatic object when disabled", payload: `{"thinking":{"type":"disabled"},"context_management":{"edits":[{"type":"custom"}]}}`, state: st({ eligible: true, automaticallyInjected: true }), want: `{"edits":[{"type":"custom"}]}` },
    { name: "adds automatic object when enabled", payload: `{"thinking":{"type":"enabled"}}`, state: st({ eligible: true }), want: claudeCodeContextManagement },
    { name: "adds automatic object when adaptive", payload: `{"thinking":{"type":"adaptive"}}`, state: st({ eligible: true }), want: claudeCodeContextManagement },
    { name: "caller ownership prevents addition", payload: `{"thinking":{"type":"enabled"}}`, state: st({ eligible: true, callerOwned: true }), want: undefined },
    { name: "ineligible request prevents addition", payload: `{"thinking":{"type":"enabled"}}`, state: st({}), want: undefined },
    { name: "omitted thinking prevents addition", payload: `{}`, state: st({ eligible: true }), want: undefined },
    { name: "removes automatic object when thinking was stripped entirely", payload: `{"context_management":${claudeCodeContextManagement}}`, state: st({ eligible: true, automaticallyInjected: true }), want: undefined },
    { name: "keeps caller object when thinking was stripped entirely", payload: `{"context_management":${claudeCodeContextManagement}}`, state: st({ eligible: true, callerOwned: true }), want: claudeCodeContextManagement },
    { name: "unknown thinking prevents addition", payload: `{"thinking":{"type":"unexpected"}}`, state: st({ eligible: true }), want: undefined },
    { name: "invalid thinking prevents addition", payload: `{"thinking":{"type":123}}`, state: st({ eligible: true }), want: undefined },
  ]) {
    test(`ReconcileClaudeCodeContextManagement/${tc.name}`, () => {
      const cm = JSON.parse(reconcileClaudeCodeContextManagement(tc.payload, tc.state)).context_management;
      expect(cm === undefined ? undefined : JSON.stringify(cm)).toBe(tc.want);
    });
  }
});

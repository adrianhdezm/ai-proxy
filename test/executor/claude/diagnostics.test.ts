// Ported from: internal/runtime/executor/helps/claude_diagnostics_test.go
// Ported from: internal/runtime/executor/claude_executor_diagnostics_test.go
// Skipped cases: none dropped. Expiry/eviction cases advance an injected clock or use the store's test hooks instead
// of poking the Go package state; TestClaudePayloadHas1hTTL and TestClaudeSubagentRequests1h exercise the existing
// request_shape.ts helpers. The executor cases inject a fake fetch for api.anthropic.com instead of a round tripper.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { claudeCacheDiagnosisBeta, claudeExtendedCacheTTLBeta } from "../../../src/executor/claude/betas.ts";
import {
  ClaudeContinuityStore,
  claudeDiagnosticsMaxEntries,
  extractClaudeBillingTags,
  injectClaudeDiagnostics,
  isClaudeNewPromptTurn,
  isValidClaudePromptID,
} from "../../../src/executor/claude/diagnostics.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudePayloadHas1hTTL, claudeSubagentRequests1h, isClaudeProbeOrHelperRequest, isClaudeSubagentRequest } from "../../../src/executor/claude/request_shape.ts";
import { claudeMessageIDFromSSE } from "../../../src/executor/claude/response.ts";
import { claudeOpts, fakeFetch, messageResponse } from "./helpers.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function clock(start = Date.UTC(2026, 7, 1, 12)): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("continuity store (helps/claude_diagnostics.go)", () => {
  test("TracksCompletedMessagePerCredentialSession", () => {
    const s = new ClaudeContinuityStore();
    const first = s.beginDiagnostics("credential-a", "session-a");
    expect(first.key).not.toBe("");
    expect(first.sequence).toBe(1);
    expect(first.previousMessageID).toBe("");
    s.commitDiagnostics(first.key, first.sequence, "msg_first");
    const second = s.beginDiagnostics("credential-a", "session-a");
    expect(second.sequence).toBe(2);
    expect(second.previousMessageID).toBe("msg_first");
    expect(s.beginDiagnostics("credential-a", "session-b").previousMessageID).toBe("");
    expect(s.beginDiagnostics("credential-b", "session-a").previousMessageID).toBe("");
  });

  test("RejectsExpiredGenerationCommit", () => {
    const c = clock();
    const s = new ClaudeContinuityStore(c.now);
    const expired = s.beginDiagnostics("credential", "session");
    s.expireEntryForTest(expired.key);
    const current = s.beginDiagnostics("credential", "session");
    expect(current.key).toBe(expired.key);
    expect(current.sequence).toBeGreaterThan(expired.sequence);
    expect(current.previousMessageID).toBe("");
    s.commitDiagnostics(current.key, current.sequence, "msg_current");
    s.commitDiagnostics(expired.key, expired.sequence, "msg_expired");
    expect(s.beginDiagnostics("credential", "session").previousMessageID).toBe("msg_current");
  });

  test("CacheEvictsOldestEntriesWithinCapacity", () => {
    const s = new ClaudeContinuityStore();
    const first = s.beginDiagnostics("credential", "session-0");
    let newestKey = "";
    for (let i = 1; i <= claudeDiagnosticsMaxEntries; i++) newestKey = s.beginDiagnostics("credential", `session-${i}`).key;
    expect(s.size).toBeLessThanOrEqual(claudeDiagnosticsMaxEntries);
    expect(s.hasEntry(first.key)).toBe(false);
    expect(s.hasEntry(newestKey)).toBe(true);
    const recreated = s.beginDiagnostics("credential", "session-0");
    expect(recreated.key).toBe(first.key);
    expect(recreated.sequence).toBeGreaterThan(first.sequence);
    s.commitDiagnostics(recreated.key, recreated.sequence, "msg_recreated");
    s.commitDiagnostics(first.key, first.sequence, "msg_evicted");
    expect(s.beginDiagnostics("credential", "session-0").previousMessageID).toBe("msg_recreated");
  });

  test("RejectsLateOlderCommit", () => {
    const s = new ClaudeContinuityStore();
    const first = s.beginDiagnostics("credential", "session");
    const second = s.beginDiagnostics("credential", "session");
    s.commitDiagnostics(first.key, second.sequence, "msg_newer");
    s.commitDiagnostics(first.key, first.sequence, "msg_older");
    expect(s.beginDiagnostics("credential", "session").previousMessageID).toBe("msg_newer");
  });

  test("TracksRequestIDAndPromptID", () => {
    const s = new ClaudeContinuityStore();
    const t1 = s.begin("cred-1", "sess-1", true, "");
    expect(t1.previousMessageID).toBe("");
    expect(t1.previousRequestID).toBe("");
    expect(t1.promptID).not.toBe("");
    s.commit(t1.key, t1.sequence, "msg_01aaa", "req_01bbb", t1.promptID);
    const t11 = s.begin("cred-1", "sess-1", false, "");
    expect(t11.previousMessageID).toBe("msg_01aaa");
    expect(t11.previousRequestID).toBe("req_01bbb");
    expect(t11.promptID).toBe(t1.promptID);
    s.commit(t1.key, t11.sequence, "msg_01ccc", "req_01ddd", t11.promptID);
    const t2 = s.begin("cred-1", "sess-1", true, "");
    expect(t2.previousMessageID).toBe("msg_01ccc");
    expect(t2.previousRequestID).toBe("req_01ddd");
    expect(t2.promptID).not.toBe(t1.promptID);
  });

  test("HelperPredicates", () => {
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-fable-5-1","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"Hi","cache_control":{"type":"ephemeral"}}]}]}`)).toBe(true);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"quota"}]}`)).toBe(true);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-fable-5-1","max_tokens":1,"messages":[{"role":"user","content":"Hi"}]}`)).toBe(false);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":"what is 1+1?"}]}`)).toBe(false);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"Hi"}],"tools":[{"name":"t1","description":"tool"}]}`)).toBe(false);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-haiku-4-5-20251001","output_config":{"format":{"schema":{"properties":{"title":{"type":"string"}}}}},"messages":[{"role":"user","content":"Return a short title summarizing this conversation"}]}`)).toBe(true);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-haiku-4-5-20251001","output_config":{"format":{"schema":{"properties":{"title":{"type":"string"}}}}},"messages":[{"role":"user","content":"what is the title of the book?"}]}`)).toBe(false);
    expect(isClaudeProbeOrHelperRequest(`{"model":"claude-sonnet-5","system":[{"type":"text","text":"cli-identity"}],"messages":[{"role":"system","content":"Return a short title summarizing this conversation"}]}`)).toBe(true);
    expect(isClaudeNewPromptTurn(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"t1"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}]}`)).toBe(false);
    expect(isClaudeNewPromptTurn(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"explain sorting"}]}`)).toBe(true);
    expect(isClaudeSubagentRequest(new Headers({ "X-Claude-Code-Agent-Id": "sub-1" }), `{}`)).toBe(true);
    expect(isClaudeSubagentRequest(undefined, `{"metadata":{"user_id":"{\\"device_id\\":\\"dev\\",\\"session_id\\":\\"sess\\",\\"parent_session_id\\":\\"parent-1\\"}"}}`)).toBe(true);
    const tags = extractClaudeBillingTags(`{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258.1e2; cc_entrypoint=cli; cch=00000; cc_prev_req=req_01abc; cc_prompt_id=3c6489dc-badc-42b2-bd28-49f8ebabfedd;"}]}`);
    expect(tags).toEqual({ prevReq: "req_01abc", promptID: "3c6489dc-badc-42b2-bd28-49f8ebabfedd" });
  });

  test("IsValidClaudePromptID", () => {
    expect(isValidClaudePromptID(crypto.randomUUID())).toBe(true);
    expect(isValidClaudePromptID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(false);
    expect(isValidClaudePromptID("3c6489dc-badc-42b2-0d28-49f8ebabfedd")).toBe(false);
    expect(isValidClaudePromptID("00000000-0000-0000-0000-000000000000")).toBe(false);
    for (const invalid of ["", "not-a-uuid", "12345", "3c6489dc-badc-42b2-bd28-49f8ebabfedd-extra"]) expect(isValidClaudePromptID(invalid)).toBe(false);
  });

  test("ConcurrentOverlappingPromptID", () => {
    const s = new ClaudeContinuityStore();
    const t1 = s.begin("cred-1", "sess-1", true, "");
    const t2 = s.begin("cred-1", "sess-1", true, "");
    expect(t1.promptID).not.toBe(t2.promptID);
    s.commit(t1.key, t1.sequence, "msg_01aaa", "req_01bbb", t1.promptID);
    const t11 = s.begin("cred-1", "sess-1", false, "");
    expect(t11.previousMessageID).toBe("msg_01aaa");
    expect(t11.previousRequestID).toBe("req_01bbb");
    expect(t11.promptID).toBe(t1.promptID);
    s.commit(t1.key, t2.sequence, "msg_01ccc", "req_01ddd", t2.promptID);
    const t21 = s.begin("cred-1", "sess-1", false, "");
    expect(t21.previousMessageID).toBe("msg_01ccc");
    expect(t21.previousRequestID).toBe("req_01ddd");
    expect(t21.promptID).toBe(t2.promptID);
  });

  test("ClearsStaleRequestID", () => {
    const s = new ClaudeContinuityStore();
    const t1 = s.begin("cred-1", "sess-1", true, "");
    s.commit(t1.key, t1.sequence, "msg_01aaa", "req_01bbb", t1.promptID);
    const t11 = s.begin("cred-1", "sess-1", false, "");
    expect(t11.previousRequestID).toBe("req_01bbb");
    s.commit(t1.key, t11.sequence, "msg_01ccc", "", t11.promptID);
    const t2 = s.begin("cred-1", "sess-1", true, "");
    expect(t2.previousMessageID).toBe("msg_01ccc");
    expect(t2.previousRequestID).toBe("");
  });

  test("ExpiredEntryDoesNotInheritPromptID", () => {
    const s = new ClaudeContinuityStore();
    const t1 = s.begin("cred-expire", "sess-expire", true, "");
    expect(t1.promptID).not.toBe("");
    s.expireEntryForTest(t1.key);
    const t2 = s.begin("cred-expire", "sess-expire", false, "");
    expect(t2.promptID).not.toBe("");
    expect(t2.promptID).not.toBe(t1.promptID);
  });

  test("IsClaudeProbeRequest_MultiContentBlocksNotAProbe", () => {
    const payload = `{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"quota"},{"type":"text","text":"Please write an analysis of the codebase."}]}]}`;
    expect(isClaudeProbeOrHelperRequest(payload)).toBe(false);
  });

  test("IsClaudeProbeRequest_SingleContentBlockWithReminderIsProbe", () => {
    const payload = `{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>some reminder</system-reminder>"},{"type":"text","text":"quota"}]}]}`;
    expect(isClaudeProbeOrHelperRequest(payload)).toBe(true);
  });

  const ttlCases: Array<[string, string, boolean]> = [
    ["empty payload", "", false],
    ["invalid json", "not-json", false],
    ["no cache control", `{"messages":[{"role":"user","content":"hello"}]}`, false],
    ["default 5m ephemeral", `{"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral"}}]}]}`, false],
    ["message content with 1h ttl", `{"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`, true],
    ["system block with 1h ttl", `{"system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral","ttl":"1h"}}]}`, true],
    ["tool block with 1h ttl", `{"tools":[{"name":"tool1","cache_control":{"type":"ephemeral","ttl":"1h"}}]}`, true],
    ["message text mentions ttl 1h without cache control", `{"messages":[{"role":"user","content":[{"type":"text","text":"can you set ttl: 1h"}]}]}`, false],
  ];
  for (const [name, payload, want] of ttlCases) test(`ClaudePayloadHas1hTTL/${name}`, () => expect(claudePayloadHas1hTTL(payload)).toBe(want));

  test("ClaudeSubagentRequests1h", () => {
    const payload = `{"messages":[{"role":"user","content":"task"}]}`;
    expect(claudeSubagentRequests1h(new Headers(), payload)).toBe(false);
    expect(claudeSubagentRequests1h(new Headers(), `{"messages":[{"role":"user","content":[{"type":"text","text":"task","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`)).toBe(true);
    expect(claudeSubagentRequests1h(new Headers({ "Anthropic-Beta": "claude-code-20250219,extended-cache-ttl-2025-04-11" }), payload)).toBe(true);
  });

  test("PinClaudeSessionDateAnchorsFirstRequestAndReanchorsAfterTTL", () => {
    const s = new ClaudeContinuityStore();
    const { key } = s.beginDiagnostics("credential", "session");
    expect(s.pinSessionDate(key, "session", "2026-08-01", 0)).toBe("2026-08-01");
    expect(s.pinSessionDate(key, "session", "2026-08-02", 0)).toBe("2026-08-01");
    s.expireEntryForTest(key);
    s.beginDiagnostics("credential", "session");
    expect(s.pinSessionDate(key, "session", "2026-08-02", 0)).toBe("2026-08-02");
    expect(s.pinSessionDate("unknown-key", "", "2026-08-03", 0)).toBe("2026-08-03");
  });

  test("PinClaudeSessionDateRetentionSurvivesContinuityTTLAndCredentialSwitch", () => {
    const c = clock();
    const s = new ClaudeContinuityStore(c.now);
    const retention = 7 * DAY;
    const keyA = s.beginDiagnostics("credential-a", "session").key;
    expect(s.pinSessionDate(keyA, "session", "2026-08-01", retention)).toBe("2026-08-01");
    s.expireEntryForTest(keyA);
    s.beginDiagnostics("credential-a", "session");
    expect(s.pinSessionDate(keyA, "session", "2026-08-02", retention)).toBe("2026-08-01");
    const keyB = s.beginDiagnostics("credential-b", "session").key;
    expect(s.pinSessionDate(keyB, "session", "2026-08-02", retention)).toBe("2026-08-01");
    s.deleteEntryForTest(keyA);
    s.deleteEntryForTest(keyB);
    s.expireForTest(false, -1000);
    const keyC = s.beginDiagnostics("credential-c", "session").key;
    expect(s.pinSessionDate(keyC, "session", "2026-08-02", retention)).toBe("2026-08-02");
  });
});

describe("executor diagnostics (claude_executor_diagnostics.go)", () => {
  test("InjectClaudeDiagnosticsMatchesNativeFieldOrderAndContinuity", () => {
    const s = new ClaudeContinuityStore();
    const body = `{"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"max_tokens":1,"messages":[]}`;
    const auth = newAuth({ id: "credential-diagnostics-order", provider: "claude" });
    const first = injectClaudeDiagnostics(s, body, auth, "session-diagnostics-order");
    expect(first.body).toContain(`"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"diagnostics":{"previous_message_id":null},"max_tokens"`);
    expect(JSON.parse(first.body).diagnostics.previous_message_id).toBeNull();
    s.commitDiagnostics(first.state.key, first.state.sequence, "msg_01ABCDEF0123456789ABCDEFG");
    const second = injectClaudeDiagnostics(s, body, auth, "session-diagnostics-order");
    expect(JSON.parse(second.body).diagnostics.previous_message_id).toBe("msg_01ABCDEF0123456789ABCDEFG");
  });

  test("ClaudeExecutorDiagnosticsAdvancesAfterSuccessfulResponse", async () => {
    const f = fakeFetch((_req, call) => messageResponse(`msg_diagnostics_${call}`));
    const auth = newAuth({
      id: "diagnostics-live-path",
      provider: "claude",
      attributes: { api_key: "sk-ant-oat-diagnostics-live-path", cloak_mode: "always" },
      metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] },
    });
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const req = { model: "claude-opus-5", payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"x"}],"max_tokens":16}`, format: "claude" as const };
    const opts = claudeOpts({ metadata: { execution_session_id: "diagnostics-conversation" } });
    await exec.execute(auth, req, opts);
    auth.attributes.api_key = "sk-ant-oat-diagnostics-live-path-rotated";
    await exec.execute(auth, req, opts);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]!.body).toContain(`"diagnostics":{"previous_message_id":null}`);
    expect(JSON.parse(f.requests[1]!.body).diagnostics.previous_message_id).toBe("msg_diagnostics_1");
    for (const r of f.requests) expect(r.headers.get("Anthropic-Beta") ?? "").toEndWith(`${claudeExtendedCacheTTLBeta},${claudeCacheDiagnosisBeta}`);
  });

  test("ClaudeMessageIDFromSSECommitsOnlyCompletedMessage", () => {
    const complete = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_complete"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    expect(claudeMessageIDFromSSE(complete)).toBe("msg_complete");
    expect(claudeMessageIDFromSSE(complete.replace(`event: message_stop\ndata: {"type":"message_stop"}\n\n`, ""))).toBe("");
  });

  test("ClaudeExecutorContinuityAdvancesRequestIDAndPromptIDInBillingHeader", async () => {
    const f = fakeFetch((_req, call) => messageResponse(`msg_turn_${call}`, "claude-sonnet-5", `req_upstream_turn_${call}`));
    const auth = newAuth({
      id: "continuity-test",
      provider: "claude",
      attributes: { api_key: "sk-ant-oat-continuity-test", cloak_mode: "always" },
      metadata: { account_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claude_device_ids: ["0".repeat(64)] },
    });
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const opts = claudeOpts({ metadata: { execution_session_id: "continuity-conv" } });
    const run = (payload: string, o = opts) => exec.execute(auth, { model: "claude-sonnet-5", payload, format: "claude" }, o);
    await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"turn 1 prompt"}],"max_tokens":100}`);
    await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"turn 1 prompt"},{"role":"assistant","content":"ok"},{"role":"user","content":"turn 2 prompt"}],"max_tokens":100}`);
    await run(
      `{"model":"claude-sonnet-5","messages":[{"role":"user","content":"turn 1 prompt"},{"role":"assistant","content":"ok"},{"role":"user","content":"turn 2 prompt"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"tool output"}]}],"max_tokens":100}`,
    );
    await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"probe"}],"max_tokens":1}`);
    await run(
      `{"model":"claude-sonnet-5","messages":[{"role":"user","content":"subagent prompt"}],"max_tokens":100}`,
      claudeOpts({ headers: new Headers({ "X-Claude-Code-Agent-Id": "subagent-worker-1" }), metadata: { execution_session_id: "continuity-subagent" } }),
    );
    await run(`{"model":"claude-sonnet-5","messages":[{"role":"user","content":"turn 5 prompt"}],"max_tokens":100}`);

    const billing = f.requests.map((r) => JSON.parse(r.body).system[0].text as string);
    expect(billing).toHaveLength(6);
    const tag = (h: string, prefix: string): string => {
      const idx = h.indexOf(prefix);
      if (idx < 0) return "";
      const v = h.slice(idx + prefix.length);
      return v.slice(0, v.indexOf(";") >= 0 ? v.indexOf(";") : undefined);
    };
    const [h1, h2, h2Tool, hProbe, hSub, h5] = billing as [string, string, string, string, string, string];
    expect(h1).toContain("cc_version=2.1.280.");
    expect(h1).toContain("cc_entrypoint=cli;");
    expect(h1).toContain("cch=");
    expect(h1).not.toContain("cc_prev_req=");
    expect(h1).toContain("cc_prompt_id=");
    expect(h2).toContain("cc_prev_req=req_upstream_turn_1;");
    expect(tag(h2, "cc_prompt_id=")).not.toBe(tag(h1, "cc_prompt_id="));
    expect(h2Tool).toContain("cc_prev_req=req_upstream_turn_2;");
    expect(tag(h2Tool, "cc_prompt_id=")).toBe(tag(h2, "cc_prompt_id="));
    expect(hProbe).not.toContain("cc_prev_req=");
    expect(hProbe).not.toContain("cc_prompt_id=");
    expect(hSub).toContain("cc_is_subagent=true;");
    expect(hSub).toContain("cc_prompt_id=");
    expect(h5).toContain("cc_prev_req=req_upstream_turn_3;");
    expect(h5).toContain("cc_prompt_id=");
  });
});

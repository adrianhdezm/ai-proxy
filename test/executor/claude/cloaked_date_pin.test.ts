// Ported from: internal/runtime/executor/claude_cloaked_date_pin_test.go
// Skipped cases: TestClaudeCloakedDateReminderProbeOverrideDoesNotReinitializeSessionDate is reduced: payload override
// rules are not ported, so it checks that an (unmodified) probe across midnight uses the current date instead of the
// session pin. The midnight flip is driven by the executor's injected clock with the credential timezone
// (Asia/Shanghai) instead of overriding claudeCodeCurrentTimeFunc.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { type ClaudeRequestContext, resolveClaudeContinuityTags } from "../../../src/executor/claude/billing.ts";
import { applyCloaking } from "../../../src/executor/claude/cloaking.ts";
import { ClaudeContinuityStore, newClaudeContinuityContext } from "../../../src/executor/claude/diagnostics.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeOpts, drain, fakeFetch, messageResponse } from "./helpers.ts";

function extractDate(body: string): string {
  const content = JSON.parse(body).messages[0].content;
  const texts = Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "") : [String(content)];
  for (const t of texts) {
    const m = /Today's date is (\d{4}-\d{2}-\d{2})/.exec(t);
    if (m) return m[1]!;
  }
  throw new Error(`no currentDate reminder found in first user message: ${body}`);
}

// 23:59 and 00:01 in Asia/Shanghai (UTC+8).
const beforeMidnight = Date.UTC(2026, 7, 1, 15, 59);
const afterMidnight = Date.UTC(2026, 7, 1, 16, 1);

/** JSON for non-stream requests, a minimal complete SSE stream for stream requests. */
function respond(req: { body: string }, call: number): Response {
  if (JSON.parse(req.body).stream !== true) return messageResponse(`msg_${call}`, "claude-opus-5", `req_upstream_${call}`);
  return new Response(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${call}","type":"message","model":"claude-opus-5","role":"assistant","content":[]}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "request-id": `req_upstream_${call}` },
  });
}

function oauth(id: string) {
  return newAuth({
    id,
    provider: "claude",
    attributes: { api_key: "sk-ant-oat-test-oauth-key-date-pin", cloak_mode: "always", timezone: "Asia/Shanghai" },
    metadata: { account_uuid: "11111111-2222-4333-8444-555555555555", claude_device_ids: ["0".repeat(62) + "d1"] },
  });
}

describe("cloaked currentDate session pin", () => {
  test("DateReminderPinnedToSessionAcrossMidnight", () => {
    let t = beforeMidnight;
    const store = new ClaudeContinuityStore(() => t);
    const auth = newAuth({ id: "test-date-pin-cred", provider: "claude", attributes: { timezone: "Asia/Shanghai" } });
    const rc: ClaudeRequestContext = { store, sessionID: "sess-midnight", hasExecutionMetadata: false, continuity: newClaudeContinuityContext(), workload: "", now: () => t, sessionDatePinRetentionMs: 0, timezone: "" };
    const payload1 = `{"model":"claude-opus-5","messages":[{"role":"user","content":"turn one"}]}`;
    const r1 = resolveClaudeContinuityTags(rc, auth, payload1, true, "", "")!;
    expect(r1).toBeDefined();
    expect(r1.continuity.pinnedDate).toBe("2026-08-01");
    const out1 = applyCloaking({}, newAuth({ id: "c", provider: "claude", metadata: { cloak_mode: "always" } }), payload1, "sk-ant-oat-x", false, { rc: { ...rc, continuity: newClaudeContinuityContext() } }).payload;
    expect(extractDate(out1)).toBe("2026-08-01");

    t = afterMidnight;
    expect(store.pinSessionDate(r1.continuity.key, "sess-midnight", "2026-08-02", 0)).toBe("2026-08-01");
    const payload2 = `{"model":"claude-opus-5","messages":[{"role":"user","content":"turn one"},{"role":"assistant","content":"ok"},{"role":"user","content":"turn two"}]}`;
    const r2 = resolveClaudeContinuityTags(rc, auth, payload2, true, "", "")!;
    expect(r2.continuity.pinnedDate).toBe("2026-08-01");
  });

  test("DateReminderSessionByteStability", async () => {
    let t = beforeMidnight;
    const f = fakeFetch(respond);
    const exec = createClaudeExecutor({ fetch: f.fetch, now: () => t });
    const auth = oauth("test-date-pin-exec-oauth");
    const payload = `{"model":"claude-opus-5","system":[{"type":"text","text":"You are an expert software engineer.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"Say OK."}],"max_tokens":100}`;
    const req = { model: "claude-opus-5", payload, format: "claude" as const };
    let opts = claudeOpts({ headers: new Headers({ "X-Session-ID": "date-pin-session-1" }) });
    await exec.execute(auth, req, opts);
    t = afterMidnight;
    await exec.execute(auth, req, opts);
    await drain(await exec.executeStream(auth, req, opts));
    const msg0 = f.requests.map((r) => JSON.stringify(JSON.parse(r.body).messages[0]));
    expect(msg0[1]).toBe(msg0[0]!);
    expect(msg0[2]).toBe(msg0[0]!);
    for (const r of f.requests) expect(extractDate(r.body)).toBe("2026-08-01");

    opts = claudeOpts({ headers: new Headers({ "X-Session-ID": "date-pin-session-2" }) });
    await exec.execute(auth, req, opts);
    expect(extractDate(f.requests[3]!.body)).toBe("2026-08-02");
  });

  test("DateReminderProbeDoesNotReuseSessionDate (reduced)", async () => {
    let t = beforeMidnight;
    const f = fakeFetch(respond);
    const exec = createClaudeExecutor({ fetch: f.fetch, now: () => t });
    const auth = oauth("test-date-pin-exec-oauth-declass");
    const opts = claudeOpts({ headers: new Headers({ "X-Session-ID": "declass-session-1" }) });
    await exec.execute(auth, { model: "claude-opus-5", payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"normal request"}],"max_tokens":100}`, format: "claude" }, opts);
    t = afterMidnight;
    const probe = `{"model":"claude-opus-5","messages":[{"role":"user","content":"probe"}],"max_tokens":1}`;
    await exec.execute(auth, { model: "claude-opus-5", payload: probe, format: "claude" }, opts);
    await drain(await exec.executeStream(auth, { model: "claude-opus-5", payload: probe, format: "claude" }, opts));
    expect(extractDate(f.requests[0]!.body)).toBe("2026-08-01");
    expect(extractDate(f.requests[1]!.body)).toBe("2026-08-02");
    expect(extractDate(f.requests[2]!.body)).toBe("2026-08-02");
  });
});

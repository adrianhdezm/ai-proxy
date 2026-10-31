// Ported from: internal/runtime/executor/claude_cloaked_cache_repro_test.go
// Skipped cases: TestClaudeCloakedOpenAIFormatPrefixStability (no OpenAI->Claude request translator is registered in
// this port's Claude executor tests). TestClaudeCloakedMultiTurnPrefixStability compares messages[1] as in Go; caller
// system prompts stay top-level in this port, so messages[1] is the earlier assistant turn rather than a relocated
// system message. Requests go to api.anthropic.com through an injected fetch.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { claudeBillingFingerprintMessageText, computeFingerprint } from "../../../src/executor/claude/billing.ts";
import { ClaudeContinuityStore } from "../../../src/executor/claude/diagnostics.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeOpts, drain, fakeFetch, messageResponse } from "./helpers.ts";

function oauth(id: string, key: string, extra: Record<string, string> = {}) {
  return newAuth({
    id,
    provider: "claude",
    attributes: { api_key: key, ...extra },
    metadata: { account_uuid: "11111111-2222-4333-8444-555555555555", claude_device_ids: ["0".repeat(63) + "1"] },
  });
}

function tag(header: string, prefix: string): string {
  const idx = header.indexOf(prefix);
  if (idx < 0) return "";
  const v = header.slice(idx + prefix.length);
  const end = v.indexOf(";");
  return end >= 0 ? v.slice(0, end) : v;
}

const systemPrompt = "You are an expert software engineer with deep knowledge of distributed systems...";

describe("billing fingerprint", () => {
  test("MultiTurnUsesFirstUserText", () => {
    const payload = `{"model":"claude-opus-5","system":"You are a helpful assistant.","messages":[{"role":"user","content":"initial conversation turn"},{"role":"assistant","content":"Understood."},{"role":"user","content":[{"type":"text","text":"<system-reminder>currentDate</system-reminder>"},{"type":"text","text":"second conversation turn"}]}]}`;
    expect(claudeBillingFingerprintMessageText(payload)).toBe("initial conversation turn");
  });

  test("EdgeCases", () => {
    expect(claudeBillingFingerprintMessageText(`{"messages":[]}`)).toBe("");
    expect(claudeBillingFingerprintMessageText(`{"messages":[{"role":"assistant","content":"hi"}]}`)).toBe("");
    expect(claudeBillingFingerprintMessageText(`{"messages":[{"role":"user","content":[{"type":"image"}]}]}`)).toBe("");
    expect(claudeBillingFingerprintMessageText(`{"messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>date</system-reminder>"}]}]}`)).toBe("");
    const multi = `{"messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>date</system-reminder>"},{"type":"text","text":"real user question"},{"type":"text","text":"additional context"}]}]}`;
    expect(claudeBillingFingerprintMessageText(multi)).toBe("real user question");
  });

  test("ComputeFingerprintUsesNativeUTF16Indices", () => {
    expect(computeFingerprint("😀abcdefghijklmnopqrstuvwxyz", "2.1.280")).toBe("dac");
    expect(computeFingerprint("abc😀abcdefghijklmnop", "2.1.280")).toBe("695");
  });
});

describe("cloaked prefix stability", () => {
  const payload1 = JSON.stringify({ model: "claude-opus-5", system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "Say OK." }], max_tokens: 100 });

  test("SingleTurnPrefixStability", async () => {
    const f = fakeFetch((_r, call) => messageResponse(`msg_${call}`, "claude-opus-5", `req_upstream_${call}`));
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const auth = oauth("test-cloaked-oauth", "sk-ant-oat-test-oauth-key");
    for (let i = 0; i < 2; i++) await exec.execute(auth, { model: "claude-opus-5", payload: payload1, format: "claude" }, claudeOpts());
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]!.body).toBe(f.requests[1]!.body);
  });

  test("SingleTurnPrefixStabilityWithPinnedSession", async () => {
    const f = fakeFetch((_r, call) => messageResponse(`msg_${call}`, "claude-opus-5", `req_upstream_${call}`));
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const auth = oauth("test-cloaked-oauth-pinned", "sk-ant-oat-test-oauth-key-pinned");
    const opts = claudeOpts({ headers: new Headers({ "X-Session-ID": "pinned-session-42" }) });
    for (let i = 0; i < 2; i++) await exec.execute(auth, { model: "claude-opus-5", payload: payload1, format: "claude" }, opts);
    expect(f.requests[0]!.body).toBe(f.requests[1]!.body);
  });

  test("MultiTurnPrefixStability", async () => {
    const f = fakeFetch((_r, call) => messageResponse(`msg_${call}`, "claude-opus-5", `req_upstream_${call}`));
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const auth = oauth("test-cloaked-multiturn-oauth", "sk-ant-oat-test-oauth-key-multiturn", { cloak_mode: "always" });
    const turns = [
      ["turn 0 user prompt", "Earlier response.", "turn 1 user prompt"],
      ["turn 0 user prompt", "Earlier response.", "turn 1 user prompt", "Understood.", "turn 2 user prompt with new question"],
      ["turn 0 user prompt", "Earlier response.", "turn 1 user prompt", "Understood.", "turn 2 user prompt with new question", "Here is the answer to question 2.", "turn 3 user prompt asking for more"],
    ].map((texts) =>
      JSON.stringify({
        model: "claude-opus-5",
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content })),
        max_tokens: 100,
      }),
    );
    const run = (payload: string) => exec.execute(auth, { model: "claude-opus-5", payload, format: "claude" }, claudeOpts());
    await run(turns[0]!);
    await run(turns[1]!);
    const [b1, b2] = f.requests.map((r) => JSON.parse(r.body));
    const sys1 = b1.system[0].text as string;
    const sys2 = b2.system[0].text as string;
    expect(tag(sys1, "cc_version=")).toBe(tag(sys2, "cc_version="));
    expect(JSON.stringify(b1.system[1])).toBe(JSON.stringify(b2.system[1]));
    expect(JSON.stringify(b1.messages[0])).toBe(JSON.stringify(b2.messages[0]));
    expect(JSON.stringify(b1.messages[1])).toBe(JSON.stringify(b2.messages[1]));
    const prompt1 = tag(sys1, "cc_prompt_id=");
    expect(prompt1).not.toBe("");
    expect(tag(sys2, "cc_prompt_id=")).toBe(prompt1);
    expect(sys1).not.toContain("cc_prev_req=");
    expect(sys2).not.toContain("cc_prev_req=");

    await run(turns[1]!);
    expect(f.requests[2]!.body).toBe(f.requests[1]!.body);

    await run(turns[2]!);
    await run(turns[2]!);
    const sys3 = JSON.parse(f.requests[3]!.body).system[0].text as string;
    expect(tag(sys3, "cc_version=")).toBe(tag(sys1, "cc_version="));
    expect(tag(sys3, "cc_prompt_id=")).toBe(prompt1);
    expect(sys3).not.toContain("cc_prev_req=");
    expect(f.requests[4]!.body).toBe(f.requests[3]!.body);
  });

  test("StreamingPrefixStability", async () => {
    const f = fakeFetch(
      (_r, call) =>
        new Response(
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${call}","type":"message","model":"claude-opus-5","role":"assistant","content":[]}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream", "request-id": `req_upstream_${call}` } },
        ),
    );
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const auth = oauth("test-cloaked-stream-oauth", "sk-ant-oat-test-stream-oauth-key");
    const payload = `{"model":"claude-opus-5","system":[{"type":"text","text":"system instructions","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"Say OK."}],"max_tokens":100}`;
    for (let i = 0; i < 2; i++) await drain(await exec.executeStream(auth, { model: "claude-opus-5", payload, format: "claude" }, claudeOpts({ stream: true })));
    expect(f.requests[0]!.body).toBe(f.requests[1]!.body);
  });

  test("ToolContinuationPreservesExplicitPromptID", async () => {
    const f = fakeFetch((_r, call) => messageResponse(`msg_${call}`, "claude-opus-5", `req_upstream_${call}`));
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const auth = oauth("test-cloaked-explicit-prompt-oauth", "sk-ant-oat-test-explicit-prompt-key", { cloak_mode: "always" });
    const opts = claudeOpts({ headers: new Headers({ "Session-Id": "sess-explicit-tool-1" }) });
    const explicit = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await exec.execute(
      auth,
      { model: "claude-opus-5", payload: `{"model":"claude-opus-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.258.000; cc_entrypoint=cli; cch=00000; cc_prompt_id=${explicit};"}],"messages":[{"role":"user","content":"run tool"}]}`, format: "claude" },
      opts,
    );
    await exec.execute(
      auth,
      {
        model: "claude-opus-5",
        payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"run tool"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}]}`,
        format: "claude",
      },
      opts,
    );
    expect(tag(JSON.parse(f.requests[1]!.body).system[0].text, "cc_prompt_id=")).toBe(explicit);
  });

  test("ColdStartToolContinuationUsesDeterministicPromptID", async () => {
    const f = fakeFetch((_r, call) =>
      call === 1
        ? new Response(`{"error":{"type":"api_error","message":"temporary failure"}}`, { status: 500, headers: { "Content-Type": "application/json", "request-id": `req_upstream_${call}` } })
        : messageResponse(`msg_${call}`, "claude-opus-5", `req_upstream_${call}`),
    );
    const exec = createClaudeExecutor({ fetch: f.fetch, continuityStore: new ClaudeContinuityStore() });
    const auth = oauth("test-cloaked-cold-start-tool-oauth", "sk-ant-oat-test-cold-start-key", { cloak_mode: "always" });
    const payload = `{"model":"claude-opus-5","messages":[{"role":"user","content":"run tool"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}]}`;
    await exec.execute(auth, { model: "claude-opus-5", payload, format: "claude" }, claudeOpts()).catch(() => undefined);
    await exec.execute(auth, { model: "claude-opus-5", payload, format: "claude" }, claudeOpts());
    const p1 = tag(JSON.parse(f.requests[0]!.body).system[0].text, "cc_prompt_id=");
    const p2 = tag(JSON.parse(f.requests[1]!.body).system[0].text, "cc_prompt_id=");
    expect(p1).not.toBe("");
    expect(p1).toBe(p2);
  });
});

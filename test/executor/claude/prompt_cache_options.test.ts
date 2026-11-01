// Ported from: internal/runtime/executor/claude_prompt_cache_options_test.go
// Skipped cases: every Go case sends an OpenAI chat-completions body (SourceFormat "openai"), whose inbound translator is
// not ported; the cases below send the Claude Messages body that translator would produce (system prompt in the
// top-level system array, function tools as Claude tools, text parts as content arrays) and keep the assertions.
// The Go ClaudeKey cloak entries become the cloak_mode credential attribute. Dropped:
// TestClaudeExecutor_CountTokensUpstream_StripsPromptCacheOptions_EvenWithPayloadRule (payload config rules not ported),
// TestClaudeExecutor_PromptCacheOptionsMode_Explicit_Cloaked_LegacyModelPreservesClientSystemBreakpoint and
// TestClaudeExecutor_CountTokensUpstream_Cloaked_LegacyModel_ExplicitPreservesClientSystemBreakpoint (legacy-model
// system reminders: caller system prompts are not relocated into the first user turn), and
// TestClaudeExecutor_CountTokensUpstream_OAuthRelocatesAffectedSystemPrompts (relocation of OAuth caller system prompts
// into mid-conversation system turns is not ported). TestClaudeExecutor_CountTokens_StripsPromptCacheOptions checks the
// one upstream count_tokens call (count tokens is never estimated locally here).
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { countCacheControls } from "../../../src/executor/claude/cache_control.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeOpts, drain, startUpstream } from "./helpers.ts";

const sse =
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","usage":{"input_tokens":1,"output_tokens":1}}}\n\n` +
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n` +
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n` +
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

const upstream = startUpstream((req) => {
  if (req.path.endsWith("/count_tokens")) return new Response(`{"input_tokens": 15}`, { headers: { "Content-Type": "application/json" } });
  if (JSON.parse(req.body).stream) return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  return new Response(`{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-3-5-sonnet","usage":{"input_tokens":1,"output_tokens":1}}`, {
    headers: { "Content-Type": "application/json" },
  });
});
afterAll(() => upstream.stop());

const model = "claude-3-5-sonnet-20241022";
const auth = (cloaked = false) => newAuth({ id: "", provider: "claude", attributes: { api_key: "key-123", base_url: upstream.url, ...(cloaked ? { cloak_mode: "always" } : {}) } });
const explicit = `"prompt_cache_options":{"mode":"explicit"}`;
const text = (t: string, cc?: string) => `{"type":"text","text":${JSON.stringify(t)}${cc ? `,"cache_control":${cc}` : ""}}`;
const user = (...parts: string[]) => `{"role":"user","content":[${parts.join(",")}]}`;

async function run(payload: string, opts: { cloaked?: boolean; stream?: boolean; countTokens?: boolean } = {}): Promise<{ raw: string; body: any }> {
  const exec = createClaudeExecutor();
  const req = { model, payload, format: "claude" as const };
  const options = claudeOpts({ stream: !!opts.stream, originalRequest: payload });
  if (opts.countTokens) await exec.countTokens(auth(opts.cloaked), req, options);
  else if (opts.stream) await drain(await exec.executeStream(auth(opts.cloaked), req, options));
  else await exec.execute(auth(opts.cloaked), req, options);
  const raw = upstream.requests[upstream.requests.length - 1]!.body;
  return { raw, body: JSON.parse(raw) };
}

describe("prompt_cache_options", () => {
  test("PromptCacheOptionsMode_Explicit_SuppressesAutoCacheControl", async () => {
    const { raw, body } = await run(`{"model":"${model}",${explicit},"system":[${text("You are a helpful assistant.")}],"messages":[${user(text("Hello"))}]}`);
    expect(countCacheControls(raw)).toBe(0);
    expect(body.prompt_cache_options).toBeUndefined();
  });

  test("PromptCacheOptionsMode_Explicit_PreservesClientBreakpoints", async () => {
    const { raw, body } = await run(
      `{"model":"${model}",${explicit},"system":[${text("You are a helpful assistant.")}],"messages":[${user(text("Cached part", `{"type":"ephemeral"}`))},${user(text("Uncached part"))}]}`,
    );
    expect(countCacheControls(raw)).toBe(1);
    expect(body.messages[0].content[0].cache_control).toBeDefined();
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toBeUndefined();
  });

  test("PromptCacheOptionsMode_Stream_Explicit_SuppressesAutoCacheControl", async () => {
    const { raw, body } = await run(`{"model":"${model}","stream":true,${explicit},"messages":[${user(text("Stream query"))}]}`, { stream: true });
    expect(countCacheControls(raw)).toBe(0);
    expect(body.prompt_cache_options).toBeUndefined();
  });

  for (const [name, options] of [
    ["missing prompt_cache_options", ""],
    ["mode implicit", `"prompt_cache_options":{"mode":"implicit"},`],
  ] as const) {
    test(`PromptCacheOptionsMode_ImplicitOrMissing_PreservesAutoCacheControl/${name}`, async () => {
      const { body } = await run(`{"model":"${model}",${options}"system":[${text("You are helpful.")}],"messages":[${user(text("Hello"))}]}`);
      expect(body.system[0].cache_control).toBeDefined();
      expect(body.messages[0].content[0].cache_control).toBeDefined();
    });
  }

  const tool = (name: string, cc?: string) => `{"name":"${name}","description":"${name === "tool1" ? "t1" : "t2"}","input_schema":{"type":"object"}${cc ? `,"cache_control":${cc}` : ""}}`;

  test("PromptCacheOptionsMode_Explicit_ToolsFallbackSuppressed", async () => {
    const { raw } = await run(`{"model":"${model}",${explicit},"tools":[${tool("tool1")},${tool("tool2")}],"messages":[${user(text("Hello without system"))}]}`);
    expect(countCacheControls(raw)).toBe(0);
  });

  test("PromptCacheOptionsMode_Explicit_ClientToolBreakpointPreserved", async () => {
    const { raw, body } = await run(`{"model":"${model}",${explicit},"tools":[${tool("tool1", `{"type":"ephemeral"}`)},${tool("tool2")}],"messages":[${user(text("Hello"))}]}`);
    expect(countCacheControls(raw)).toBe(1);
    expect(body.tools[0].cache_control).toBeDefined();
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
  });

  test("PromptCacheOptionsMode_Explicit_Cloaked_SuppressesAllAutoCacheControl", async () => {
    const { raw, body } = await run(`{"model":"${model}",${explicit},"system":[${text("You are a helpful assistant.")}],"messages":[${user(text("Hello in cloaked mode"))}]}`, { cloaked: true });
    expect(countCacheControls(raw)).toBe(0);
    expect(body.prompt_cache_options).toBeUndefined();
  });

  test("PromptCacheOptionsMode_Explicit_Cloaked_PreservesClientBreakpoints", async () => {
    const { raw, body } = await run(
      `{"model":"${model}",${explicit},"system":[${text("You are a helpful assistant.")}],"messages":[${user(text("First turn"))},{"role":"assistant","content":[${text("Understood.")}]},${user(text("Specific cached user query", `{"type":"ephemeral"}`))}]}`,
      { cloaked: true },
    );
    expect(countCacheControls(raw)).toBe(1);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.messages[2].content[0].cache_control).toBeDefined();
  });

  test("PromptCacheOptionsMode_Explicit_Cloaked_PreservesClientSystemBreakpoint", async () => {
    const { raw, body } = await run(
      `{"model":"${model}",${explicit},"system":[${text("Special client system prompt with breakpoint", `{"type":"ephemeral","scope":"global"}`)}],"messages":[${user(text("Regular user query"))}]}`,
      { cloaked: true },
    );
    expect(countCacheControls(raw)).toBe(1);
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    const found = (body.system as any[]).some((p) => p.text === "Special client system prompt with breakpoint" && p.cache_control?.type === "ephemeral" && p.cache_control?.scope === "global");
    expect(found).toBe(true);
  });

  test("CountTokens_StripsPromptCacheOptions", async () => {
    const { body } = await run(`{"model":"${model}",${explicit},"messages":[${user(text("How many tokens?"))}]}`, { countTokens: true });
    expect(body.prompt_cache_options).toBeUndefined();
  });

  test("PromptCacheOptionsMode_Explicit_ProbePreservesClient1hTTL", async () => {
    const { body } = await run(`{"model":"${model}",${explicit},"messages":[${user(text("Hi", `{"type":"ephemeral","ttl":"1h"}`))}]}`);
    expect(body.messages[0].content[0].cache_control.ttl).toBe("1h");
  });

  test("CountTokensUpstream_Cloaked_ExplicitPreservesClientSystemBreakpoint", async () => {
    const { raw, body } = await run(
      `{"model":"${model}",${explicit},"system":[${text("Count tokens system instructions", `{"type":"ephemeral","scope":"global"}`)}],"messages":[${user(text("Count tokens user message"))}]}`,
      { cloaked: true, countTokens: true },
    );
    expect(countCacheControls(raw)).toBe(1);
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    const found = (body.system as any[]).some((p) => p.text === "Count tokens system instructions" && p.cache_control?.type === "ephemeral" && p.cache_control?.scope === "global");
    expect(found).toBe(true);
  });
});

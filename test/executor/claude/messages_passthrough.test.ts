// Ported from: internal/runtime/executor/claude_messages_passthrough_test.go
// Skipped cases: none (the Go round-tripper on context is replaced by ClaudeExecutorConfig.fetch).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { applyClaudeCloakThinkingDisplay, applyCloaking, claudeCodeCLIIdentity } from "../../../src/executor/claude/cloaking.ts";
import { type FetchLike, createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { anthropicMessagesURL, claudeOAuthTestMetadata, claudeOpts, headersFor } from "./helpers.ts";

const oauthKey = "sk-ant-oat-direct-messages-test";
const apiKey = "sk-ant-api03-direct-messages-test";
const directOAuthAuth = (extra: Record<string, string> = {}) => newAuth({ id: "direct-oauth", provider: "claude", attributes: { api_key: oauthKey, ...extra }, metadata: claudeOAuthTestMetadata() });
const directAPIKeyAuth = (extra: Record<string, string> = {}) => newAuth({ id: "direct-key", provider: "claude", attributes: { api_key: apiKey, ...extra } });
const piHeaders = (betas?: string) => {
  const h = new Headers({ "User-Agent": "pi (darwin; arm64)" });
  if (betas) h.set("Anthropic-Beta", betas);
  return h;
};

/** A fetch stand-in that records the request and answers with a minimal Messages response. */
function recordingFetch(): { fetch: FetchLike; seen: { url: string; headers: Headers; body: string }[] } {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    seen.push({ url: input, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(`{"id":"msg_direct","type":"message","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`, { headers: { "Content-Type": "application/json" } });
  };
  return { fetch, seen };
}

describe("direct Messages passthrough", () => {
  test("ApplyClaudeCloak_DirectMessagesPreservesCallerBody", () => {
    const payload = `{"model":"claude-opus-5-5","system":[{"type":"text","text":"caller system"}],"thinking":{"type":"adaptive","display":"summarized"},"tools":[{"name":"caller_tool"}],"messages":[{"role":"user","content":"hello"}]}`;
    const got = applyCloaking({}, directOAuthAuth({ cloak_mode: "never" }), payload, oauthKey, false);
    expect(got.cloaked).toBe(false);
    expect(got.payload).toBe(payload);
  });

  test("ApplyClaudeHeaders_DirectMessagesPreservesCallerFingerprint", () => {
    const incoming = piHeaders("caller-beta-2099-01-01");
    const h = headersFor({ url: anthropicMessagesURL, auth: directAPIKeyAuth(), apiKey, stream: false, body: `{"model":"claude-opus-5-5","thinking":{"type":"adaptive","display":"summarized"}}`, incomingHeaders: incoming, confirmedClaudeCode: false });
    expect(h.get("User-Agent")).toBe("pi (darwin; arm64)");
    expect(h.get("Anthropic-Beta")).toBe("caller-beta-2099-01-01");
    expect(h.get("X-App")).toBeNull();
  });

  test("ClaudeExecutor_DirectMessagesOfficialUpstreamPreservesCallerShape", async () => {
    const { fetch, seen } = recordingFetch();
    const payload = `{"model":"claude-opus-5-5","system":[{"type":"text","text":"caller system","cache_control":{"type":"ephemeral"}}],"thinking":{"type":"adaptive","display":"summarized"},"tools":[{"name":"caller_tool","description":"caller tool","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hello"}],"max_tokens":32}`;
    await createClaudeExecutor({ fetch }).execute(directAPIKeyAuth({ base_url: "https://api.anthropic.com" }), { model: "claude-opus-5-5", payload, format: "claude" }, claudeOpts({ headers: piHeaders("caller-beta-2099-01-01") }));
    const req = seen[0]!;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(req.headers.get("x-api-key")).toBe(apiKey);
    expect(req.headers.get("User-Agent")).toBe("pi (darwin; arm64)");
    expect(req.headers.get("Anthropic-Beta")).toBe("caller-beta-2099-01-01");
    const body = JSON.parse(req.body);
    expect(body.system).toHaveLength(1);
    expect(body.system.some((b: { text: string }) => b.text === claudeCodeCLIIdentity)).toBe(false);
    expect(body.thinking.display).toBe("summarized");
    expect(body.tools[0].name).toBe("caller_tool");
    expect(body.messages[0].content?.[0]?.cache_control).toBeUndefined();
  });

  test("ApplyClaudeHeaders_DirectMessagesAPIKeyPreservesExactCallerBetas", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: directAPIKeyAuth(), apiKey, stream: false, body: `{"model":"claude-opus-5-5","thinking":{"type":"adaptive","display":"summarized"}}`, incomingHeaders: piHeaders("caller-beta-2099-01-01"), confirmedClaudeCode: false });
    expect(h.get("Anthropic-Beta")).toBe("caller-beta-2099-01-01");
  });

  test("ApplyClaudeHeaders_DirectMessagesOAuthInjectsOAuthBetaWhenEmpty", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: directOAuthAuth(), apiKey: oauthKey, stream: false, body: `{"model":"claude-opus-5-5","thinking":{"type":"adaptive","display":"summarized"}}`, incomingHeaders: piHeaders(), confirmedClaudeCode: false });
    const betas = h.get("Anthropic-Beta") ?? "";
    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("claude-code-20250219");
  });

  test("ClaudeExecutor_PreserveCallerFingerprintAlignsSessionIDWithBody", async () => {
    const { fetch, seen } = recordingFetch();
    const incoming = new Headers({ "User-Agent": "pi (darwin; arm64)", "X-Claude-Code-Session-Id": "forged-session-a", "X-Claude-Code-Request-Class": "forged-class" });
    const payload = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hello"}],"max_tokens":32}`;
    await createClaudeExecutor({ fetch }).execute(directOAuthAuth({ base_url: "https://api.anthropic.com" }), { model: "claude-opus-5-5", payload, format: "claude" }, claudeOpts({ headers: incoming }));
    const req = seen[0]!;
    const headerSession = req.headers.get("X-Claude-Code-Session-Id") ?? "";
    expect(headerSession).not.toBe("forged-session-a");
    expect(headerSession).not.toBe("");
    const userID = JSON.parse(JSON.parse(req.body).metadata.user_id);
    expect(userID.session_id).toBe(headerSession);
    expect(req.headers.get("X-Claude-Code-Request-Class")).toBeNull();
  });

  for (const tc of [
    { name: "opus adaptive", body: `{"model":"claude-opus-5-5","thinking":{"type":"adaptive"}}`, want: "updates" },
    { name: "fable enabled", body: `{"model":"claude-fable-5-1","thinking":{"type":"enabled"}}`, want: "updates" },
    { name: "sonnet adaptive", body: `{"model":"claude-sonnet-5","thinking":{"type":"adaptive"}}`, want: "updates" },
    { name: "explicit summarized", body: `{"model":"claude-opus-5-5","thinking":{"type":"adaptive","display":"summarized"}}`, want: "summarized" },
    { name: "explicit omitted", body: `{"model":"claude-sonnet-5","thinking":{"type":"adaptive","display":"omitted"}}`, want: "omitted" },
    { name: "disabled", body: `{"model":"claude-opus-5-5","thinking":{"type":"disabled"}}`, want: undefined },
    { name: "legacy model", body: `{"model":"claude-opus-4-6","thinking":{"type":"adaptive"}}`, want: undefined },
  ]) {
    test(`ApplyClaudeCloakThinkingDisplay/${tc.name}`, () => {
      expect(JSON.parse(applyClaudeCloakThinkingDisplay(tc.body, false)).thinking.display).toBe(tc.want);
    });
  }
});

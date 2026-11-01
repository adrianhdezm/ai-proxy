// Ported from: internal/runtime/executor/claude_executor_subagent_ttl_regression_test.go
// Skipped cases: none. The ClaudeKey config entries of the Go tests carry no settings that matter here and are
// omitted; the streaming variants drain the stream.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeOAuthTestMetadata, claudeOpts, drain, jsonResponse, okMessage, sseResponse, withUpstream } from "./helpers.ts";

const sse = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;

function payloadWith(text: string, ttl1h: boolean): string {
  const cc = ttl1h ? `{"type":"ephemeral","ttl":"1h"}` : `{"type":"ephemeral"}`;
  return `{"model":"claude-sonnet-5","messages":[{"role":"user","content":[{"type":"text","text":"${text}","cache_control":${cc}}]}]}`;
}

async function run(opts: { oauth: boolean; stream: boolean; ttl1h: boolean; betas: string; agent: string }): Promise<{ body: string; betas: string }> {
  return withUpstream(
    () => (opts.stream ? sseResponse(sse) : jsonResponse(okMessage("claude-sonnet-5"))),
    async (upstream) => {
      const key = opts.oauth ? "sk-ant-oat-subagent-test" : "sk-ant-api03-subagent-key-test";
      const auth = opts.oauth
        ? newAuth({ id: "auth-subagent", provider: "claude", metadata: claudeOAuthTestMetadata(), attributes: { api_key: key, base_url: upstream.url } })
        : newAuth({ id: "auth-subagent-key", provider: "claude", attributes: { api_key: key, base_url: upstream.url } });
      const headers = new Headers({ "User-Agent": "claude-cli/2.1.281 (external, cli)", "X-Claude-Code-Agent-Id": opts.agent, "Anthropic-Beta": opts.betas });
      const req = { model: "claude-sonnet-5", payload: payloadWith("subagent work", opts.ttl1h), format: "claude" as const };
      if (opts.stream) await drain(await createClaudeExecutor().executeStream(auth, req, claudeOpts({ headers, stream: true })));
      else await createClaudeExecutor().execute(auth, req, claudeOpts({ headers }));
      const seen = upstream.requests[0]!;
      return { body: seen.body, betas: seen.headers.get("Anthropic-Beta") ?? "" };
    },
  );
}

function every1h(body: string): boolean {
  for (const msg of JSON.parse(body).messages) for (const block of Array.isArray(msg.content) ? msg.content : []) if (block.cache_control && block.cache_control.ttl !== "1h") return false;
  return true;
}

describe("subagent cache TTL regression (#5629)", () => {
  for (const stream of [false, true]) {
    const suffix = stream ? "_Stream" : "";
    test(`SubagentPreserves1hTTLAndExtendedCacheBetaWhenRequested${suffix}`, async () => {
      const { body, betas } = await run({ oauth: true, stream, ttl1h: true, betas: "claude-code-20250219,oauth-2025-04-20,extended-cache-ttl-2025-04-11", agent: "agent-sub-123" });
      expect(body).toContain(`"ttl":"1h"`);
      expect(every1h(body)).toBe(true);
      expect(betas).toContain("extended-cache-ttl-2025-04-11");
    });

    test(`APIKeySubagentPreserves1hTTLAndInjectsBeta${suffix}`, async () => {
      const { body, betas } = await run({ oauth: false, stream, ttl1h: true, betas: "claude-code-20250219", agent: "agent-sub-apikey-101" });
      expect(body).toContain(`"ttl":"1h"`);
      expect(betas).toContain("extended-cache-ttl-2025-04-11");
    });
  }

  test("SubagentWithout1hKeepsDefault5m", async () => {
    const { body, betas } = await run({ oauth: true, stream: false, ttl1h: false, betas: "claude-code-20250219,oauth-2025-04-20", agent: "agent-sub-default-789" });
    expect(body).not.toContain(`"ttl":"1h"`);
    expect(betas).not.toContain("extended-cache-ttl-2025-04-11");
  });
});

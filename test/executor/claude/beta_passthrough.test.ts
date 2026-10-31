// Ported from: internal/runtime/executor/claude_executor_beta_passthrough_test.go
// Skipped cases: none (the fingerprint_profile=claude-code-cli fixture stays; the Go gin context is replaced by incomingHeaders).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { anthropicMessagesURL, headersFor } from "./helpers.ts";

const fixtureKey = ["test", "fixture", "key"].join("-");
const fixtureAuth = () => newAuth({ id: "fixture", provider: "claude", attributes: { api_key: fixtureKey, fingerprint_profile: "claude-code-cli" } });

describe("claude beta passthrough", () => {
  test("ForwardsUnmanagedCallerBetas", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: fixtureAuth(), apiKey: fixtureKey, stream: false, body: `{"model":"claude-fable-5-1"}`, incomingHeaders: new Headers({ "Anthropic-Beta": "message-threads-2026-08-12" }), confirmedClaudeCode: false });
    const betas = h.get("Anthropic-Beta") ?? "";
    expect(betas).toContain("message-threads-2026-08-12");
    expect(betas).toContain("mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24");
  });

  test("StillGatesManagedCallerBetas", () => {
    const h = headersFor({ url: anthropicMessagesURL, auth: fixtureAuth(), apiKey: fixtureKey, stream: false, body: `{"model":"claude-haiku-4-5"}`, incomingHeaders: new Headers({ "Anthropic-Beta": "effort-2025-11-24" }), confirmedClaudeCode: false });
    expect(h.get("Anthropic-Beta") ?? "").not.toContain("effort-2025-11-24");
  });

  for (const tt of [
    { name: "confirmed main", requestClass: "main", confirmed: true },
    { name: "confirmed auxiliary", requestClass: "auxiliary", confirmed: true },
    { name: "unconfirmed caller", requestClass: "main", confirmed: false },
  ]) {
    test(`PreservesNativeGatewayHintsOnly/${tt.name}`, () => {
      const incoming: Record<string, string> = {
        "x-claude-code-request-class": tt.requestClass,
        "x-claude-code-agent-type": "builtin",
        "x-claude-code-prev-tool-durations": "5",
        "x-claude-code-compaction": "false",
        "x-claude-code-context-compacted": "false",
      };
      const h = headersFor({ url: "https://api.anthropic.com/v1/messages", auth: fixtureAuth(), apiKey: fixtureKey, stream: false, body: `{"model":"claude-opus-5-5"}`, incomingHeaders: new Headers(incoming), confirmedClaudeCode: tt.confirmed });
      for (const [key, value] of Object.entries(incoming)) {
        expect(h.get(key) ?? "").toBe(tt.confirmed ? value : "");
      }
    });
  }

  test("ForwardsUnmanagedCallerBetas_OAuth", () => {
    const auth = newAuth({ id: "claude-oauth-fixture", provider: "claude", metadata: { access_token: "sk-ant-oat-fixture" } });
    const body = `{
      "model": "claude-fable-5-1",
      "max_tokens": 16,
      "messages": [
        {"role": "user",   "content": "hi"},
        {"role": "system", "content": [], "output_config": {"effort": "low"}},
        {"role": "user",   "content": "say ok"}
      ]
    }`;
    const h = headersFor({ url: anthropicMessagesURL, auth, apiKey: "sk-ant-oat-fixture", stream: false, body, incomingHeaders: new Headers({ "Anthropic-Beta": "message-threads-2026-08-12,mid-conversation-system-2026-04-07" }), confirmedClaudeCode: false });
    const betas = h.get("Anthropic-Beta") ?? "";
    expect(betas).toContain("message-threads-2026-08-12");
    expect(betas).toContain("mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01");
  });
});

// Ported from: internal/runtime/executor/codex_executor_claude_effort_test.go
// Skipped cases: the "final override wins" and "final filter is not restored" rows (payload config rules are not
// ported); the "standalone effort preserved" row runs for both stream modes. Kept beside the Claude executor tests
// because it pins the Claude-inbound output_config.effort mapping; it only drives the Codex executor.
import { afterAll, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import { claudeOpts, drain, startUpstream } from "./helpers.ts";

const upstream = startUpstream(
  () =>
    new Response(
      `data: {"type":"response.completed","response":{"id":"resp_effort","object":"response","status":"completed","model":"gpt-6.1-sol","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ),
);
afterAll(() => upstream.stop());

for (const stream of [false, true]) {
  test(`CodexExecutorClaudeStandaloneEffortFinalPayload/standalone effort preserved/stream=${stream}`, async () => {
    const auth = newAuth({ id: "codex-oauth", provider: "codex", attributes: { base_url: upstream.url }, metadata: { type: "codex", access_token: "oauth-token", account_id: "acct" } });
    const req = {
      model: "gpt-6.1-sol",
      payload: `{"model":"gpt-6.1-sol","max_tokens":256,"messages":[{"role":"user","content":"Reply exactly OK."}],"output_config":{"effort":"high"}}`,
      format: "claude" as const,
    };
    const executor = new CodexExecutor();
    const before = upstream.requests.length;
    if (stream) await drain(await executor.executeStream(auth, req, claudeOpts({ stream: true })));
    else await executor.execute(auth, req, claudeOpts());
    expect(upstream.requests.length).toBe(before + 1);
    expect(JSON.parse(upstream.requests[upstream.requests.length - 1]!.body).reasoning?.effort).toBe("high");
  });
}

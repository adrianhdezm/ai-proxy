// Ported from: internal/runtime/executor/claude_executor_cloaking_display_test.go
// Skipped cases: the "payload display stays operator owned" and "payload deletion is not refilled" rows of
// TestReconcileClaudeCloakDisplayAfterThinkingOverride (payload config rules are not ported). The simplified cloak
// writes thinking.display only after the thinking override has run, so reconcileClaudeCodeFableModelAfterPayload has
// no TypeScript counterpart; these cases assert the same outcomes on the executor's cloaked request body.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeOAuthTestMetadata, claudeOpts, jsonResponse, lastBody, withUpstream } from "./helpers.ts";

async function cloakedThinking(model: string, thinking: string): Promise<Record<string, unknown> | undefined> {
  return withUpstream(
    () => jsonResponse(`{"id":"msg_1","type":"message","model":"${model}","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`),
    async (upstream) => {
      const auth = newAuth({ id: "cloak-display", provider: "claude", attributes: { base_url: upstream.url }, metadata: { access_token: "sk-ant-oat-display", ...claudeOAuthTestMetadata() } });
      const payload = `{"model":"${model}","max_tokens":4096,"thinking":${thinking},"messages":[{"role":"user","content":"hi"}]}`;
      await createClaudeExecutor().execute(auth, { model, payload, format: "claude" }, claudeOpts());
      return lastBody(upstream).thinking;
    },
  );
}

describe("cloak thinking display", () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1"]) {
    test(`${model}: disabled thinking gets no synthetic display`, async () => {
      // Models that cannot disable thinking are mapped to adaptive + display "omitted" by src/thinking;
      // either way the cloak must not add its synthetic "updates" display.
      expect((await cloakedThinking(model, `{"type":"disabled"}`))?.display).not.toBe("updates");
    });
    test(`${model}: adaptive thinking gets the synthetic updates display`, async () => {
      expect((await cloakedThinking(model, `{"type":"adaptive"}`))?.display).toBe("updates");
    });
    test(`${model}: caller display stays caller owned`, async () => {
      expect((await cloakedThinking(model, `{"type":"adaptive","display":"summarized"}`))?.display).toBe("summarized");
    });
  }

  test("RemovesSyntheticDisplayForNonProgressModel", async () => {
    expect((await cloakedThinking("claude-opus-4-8", `{"type":"adaptive"}`))?.display).toBeUndefined();
  });
});

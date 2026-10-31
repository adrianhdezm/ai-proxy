// Ported from: internal/runtime/executor/claude_thinking_replay_test.go
// Skipped cases: the "other provider" row of TestClaudeThinkingReplayEnabledRequiresCompatClaudeAPIKey uses
// provider "kimi" as in Go (kept: it only checks the provider gate). Each test uses its own replay cache instead of
// clearing the process-wide one.
import { describe, expect, test } from "bun:test";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import { ClaudeThinkingReplayCache } from "../../../src/cache/claude_thinking_replay_cache.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { ClaudeResolvedModelInfoMetadataKey, claudeThinkingReplayEnabled, claudeThinkingReplayScopeFromRequest } from "../../../src/executor/claude/thinking_replay.ts";
import type { ExecOptions, ExecRequest } from "../../../src/executor/types.ts";
import { drain, jsonResponse, sseResponse, withUpstream } from "./helpers.ts";

function replayAuth(baseURL: string): Auth {
  return newAuth({ id: "claude-replay-auth", provider: "claude", attributes: { api_key: "key-claude-replay", auth_kind: "apikey", base_url: baseURL } });
}

function replayRequest(payload: string, sessionID: string, isCompat: boolean, source = "claude"): [ExecRequest, ExecOptions] {
  return [
    { model: "claude-synthetic-4772", payload, format: "claude", metadata: { [ClaudeResolvedModelInfoMetadataKey]: { isCompat } } },
    { stream: false, sourceFormat: source, metadata: { execution_session_id: sessionID } },
  ];
}

describe("claudeThinkingReplayEnabled", () => {
  const [baseReq, baseOpts] = replayRequest(`{"messages":[]}`, "scope", true);
  const baseAuth = replayAuth("http://127.0.0.1");
  const cases: Array<[string, Auth, ExecRequest, ExecOptions, boolean]> = [
    ["compat Claude API key", baseAuth, baseReq, baseOpts, true],
    ["non compat model", baseAuth, replayRequest(`{"messages":[]}`, "scope-non-compat", false)[0], baseOpts, false],
    ["OAuth credential", newAuth({ id: "o", provider: "claude", attributes: { api_key: "sk-ant-oat-replay", auth_kind: "oauth" } }), baseReq, baseOpts, false],
    ["other provider", newAuth({ id: "k", provider: "kimi", attributes: { api_key: "key-claude-replay", auth_kind: "apikey" } }), baseReq, baseOpts, false],
    ["OpenAI source format", baseAuth, baseReq, { ...baseOpts, sourceFormat: "openai" }, false],
  ];
  for (const [name, auth, req, opts, want] of cases) test(name, () => expect(claudeThinkingReplayEnabled(auth, req, opts)).toBe(want));
});

const toolUseAssistant = (id: string, path: string) => `{"role":"assistant","content":[{"type":"tool_use","id":"${id}","name":"Read","input":{"path":"${path}"}}]}`;

describe("compat thinking replay on the executor", () => {
  test("RestoresOmittedBlock", async () => {
    let call = 0;
    await withUpstream(
      () =>
        ++call === 1
          ? jsonResponse(`{"id":"msg-1","type":"message","role":"assistant","model":"claude-synthetic-4772","content":[{"type":"thinking","thinking":"provider reasoning","signature":"EgI="},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"path":"README.md"}}],"stop_reason":"tool_use"}`)
          : jsonResponse(`{"id":"msg-2","type":"message","role":"assistant","model":"claude-synthetic-4772","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}`),
      async (upstream) => {
        const exec = createClaudeExecutor({ thinkingReplayCache: new ClaudeThinkingReplayCache() });
        const auth = replayAuth(upstream.url);
        await exec.execute(auth, ...replayRequest(`{"messages":[{"role":"user","content":"inspect"}]}`, "nonstream-replay", true));
        const second = `{"messages":[{"role":"user","content":"inspect"},${toolUseAssistant("toolu_1", "README.md")},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`;
        await exec.execute(auth, ...replayRequest(second, "nonstream-replay", true));
        expect(upstream.requests).toHaveLength(2);
        const content = JSON.parse(upstream.requests[1]!.body).messages[1].content;
        expect(content).toHaveLength(2);
        expect(content[0].type).toBe("thinking");
        expect(content[0].signature).toBe("EgI=");
      },
    );
  });

  test("RestoresOmittedBlockInStream", async () => {
    const thinkingStream =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","content":[]}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"provider reasoning"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EgI="}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    let call = 0;
    await withUpstream(
      () =>
        ++call === 1
          ? sseResponse(thinkingStream)
          : sseResponse(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg-2","type":"message","role":"assistant","content":[]}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`),
      async (upstream) => {
        const exec = createClaudeExecutor({ thinkingReplayCache: new ClaudeThinkingReplayCache() });
        const auth = replayAuth(upstream.url);
        await drain(await exec.executeStream(auth, ...replayRequest(`{"messages":[{"role":"user","content":"inspect"}]}`, "stream-replay", true)));
        const second = `{"messages":[{"role":"user","content":"inspect"},${toolUseAssistant("toolu_1", "README.md")},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`;
        await drain(await exec.executeStream(auth, ...replayRequest(second, "stream-replay", true)));
        const content = JSON.parse(upstream.requests[1]!.body).messages[1].content;
        expect(content).toHaveLength(2);
        expect(content[0].type).toBe("thinking");
        expect(content[0].signature).toBe("EgI=");
      },
    );
  });

  test("ClearsAfterUpstreamBadRequest", async () => {
    let call = 0;
    await withUpstream(
      () =>
        ++call === 1
          ? jsonResponse(`{"id":"msg-1","type":"message","role":"assistant","model":"claude-synthetic-4772","content":[{"type":"thinking","thinking":"reasoning","signature":"EgI="},{"type":"tool_use","id":"toolu-1","name":"Read","input":{"path":"README.md"}}],"stop_reason":"tool_use"}`)
          : jsonResponse(`{"type":"error","error":{"type":"invalid_request_error","message":"invalid thinking signature"}}`, 400),
      async (upstream) => {
        const cache = new ClaudeThinkingReplayCache();
        const exec = createClaudeExecutor({ thinkingReplayCache: cache });
        const auth = replayAuth(upstream.url);
        const [firstReq, firstOpts] = replayRequest(`{"messages":[{"role":"user","content":"inspect"}]}`, "bad-request-replay", true);
        await exec.execute(auth, firstReq, firstOpts);
        const second = `{"messages":[{"role":"user","content":"inspect"},${toolUseAssistant("toolu-1", "README.md")},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"ok"}]}]}`;
        await expect(exec.execute(auth, ...replayRequest(second, "bad-request-replay", true))).rejects.toThrow();
        const scope = claudeThinkingReplayScopeFromRequest(auth, firstReq, firstOpts);
        expect(cache.get(scope.modelFamily, scope.sessionKey).found).toBe(false);
      },
    );
  });

  test("RestoresMultipleOmittedBlocks", async () => {
    let call = 0;
    await withUpstream(
      () => {
        call++;
        if (call === 1) return jsonResponse(`{"id":"msg-1","type":"message","role":"assistant","model":"claude-synthetic-4772","content":[{"type":"thinking","thinking":"first","signature":"EgI="},{"type":"tool_use","id":"toolu-1","name":"Read","input":{"path":"one"}}],"stop_reason":"tool_use"}`);
        if (call === 2) return jsonResponse(`{"id":"msg-2","type":"message","role":"assistant","model":"claude-synthetic-4772","content":[{"type":"thinking","thinking":"second","signature":"EgM="},{"type":"tool_use","id":"toolu-2","name":"Read","input":{"path":"two"}}],"stop_reason":"tool_use"}`);
        return jsonResponse(`{"id":"msg-3","type":"message","role":"assistant","model":"claude-synthetic-4772","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}`);
      },
      async (upstream) => {
        const exec = createClaudeExecutor({ thinkingReplayCache: new ClaudeThinkingReplayCache() });
        const auth = replayAuth(upstream.url);
        const s = "multi-turn-replay";
        await exec.execute(auth, ...replayRequest(`{"messages":[{"role":"user","content":"inspect"}]}`, s, true));
        const turn1 = `{"role":"user","content":"inspect"},${toolUseAssistant("toolu-1", "one")},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-1","content":"one result"}]}`;
        await exec.execute(auth, ...replayRequest(`{"messages":[${turn1}]}`, s, true));
        await exec.execute(auth, ...replayRequest(`{"messages":[${turn1},${toolUseAssistant("toolu-2", "two")},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu-2","content":"two result"}]}]}`, s, true));
        expect(upstream.requests).toHaveLength(3);
        const messages = JSON.parse(upstream.requests[2]!.body).messages;
        expect(messages[1].content).toHaveLength(2);
        expect(messages[1].content[0]).toMatchObject({ type: "thinking", signature: "EgI=" });
        expect(messages[3].content).toHaveLength(2);
        expect(messages[3].content[0]).toMatchObject({ type: "thinking", signature: "EgM=" });
      },
    );
  });
});

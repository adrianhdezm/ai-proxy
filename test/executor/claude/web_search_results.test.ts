// Ported from: internal/runtime/executor/claude_executor_web_search_results_test.go
// Skipped cases: TestClaudeExecutor_WebSearchResultRestoreRunsBeforePayloadRules (payload config rules are not
//   ported). Adaptations: the cache config is the ClaudeExecutorConfig.webSearchResultCache option (Go:
//   client.codex.web-search-result-cache; the YAML field is wired by the config slice) and every scenario uses a
//   private cache instead of clearing the process-wide one; TestClaudeExecutor_CountTokensRestoresWebSearchResultsWhenEnabled
//   checks the restored content in the count_tokens upstream body instead of comparing local token estimates
//   (local estimation is not ported).
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth, type Auth } from "../../../src/auth/types.ts";
import { ClaudeWebSearchResultCache } from "../../../src/cache/claude_web_search_result_cache.ts";
import { ClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import type { ClaudeWebSearchResultCacheConfig } from "../../../src/executor/claude/web_search_results.ts";
import type { ExecOptions } from "../../../src/executor/types.ts";
import { startUpstream } from "./helpers.ts";

const results = `[{"type":"web_search_result","url":"https://example.com/a","title":"A","encrypted_content":"enc-a","page_age":null},{"type":"web_search_result","url":"https://example.com/b","title":"B","encrypted_content":"enc-b","page_age":null}]`;

/** Answers the first request with a native web search and later ones with plain text (Go: claudeWebSearchUpstream). */
const upstream = startUpstream((req) => {
  if (req.path.endsWith("/count_tokens")) return Response.json({ input_tokens: req.body.length });
  let blocks = [`{"type":"text","text":"done"}`];
  if (!req.body.includes(`"web_search_tool_result"`)) {
    blocks = [
      `{"type":"server_tool_use","id":"srvtoolu_01abc","name":"web_search","input":{"query":"q"}}`,
      `{"type":"web_search_tool_result","tool_use_id":"srvtoolu_01abc","content":${results}}`,
      `{"type":"text","text":"found two pages"}`,
    ];
  }
  if (!(JSON.parse(req.body) as { stream?: boolean }).stream) {
    return new Response(`{"id":"msg_ws","type":"message","role":"assistant","model":"claude-opus-5-5","content":[${blocks.join(",")}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":5}}`, {
      headers: { "Content-Type": "application/json" },
    });
  }
  const events = [`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ws","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}`];
  blocks.forEach((block, index) => {
    const isText = block.includes(`"type":"text"`);
    events.push(`event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":${isText ? `{"type":"text","text":""}` : block}}`);
    if (isText) events.push(`event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":${JSON.stringify((JSON.parse(block) as { text: string }).text)}}}`);
    events.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}`);
  });
  events.push(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`, `event: message_stop\ndata: {"type":"message_stop"}`);
  return new Response(events.join("\n\n") + "\n\n", { headers: { "Content-Type": "text/event-stream" } });
});
afterAll(() => upstream.stop());

const user = `{"type":"message","role":"user","content":[{"type":"input_text","text":"search for q"}]}`;
// The history as Codex stores it: the web_search_call has no results.
const history =
  user +
  `,{"type":"web_search_call","id":"ws_srvtoolu_01abc","status":"completed","action":{"type":"search","query":"q"}},` +
  `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"found two pages"}]},` +
  `{"type":"message","role":"user","content":[{"type":"input_text","text":"how many results?"}]}`;

const enabled: ClaudeWebSearchResultCacheConfig = { enabled: true, ttlMs: 30 * 60_000, limit: 16 };

interface Run {
  sessionID: string;
  input: string;
  auth?: { id?: string; apiKey?: string };
}

function authFor(run: Run): Auth {
  return newAuth({ id: run.auth?.id ?? (run.auth ? "" : "claude-cred-default"), provider: "claude", attributes: { api_key: run.auth?.apiKey ?? "key-web-search", base_url: upstream.url } });
}

function optionsFor(run: Run, stream: boolean, payload: string): ExecOptions {
  const opts: ExecOptions = { stream, sourceFormat: "openai-response", responseFormat: "openai-response", originalRequest: payload };
  if (run.sessionID !== "") opts.metadata = { execution_session_id: run.sessionID };
  return opts;
}

async function scenario(config: ClaudeWebSearchResultCacheConfig | undefined, stream: boolean, runs: Run[]): Promise<string[]> {
  const before = upstream.requests.length;
  const executor = new ClaudeExecutor({ webSearchResultCache: config, webSearchResultStore: new ClaudeWebSearchResultCache() });
  for (const run of runs) {
    const payload = `{"model":"claude-opus-5-5","stream":${stream},"input":[${run.input}]}`;
    const req = { model: "claude-opus-5-5", payload, format: "openai-response" };
    if (!stream) {
      await executor.execute(authFor(run), req, optionsFor(run, stream, payload));
      continue;
    }
    const result = await executor.executeStream(authFor(run), req, optionsFor(run, stream, payload));
    for await (const _chunk of result.chunks) {
      // drain
    }
  }
  return upstream.requests.slice(before).map((r) => r.body);
}

/** The raw content of the first web_search_tool_result block (Go: claudeWebSearchResultContent). */
function resultContent(body: string): string {
  const root = JSON.parse(body) as { messages: Array<{ content: unknown }> };
  for (const message of root.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === "web_search_tool_result") return JSON.stringify(block.content);
    }
  }
  throw new Error(`no web_search_tool_result block in upstream body: ${body}`);
}

for (const stream of [false, true]) {
  const mode = stream ? "stream" : "non-stream";
  describe(mode, () => {
    test("TestClaudeExecutor_RestoresWebSearchResultsDroppedByResponsesClient", async () => {
      const bodies = await scenario(enabled, stream, [
        { sessionID: "session-ws", input: user },
        { sessionID: "session-ws", input: history },
        { sessionID: "other-session", input: history },
        { sessionID: "", input: history },
      ]);
      expect(bodies).toHaveLength(4);
      expect(resultContent(bodies[1]!)).toBe(results);
      expect(resultContent(bodies[2]!)).toBe("[]");
      expect(resultContent(bodies[3]!)).toBe("[]");
    });

    test("TestClaudeExecutor_WebSearchResultCacheDisabledByDefault", async () => {
      const bodies = await scenario(undefined, stream, [
        { sessionID: "session-ws", input: user },
        { sessionID: "session-ws", input: history },
      ]);
      expect(bodies).toHaveLength(2);
      expect(resultContent(bodies[1]!)).toBe("[]");
    });

    test("TestClaudeExecutor_WebSearchResultCacheScopesByCredential", async () => {
      const credA = { id: "claude-cred-a" };
      const credB = { id: "claude-cred-b" };
      const keyA = { apiKey: "key-a" };
      const keyB = { apiKey: "key-b" };
      const bodies = await scenario(enabled, stream, [
        { sessionID: "session-ws", auth: credA, input: user },
        { sessionID: "session-ws", auth: credB, input: history },
        { sessionID: "session-ws", auth: credA, input: history },
        { sessionID: "session-key", auth: keyA, input: user },
        { sessionID: "session-key", auth: keyB, input: history },
        { sessionID: "session-key", auth: keyA, input: history },
      ]);
      expect(bodies).toHaveLength(6);
      expect(resultContent(bodies[1]!)).toBe("[]");
      expect(resultContent(bodies[2]!)).toBe(results);
      expect(resultContent(bodies[4]!)).toBe("[]");
      expect(resultContent(bodies[5]!)).toBe(results);
    });
  });
}

test("TestClaudeExecutor_WebSearchResultCacheHonorsConfiguredLimit", async () => {
  const bodies = await scenario({ enabled: true, ttlMs: 1800_000, limit: 1 }, false, [
    { sessionID: "session-1", input: user },
    { sessionID: "session-2", input: user },
    { sessionID: "session-1", input: history },
    { sessionID: "session-2", input: history },
  ]);
  expect(bodies).toHaveLength(4);
  // Limit is 1, so session-2's search result evicted session-1's entry.
  expect(resultContent(bodies[2]!)).toBe("[]");
  expect(resultContent(bodies[3]!)).toBe(results);
});

test("TestClaudeExecutor_CountTokensRestoresWebSearchResultsWhenEnabled", async () => {
  const store = new ClaudeWebSearchResultCache();
  const enabledExec = new ClaudeExecutor({ webSearchResultCache: enabled, webSearchResultStore: store });
  const disabledExec = new ClaudeExecutor({ webSearchResultStore: store });
  const auth = authFor({ sessionID: "", input: "" });
  const first = `{"model":"claude-opus-5-5","stream":false,"input":[${user}]}`;
  await enabledExec.execute(auth, { model: "claude-opus-5-5", payload: first, format: "openai-response" }, optionsFor({ sessionID: "session-count", input: "" }, false, first));

  const historyPayload = `{"model":"claude-opus-5-5","stream":false,"input":[${history}]}`;
  const historyOpts: ExecOptions = { ...optionsFor({ sessionID: "session-count", input: "" }, false, historyPayload), responseFormat: "claude" };
  const req = { model: "claude-opus-5-5", payload: historyPayload, format: "openai-response" };
  const countBody = async (ex: ClaudeExecutor, a: Auth): Promise<string> => {
    const before = upstream.requests.length;
    await ex.countTokens(a, req, historyOpts);
    return upstream.requests.slice(before).find((r) => r.path.endsWith("/count_tokens"))!.body;
  };
  expect(resultContent(await countBody(enabledExec, auth))).toBe(results);
  expect(resultContent(await countBody(disabledExec, auth))).toBe("[]");
  const otherAuth = newAuth({ id: "other-cred", provider: "claude", attributes: { api_key: "key-other", base_url: upstream.url } });
  expect(resultContent(await countBody(enabledExec, otherAuth))).toBe("[]");
});

// Ported from: internal/runtime/executor/codex_executor_reasoning_replay_cache_test.go
// Skipped cases: none. Adaptations: every test injects its own CodexReasoningReplayCache (Go: the global cache cleared
//   per test); fake upstreams are fetch stubs; TestCodexExecutorReasoningReplayCacheSharesSameSessionAcrossClientKeys has
//   no gin context carrying a client API key here (the session key never reads one for Claude inbound), so it checks the
//   scope and the replay are the same for two independent derivations; the openai-response cases check that a non-Claude
//   inbound request neither receives nor stores replay items.
import { describe, expect, test } from "bun:test";
import { CodexReasoningReplayCache } from "../../../src/cache/codex_reasoning_replay_cache.ts";
import {
  CodexExecutor,
  CodexReplayPrefixFingerprints,
  ExecutionSessionMetadataKey,
  applyCodexReasoningReplayCache,
  cacheCodexReasoningReplayFromCompleted,
  codexReasoningReplayScopeFromRequest,
  codexReasoningReplaySessionKey,
  codexReasoningReplaySessionKeyFromHeaders,
  codexReasoningReplaySessionKeyFromPayload,
  codexReplayInputPrefixFingerprint,
  type CodexReasoningReplayScope,
} from "../../../src/executor/codex/index.ts";
import type { ExecOptions, ExecRequest } from "../../../src/executor/types.ts";
import { sha256Hex } from "../../../src/util/hash.ts";
import { apiKeyAuth, drain, getString, getValue, options, sseResponse, stubFetch } from "./helpers.ts";

/** Go: validCodexReasoningEncryptedContentForTestSeed. */
function validEncrypted(seed: number): string {
  const payload = new Uint8Array(1 + 8 + 16 + 16 + 32);
  payload[0] = 0x80;
  for (let i = 9; i < payload.length; i++) payload[i] = (seed + i) & 0xff;
  return Buffer.from(payload).toString("base64url");
}

/** Go: shortenedCodexReplayCallIDForTest. */
function shortenedCallID(id: string): string {
  const limit = 64;
  if (id.length <= limit) return id;
  const suffix = "_" + sha256Hex(id).slice(0, 16);
  const prefixLen = limit - suffix.length;
  return prefixLen <= 0 ? suffix.slice(suffix.length - limit) : id.slice(0, prefixLen) + suffix;
}

function reasoningItem(encrypted: string): string {
  return `{"type":"reasoning","summary":[],"content":null,"encrypted_content":"${encrypted}"}`;
}

function claudeSessionPayload(session: string, messages: string, extra = ""): string {
  return `{"model":"gpt-5.4","metadata":{"user_id":"{\\"device_id\\":\\"device-test\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"${session}\\"}"},"messages":${messages}${extra}}`;
}

const claude = "claude";
const claudeReq = (payload: string, model = "gpt-5.4"): ExecRequest => ({ model, payload, format: "claude" });
const claudeOpts = (extra: Partial<ExecOptions> = {}): ExecOptions => ({ stream: false, sourceFormat: claude, ...extra }) as ExecOptions;

/** An executor on a fetch stub that answers every request with `stream` and records the bodies. */
function harness(stream: string) {
  const cache = new CodexReasoningReplayCache();
  const { fetch, calls } = stubFetch(() => sseResponse(stream));
  const executor = new CodexExecutor({ fetch, reasoningReplayCache: cache });
  return { cache, executor, bodies: () => calls.map((c) => c.body) };
}

const completedEmpty = `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt-5.4","output":[]}}` + "\n\n";

test("TestCodexExecutorReasoningReplayCacheStoresFinalDoneAndInjectsNextClaudeRequest", async () => {
  const added = validEncrypted(1);
  const done = validEncrypted(2);
  const { executor, bodies } = harness(
    `data: {"type":"response.output_item.added","item":{"id":"rs_added","type":"reasoning","status":"in_progress","summary":[],"encrypted_content":"${added}"},"output_index":0}\n` +
      `data: {"type":"response.output_item.done","item":{"id":"rs_done","type":"reasoning","summary":[],"encrypted_content":"${done}"},"output_index":0}\n` +
      `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt-5.4","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`,
  );
  await executor.execute(apiKeyAuth(""), claudeReq(claudeSessionPayload("session-1", `[{"role":"user","content":[{"type":"text","text":"hello"}]}]`)), claudeOpts());
  await executor.execute(apiKeyAuth(""), claudeReq(claudeSessionPayload("session-1", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`)), claudeOpts());
  expect(bodies().length).toBe(2);
  const second = bodies()[1]!;
  expect(getString(second, "input.0.type")).toBe("reasoning");
  expect(getString(second, "input.0.encrypted_content")).toBe(done);
  expect(getString(second, "input.1.role")).toBe("user");
});

test("TestCodexExecutorReasoningReplayCacheSharesSameSessionAcrossClientKeys", () => {
  const cache = new CodexReasoningReplayCache();
  const req = claudeReq(claudeSessionPayload("session-only", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`));
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`;
  const encrypted = validEncrypted(11);
  const first = codexReasoningReplayScopeFromRequest(claude, req, claudeOpts(), body);
  expect(first.sessionKey).toBe("claude:session-only:agent:main");
  cacheCodexReasoningReplayFromCompleted(cache, first, `{"response":{"output":[${reasoningItem(encrypted)}]}}`);
  const second = applyCodexReasoningReplayCache(cache, claude, req, claudeOpts(), body);
  expect(second.scope).toEqual(first);
  expect(getString(second.body, "input.0.type")).toBe("reasoning");
  expect(getString(second.body, "input.0.encrypted_content")).toBe(encrypted);
});

test("TestCodexExecutorReasoningReplaySessionKeyUsesClaudeCodeJSONSessionID", () => {
  const req = claudeReq(`{
    "model":"gpt-5.4",
    "metadata":{"user_id":"{\\"device_id\\":\\"device-a\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"session-json-1\\"}"},
    "messages":[{"role":"user","content":[{"type":"text","text":"next"}]}]
  }`);
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`;
  expect(codexReasoningReplaySessionKey(claude, req, claudeOpts(), body)).toBe("claude:session-json-1:agent:main");
});

test("TestCodexExecutorReasoningReplaySessionKeyIsolatesClaudeCodeAgents", () => {
  const req = claudeReq(`{"model":"local-alias","messages":[{"role":"user","content":"next"}]}`, "local-alias-high");
  const body = `{"model":"gpt-5.4","prompt_cache_key":"shared-client-key","input":[{"type":"message","role":"user","content":"next"}]}`;
  const rootHeaders = new Headers({ "X-Claude-Code-Session-Id": "session-agents" });
  const childA = new Headers(rootHeaders);
  childA.set("X-Claude-Code-Agent-Id", "agent-a");
  const childB = new Headers(rootHeaders);
  childB.set("X-Claude-Code-Agent-Id", "agent-b");
  const metadata = { [ExecutionSessionMetadataKey]: "shared-execution-session" };
  const scopes = [rootHeaders, childA, childB].map((headers) => codexReasoningReplayScopeFromRequest(claude, req, claudeOpts({ headers, metadata }), body));
  for (const scope of scopes) expect(scope.modelName).toBe("gpt-5.4");
  expect(new Set(scopes.map((s) => s.sessionKey)).size).toBe(3);
});

test("TestCodexExecutorReasoningReplaySessionKeyRejectsBareClaudeUserID", () => {
  const req = claudeReq(`{"model":"gpt-5.4","metadata":{"user_id":"same-user-across-chats"},"messages":[{"role":"user","content":[{"type":"text","text":"next"}]}]}`);
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`;
  expect(codexReasoningReplaySessionKey(claude, req, claudeOpts(), body)).toBe("");
});

test("TestCodexExecutorReasoningReplaySessionKeyCanonicalizesSessionHeaderAliases", () => {
  const keys = ["Session_id", "session_id", "Session-Id"].map((name) => codexReasoningReplaySessionKeyFromHeaders(new Headers({ [name]: "session-alias" })));
  expect(new Set(keys).size).toBe(1);
  expect(keys[2]).toBe("session-id:session-alias");
});

test("TestCodexExecutorReasoningReplaySessionKeyCanonicalizesWindowHeaderWithPayload", () => {
  const fromPayload = codexReasoningReplaySessionKeyFromPayload(`{"client_metadata":{"x-codex-window-id":"window-1"}}`);
  const fromHeader = codexReasoningReplaySessionKeyFromHeaders(new Headers({ "X-Codex-Window-Id": "window-1" }));
  expect(fromPayload).toBe(fromHeader);
  expect(fromHeader).toBe("window:window-1");
});

test("TestCodexExecutorReasoningReplayCacheSharesSameSessionAcrossCodexAuths", async () => {
  const encrypted = validEncrypted(12);
  const { executor, bodies } = harness(
    `data: {"type":"response.output_item.done","item":{"id":"rs_done","type":"reasoning","summary":[],"encrypted_content":"${encrypted}"},"output_index":0}\n` + completedEmpty,
  );
  await executor.execute(apiKeyAuth("", "test-a"), claudeReq(claudeSessionPayload("session-auth-switch", `[{"role":"user","content":[{"type":"text","text":"hello"}]}]`)), claudeOpts());
  await executor.execute(apiKeyAuth("", "test-b"), claudeReq(claudeSessionPayload("session-auth-switch", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`)), claudeOpts());
  const second = bodies()[1]!;
  expect(getString(second, "input.0.type")).toBe("reasoning");
  expect(getString(second, "input.0.encrypted_content")).toBe(encrypted);
});

test("TestCodexExecutorReasoningReplayCacheDoesNotInjectNativeResponsesRequest", async () => {
  const { cache, executor, bodies } = harness(completedEmpty);
  cache.cacheItem("gpt-5.4", "prompt-cache:native-session", reasoningItem(validEncrypted(3)));
  await executor.execute(
    apiKeyAuth(""),
    { model: "gpt-5.4", payload: `{"model":"gpt-5.4","prompt_cache_key":"native-session","input":[{"role":"user","content":"native"}]}`, format: "openai-response" },
    options("openai-response", false),
  );
  expect(getString(bodies()[0]!, "input.0.type")).not.toBe("reasoning");
  expect(getString(bodies()[0]!, "input.0.role")).toBe("user");
});

test("TestCodexExecutorReasoningReplayCacheDoesNotStoreNativeResponsesRequest", async () => {
  const { cache, executor } = harness(
    `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt-5.4","output":[{"id":"rs_native","type":"reasoning","summary":[],"encrypted_content":"${validEncrypted(4)}"}]}}\n\n`,
  );
  await executor.execute(
    apiKeyAuth(""),
    { model: "gpt-5.4", payload: `{"model":"gpt-5.4","prompt_cache_key":"native-store","input":[{"role":"user","content":"native"}]}`, format: "openai-response" },
    options("openai-response", false),
  );
  expect(cache.getItem("gpt-5.4", "prompt-cache:native-store")).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("TestCodexExecutorReasoningReplayCacheDoesNotDuplicateClaudeClientReasoning", async () => {
  const cached = validEncrypted(5);
  const client = validEncrypted(6);
  const { cache, executor, bodies } = harness(completedEmpty);
  cache.cacheItem("gpt-5.4", "claude:session-2:agent:main", reasoningItem(cached));
  await executor.execute(
    apiKeyAuth(""),
    claudeReq(
      claudeSessionPayload(
        "session-2",
        `[{"role":"assistant","content":[{"type":"thinking","thinking":"client summary","signature":"${client}"},{"type":"text","text":"answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]`,
      ),
    ),
    claudeOpts(),
  );
  const body = bodies()[0]!;
  expect(getString(body, "input.0.encrypted_content")).toBe(client);
  const input = getValue(body, "input") as Array<{ type?: string }>;
  expect(input.filter((item) => item.type === "reasoning").length).toBe(1);
});

test("TestCodexExecutorReasoningReplayCacheInsertsReasoningBeforeAssistantOutputInClaudeHistory", async () => {
  const cached = validEncrypted(7);
  const { cache, executor, bodies } = harness(completedEmpty);
  cache.cacheItem("gpt-5.4", "claude:session-history:agent:main", reasoningItem(cached));
  await executor.execute(
    apiKeyAuth(""),
    claudeReq(
      claudeSessionPayload(
        "session-history",
        `[{"role":"user","content":[{"type":"text","text":"first"}]},{"role":"assistant","content":[{"type":"text","text":"answer"}]},{"role":"user","content":[{"type":"text","text":"next"}]}]`,
      ),
    ),
    claudeOpts(),
  );
  const body = bodies()[0]!;
  expect(getString(body, "input.0.role")).toBe("user");
  expect(getString(body, "input.1.type")).toBe("reasoning");
  expect(getString(body, "input.1.encrypted_content")).toBe(cached);
  expect(getString(body, "input.2.role")).toBe("assistant");
  expect(getString(body, "input.3.role")).toBe("user");
});

test("TestCodexExecutorReasoningReplayCacheExecuteStreamStoresFinalDoneForClaude", async () => {
  const added = validEncrypted(7);
  const done = validEncrypted(8);
  const { executor, bodies } = harness(
    `data: {"type":"response.output_item.added","item":{"id":"rs_added","type":"reasoning","status":"in_progress","summary":[],"encrypted_content":"${added}"},"output_index":0}\n` +
      `data: {"type":"response.output_item.done","item":{"id":"rs_done","type":"reasoning","summary":[],"encrypted_content":"${done}"},"output_index":0}\n` +
      completedEmpty,
  );
  const result = await executor.executeStream(
    apiKeyAuth(""),
    claudeReq(claudeSessionPayload("stream-session-1", `[{"role":"user","content":[{"type":"text","text":"hello"}]}]`)),
    claudeOpts({ stream: true }),
  );
  const { error } = await drain(result);
  expect(error).toBeUndefined();
  await executor.execute(apiKeyAuth(""), claudeReq(claudeSessionPayload("stream-session-1", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`)), claudeOpts());
  expect(getString(bodies()[1]!, "input.0.encrypted_content")).toBe(done);
});

test("TestCodexExecutorReasoningReplayCacheExecuteStreamStoresFinalDoneForClaude (bootstrap buffering)", async () => {
  const done = validEncrypted(18);
  const cache = new CodexReasoningReplayCache();
  const { fetch, calls } = stubFetch(() =>
    sseResponse(`data: {"type":"response.output_item.done","item":{"id":"rs_done","type":"reasoning","summary":[],"encrypted_content":"${done}"},"output_index":0}\n` + completedEmpty),
  );
  const executor = new CodexExecutor({ fetch, reasoningReplayCache: cache, streamBootstrapBuffering: true });
  const payload = (text: string) => claudeSessionPayload("stream-session-buffered", `[{"role":"user","content":[{"type":"text","text":"${text}"}]}]`);
  const { error } = await drain(await executor.executeStream(apiKeyAuth(""), claudeReq(payload("hello")), claudeOpts({ stream: true })));
  expect(error).toBeUndefined();
  await drain(await executor.executeStream(apiKeyAuth(""), claudeReq(payload("next")), claudeOpts({ stream: true })));
  expect(getString(calls[1]!.body, "input.0.encrypted_content")).toBe(done);
});

describe("invalid signature clears the session", () => {
  const failed = `data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"message":"Invalid signature in thinking block","type":"invalid_request_error","code":"invalid_request_error"}}}` + "\n\n";

  test("TestCodexExecutorReasoningReplayCacheClearsOnNonStreamResponseFailedInvalidSignature", async () => {
    const { cache, executor } = harness(failed);
    cache.cacheItem("gpt-5.4", "claude:session-invalid-nonstream:agent:main", reasoningItem(validEncrypted(9)));
    await expect(
      executor.execute(apiKeyAuth(""), claudeReq(claudeSessionPayload("session-invalid-nonstream", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`)), claudeOpts()),
    ).rejects.toBeDefined();
    expect(cache.getItem("gpt-5.4", "claude:session-invalid-nonstream:agent:main")).toBeUndefined();
  });

  test("TestCodexExecutorReasoningReplayCacheClearsOnStreamResponseFailedInvalidSignature", async () => {
    const { cache, executor } = harness(failed);
    cache.cacheItem("gpt-5.4", "claude:session-invalid-stream:agent:main", reasoningItem(validEncrypted(10)));
    const result = await executor.executeStream(
      apiKeyAuth(""),
      claudeReq(claudeSessionPayload("session-invalid-stream", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`)),
      claudeOpts({ stream: true }),
    );
    const { error } = await drain(result);
    expect(error).toBeDefined();
    expect(cache.getItem("gpt-5.4", "claude:session-invalid-stream:agent:main")).toBeUndefined();
  });

  test("an HTTP 400 invalid-signature rejection clears it too", async () => {
    const cache = new CodexReasoningReplayCache();
    const { fetch } = stubFetch(
      () => new Response(`{"error":{"message":"Invalid signature in thinking block","type":"invalid_request_error"}}`, { status: 400, headers: { "Content-Type": "application/json" } }),
    );
    const executor = new CodexExecutor({ fetch, reasoningReplayCache: cache });
    cache.cacheItem("gpt-5.4", "claude:session-invalid-http:agent:main", reasoningItem(validEncrypted(19)));
    await expect(
      executor.executeStream(apiKeyAuth(""), claudeReq(claudeSessionPayload("session-invalid-http", `[{"role":"user","content":"next"}]`)), claudeOpts({ stream: true })),
    ).rejects.toBeDefined();
    expect(cache.getItem("gpt-5.4", "claude:session-invalid-http:agent:main")).toBeUndefined();
  });
});

const toolSchema = `,"tools":[{"name":"lookup","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}}]`;

test("TestCodexExecutorReasoningReplayCacheReplaysFunctionCallForClaudeToolResult", async () => {
  const encrypted = validEncrypted(8);
  const { executor, bodies } = harness(
    `data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","summary":[],"encrypted_content":"${encrypted}"},"output_index":0}\n` +
      `data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"weather\\"}","status":"in_progress"},"output_index":1}\n` +
      `data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"weather\\"}","status":"completed"},"output_index":1}\n` +
      completedEmpty,
  );
  await executor.execute(apiKeyAuth(""), claudeReq(claudeSessionPayload("claude-session-tool", `[{"role":"user","content":[{"type":"text","text":"call lookup"}]}]`, toolSchema)), claudeOpts());
  await executor.execute(
    apiKeyAuth(""),
    claudeReq(
      claudeSessionPayload(
        "claude-session-tool",
        `[{"role":"user","content":[{"type":"text","text":"call lookup"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"sunny"}]}]`,
        toolSchema,
      ),
    ),
    claudeOpts(),
  );
  const second = bodies()[1]!;
  expect(getString(second, "input.0.type")).toBe("message");
  expect(getString(second, "input.1.type")).toBe("reasoning");
  expect(getString(second, "input.2.type")).toBe("function_call");
  expect(getString(second, "input.2.call_id")).toBe("call_1");
  expect(getString(second, "input.3.type")).toBe("function_call_output");
  expect(getString(second, "input.3.call_id")).toBe("call_1");
});

function scope(session: string, requestFingerprint = ""): CodexReasoningReplayScope {
  return { modelName: "gpt-5.4", sessionKey: `claude:${session}:agent:main`, requestFingerprint };
}

function sessionReq(session: string): ExecRequest {
  return claudeReq(`{"metadata":{"user_id":"{\\"session_id\\":\\"${session}\\"}"}}`);
}

function inputOf(body: string): Array<Record<string, unknown>> {
  return getValue(body, "input") as Array<Record<string, unknown>>;
}

test("TestCodexExecutorReasoningReplayCacheRestoresCumulativeToolTurns", () => {
  const cache = new CodexReasoningReplayCache();
  const first = validEncrypted(21);
  const second = validEncrypted(22);
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-cumulative-tools"), `{"response":{"output":[${reasoningItem(first)},{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"first\\"}"}]}}`);
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-cumulative-tools"), `{"response":{"output":[${reasoningItem(second)},{"type":"function_call","call_id":"call_2","name":"lookup","arguments":"{\\"q\\":\\"second\\"}"}]}}`);
  const body =
    `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"first"},{"type":"function_call_output","call_id":"call_1","output":"one"},` +
    `{"type":"message","role":"user","content":"second"},{"type":"function_call_output","call_id":"call_2","output":"two"},{"type":"message","role":"user","content":"third"}]}`;
  const out = applyCodexReasoningReplayCache(cache, claude, sessionReq("session-cumulative-tools"), claudeOpts(), body);
  expect(out.scope.sessionKey).toBe(scope("session-cumulative-tools").sessionKey);
  const items = inputOf(out.body);
  expect(items.map((i) => i.type)).toEqual(["message", "reasoning", "function_call", "function_call_output", "message", "reasoning", "function_call", "function_call_output", "message"]);
  expect(items[1]!.encrypted_content).toBe(first);
  expect(items[5]!.encrypted_content).toBe(second);
});

test("TestCodexExecutorReasoningReplayCacheRestoresCumulativeAssistantTurns", () => {
  const cache = new CodexReasoningReplayCache();
  const first = validEncrypted(23);
  const second = validEncrypted(24);
  const answer = (text: string) => `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"${text}"}]}`;
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-cumulative-messages"), `{"response":{"output":[${reasoningItem(first)},${answer("first answer")}]}}`);
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-cumulative-messages"), `{"response":{"output":[${reasoningItem(second)},${answer("second answer")}]}}`);
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"first"},${answer("first answer")},{"type":"message","role":"user","content":"second"},${answer("second answer")},{"type":"message","role":"user","content":"third"}]}`;
  const out = applyCodexReasoningReplayCache(cache, claude, sessionReq("session-cumulative-messages"), claudeOpts(), body);
  const items = inputOf(out.body);
  expect(items.map((i) => i.type)).toEqual(["message", "reasoning", "message", "message", "reasoning", "message", "message"]);
  expect(items[1]!.encrypted_content).toBe(first);
  expect(items[4]!.encrypted_content).toBe(second);
});

test("TestCodexExecutorReasoningReplayCacheSkipsDetachedTurnAfterCompaction", () => {
  const cache = new CodexReasoningReplayCache();
  const detached = validEncrypted(25);
  const retained = validEncrypted(26);
  const answer = (text: string) => `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"${text}"}]}`;
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-compacted"), `{"response":{"output":[${reasoningItem(detached)},${answer("removed answer")}]}}`);
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-compacted"), `{"response":{"output":[${reasoningItem(retained)},${answer("retained answer")}]}}`);
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"compacted summary"},${answer("retained answer")},{"type":"message","role":"user","content":"continue"}]}`;
  const items = inputOf(applyCodexReasoningReplayCache(cache, claude, sessionReq("session-compacted"), claudeOpts(), body).body);
  expect(items.length).toBe(4);
  expect(items[1]!.encrypted_content).toBe(retained);
  expect(items.some((i) => i.encrypted_content === detached)).toBe(false);
});

test("TestCodexExecutorReasoningReplayCacheMatchesNewestDuplicateAssistantAfterCompaction", () => {
  const cache = new CodexReasoningReplayCache();
  const older = validEncrypted(27);
  const newer = validEncrypted(28);
  for (const encrypted of [older, newer]) {
    cacheCodexReasoningReplayFromCompleted(cache, scope("session-duplicate-compaction"), `{"response":{"output":[${reasoningItem(encrypted)},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}]}}`);
  }
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"compacted summary"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]},{"type":"message","role":"user","content":"continue"}]}`;
  const items = inputOf(applyCodexReasoningReplayCache(cache, claude, sessionReq("session-duplicate-compaction"), claudeOpts(), body).body);
  expect(items.length).toBe(4);
  expect(items[1]!.encrypted_content).toBe(newer);
  expect(items.some((i) => i.encrypted_content === older)).toBe(false);
});

test("TestCodexExecutorReasoningReplayCacheUsesRequestPrefixForDuplicateOutOfOrderTurns", () => {
  const cache = new CodexReasoningReplayCache();
  const done = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}`;
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"first"},${done},{"type":"message","role":"user","content":"second"},${done},{"type":"message","role":"user","content":"third"}]}`;
  const inputItems = inputOf(body);
  const older = validEncrypted(29);
  const newer = validEncrypted(30);
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-duplicate-prefix", codexReplayInputPrefixFingerprint(inputItems, 3)), `{"response":{"output":[${reasoningItem(newer)},${done}]}}`);
  cacheCodexReasoningReplayFromCompleted(cache, scope("session-duplicate-prefix", codexReplayInputPrefixFingerprint(inputItems, 1)), `{"response":{"output":[${reasoningItem(older)},${done}]}}`);
  const items = inputOf(applyCodexReasoningReplayCache(cache, claude, sessionReq("session-duplicate-prefix"), claudeOpts(), body).body);
  expect(items.length).toBe(7);
  expect(items[1]!.encrypted_content).toBe(older);
  expect(items[4]!.encrypted_content).toBe(newer);
});

test("TestCodexExecutorReasoningReplayCacheDropsFunctionCallWithoutMatchingOutput", () => {
  const cache = new CodexReasoningReplayCache();
  cacheCodexReasoningReplayFromCompleted(
    cache,
    scope("session-dropped-tool"),
    `{"response":{"output":[${reasoningItem(validEncrypted(14))},{"type":"function_call","call_id":"call_dropped","name":"TaskCreate","arguments":"{}"}]}}`,
  );
  const body = `{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`;
  const req = claudeReq(claudeSessionPayload("session-dropped-tool", `[{"role":"user","content":[{"type":"text","text":"next"}]}]`));
  const out = applyCodexReasoningReplayCache(cache, claude, req, claudeOpts(), body);
  expect(out.scope.sessionKey).toBe(scope("session-dropped-tool").sessionKey);
  const items = inputOf(out.body);
  expect(items[0]!.role).toBe("user");
  expect(items.some((i) => i.type === "reasoning")).toBe(false);
  expect(items.some((i) => i.call_id === "call_dropped")).toBe(false);
});

test("TestCodexExecutorReasoningReplayCacheMatchesShortenedClaudeToolResultCallID", async () => {
  const longCallID = "call_" + "a".repeat(62);
  const shortCallID = shortenedCallID(longCallID);
  expect(longCallID.length > 64 && shortCallID.length <= 64 && shortCallID !== longCallID).toBe(true);
  const encrypted = validEncrypted(13);
  const { executor, bodies } = harness(
    `data: {"type":"response.output_item.done","item":{"id":"rs_long","type":"reasoning","summary":[],"encrypted_content":"${encrypted}"},"output_index":0}\n` +
      `data: {"type":"response.output_item.done","item":{"id":"fc_long","type":"function_call","call_id":"${longCallID}","name":"lookup","arguments":"{\\"q\\":\\"weather\\"}","status":"completed"},"output_index":1}\n` +
      completedEmpty,
  );
  await executor.execute(apiKeyAuth(""), claudeReq(claudeSessionPayload("claude-session-short-tool", `[{"role":"user","content":[{"type":"text","text":"call lookup"}]}]`, toolSchema)), claudeOpts());
  await executor.execute(
    apiKeyAuth(""),
    claudeReq(
      claudeSessionPayload(
        "claude-session-short-tool",
        `[{"role":"user","content":[{"type":"text","text":"call lookup"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"${shortCallID}","content":"sunny"}]}]`,
        toolSchema,
      ),
    ),
    claudeOpts(),
  );
  const second = bodies()[1]!;
  expect(getString(second, "input.0.type")).toBe("message");
  expect(getString(second, "input.1.type")).toBe("reasoning");
  expect(getString(second, "input.2.type")).toBe("function_call");
  expect(getString(second, "input.2.call_id")).toBe(shortCallID);
  expect(getString(second, "input.3.type")).toBe("function_call_output");
  expect(getString(second, "input.3.call_id")).toBe(shortCallID);
});

test("TestCodexReplayPrefixFingerprintsMatchesDirectComputation", () => {
  const items = [
    JSON.parse(`{"type":"message","role":"user","content":"a"}`),
    JSON.parse(`{"type":"reasoning","encrypted_content":"abc"}`),
    JSON.parse(`{"type":"function_call","call_id":"call_1"}`),
    JSON.parse(`{"type":"function_call_output","call_id":"call_1","output":"ok"}`),
  ];
  const cache = new CodexReplayPrefixFingerprints(items);
  for (const end of [4, 2, 0, 3, 1, 4, 2]) expect(cache.at(end)).toBe(codexReplayInputPrefixFingerprint(items, end));
  for (const end of [-1, 5]) expect(cache.at(end)).toBe("");
});

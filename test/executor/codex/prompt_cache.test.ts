// Ported from: internal/runtime/executor/codex_executor_cache_test.go
// Skipped cases: TestCodexExecutorCacheHelper_OpenAIChatCompletions_StablePromptCacheKeyFromAPIKey (the OpenAI
//   chat-completions inbound format and its client-API-key derived prompt_cache_key are not served by this port).
//   Adaptations: Go's cacheHelper returned the built *http.Request; here applyCodexHTTPPromptCache returns the body
//   and the Session-Id value, and one end-to-end case checks both on the wire. The gin request headers of
//   TestCodexExecutorCacheHelper_ClaudeUsesSessionHeader are the executor's client headers (ExecOptions.headers).
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import {
  ClaudeCodeAgentHeader,
  ClaudeCodeSessionHeader,
  CodexExecutor,
  DerivedSessionIDMetadataKey,
  applyCodexHTTPPromptCache,
  applyCodexHeaders,
  applyCodexPromptCacheHeaders,
  derivedSessionUUID,
  uuidV5OID,
} from "../../../src/executor/codex/index.ts";
import type { ExecRequest } from "../../../src/executor/types.ts";
import { drain, getString, options, startUpstream, sseResponse } from "./helpers.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rawJSON = `{"model":"gpt-5.4","stream":true}`;

function req(model: string, payload: string, metadata?: Record<string, unknown>): ExecRequest {
  return { model, payload, format: "claude", metadata };
}

test("uuidV5OID matches Go uuid.NewSHA1(uuid.NameSpaceOID, ...)", () => {
  // Reference values from Python's uuid.uuid5(uuid.NAMESPACE_OID, name).
  expect(uuidV5OID("cli-proxy-api:codex:prompt-cache:test-api-key")).toBe("76a25d65-2f6f-5267-af11-943676d3ef27");
  expect(uuidV5OID("")).toBe("0a68eb57-c88a-5f34-9e9d-27f85e68af4f");
});

test("TestCodexExecutorCacheHelper_UsesDerivedSessionUUID", () => {
  const request = req("gpt-5.4", `{"model":"gpt-5.4","messages":[{"role":"user","content":"hello"}]}`, { [DerivedSessionIDMetadataKey]: "ctx:v1:derived-root" });
  const expectedKey = derivedSessionUUID("codex", request.metadata);
  // Go used the OpenAI chat format; any format without its own cache identity falls back to the derived session.
  const { body, sessionID } = applyCodexHTTPPromptCache("openai", request, rawJSON, undefined);
  expect(getString(body, "prompt_cache_key")).toBe(expectedKey);
  expect(sessionID).toBe(expectedKey);
  expect(expectedKey).toMatch(uuidPattern);
});

test("TestCodexExecutorCacheHelper_ClaudeUsesClaudeCodeSessionID", () => {
  const first = req(
    "gpt-5.4-claude-cache-session",
    `{"model":"gpt-5.4","metadata":{"user_id":"{\\"device_id\\":\\"device-a\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"cache-session-1\\"}"},"messages":[{"role":"user","content":[{"type":"text","text":"first"}]}]}`,
  );
  const second = req(
    "gpt-5.4-claude-cache-session",
    `{"model":"gpt-5.4","metadata":{"user_id":"{\\"device_id\\":\\"device-b\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"cache-session-1\\"}"},"messages":[{"role":"user","content":[{"type":"text","text":"next"}]}]}`,
  );
  const a = applyCodexHTTPPromptCache("claude", first, rawJSON, undefined);
  const b = applyCodexHTTPPromptCache("claude", second, rawJSON, undefined);
  const firstKey = getString(a.body, "prompt_cache_key");
  expect(firstKey).not.toBe("");
  expect(getString(b.body, "prompt_cache_key")).toBe(firstKey);
  expect(a.sessionID).toBe(firstKey);
  expect(b.sessionID).toBe(firstKey);
});

test("TestCodexExecutorCacheHelper_ClaudeRejectsBareUserID", () => {
  const request = req("gpt-5.4-claude-cache-bare-user", `{"model":"gpt-5.4","metadata":{"user_id":"same-user-across-chats"},"messages":[{"role":"user","content":[{"type":"text","text":"first"}]}]}`);
  const { body, sessionID } = applyCodexHTTPPromptCache("claude", request, rawJSON, undefined);
  expect(getString(body, "prompt_cache_key")).toBe("");
  expect(body).toBe(rawJSON);
  expect(sessionID).toBe("");
});

test("TestApplyCodexHeadersUsesAccountHeaderForOAuth", () => {
  const headers = new Headers();
  const auth = newAuth({ id: "codex-oauth", provider: "codex", metadata: { account_id: "acct-1" } });
  applyCodexHeaders(headers, auth, "oauth-token", true, undefined, undefined);
  expect(headers.get("Chatgpt-Account-Id")).toBe("acct-1");
});

test("TestCodexExecutorCacheHelper_ClaudeUsesSessionHeader", () => {
  const clientHeaders = new Headers({ [ClaudeCodeSessionHeader]: "cache-session-header" });
  const first = req("gpt-5.4-claude-cache-header", `{"model":"gpt-5.4","messages":[{"role":"user","content":[{"type":"text","text":"first"}]}]}`);
  const second = req("gpt-5.4-claude-cache-header", `{"model":"gpt-5.4","messages":[{"role":"user","content":[{"type":"text","text":"next"}]}]}`);
  const firstKey = getString(applyCodexHTTPPromptCache("claude", first, rawJSON, clientHeaders).body, "prompt_cache_key");
  const secondKey = getString(applyCodexHTTPPromptCache("claude", second, rawJSON, clientHeaders).body, "prompt_cache_key");
  expect(firstKey).not.toBe("");
  expect(secondKey).toBe(firstKey);
});

test("TestCodexExecutorCacheHelper_ClaudeAgentScopeUsesResolvedModelAcrossHTTPAndWebsocket", () => {
  const request = req("requested-alias-high", `{"model":"requested-alias","messages":[{"role":"user","content":"hello"}]}`);
  const rootHeaders = new Headers({ [ClaudeCodeSessionHeader]: "resolved-model-session" });
  const childHeaders = new Headers(rootHeaders);
  childHeaders.set(ClaudeCodeAgentHeader, "agent-a");

  const rootKey = getString(applyCodexHTTPPromptCache("claude", request, rawJSON, rootHeaders).body, "prompt_cache_key");
  const childKey = getString(applyCodexHTTPPromptCache("claude", request, rawJSON, childHeaders).body, "prompt_cache_key");
  expect(rootKey).not.toBe("");
  expect(childKey).not.toBe("");
  expect(rootKey).not.toBe(childKey);

  const aliasReq = { ...request, model: "another-local-alias-low" };
  const aliasKey = getString(applyCodexHTTPPromptCache("claude", aliasReq, rawJSON, childHeaders).body, "prompt_cache_key");
  expect(aliasKey).toBe(childKey);

  const websocket = applyCodexPromptCacheHeaders("claude", aliasReq, rawJSON, childHeaders);
  expect(getString(websocket.body, "prompt_cache_key")).toBe(childKey);
});

describe("end to end: the HTTP executor sends prompt_cache_key and Session-Id", () => {
  const upstream = startUpstream(() => sseResponse(`data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`));
  afterAll(() => upstream.close());

  test("Claude Code session header", async () => {
    const auth = newAuth({ id: "codex-key", provider: "codex", attributes: { api_key: "k", base_url: upstream.url } });
    const clientHeaders = new Headers({ [ClaudeCodeSessionHeader]: "session-e2e" });
    const result = await new CodexExecutor().executeStream(auth, req("gpt-5.4", `{"model":"gpt-5.4","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`), options("claude", true, { headers: clientHeaders }));
    await drain(result);
    const sent = upstream.requests[upstream.requests.length - 1]!;
    const key = getString(sent.body, "prompt_cache_key");
    expect(key).toMatch(uuidPattern);
    expect(sent.headers.get("Session-Id")).toBe(key);
  });

  test("Responses prompt_cache_key", async () => {
    const auth = newAuth({ id: "codex-key", provider: "codex", attributes: { api_key: "k", base_url: upstream.url } });
    const result = await new CodexExecutor().executeStream(
      auth,
      { model: "gpt-5.4", payload: `{"model":"gpt-5.4","prompt_cache_key":"client-cache","input":"hi"}`, format: "openai-response" },
      options("openai-response", true),
    );
    await drain(result);
    const sent = upstream.requests[upstream.requests.length - 1]!;
    expect(getString(sent.body, "prompt_cache_key")).toBe("client-cache");
    expect(sent.headers.get("Session-Id")).toBe("client-cache");
  });
});

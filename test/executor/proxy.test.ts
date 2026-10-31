// Ported from: internal/runtime/executor/helps/proxy_helpers_test.go
// Ported from: internal/runtime/executor/request_proxy_priority_test.go
// Skipped cases: TestNewDevinHTTPClient_* (Devin dropped); request_proxy_priority_test.go's antigravityProxyURL half
//   (Antigravity dropped) and its gorilla websocket dialer half (the Codex websocket executor takes the same
//   request > credential order; Bun's WebSocket client has no dialer Proxy func to inspect).
// Adapted: Go inspected http.Transport.Proxy; here the executors hand the chosen URL to Bun's fetch `proxy` option,
//   so the tests capture that option through an injected fetch. The refresh case (WithoutRequestProxyURL) is the
//   Gemini CLI token refresh, which passes no request options.
import { describe, expect, test } from "bun:test";
import { applyFetchProxy, effectiveProxyURL, fetchProxyOption } from "../../src/executor/proxy.ts";
import { AIStudioExecutor } from "../../src/executor/gemini/aistudio.ts";
import { OpenAICompatExecutor } from "../../src/executor/openai/index.ts";
import { ClaudeExecutor } from "../../src/executor/claude/executor.ts";
import { CodexExecutor } from "../../src/executor/codex/index.ts";
import { defaultConfig } from "../../src/config/load.ts";
import { newAuth } from "../../src/auth/types.ts";

const requestProxy = "http://request-proxy.example:8081";
const authProxy = "http://auth-proxy.example:8080";
const globalProxy = "http://global-proxy.example.com:8080";

test("TestNewProxyAwareHTTPClientRequestProxyOverridesAuthAndGlobal", () => {
  expect(effectiveProxyURL(requestProxy, authProxy, globalProxy)).toBe(requestProxy);
  // Without the request override (token refresh): the credential proxy wins over the global one.
  expect(effectiveProxyURL(undefined, authProxy, globalProxy)).toBe(authProxy);
  expect(effectiveProxyURL("", "  ", globalProxy)).toBe(globalProxy);
  expect(effectiveProxyURL(undefined, undefined, undefined)).toBe("");
});

test("TestNewProxyAwareHTTPClientDirectBypassesGlobalProxy", () => {
  expect(fetchProxyOption(effectiveProxyURL(undefined, "direct", globalProxy))).toBeUndefined();
  expect(fetchProxyOption(effectiveProxyURL(undefined, "NONE", globalProxy))).toBeUndefined();
  expect(fetchProxyOption(effectiveProxyURL(" direct ", authProxy, globalProxy))).toBeUndefined();
  const init: { proxy?: string } = { proxy: "stale" };
  applyFetchProxy(init, undefined, "direct", globalProxy);
  expect("proxy" in init).toBe(false);
  applyFetchProxy(init, undefined, "", globalProxy);
  expect(init.proxy).toBe(globalProxy);
});

/** A fetch that records the `proxy` option and answers with `body`. */
function capturingFetch(body: () => Response) {
  const proxies: Array<string | undefined> = [];
  const fetchImpl = async (_input: string, init?: RequestInit & { proxy?: string }) => {
    proxies.push(init?.proxy);
    return body();
  };
  return { proxies, fetch: fetchImpl };
}

describe("executors pass the effective proxy to fetch", () => {
  const claudeMessage = () =>
    Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  const claudeReq = { model: "claude-opus-5", payload: `{"model":"claude-opus-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`, format: "claude" as const };

  test("AI Studio: request > credential > global, direct disables", async () => {
    const f = capturingFetch(() => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
    const exec = new AIStudioExecutor({ fetch: f.fetch as never, proxyUrl: globalProxy });
    const auth = (proxyUrl?: string) => newAuth({ id: "a", provider: "aistudio", proxyUrl, attributes: { api_key: "k" } });
    await exec.execute(auth(authProxy), claudeReq, { stream: false, sourceFormat: "claude", proxyUrl: requestProxy });
    await exec.execute(auth(authProxy), claudeReq, { stream: false, sourceFormat: "claude" });
    await exec.execute(auth(""), claudeReq, { stream: false, sourceFormat: "claude" });
    await exec.execute(auth("direct"), claudeReq, { stream: false, sourceFormat: "claude" });
    expect(f.proxies).toEqual([requestProxy, authProxy, globalProxy, undefined]);
  });

  test("OpenAI: request > credential > global, direct disables", async () => {
    const f = capturingFetch(() => Response.json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    const cfg = defaultConfig();
    cfg.requests.proxyUrl = globalProxy;
    const exec = new OpenAICompatExecutor(cfg, { fetch: f.fetch as never });
    const auth = (proxyUrl?: string) => newAuth({ id: "o", provider: "openai", proxyUrl, attributes: { api_key: "k", base_url: "http://upstream.invalid/v1" } });
    await exec.execute(auth(authProxy), claudeReq, { stream: false, sourceFormat: "claude", proxyUrl: requestProxy });
    await exec.execute(auth(""), claudeReq, { stream: false, sourceFormat: "claude" });
    await exec.execute(auth("direct"), claudeReq, { stream: false, sourceFormat: "claude" });
    expect(f.proxies).toEqual([requestProxy, globalProxy, undefined]);
  });

  test("Claude: request > credential > global, direct disables", async () => {
    const f = capturingFetch(claudeMessage);
    const exec = new ClaudeExecutor({ fetch: f.fetch as never, proxyUrl: globalProxy, cloakMode: "never" });
    const auth = (proxyUrl?: string) => newAuth({ id: "c", provider: "claude", proxyUrl, attributes: { api_key: "k", base_url: "http://upstream.invalid" } });
    await exec.execute(auth(authProxy), claudeReq, { stream: false, sourceFormat: "claude", proxyUrl: requestProxy });
    await exec.execute(auth(""), claudeReq, { stream: false, sourceFormat: "claude" });
    await exec.execute(auth("direct"), claudeReq, { stream: false, sourceFormat: "claude" });
    expect(f.proxies).toEqual([requestProxy, globalProxy, undefined]);
  });

  test("Codex: request > credential, direct disables", async () => {
    const completed = `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt-5","output":[{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;
    const f = capturingFetch(() => new Response(completed, { headers: { "Content-Type": "text/event-stream" } }));
    const exec = new CodexExecutor({ fetch: f.fetch as never });
    const auth = (proxyUrl?: string) => newAuth({ id: "x", provider: "codex", proxyUrl, attributes: { api_key: "k", base_url: "http://upstream.invalid" } });
    const req = { model: "gpt-5", payload: claudeReq.payload, format: "claude" as const };
    await exec.execute(auth(authProxy), req, { stream: false, sourceFormat: "claude", proxyUrl: requestProxy });
    await exec.execute(auth(authProxy), req, { stream: false, sourceFormat: "claude" });
    await exec.execute(auth("direct"), req, { stream: false, sourceFormat: "claude" });
    expect(f.proxies).toEqual([requestProxy, authProxy, undefined]);
  });

  test.todo("Codex: the global proxy (requests.proxy-url) applies when the credential has none (CodexExecutorOptions has no global proxy and createExecutors does not pass it; needs src/executor/codex and src/executor/index.ts changes)");
});

// New test (no Go counterpart of its own; Go: helps.effectiveProxyURL as used by the Codex executors):
// CodexExecutorOptions.proxyUrl is the global proxy, used only when neither ExecOptions.proxyUrl nor
// auth.proxyUrl is set; "direct" disables it. Covers the HTTP transport, the image endpoints, token
// refresh and the websocket dialer.
import { expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { CodexExecutor, CodexWebsocketSessionStore, CodexWebsocketsExecutor } from "../../../src/executor/codex/index.ts";
import { FormatOpenAIImage } from "../../../src/executor/openai/images.ts";
import { RequestPathMetadataKey, type ExecOptions } from "../../../src/executor/types.ts";

const completed = `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`;

function capture(answer: () => Response) {
  const proxies: Array<string | undefined> = [];
  const fetch = async (_url: string, init?: RequestInit & { proxy?: string }) => {
    proxies.push(init?.proxy);
    return answer();
  };
  return { fetch, proxies };
}

const auth = (proxyUrl?: string, extra: Record<string, unknown> = {}) =>
  newAuth({ id: "codex-proxy", provider: "codex", proxyUrl, attributes: { api_key: "k", base_url: "http://upstream.invalid" }, ...extra });
const req = { model: "gpt-5.4", payload: `{"model":"gpt-5.4","input":"hi"}`, format: "openai-response" };
const opts = (proxyUrl?: string): ExecOptions => ({ stream: false, sourceFormat: "openai-response", ...(proxyUrl !== undefined ? { proxyUrl } : {}) });

test("HTTP transport: request > credential > global; direct disables", async () => {
  const f = capture(() => new Response(completed, { headers: { "Content-Type": "text/event-stream" } }));
  const exec = new CodexExecutor({ fetch: f.fetch, proxyUrl: "http://global:1" });
  await exec.execute(auth("http://auth:1"), req, opts("http://request:1"));
  await exec.execute(auth("http://auth:1"), req, opts());
  await exec.execute(auth(), req, opts());
  await exec.execute(auth("direct"), req, opts());
  expect(f.proxies).toEqual(["http://request:1", "http://auth:1", "http://global:1", undefined]);
  // Without a global proxy nothing is set.
  const g = capture(() => new Response(completed, { headers: { "Content-Type": "text/event-stream" } }));
  await new CodexExecutor({ fetch: g.fetch }).execute(auth(), req, opts());
  expect(g.proxies).toEqual([undefined]);
});

test("image endpoints use the global proxy", async () => {
  const f = capture(() => new Response(`{"created":1,"data":[{"b64_json":"AA=="}]}`, { headers: { "Content-Type": "application/json" } }));
  const exec = new CodexExecutor({ fetch: f.fetch, proxyUrl: "http://global:1" });
  const imageOpts: ExecOptions = { stream: false, sourceFormat: FormatOpenAIImage, metadata: { [RequestPathMetadataKey]: "/v1/images/generations" } };
  await exec.execute(auth(), { model: "gpt-image-1.5", payload: `{"model":"gpt-image-1.5","prompt":"a cat"}`, format: FormatOpenAIImage }, imageOpts);
  expect(f.proxies).toEqual(["http://global:1"]);
});

test("token refresh uses the global proxy when the credential has none", async () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const idToken = `${b64({ alg: "none" })}.${b64({ email: "u@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })}.`;
  const f = capture(() => Response.json({ access_token: "a", refresh_token: "r", id_token: idToken, expires_in: 3600 }));
  const exec = new CodexExecutor({ fetch: f.fetch, proxyUrl: "http://global:1" });
  await exec.refresh(newAuth({ id: "codex-oauth", provider: "codex", metadata: { refresh_token: "old" } }));
  expect(f.proxies).toEqual(["http://global:1"]);
});

test("websocket dialer gets the global proxy", async () => {
  const dialed: string[] = [];
  const exec = new CodexWebsocketsExecutor({
    store: new CodexWebsocketSessionStore(),
    proxyUrl: "http://global:1",
    dialer: async (_url, _headers, options) => {
      dialed.push(options.proxyUrl ?? "");
      throw new Error("dial refused in test");
    },
  });
  await exec.execute(auth(), { model: "gpt-5.4", payload: `{"model":"gpt-5.4","input":"hi"}`, format: "codex" }, { stream: false, sourceFormat: "codex" } as ExecOptions).catch(() => undefined);
  expect(dialed[0]).toBe("http://global:1");
});

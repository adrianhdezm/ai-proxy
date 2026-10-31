// New (no upstream test): CodexExecutor wiring — credential/URL selection and the non-SIWC header
// policy for OAuth and API-key credentials, upstream non-2xx classification on the stream path,
// a Claude streaming round trip, the local countTokens estimate and refresh().
import { describe, expect, test } from "bun:test";
import { CodexExecutor, codexOriginator, codexUserAgent, createCodexExecutor } from "../../../src/executor/codex/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { apiKeyAuth, claudePayload, drain, getString, getValue, oauthAuth, options, request, sseResponse, stubFetch } from "./helpers.ts";

const completed = `data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n`;

describe("credentials, URL and headers", () => {
  test("OAuth credentials use the ChatGPT backend, bearer token, account id, routing hint and Codex identity", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const executor = createCodexExecutor({ fetch: stub.fetch });
    expect(executor.identifier).toBe("codex");
    await executor.execute(oauthAuth({ accessToken: "tok-oauth", accountId: "acct_9" }), request("gpt-5.4(high)", claudePayload("gpt-5.4(high)")), options("claude", false));
    const call = stub.calls[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.headers.get("Authorization")).toBe("Bearer tok-oauth");
    expect(call.headers.get("Chatgpt-Account-Id")).toBe("acct_9");
    expect(call.headers.get("Accept")).toBe("text/event-stream");
    expect(call.headers.get("User-Agent")).toBe(codexUserAgent);
    expect(call.headers.get("Originator")).toBe(codexOriginator);
    expect(call.headers.get("X-Codex-Routing-Hint")).toBe("model=gpt-5.4");
    // Base model without the thinking suffix, stream forced on, suffix applied as reasoning effort.
    expect(getString(call.body, "model")).toBe("gpt-5.4");
    expect(getValue(call.body, "stream")).toBe(true);
    expect(getString(call.body, "reasoning.effort")).toBe("high");
  });

  test("API-key credentials use attributes.base_url and send no account id or routing hint", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const executor = new CodexExecutor({ fetch: stub.fetch });
    await executor.execute(apiKeyAuth("https://example.test/v1/", "sk-test", { "header:X-Custom": "yes" }), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", false));
    const call = stub.calls[0]!;
    expect(call.url).toBe("https://example.test/v1/responses");
    expect(call.headers.get("Authorization")).toBe("Bearer sk-test");
    expect(call.headers.get("Chatgpt-Account-Id")).toBeNull();
    expect(call.headers.get("X-Codex-Routing-Hint")).toBeNull();
    expect(call.headers.get("X-Custom")).toBe("yes");
  });

  test("disableCloaking keeps the client User-Agent and forwards Codex client headers", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const executor = new CodexExecutor({ fetch: stub.fetch, disableCloaking: true });
    const clientHeaders = new Headers({ "User-Agent": "my-client/1.0", "X-Codex-Turn-State": "turn-1", Version: "0.99.0" });
    await executor.execute(apiKeyAuth("https://example.test"), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", false, { headers: clientHeaders }));
    const call = stub.calls[0]!;
    expect(call.headers.get("User-Agent")).toBe("my-client/1.0");
    expect(call.headers.get("X-Codex-Turn-State")).toBe("turn-1");
    expect(call.headers.get("Version")).toBe("0.99.0");
    expect(call.headers.get("Originator")).toBeNull();
  });

  test("request fields Codex rejects are removed", async () => {
    const stub = stubFetch(() => sseResponse(completed));
    const executor = new CodexExecutor({ fetch: stub.fetch });
    const payload = `{"model":"gpt-5.4","input":"hi","previous_response_id":"resp_0","generate":true,"prompt_cache_retention":"24h","safety_identifier":"u","stream_options":{"include_usage":true},"parallel_tool_calls":true}`;
    await executor.execute(apiKeyAuth("https://example.test"), request("gpt-5.4", payload), options("openai-response", false));
    const body = stub.calls[0]!.body;
    for (const field of ["previous_response_id", "generate", "prompt_cache_retention", "safety_identifier", "stream_options", "parallel_tool_calls"]) {
      expect(getValue(body, field)).toBeUndefined();
    }
  });
});

describe("upstream rejections on the stream path", () => {
  test("429 usage_limit_reached is credential scoped with the reset as retry hint", async () => {
    const stub = stubFetch(
      () => new Response(`{"error":{"type":"usage_limit_reached","message":"limit","resets_in_seconds":120}}`, { status: 429, headers: { "Content-Type": "application/json" } }),
    );
    const executor = new CodexExecutor({ fetch: stub.fetch });
    const err = await executor.executeStream(oauthAuth(), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", true)).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(429);
    expect(err.credentialScoped).toBe(true);
    expect(err.retryAfterMs).toBe(120_000);
  });

  test("modelLevelCooling keeps a usage limit model scoped", async () => {
    const stub = stubFetch(() => new Response(`{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}`, { status: 429 }));
    const executor = new CodexExecutor({ fetch: stub.fetch, modelLevelCooling: true });
    const err = await executor.executeStream(oauthAuth(), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", true)).catch((e) => e);
    expect(err.credentialScoped).toBe(false);
    expect(err.retryAfterMs).toBe(60_000);
  });

  test("turn rate limit is a transient rate limit honouring Retry-After", async () => {
    const stub = stubFetch(
      () =>
        new Response(`{"error":{"type":"rate_limit_error","code":"turn_rate_limit_exceeded","message":"Codex is at capacity, please try again later"}}`, {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
    );
    const executor = new CodexExecutor({ fetch: stub.fetch });
    const err = await executor.executeStream(oauthAuth(), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", true)).catch((e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.transientRateLimit).toBe(true);
    expect(err.credentialScoped).toBe(false);
    expect(err.retryAfterMs).toBe(7000);
  });

  test("an accepted stream that closes before any payload is a 502 that is not request scoped", async () => {
    const stub = stubFetch(() => sseResponse(""));
    const executor = new CodexExecutor({ fetch: stub.fetch });
    const result = await executor.executeStream(oauthAuth(), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", true));
    const { chunks, error } = await drain(result);
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).requestScoped).toBe(false);
    expect((error as StatusError).streamTruncated).toBe(false);
  });
});

test("Claude streaming round trip translates every event into Claude SSE frames", async () => {
  const stream =
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}\n\n` +
    `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n` +
    `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_1","delta":"Hi there"}\n\n` +
    `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi there"}]}}\n\n` +
    completed;
  const stub = stubFetch(() => sseResponse(stream));
  const executor = new CodexExecutor({ fetch: stub.fetch });
  const result = await executor.executeStream(oauthAuth(), request("gpt-5.4", claudePayload("gpt-5.4")), options("claude", true));
  const { chunks, error } = await drain(result);
  expect(error).toBeUndefined();
  const joined = chunks.join("");
  expect(joined).toContain("event: message_start");
  expect(joined).toContain("Hi there");
  expect(joined).toContain("event: message_stop");
  for (const chunk of chunks) expect(chunk.startsWith("event: ")).toBe(true);
});

test("countTokens returns a local Claude input_tokens estimate", async () => {
  const executor = new CodexExecutor({ fetch: () => Promise.reject(new Error("no network")) });
  const payload = JSON.stringify({ model: "gpt-5.4", max_tokens: 10, system: "be brief", messages: [{ role: "user", content: "x".repeat(400) }] });
  const resp = await executor.countTokens(oauthAuth(), request("gpt-5.4", payload), options("claude", false));
  const n = getValue(resp.payload, "input_tokens") as number;
  expect(typeof n).toBe("number");
  // ~400 characters of user text plus the system prompt, at four characters per token.
  expect(n).toBeGreaterThanOrEqual(100);
  expect(n).toBeLessThan(120);
});

describe("refresh", () => {
  test("API-key credentials are returned unchanged", async () => {
    const executor = new CodexExecutor({ fetch: () => Promise.reject(new Error("must not be called")) });
    const auth = apiKeyAuth("https://example.test");
    expect(await executor.refresh(auth)).toBe(auth);
  });

  test("OAuth credentials are refreshed through the Codex token endpoint", async () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const idToken = `${b64({ alg: "none" })}.${b64({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct_new", chatgpt_plan_type: "plus" } })}.sig`;
    const stub = stubFetch(() =>
      Response.json({ access_token: "new-access", refresh_token: "new-refresh", id_token: idToken, expires_in: 3600, token_type: "Bearer" }),
    );
    const executor = new CodexExecutor({ fetch: stub.fetch });
    const refreshed = await executor.refresh(oauthAuth({ accessToken: "old-access", refreshToken: "old-refresh" }));
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.body).toContain("refresh_token=old-refresh");
    expect(refreshed.metadata.access_token).toBe("new-access");
    expect(refreshed.metadata.refresh_token).toBe("new-refresh");
    expect(refreshed.metadata.account_id).toBe("acct_new");
  });
});

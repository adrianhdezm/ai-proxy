// New (no upstream test): the v7.0.12 Gemini CLI executor ships without tests. These cover the
// Code Assist envelope, headers, token refresh, 429 retry hints, countTokens and stream-end
// behaviour against a fake Code Assist + Google token server (Bun.serve on port 0).
// The OAuth client id/secret below are fakes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GeminiAuthenticator } from "../../../src/auth/gemini/index.ts";
import { type Auth, newAuth } from "../../../src/auth/types.ts";
import { GeminiCLIApiClientHeader, cliPreviewFallbackOrder, createGeminiCLIExecutor, type GeminiCLIExecutor } from "../../../src/executor/gemini/index.ts";
import { type ExecOptions, StatusError } from "../../../src/executor/types.ts";
import { claudeEvents, drain, type FakeUpstream, json, sse, startFakeUpstream } from "./helpers.ts";

const fakeClient = { clientId: "fake-client-id.apps.googleusercontent.com", clientSecret: "fake-client-secret" };
const nowMs = Date.parse("2026-10-30T12:00:00Z");
const now = () => nowMs;
const claudeOpts: ExecOptions = { stream: false, sourceFormat: "claude", responseFormat: "claude" };

let upstream: FakeUpstream;
let tokenRequests: URLSearchParams[];
let generateHandler: (path: string, body: string) => Response;

beforeAll(() => {
  upstream = startFakeUpstream((r) => {
    if (r.path === "/token") {
      tokenRequests.push(new URLSearchParams(r.body));
      return json({ access_token: "fresh-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    return generateHandler(r.path, r.body);
  });
});
afterAll(() => upstream.stop());
beforeEach(() => {
  tokenRequests = [];
  upstream.requests.length = 0;
  generateHandler = () => json({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } });
});

function cliAuth(expiry: string, accessToken = "valid-access-token", extra: Record<string, unknown> = {}): Auth {
  return newAuth({
    id: "gemini-user@example.com-my-project.json",
    provider: "gemini-cli",
    label: "user@example.com",
    attributes: { "header:X-Custom": "custom-value" },
    metadata: {
      type: "gemini",
      project_id: "my-project",
      email: "user@example.com",
      token: { access_token: accessToken, token_type: "Bearer", refresh_token: "refresh-token-1", expiry, token_uri: `${upstream.url}/token` },
      ...extra,
    },
  });
}

const futureExpiry = new Date(nowMs + 3600_000).toISOString();
const pastExpiry = new Date(nowMs - 60_000).toISOString();

function executor(opts: { switchPreviewModel?: boolean; onAuthUpdated?: (a: Auth) => void } = {}): GeminiCLIExecutor {
  return createGeminiCLIExecutor({
    endpoint: upstream.url,
    now,
    authenticator: new GeminiAuthenticator({ client: fakeClient, endpoints: { tokenUrl: `${upstream.url}/token` } }),
    ...opts,
  });
}

const claudeReq = (model = "gemini-2.5-pro") => ({
  model,
  format: "claude",
  payload: JSON.stringify({ model, max_tokens: 64, system: "be brief", messages: [{ role: "user", content: "hi" }] }),
});

describe("gemini-cli non-stream", () => {
  test("sends the Code Assist envelope with Bearer token and Gemini CLI headers", async () => {
    generateHandler = () =>
      json({
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "hello from code assist" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
        },
        traceId: "t1",
      });
    const res = await executor().execute(cliAuth(futureExpiry), claudeReq(), claudeOpts);
    const sent = upstream.requests.at(-1)!;
    expect(sent.path).toBe("/v1internal:generateContent");
    expect(sent.search).toBe("");
    expect(sent.headers.get("authorization")).toBe("Bearer valid-access-token");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.headers.get("accept")).toBe("application/json");
    expect(sent.headers.get("user-agent")).toMatch(/^GeminiCLI\/0\.34\.0\/gemini-2\.5-pro \(.+; .+; terminal\)$/);
    expect(sent.headers.get("x-goog-api-client")).toBe(GeminiCLIApiClientHeader);
    expect(sent.headers.get("x-custom")).toBe("custom-value");
    const body = JSON.parse(sent.body);
    expect(Object.keys(body)).toEqual(["project", "model", "request"]);
    expect(body.project).toBe("my-project");
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body.request.model).toBeUndefined();
    expect(body.request.contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(body.request.systemInstruction.parts[0].text).toBe("be brief");
    const out = JSON.parse(res.payload);
    expect(out.type).toBe("message");
    expect(out.content[0]).toMatchObject({ type: "text", text: "hello from code assist" });
    expect(out.usage).toMatchObject({ input_tokens: 4, output_tokens: 3 });
    expect(res.metadata?.usage).toMatchObject({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    expect(tokenRequests.length).toBe(0);
  });

  test("thinking suffix is applied inside request.generationConfig", async () => {
    await executor().execute(cliAuth(futureExpiry), claudeReq("gemini-2.5-pro(2048)"), claudeOpts);
    const body = JSON.parse(upstream.requests.at(-1)!.body);
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(2048);
  });

  test("429 with RetryInfo -> StatusError 429 retryAfterMs (single attempt, empty preview table)", async () => {
    const errBody = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.5s" }],
      },
    });
    generateHandler = () => json(errBody, 429);
    const exec = executor({ switchPreviewModel: true });
    const err = (await exec.execute(cliAuth(futureExpiry), claudeReq(), claudeOpts).catch((e) => e)) as StatusError;
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(3500);
    expect(err.body).toBe(errBody);
    expect(upstream.requests.filter((r) => r.path !== "/token").length).toBe(1);

    const errStream = (await exec.executeStream(cliAuth(futureExpiry), claudeReq(), { ...claudeOpts, stream: true }).catch((e) => e)) as StatusError;
    expect(errStream.statusCode).toBe(429);
    expect(errStream.retryAfterMs).toBe(3500);
  });

  test("other non-2xx -> StatusError with the upstream body", async () => {
    generateHandler = () => json(`{"error":{"code":403,"message":"permission denied"}}`, 403);
    const err = (await executor().execute(cliAuth(futureExpiry), claudeReq(), claudeOpts).catch((e) => e)) as StatusError;
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain("permission denied");
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("cliPreviewFallbackOrder keeps the upstream (empty) table", () => {
    expect(cliPreviewFallbackOrder("gemini-2.5-pro")).toEqual([]);
    expect(cliPreviewFallbackOrder("gemini-2.5-flash")).toEqual([]);
    expect(cliPreviewFallbackOrder("gemini-2.5-flash-lite")).toEqual([]);
    expect(cliPreviewFallbackOrder("gemini-3-pro")).toEqual([]);
  });
});

describe("gemini-cli stream", () => {
  test("streams Code Assist SSE into Claude SSE ending in message_stop", async () => {
    generateHandler = () =>
      sse(
        `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]},"traceId":"t"}\n\n` +
          `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}}\n\n`,
      );
    const res = await executor().executeStream(cliAuth(futureExpiry), claudeReq(), { ...claudeOpts, stream: true });
    const { text, error } = await drain(res);
    expect(error).toBeUndefined();
    const sent = upstream.requests.at(-1)!;
    expect(sent.path).toBe("/v1internal:streamGenerateContent");
    expect(sent.search).toBe("?alt=sse");
    expect(sent.headers.get("accept")).toBe("text/event-stream");
    expect(sent.headers.get("authorization")).toBe("Bearer valid-access-token");
    const body = JSON.parse(sent.body);
    expect(body.project).toBe("my-project");
    expect(body.model).toBe("gemini-2.5-pro");
    expect(Array.isArray(body.request.contents)).toBe(true);
    const events = claudeEvents(text);
    expect(events[0]).toBe("message_start");
    expect(events).toContain("message_delta");
    expect(events.at(-1)).toBe("message_stop");
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');
  });

  test("output without finishReason still flushes message_stop (v7 behaviour)", async () => {
    generateHandler = () => sse(`data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}}\n\n`);
    const { text, error } = await drain(await executor().executeStream(cliAuth(futureExpiry), claudeReq(), { ...claudeOpts, stream: true }));
    expect(error).toBeUndefined();
    expect(text).toContain('"text":"partial"');
    expect(claudeEvents(text).at(-1)).toBe("message_stop");
  });

  test("empty body -> StatusError 502 before the first chunk (bootstrap failover, not truncated)", async () => {
    generateHandler = () => sse("");
    const { chunks, error } = await drain(await executor().executeStream(cliAuth(futureExpiry), claudeReq(), { ...claudeOpts, stream: true }));
    expect(chunks.length).toBe(0);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).streamTruncated).toBe(false);
    expect((error as StatusError).requestScoped).toBe(false);
  });
});

describe("gemini-cli countTokens", () => {
  test("posts {request} without project/model/safetySettings and returns Claude input_tokens", async () => {
    generateHandler = () => json(`{"totalTokens":9}`);
    const res = await executor().countTokens(cliAuth(futureExpiry), claudeReq(), claudeOpts);
    const sent = upstream.requests.at(-1)!;
    expect(sent.path).toBe("/v1internal:countTokens");
    expect(sent.headers.get("authorization")).toBe("Bearer valid-access-token");
    const body = JSON.parse(sent.body);
    expect(Object.keys(body)).toEqual(["request"]);
    expect(body.request.contents[0].parts[0].text).toBe("hi");
    expect(body.request.safetySettings).toBeUndefined();
    expect(JSON.parse(res.payload)).toEqual({ input_tokens: 9 });
  });
});

describe("gemini-cli token source", () => {
  test("expired token is refreshed before the request and written into auth.metadata in place", async () => {
    const updated: Auth[] = [];
    const auth = cliAuth(pastExpiry, "stale-access-token");
    const metadataRef = auth.metadata;
    await executor({ onAuthUpdated: (a) => updated.push(a) }).execute(auth, claudeReq(), claudeOpts);
    expect(tokenRequests.length).toBe(1);
    expect(tokenRequests[0]!.get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[0]!.get("refresh_token")).toBe("refresh-token-1");
    expect(tokenRequests[0]!.get("client_id")).toBe(fakeClient.clientId);
    expect(upstream.requests.at(-1)!.headers.get("authorization")).toBe("Bearer fresh-access-token");
    expect(auth.metadata).toBe(metadataRef);
    expect(auth.metadata.access_token).toBe("fresh-access-token");
    expect((auth.metadata.token as Record<string, unknown>).access_token).toBe("fresh-access-token");
    expect(auth.metadata.refresh_token).toBe("refresh-token-1");
    expect(Date.parse(String(auth.metadata.expiry))).toBe(nowMs + 3600_000);
    expect(auth.metadata.project_id).toBe("my-project");
    expect(updated).toEqual([auth]);
  });

  test("a token within 30s of expiry is refreshed; a later one is not", async () => {
    await executor().execute(cliAuth(new Date(nowMs + 20_000).toISOString()), claudeReq(), claudeOpts);
    expect(tokenRequests.length).toBe(1);
    tokenRequests = [];
    await executor().execute(cliAuth(new Date(nowMs + 120_000).toISOString()), claudeReq(), claudeOpts);
    expect(tokenRequests.length).toBe(0);
  });

  test("concurrent requests share one refresh (single-flight per auth id)", async () => {
    const exec = executor();
    const auth = cliAuth(pastExpiry, "stale-access-token");
    await Promise.all([exec.execute(auth, claudeReq(), claudeOpts), exec.execute(auth, claudeReq(), claudeOpts), exec.countTokens(auth, claudeReq(), claudeOpts).catch(() => undefined)]);
    expect(tokenRequests.length).toBe(1);
  });

  test("top-level token fields are honoured when there is no nested token", async () => {
    const auth = newAuth({
      id: "flat",
      provider: "gemini-cli",
      metadata: { project_id: "p", access_token: "flat-token", refresh_token: "r", expiry: futureExpiry },
    });
    await executor().execute(auth, claudeReq(), claudeOpts);
    expect(upstream.requests.at(-1)!.headers.get("authorization")).toBe("Bearer flat-token");
  });

  test("missing token without refresh token -> 401", async () => {
    const auth = newAuth({ id: "empty", provider: "gemini-cli", metadata: { project_id: "p" } });
    const err = (await executor().execute(auth, claudeReq(), claudeOpts).catch((e) => e)) as StatusError;
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(401);
  });

  test("refresh() returns the refreshed copy", async () => {
    const auth = cliAuth(pastExpiry, "stale-access-token");
    const refreshed = await executor().refresh(auth);
    expect(refreshed).not.toBe(auth);
    expect(refreshed.metadata.access_token).toBe("fresh-access-token");
    expect((auth.metadata.token as Record<string, unknown>).access_token).toBe("stale-access-token");
  });
});

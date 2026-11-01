// Ported from: internal/runtime/executor/claude_executor_test.go
// Skipped cases: this file holds the response decoding/transport cases. TestDecodeResponseBody* live in
// response_decode.test.ts. TestClaudeExecutor_ExecuteStreamOpenAIResponseTranslatesCacheAndTrailingUsageChunk and
// TestClaudeExecutor_ExecutePayloadStreamOverrideDoesNotChangeResponseParser (no Claude->OpenAI response translator and
// no payload config rules in this port).
import { describe, expect, test } from "bun:test";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { apiKeyAuth, claudeOpts, collect, expectStatusError, gzip, jsonResponse, lastHeaders, okMessage, withUpstream } from "./helpers.ts";

const sonnet = "claude-3-5-sonnet-20241022";
const hiPayload = `{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`;
const firstData = `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`;
const secondData = `{"type":"message_stop"}`;
const upstreamStream = `event: content_block_delta\ndata: ${firstData}\n\nevent: message_stop\ndata: ${secondData}\n\n`;
const wantFrames = [`event: content_block_delta\ndata: ${firstData}\n\n`, `event: message_stop\ndata: ${secondData}\n\n`];

describe("claude executor responses", () => {
  test("ExecuteStreamDirectPassthroughEmitsCompleteSSEEvents", async () => {
    await withUpstream(
      () => new Response(upstreamStream, { headers: { "Content-Type": "text/event-stream" } }),
      async (upstream) => {
        const result = await createClaudeExecutor().executeStream(apiKeyAuth(upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts());
        const got = await collect(result);
        expect(got.error).toBeUndefined();
        expect(got.chunks).toEqual(wantFrames);
      },
    );
  });

  test("ExecuteStreamDecodesCompressedSSE", async () => {
    await withUpstream(
      () => new Response(gzip(upstreamStream), { headers: { "Content-Type": "text/event-stream", "Content-Encoding": "gzip" } }),
      async (upstream) => {
        const result = await createClaudeExecutor().executeStream(apiKeyAuth(upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts());
        const got = await collect(result);
        expect(got.error).toBeUndefined();
        expect(got.chunks).toEqual(wantFrames);
      },
    );
  });

  test("ExecuteStream_GzipNoContentEncodingHeader", async () => {
    await withUpstream(
      () => new Response(gzip(upstreamStream), { headers: { "Content-Type": "text/event-stream" } }),
      async (upstream) => {
        const got = await collect(await createClaudeExecutor().executeStream(apiKeyAuth(upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expect(got.error).toBeUndefined();
        expect(got.chunks).toEqual(wantFrames);
      },
    );
  });

  test("Execute decodes a gzip JSON body", async () => {
    await withUpstream(
      () => new Response(gzip(okMessage()), { headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }),
      async (upstream) => {
        const resp = await createClaudeExecutor().execute(apiKeyAuth(upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts());
        expect(JSON.parse(resp.payload).content[0].text).toBe("ok");
        expect(resp.metadata?.usage).toBeDefined();
      },
    );
  });

  for (const mode of ["execute", "stream"] as const) {
    test(`${mode}: InvalidGzipErrorBodyReturnsDecodeMessage`, async () => {
      await withUpstream(
        () => new Response("not-a-valid-gzip-stream", { status: 400, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }),
        async (upstream) => {
          const exec = createClaudeExecutor();
          const req = { model: sonnet, payload: hiPayload, format: "claude" as const };
          const err = await expectStatusError(mode === "execute" ? exec.execute(apiKeyAuth(upstream.url), req, claudeOpts()) : exec.executeStream(apiKeyAuth(upstream.url), req, claudeOpts()));
          expect(err.message).toContain("failed to decode error response body");
          expect(err.statusCode).toBe(400);
        },
      );
    });

    test(`${mode}: GzipErrorBodyNoContentEncodingHeader`, async () => {
      const errJSON = `{"type":"error","error":{"type":"invalid_request_error","message":"test error"}}`;
      await withUpstream(
        () => new Response(gzip(errJSON), { status: 400, headers: { "Content-Type": "application/json" } }),
        async (upstream) => {
          const exec = createClaudeExecutor();
          const req = { model: sonnet, payload: hiPayload, format: "claude" as const };
          const err = await expectStatusError(mode === "execute" ? exec.execute(apiKeyAuth(upstream.url), req, claudeOpts()) : exec.executeStream(apiKeyAuth(upstream.url), req, claudeOpts()));
          expect(err.message).toContain(errJSON);
          expect(err.responseBody()).toBe(errJSON);
        },
      );
    });
  }

  test("ExecuteStream_SetsIdentityAcceptEncoding", async () => {
    await withUpstream(
      () => new Response(`data: {"type":"message_stop"}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
      async (upstream) => {
        await collect(await createClaudeExecutor().executeStream(apiKeyAuth(upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expect(lastHeaders(upstream).get("Accept-Encoding")).toBe("identity");
        expect(lastHeaders(upstream).get("Accept")).toBe("text/event-stream");
      },
    );
  });

  test("Execute_SetsCompressedAcceptEncoding", async () => {
    await withUpstream(
      () => jsonResponse(okMessage()),
      async (upstream) => {
        await createClaudeExecutor().execute(apiKeyAuth(upstream.url), { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts());
        expect(lastHeaders(upstream).get("Accept-Encoding")).toBe("gzip, deflate, br, zstd");
        expect(lastHeaders(upstream).get("Accept")).toBe("application/json");
      },
    );
  });

  test("ExecuteStream_AcceptEncodingOverrideCannotBypassIdentity", async () => {
    await withUpstream(
      () => new Response(`data: {"type":"message_stop"}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
      async (upstream) => {
        const auth = apiKeyAuth(upstream.url, { "header:Accept-Encoding": "gzip, deflate, br, zstd" });
        const got = await collect(await createClaudeExecutor().executeStream(auth, { model: sonnet, payload: hiPayload, format: "claude" }, claudeOpts()));
        expect(got.error).toBeUndefined();
        expect(lastHeaders(upstream).get("Accept-Encoding")).toBe("identity");
      },
    );
  });

  test("upstreamModelNormalizer writes the requested model back into the response", async () => {
    await withUpstream(
      () => jsonResponse(okMessage("claude-upstream-x")),
      async (upstream) => {
        const exec = createClaudeExecutor({ upstreamModelNormalizer: () => "claude-upstream-x" });
        const resp = await exec.execute(apiKeyAuth(upstream.url), { model: "alias-model", payload: hiPayload, format: "claude" }, claudeOpts());
        expect(JSON.parse(upstream.requests[0]!.body).model).toBe("claude-upstream-x");
        expect(JSON.parse(resp.payload).model).toBe("alias-model");
      },
    );
  });
});

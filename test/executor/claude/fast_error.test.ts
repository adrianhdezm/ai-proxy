// Ported from: internal/runtime/executor/claude_executor_fast_error_test.go
// Ported from: internal/runtime/executor/claude_request_rate_test.go
// Ported from: internal/runtime/executor/helps/claude_request_rate_test.go
// Skipped cases: none. Adaptations: Go's RequestTerminatedError / RequestScopedError / RetryAfter() map onto
// StatusError (statusCode, body, headers, requestScoped, credentialScoped, retryAfterMs); "errors.Is(transport error)" is
// StatusError.cause. The stream variant of TestClaudeExecutorFastSuccessfulHTTPDecodeErrorDoesNotExposeSuccessStatus
// observes the decode error from the stream iterator, since the response body is decoded lazily. Go's
// "differently cased header keys" rows become repeated values of one Fetch Headers entry (the Headers API is
// case-insensitive); the "http header round trip" row is the plain Headers object.
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { classifyClaudeUpstreamError } from "../../../src/executor/claude/errors.ts";
import { claudeFastModeBeta } from "../../../src/executor/claude/betas.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { newClaudeFastDirectResponseError } from "../../../src/executor/claude/fast_error.ts";
import { maxClaudeRateLimitWindowMs, parseClaudeRateLimitResetForError } from "../../../src/executor/claude/ratelimit.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { claudeOAuthTestMetadata, claudeOpts, collect, fakeFetch, gzip } from "./helpers.ts";

const SECOND = 1000;
const HOUR = 3600 * SECOND;

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected an error");
}

describe("claude_executor_fast_error_test.go", () => {
  const errorJSON = `{"type":"error","error":{"type":"upstream_error","message":"Fast request rejected"}}`;
  const cases = [
    { name: "non-stream OAuth bad request", status: 400, oauth: true },
    { name: "stream OAuth unauthorized", status: 401, stream: true, oauth: true },
    { name: "non-stream API key forbidden", status: 403 },
    { name: "stream OAuth credits refusal", status: 429, stream: true, oauth: true, compressed: true },
    { name: "non-stream OAuth server error", status: 500, oauth: true },
    { name: "stream OAuth beta-only Fast refusal", status: 503, stream: true, oauth: true, betaOnly: true },
  ];
  for (const tc of cases) {
    test(`ClaudeExecutorFastHTTPErrorPassesThroughWithoutRetry/${tc.name}`, async () => {
      const { fetch, requests } = fakeFetch((req) => {
        if (!tc.betaOnly) expect(req.body).toContain(`"speed":"fast"`);
        else expect(req.body).not.toContain(`"speed"`);
        expect(req.headers.get("Anthropic-Beta") ?? "").toContain(claudeFastModeBeta);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        let body: string | Uint8Array = errorJSON;
        if (tc.compressed) {
          body = gzip(errorJSON);
          headers["Content-Encoding"] = "gzip";
        }
        return new Response(body as BodyInit, { status: tc.status, headers });
      });
      const auth = tc.oauth
        ? newAuth({ id: "fast-error-test", provider: "claude", attributes: { api_key: "sk-ant-oat-fast-error", cloak_mode: "always" }, metadata: claudeOAuthTestMetadata() })
        : newAuth({ id: "fast-error-test", provider: "claude", attributes: { api_key: "sk-ant-api03-fast-error" } });
      let payload = `{"model":"claude-opus-5","max_tokens":16,"speed":"fast","messages":[{"role":"user","content":"reply OK"}]}`;
      const opts = claudeOpts({ stream: !!tc.stream, responseFormat: "claude" });
      if (tc.betaOnly) {
        payload = `{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"reply OK"}]}`;
        opts.headers = new Headers({ "Anthropic-Beta": claudeFastModeBeta });
      }
      const exec = createClaudeExecutor({ fetch });
      const req = { model: "claude-opus-5", payload, format: "claude" as const };
      const err = await errorOf(tc.stream ? exec.executeStream(auth, req, opts) : exec.execute(auth, req, opts));
      expect(requests.length).toBe(1);
      expect(err).toBeInstanceOf(StatusError);
      const direct = err as StatusError;
      expect(direct.statusCode).toBe(tc.status);
      expect(direct.body).toBe(errorJSON);
      expect(direct.responseBody()).toBe(errorJSON);
      expect(direct.headers?.get("Content-Encoding") ?? "").toBe("");
      expect(direct.requestScoped).toBe(true);
    });
  }

  for (const mode of ["execute", "stream"] as const) {
    test(`ClaudeExecutorFastSuccessfulHTTPDecodeErrorDoesNotExposeSuccessStatus/${mode}`, async () => {
      const { fetch, requests } = fakeFetch(() => new Response("not-a-gzip-stream", { status: 200, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }));
      const auth = newAuth({ id: "fast-success-decode-error", provider: "claude", attributes: { api_key: "sk-ant-oat-fast-success-decode-error" }, metadata: claudeOAuthTestMetadata() });
      const req = { model: "claude-opus-5", payload: `{"model":"claude-opus-5","max_tokens":16,"speed":"fast","messages":[{"role":"user","content":"reply OK"}]}`, format: "claude" as const };
      const exec = createClaudeExecutor({ fetch });
      let err: unknown;
      if (mode === "execute") {
        err = await errorOf(exec.execute(auth, req, claudeOpts({ responseFormat: "claude" })));
      } else {
        const result = await exec.executeStream(auth, req, claudeOpts({ stream: true, responseFormat: "claude" }));
        err = (await collect(result)).error;
      }
      expect(requests.length).toBe(1);
      expect(err).toBeInstanceOf(StatusError);
      expect((err as StatusError).requestScoped).toBe(true);
      expect((err as StatusError).statusCode).toBe(0);
    });
  }

  test("ClaudeExecutorFastTransportErrorIsRequestScopedWithoutRetry", async () => {
    const upstreamErr = new Error("transport unavailable");
    let attempts = 0;
    const exec = createClaudeExecutor({
      fetch: async () => {
        attempts++;
        throw upstreamErr;
      },
    });
    const auth = newAuth({ id: "fast-transport-error", provider: "claude", attributes: { api_key: "sk-ant-oat-fast-transport" }, metadata: claudeOAuthTestMetadata() });
    const err = await errorOf(
      exec.execute(auth, { model: "claude-opus-5", payload: `{"model":"claude-opus-5","max_tokens":16,"speed":"fast","messages":[{"role":"user","content":"reply OK"}]}`, format: "claude" }, claudeOpts({ responseFormat: "claude" })),
    );
    expect((err as Error).cause).toBe(upstreamErr);
    expect(attempts).toBe(1);
    expect((err as StatusError).requestScoped).toBe(true);
  });

  test("ClaudeExecutorNonFastErrorKeepsCredentialScopedBehavior", async () => {
    const { fetch, requests } = fakeFetch(
      () => new Response(`{"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}`, { status: 429, headers: { "Content-Type": "application/json" } }),
    );
    const auth = newAuth({ id: "standard-rate-limit", provider: "claude", attributes: { api_key: "sk-ant-oat-standard-rate-limit" }, metadata: claudeOAuthTestMetadata() });
    const err = await errorOf(
      createClaudeExecutor({ fetch }).execute(auth, { model: "claude-opus-5", payload: `{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"reply OK"}]}`, format: "claude" }, claudeOpts({ responseFormat: "claude" })),
    );
    expect((err as StatusError).statusCode).toBe(429);
    expect((err as StatusError).message).not.toContain("claude Fast upstream request failed");
    expect((err as StatusError).requestScoped).toBe(false);
    expect(requests.length).toBe(1);
  });
});

describe("claude_request_rate_test.go (Issue #6720)", () => {
  const perMinuteBody = (resource: string) =>
    `{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the ${resource} per minute rate limit. Please try again later."}}`;
  const baseHeaders = (nowMs: number) => new Headers({ "Retry-After": "30", "Anthropic-Ratelimit-Unified-Reset": String(Math.floor((nowMs + 4 * HOUR) / 1000)) });
  const classify = (fast: boolean, headers: Headers, body: string, nowMs: number): number => {
    const err = fast ? newClaudeFastDirectResponseError(429, headers, body, nowMs) : classifyClaudeUpstreamError(429, headers, body, nowMs);
    expect(err.retryAfterMs).toBeDefined();
    return err.retryAfterMs!;
  };

  for (const resource of ["requests", "input tokens", "output tokens"]) {
    for (const fast of [false, true]) {
      test(`ClaudePerMinuteRateLimitHonorsShortRetryAfter/${resource}/${fast ? "fast_direct" : "standard"}`, () => {
        const now = Date.now();
        const got = classify(fast, baseHeaders(now), perMinuteBody(resource), now);
        expect(got).toBeGreaterThanOrEqual(29 * SECOND);
        expect(got).toBeLessThanOrEqual(60 * SECOND);
      });
    }
  }

  const conservative: Array<{ name: string; body: string; mutate?: (h: Headers) => void }> = [
    { name: "explicit unified status", body: perMinuteBody("requests"), mutate: (h) => h.set("Anthropic-Ratelimit-Unified-Status", "rejected") },
    { name: "unknown message wording", body: `{"type":"error","error":{"type":"rate_limit_error","message":"The requests per minute limit is mentioned for information only."}}` },
    {
      name: "mixed quota message",
      body: `{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the requests per minute rate limit. Please try again later. Your weekly usage quota is exhausted."}}`,
    },
    {
      name: "repeated retry-after values",
      body: perMinuteBody("requests"),
      mutate: (h) => {
        h.set("Retry-After", "30");
        h.append("Retry-After", "14400");
      },
    },
    { name: "missing retry-after", body: perMinuteBody("requests"), mutate: (h) => h.delete("Retry-After") },
    { name: "malformed body", body: `{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the requests per minute rate limit. Please try again later."}` },
  ];
  for (const tc of conservative) {
    for (const fast of [false, true]) {
      test(`ClaudePerMinuteRateLimitKeepsConservativeQuota/${tc.name}/${fast ? "fast_direct" : "standard"}`, () => {
        const now = Date.now();
        const headers = baseHeaders(now);
        tc.mutate?.(headers);
        const got = classify(fast, headers, tc.body, now);
        expect(got).toBeGreaterThanOrEqual(4 * HOUR - 2 * SECOND);
        expect(got).toBeLessThanOrEqual(4 * HOUR + 30 * SECOND);
      });
    }
  }
});

describe("helps/claude_request_rate_test.go", () => {
  const now = Date.UTC(2026, 9, 17, 14, 0, 0);
  const unifiedReset = String(Math.floor((now + 4 * HOUR) / 1000));
  const perMinute = `{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the requests per minute rate limit. Please try again later."}}`;
  const short = { min: 31 * SECOND, max: 60 * SECOND };
  const long = { min: 4 * HOUR + SECOND, max: 4 * HOUR + 30 * SECOND };
  const cases: Array<{ name: string; body?: string; mutate?: (h: Headers) => void; want?: { min: number; max: number }; wantNil?: boolean; nilHeaders?: boolean }> = [
    { name: "nil headers", body: perMinute, nilHeaders: true, wantNil: true },
    { name: "short retry honored", body: perMinute, want: short },
    { name: "http date retry honored", body: perMinute, mutate: (h) => h.set("Retry-After", new Date(now + 30 * SECOND).toUTCString()), want: short },
    {
      name: "message case and whitespace ignored",
      body: `{"type":"error","error":{"type":"rate_limit_error","message":"  THIS REQUEST WOULD EXCEED THE REQUESTS PER MINUTE RATE LIMIT. PLEASE TRY AGAIN LATER.\\n"}}`,
      want: short,
    },
    { name: "empty alias status values do not block", body: perMinute, mutate: (h) => h.set("anthropic-ratelimit-unified-status", ""), want: short },
    {
      name: "maximum usable retry honored",
      body: perMinute,
      mutate: (h) => h.set("Retry-After", String(Math.floor(maxClaudeRateLimitWindowMs / SECOND))),
      want: { min: maxClaudeRateLimitWindowMs + SECOND, max: maxClaudeRateLimitWindowMs + 30 * SECOND },
    },
    {
      name: "nonempty alias status blocks",
      body: perMinute,
      mutate: (h) => {
        h.set("Anthropic-Ratelimit-Unified-Status", "");
        h.append("anthropic-ratelimit-unified-status", "");
        h.append("anthropic-ratelimit-unified-status", "rejected");
      },
      want: long,
    },
    { name: "allowed shared window already excludes unified reset", body: perMinute, mutate: (h) => h.set("Anthropic-Ratelimit-Unified-5h-Status", "allowed"), want: short },
    {
      name: "aliased retry-after keys are ambiguous",
      body: perMinute,
      mutate: (h) => {
        h.delete("Retry-After");
        h.append("retry-after", "30");
        h.append("RETRY-AFTER", "30");
      },
      want: long,
    },
    { name: "unusable retry beyond recoverable window", body: perMinute, mutate: (h) => h.set("Retry-After", String(Math.floor(maxClaudeRateLimitWindowMs / SECOND) + 1)), want: long },
    {
      name: "lowercase headers honored",
      body: perMinute,
      mutate: (h) => {
        h.delete("Retry-After");
        h.delete("Anthropic-Ratelimit-Unified-Reset");
        h.set("retry-after", "30");
        h.set("anthropic-ratelimit-unified-reset", unifiedReset);
      },
      want: short,
    },
    { name: "differently cased unified resets all excluded", body: perMinute, mutate: (h) => h.append("anthropic-ratelimit-unified-reset", String(Math.floor((now + 2 * HOUR) / 1000))), want: short },
    { name: "http header round trip honored", body: perMinute, want: short },
    { name: "nil body keeps conservative result", body: "", want: long },
    { name: "invalid retry keeps conservative result", body: perMinute, mutate: (h) => h.set("Retry-After", "invalid"), want: long },
    { name: "zero retry keeps conservative result", body: perMinute, mutate: (h) => h.set("Retry-After", "0"), want: long },
    { name: "negative retry keeps conservative result", body: perMinute, mutate: (h) => h.set("Retry-After", "-30"), want: long },
    { name: "overflow retry keeps conservative result", body: perMinute, mutate: (h) => h.set("Retry-After", "1e300"), want: long },
    {
      name: "wrong error type",
      body: `{"type":"error","error":{"type":"api_error","message":"This request would exceed the requests per minute rate limit. Please try again later."}}`,
      want: long,
    },
    {
      name: "overage-only rejection keeps no credential cooldown",
      body: perMinute,
      mutate: (h) => {
        h.set("Anthropic-Ratelimit-Unified-Status", "rejected");
        h.set("Anthropic-Ratelimit-Unified-5h-Status", "allowed");
        h.set("Anthropic-Ratelimit-Unified-7d-Status", "allowed");
        h.set("Anthropic-Ratelimit-Unified-Overage-Status", "rejected");
      },
      wantNil: true,
    },
  ];
  for (const tc of cases) {
    test(`ParseClaudeRateLimitResetForError_Issue6720/${tc.name}`, () => {
      let headers: Headers | undefined;
      if (!tc.nilHeaders) {
        headers = new Headers({ "Retry-After": "30", "Anthropic-Ratelimit-Unified-Reset": unifiedReset });
        tc.mutate?.(headers);
      }
      const before = headers ? [...headers.entries()] : undefined;
      const got = parseClaudeRateLimitResetForError(headers, tc.body ?? "", now);
      if (headers) expect([...headers.entries()]).toEqual(before!);
      if (tc.wantNil) {
        expect(got).toBeUndefined();
        return;
      }
      expect(got).toBeDefined();
      expect(got!).toBeGreaterThanOrEqual(tc.want!.min);
      expect(got!).toBeLessThanOrEqual(tc.want!.max);
    });
  }
});

// Ported from: internal/runtime/executor/openai_compat_executor_retry_test.go
// Skipped cases: none (inbound payloads adapted to Claude Messages requests).
import { afterAll, describe, expect, test } from "bun:test";
import { OpenAICompatExecutor, openAICompatRetryAfter } from "../../../src/executor/openai/index.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { FormatClaude } from "../../../src/translator/types.ts";
import { apiKeyAuth, jsonResponse, startUpstream } from "./helpers.ts";

const Second = 1000;
const Minute = 60 * Second;

describe("openAICompatRetryAfter", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  const cases: Array<{ name: string; status: number; headers?: Record<string, string>; body?: string; want?: number }> = [
    { name: "delta seconds header", status: 429, headers: { "Retry-After": "17" }, want: 17 * Second },
    { name: "http date header", status: 429, headers: { "Retry-After": new Date(now + 23 * Second).toUTCString() }, want: 23 * Second },
    { name: "explicit TPM code fallback", status: 429, body: `{"error":{"code":"ModelAccountTpmRateLimitExceeded","message":"TPM limit exceeded"}}`, want: Minute },
    { name: "TPM message fallback", status: 429, body: `{"error":{"message":"TPM (Tokens Per Minute) limit of this model is exceeded"}}`, want: Minute },
    { name: "provider header wins over fallback", status: 429, headers: { "Retry-After": "5" }, body: `{"error":{"code":"ModelAccountTpmRateLimitExceeded"}}`, want: 5 * Second },
    { name: "generic 429 has no invented deadline", status: 429, body: `{"error":{"code":"rate_limit"}}` },
    { name: "non-429 ignores header", status: 503, headers: { "Retry-After": "30" } },
    { name: "explicit zero stays distinguishable from absent", status: 429, headers: { "Retry-After": "0" }, want: 0 },
    { name: "past http date clamps to zero", status: 429, headers: { "Retry-After": new Date(now - 10 * Second).toUTCString() }, want: 0 },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const got = openAICompatRetryAfter(tt.status, tt.headers ? new Headers(tt.headers) : undefined, tt.body ?? "", now);
      expect(got).toBe(tt.want);
    });
  }
});

describe("OpenAICompatExecutor propagates Retry-After", () => {
  const upstream = startUpstream(() => jsonResponse(`{"error":{"code":"rate_limit","message":"try later"}}`, 429, { "Retry-After": "7" }));
  afterAll(() => upstream.close());

  const executor = new OpenAICompatExecutor();
  const auth = apiKeyAuth({ baseURL: upstream.baseURL, apiKey: "test" });
  const request = { model: "compatible-model", payload: `{"model":"compatible-model","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, format: FormatClaude };

  test("nonstream", async () => {
    let caught: unknown;
    try {
      await executor.execute(auth, request, { stream: false, sourceFormat: FormatClaude });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StatusError);
    const err = caught as StatusError;
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(7 * Second);
    expect(err.responseBody()).toBe(`{"error":{"code":"rate_limit","message":"try later"}}`);
    expect(err.headers?.get("Retry-After")).toBe("7");
  });

  test("stream bootstrap", async () => {
    let caught: unknown;
    try {
      await executor.executeStream(auth, request, { stream: true, sourceFormat: FormatClaude });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StatusError);
    const err = caught as StatusError;
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(7 * Second);
    expect(err.requestScoped).toBe(false);
    expect(err.streamTruncated).toBe(false);
  });
});

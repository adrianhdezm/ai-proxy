// Ported from: test/codex_quota_failover_test.go
// Skipped cases: the "websocket-error" and "websocket-failed" transports of both tests (websockets not ported).
//   Inbound requests are Claude Messages (Go used openai-response), so the "response.created" /
//   "response.completed" payload checks become message_start / message_stop.
import { afterAll, describe, expect, test } from "bun:test";
import { StatusError } from "../../../src/executor/types.ts";
import { accountOf, claudePayload, codexManager, drain, options, sseResponse, startUpstream } from "./helpers.ts";

const created = `{"type":"response.created","response":{"id":"quota-test-response"}}`;
const quota = `{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":3600}`;
const completed = `{"type":"response.completed","response":{"id":"quota-test-success","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`;
const Hour = 3_600_000;

describe("TestCodexTerminalQuotaCoolsAccountAcrossModels/sse", () => {
  const model = "gpt-5.4";
  const siblingModel = "gpt-5.4-mini";
  const attempts: string[] = [];
  const upstream = startUpstream((req) => {
    const account = accountOf(req);
    attempts.push(account);
    const terminal = account === "quota-high" ? `{"type":"error","status":429,"error":${quota}}` : completed;
    return sseResponse(`data: ${created}\n\ndata: ${terminal}\n\n`);
  });
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 0 });
  const highID = "quota-high-sse";
  const lowID = "quota-low-sse";
  harness.addAuth(highID, "quota-high", upstream.url, { priority: 4, disableCooling: false, models: [model, siblingModel] });
  harness.addAuth(lowID, "quota-low", upstream.url, { priority: 3, disableCooling: false, models: [model, siblingModel] });
  afterAll(() => {
    harness.cleanup();
    upstream.close();
  });

  const run = async (requestModel: string) => {
    const result = await harness.manager.executeStream(["codex"], { model: requestModel, payload: claudePayload(requestModel), format: "claude" }, options("claude", true));
    const { chunks, error } = await drain(result);
    return { payload: chunks.join(""), error };
  };

  test("a terminal usage limit cools the whole account and the sibling model fails over", async () => {
    const before = Date.now();
    const first = await run(model);
    expect(first.payload).toContain("event: message_start");
    expect(first.error).toBeInstanceOf(StatusError);
    expect((first.error as StatusError).statusCode).toBe(429);
    expect((first.error as StatusError).credentialScoped).toBe(true);

    const high = harness.manager.getById(highID)!;
    expect(high.quota.reason).toBe("credential_quota");
    expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + Hour);

    const sibling = await run(siblingModel);
    expect(sibling.error).toBeUndefined();
    expect(sibling.payload).toContain("event: message_stop");
    expect(attempts).toEqual(["quota-high", "quota-low"]);
  });
});

describe("TestCodexModelLevelCoolingPreservesSiblingModel/sse", () => {
  const model = "gpt-5.3-codex-spark";
  const siblingModel = "gpt-5.6-sol";
  const attempts: string[] = [];
  const upstream = startUpstream((req) => {
    const account = accountOf(req);
    attempts.push(account);
    const terminal = account === "quota-high" && req.body.includes(model) ? `{"type":"error","status":429,"error":${quota}}` : completed;
    return sseResponse(`data: ${created}\n\ndata: ${terminal}\n\n`);
  });
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 0 }, { modelLevelCooling: true });
  const highID = "quota-high-mlc-sse";
  const lowID = "quota-low-mlc-sse";
  harness.addAuth(highID, "quota-high", upstream.url, { priority: 4, disableCooling: false, models: [model, siblingModel] });
  harness.addAuth(lowID, "quota-low", upstream.url, { priority: 3, disableCooling: false, models: [model, siblingModel] });
  afterAll(() => {
    harness.cleanup();
    upstream.close();
  });

  const run = async (requestModel: string) => {
    const result = await harness.manager.executeStream(["codex"], { model: requestModel, payload: claudePayload(requestModel), format: "claude" }, options("claude", true));
    const { chunks, error } = await drain(result);
    return { payload: chunks.join(""), error };
  };

  test("only the model cools and the sibling stays on the same account", async () => {
    const before = Date.now();
    const first = await run(model);
    expect(first.payload).toContain("event: message_start");
    expect(first.error).toBeInstanceOf(StatusError);
    expect((first.error as StatusError).credentialScoped).toBe(false);

    const high = harness.manager.getById(highID)!;
    expect(high.quota.reason).not.toBe("credential_quota");
    expect(high.quota.reason).toBe("quota");
    expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + Hour);

    const sibling = await run(siblingModel);
    expect(sibling.error).toBeUndefined();
    expect(sibling.payload).toContain("event: message_stop");
    expect(attempts).toEqual(["quota-high", "quota-high"]);
  });
});

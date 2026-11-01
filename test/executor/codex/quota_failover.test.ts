// Ported from: test/codex_quota_failover_test.go
// Skipped cases: none. The "sse" transport sends Claude Messages inbound (Go used openai-response), so its
//   "response.created" / "response.completed" payload checks become message_start / message_stop; the
//   "websocket-error" and "websocket-failed" transports run the Codex websocket executor with openai-response
//   inbound exactly like Go.
import { afterAll, describe, expect, test } from "bun:test";
import { StatusError } from "../../../src/executor/types.ts";
import { AuthManager } from "../../../src/auth/manager/index.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { CodexWebsocketSessionStore, CodexWebsocketsExecutor } from "../../../src/executor/codex/index.ts";
import { getGlobalRegistry } from "../../../src/registry/index.ts";
import { accountOf, claudePayload, codexManager, drain, options, sseResponse, startUpstream } from "./helpers.ts";
import { startFakeCodexWebsocket } from "./websocket_helpers.ts";

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

// ---------------------------------------------------------------------------
// Websocket transports (Go: the "websocket-error" / "websocket-failed" subtests)
// ---------------------------------------------------------------------------

function websocketQuotaHarness(transport: string, model: string, siblingModel: string, terminalFor: (account: string, request: string) => string, modelLevelCooling: boolean) {
  const attempts: string[] = [];
  const upstream = startFakeCodexWebsocket({
    onMessage(conn, message) {
      const account = (conn.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      attempts.push(account);
      conn.send(created);
      conn.send(terminalFor(account, message));
      conn.close();
    },
  });
  const manager = new AuthManager({ sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(0, 0, 0);
  manager.registerExecutor(new CodexWebsocketsExecutor({ modelLevelCooling, store: new CodexWebsocketSessionStore() }));
  const ids = [`quota-high-${transport}${modelLevelCooling ? "-mlc" : ""}`, `quota-low-${transport}${modelLevelCooling ? "-mlc" : ""}`];
  ids.forEach((id, i) => {
    getGlobalRegistry().registerClient(id, "codex", [model, siblingModel].map((m) => ({ id: m, type: "codex" })));
    manager.register(newAuth({ id, provider: "codex", attributes: { priority: String(4 - i), base_url: upstream.url, api_key: i === 0 ? "quota-high" : "quota-low" }, metadata: { disable_cooling: false } }));
  });
  const run = async (requestModel: string) => {
    const result = await manager.executeStream(["codex"], { model: requestModel, payload: JSON.stringify({ model: requestModel, input: "hello" }), format: "openai-response" }, options("openai-response", true));
    const { chunks, error } = await drain(result);
    return { payload: chunks.join(""), error };
  };
  return {
    attempts,
    manager,
    highID: ids[0]!,
    run,
    cleanup() {
      for (const id of ids) getGlobalRegistry().unregisterClient(id);
      upstream.close();
    },
  };
}

function quotaTerminal(transport: string): string {
  return transport === "websocket-failed" ? `{"type":"response.failed","response":{"error":${quota}}}` : `{"type":"error","status":429,"error":${quota}}`;
}

for (const transport of ["websocket-error", "websocket-failed"]) {
  describe(`TestCodexTerminalQuotaCoolsAccountAcrossModels/${transport}`, () => {
    const model = "gpt-5.4";
    const siblingModel = "gpt-5.4-mini";
    const harness = websocketQuotaHarness(transport, model, siblingModel, (account) => (account === "quota-high" ? quotaTerminal(transport) : completed), false);
    afterAll(() => harness.cleanup());

    test("a terminal usage limit cools the whole account and the sibling model fails over", async () => {
      const before = Date.now();
      const first = await harness.run(model);
      expect(first.payload).toContain("response.created");
      expect(first.error).toBeInstanceOf(StatusError);
      expect((first.error as StatusError).credentialScoped).toBe(true);
      const high = harness.manager.getById(harness.highID)!;
      expect(high.quota.reason).toBe("credential_quota");
      expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + Hour);
      const sibling = await harness.run(siblingModel);
      expect(sibling.error).toBeUndefined();
      expect(sibling.payload).toContain("response.completed");
      expect(harness.attempts).toEqual(["quota-high", "quota-low"]);
    });
  });

  describe(`TestCodexModelLevelCoolingPreservesSiblingModel/${transport}`, () => {
    const model = "gpt-5.3-codex-spark";
    const siblingModel = "gpt-5.6-sol";
    const harness = websocketQuotaHarness(transport, model, siblingModel, (account, request) => (account === "quota-high" && request.includes(model) ? quotaTerminal(transport) : completed), true);
    afterAll(() => harness.cleanup());

    test("only the model cools and the sibling stays on the same account", async () => {
      const before = Date.now();
      const first = await harness.run(model);
      expect(first.payload).toContain("response.created");
      expect(first.error).toBeInstanceOf(StatusError);
      expect((first.error as StatusError).credentialScoped).toBe(false);
      const high = harness.manager.getById(harness.highID)!;
      expect(high.quota.reason).not.toBe("credential_quota");
      expect(high.quota.reason).toBe("quota");
      expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + Hour);
      const sibling = await harness.run(siblingModel);
      expect(sibling.error).toBeUndefined();
      expect(sibling.payload).toContain("response.completed");
      expect(harness.attempts).toEqual(["quota-high", "quota-high"]);
    });
  });
}

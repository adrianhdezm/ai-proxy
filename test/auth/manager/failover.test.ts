// Ported from: test/codex_quota_failover_test.go
// Ported from: test/codex_stream_disconnect_failover_test.go
// Skipped cases: the websocket-error / websocket-failed transports and the stream-bootstrap-buffering variants (the real
// Codex executor is replaced by a fake ProviderExecutor; a second copy of these tests runs against the Codex executor
// once it lands), TestCodexStreamDisconnectExhaustionNotInvalidRequestError is checked at the manager boundary (the
// surfaced error is the upstream transport error, not a request-scoped one) instead of through the HTTP handler.
import { expect, test } from "bun:test";
import { isRequestInvalidError, isRequestScopedError } from "../../../src/auth/manager/index.ts";
import { statusCodeOf } from "../../../src/executor/types.ts";
import { Hour, auth, drain, fakeExecutor, newManager, opts, registerModels, req, statusError, streamOf, type TestManager } from "./helpers.ts";

const created = `data: {"type":"response.created","response":{"id":"quota-test-response"}}\n\n`;
const completed = `data: {"type":"response.completed","response":{"id":"quota-test-success","status":"completed","output":[]}}\n\n`;
const usageLimitBody = `{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_in_seconds":3600}}`;

function registerAccounts(tm: TestManager, ids: Array<{ id: string; priority: string; cooling?: boolean }>, ...models: string[]): void {
  for (const { id, priority, cooling } of ids) {
    registerModels(tm.registry, id, "codex", ...models);
    tm.manager.register(auth({ id, provider: "codex", attributes: { priority, api_key: id }, metadata: { disable_cooling: cooling === false } }));
  }
}

test("CodexTerminalQuotaCoolsAccountAcrossModels", async () => {
  const model = "gpt-5.4";
  const siblingModel = "gpt-5.4-mini";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  const attempts: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a) => {
        attempts.push(a.id);
        if (a.id === "quota-high") {
          // The real Codex executor marks usage_limit_reached as credential scoped with resets_in_seconds as the hint.
          return streamOf([created, statusError(429, usageLimitBody, { retryAfterMs: 3600 * 1000, credentialScoped: true })]);
        }
        return streamOf([created, completed]);
      },
    }),
  );
  registerAccounts(tm, [{ id: "quota-high", priority: "4", cooling: true }, { id: "quota-low", priority: "3", cooling: true }], model, siblingModel);

  const before = tm.clock.now();
  const first = await drain(await tm.manager.executeStream(["codex"], req(model), opts({ stream: true })));
  expect(first.payload).toContain("response.created");
  expect(first.error).toBeDefined();
  expect((first.error as { credentialScoped?: boolean }).credentialScoped).toBe(true);
  const high = tm.manager.getById("quota-high")!;
  expect(high.quota.reason).toBe("credential_quota");
  expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + Hour);

  const sibling = await drain(await tm.manager.executeStream(["codex"], req(siblingModel), opts({ stream: true })));
  expect(sibling.error).toBeUndefined();
  expect(sibling.payload).toContain("response.completed");
  expect(attempts).toEqual(["quota-high", "quota-low"]);
});

test("CodexModelLevelCoolingPreservesSiblingModel", async () => {
  const model = "gpt-5.3-codex-spark";
  const siblingModel = "gpt-5.6-sol";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  const attempts: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a, r) => {
        attempts.push(a.id);
        if (a.id === "quota-high" && r.model === model) {
          // With model-level cooling the Codex executor does not flag the error as credential scoped.
          return streamOf([created, statusError(429, usageLimitBody, { retryAfterMs: 3600 * 1000 })]);
        }
        return streamOf([created, completed]);
      },
    }),
  );
  registerAccounts(tm, [{ id: "quota-high", priority: "4", cooling: true }, { id: "quota-low", priority: "3", cooling: true }], model, siblingModel);

  const before = tm.clock.now();
  const first = await drain(await tm.manager.executeStream(["codex"], req(model), opts({ stream: true })));
  expect(first.payload).toContain("response.created");
  expect(first.error).toBeDefined();
  expect((first.error as { credentialScoped?: boolean }).credentialScoped).toBe(false);
  const high = tm.manager.getById("quota-high")!;
  expect(high.quota.reason).toBe("quota");
  expect(high.quota.nextRecoverAt).toBeGreaterThanOrEqual(before + Hour);

  const sibling = await drain(await tm.manager.executeStream(["codex"], req(siblingModel), opts({ stream: true })));
  expect(sibling.error).toBeUndefined();
  expect(sibling.payload).toContain("response.completed");
  expect(attempts).toEqual(["quota-high", "quota-high"]);
});

// Issue #6247: upstream A sends 200 headers and closes before any SSE bytes; the gateway must fail over to B.
test("CodexStreamDisconnectAfterHeadersFailsOver", async () => {
  const model = "gpt-6-astra";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 2);
  const attempts: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a) => {
        attempts.push(a.id);
        const headers = new Headers({ "Content-Type": "text/event-stream" });
        if (a.id === "account-a") return streamOf([new Error("unexpected EOF")], headers);
        return streamOf([`data: {"type":"response.created","response":{"id":"resp_b","model":"${model}"}}\n\n`, `data: {"type":"response.output_text.delta","delta":"MOCK_B"}\n\n`, completed], headers);
      },
    }),
  );
  registerAccounts(tm, [{ id: "account-a", priority: "100" }, { id: "account-b", priority: "0" }], model);

  const result = await tm.manager.executeStream(["codex"], req(model), opts({ stream: true, responseFormat: "openai-response" }));
  const drained = await drain(result);
  expect(drained.error).toBeUndefined();
  expect(drained.payload).toContain("MOCK_B");
  expect(drained.payload).toContain("response.completed");
  expect(attempts).toEqual(["account-a", "account-b"]);
});

// A stream that closes cleanly with no bytes at all is a bootstrap failure as well.
test("CodexStreamEmptyBeforeOutputFailsOver", async () => {
  const model = "gpt-6-astra";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 2);
  const attempts: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a) => {
        attempts.push(a.id);
        if (a.id === "account-a") return streamOf([]);
        return streamOf([created, completed]);
      },
    }),
  );
  registerAccounts(tm, [{ id: "account-a", priority: "100" }, { id: "account-b", priority: "0" }], model);
  const drained = await drain(await tm.manager.executeStream(["codex"], req(model), opts({ stream: true })));
  expect(drained.error).toBeUndefined();
  expect(drained.payload).toContain("response.completed");
  expect(attempts).toEqual(["account-a", "account-b"]);
});

// When every credential disconnects before output, the surfaced error is the upstream failure, never an invalid request.
test("CodexStreamDisconnectExhaustionNotInvalidRequestError", async () => {
  const model = "gpt-6-astra";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  const upstream = new Error("unexpected EOF");
  tm.manager.registerExecutor(fakeExecutor({ stream: () => streamOf([upstream], new Headers({ "Content-Type": "text/event-stream" })) }));
  registerAccounts(tm, [{ id: "codex-exhaustion-test", priority: "0" }], model);

  const result = await tm.manager.executeStream(["codex"], req(model), opts({ stream: true }));
  const drained = await drain(result);
  expect(drained.chunks).toHaveLength(0);
  expect(drained.error).toBe(upstream);
  expect(isRequestScopedError(drained.error)).toBe(false);
  expect(isRequestInvalidError(drained.error)).toBe(false);
  expect(statusCodeOf(drained.error)).toBeUndefined();
});

// Upstream A disconnects AFTER emitting output: no failover (replaying partial output is unsafe); the error ends the stream.
test("CodexStreamDisconnectAfterOutputDoesNotFailOver", async () => {
  const model = "gpt-6-astra";
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 2);
  const attempts: string[] = [];
  const truncated = statusError(502, "upstream stream ended before a terminal event", { streamTruncated: true });
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a) => {
        attempts.push(a.id);
        return streamOf([`data: {"type":"response.created","response":{"id":"resp_a","model":"${model}"}}\n\n`, `data: {"type":"response.output_text.delta","delta":"MOCK_A_PARTIAL"}\n\n`, truncated]);
      },
    }),
  );
  registerAccounts(tm, [{ id: "account-a", priority: "100" }, { id: "account-b", priority: "0" }], model);

  const drained = await drain(await tm.manager.executeStream(["codex"], req(model), opts({ stream: true })));
  expect(drained.payload).toContain("MOCK_A_PARTIAL");
  expect(drained.error).toBe(truncated);
  expect(attempts).toEqual(["account-a"]);
  // A truncated accepted stream never cools the credential.
  const a = tm.manager.getById("account-a")!;
  expect(a.modelStates?.[model]?.unavailable ?? false).toBe(false);
});

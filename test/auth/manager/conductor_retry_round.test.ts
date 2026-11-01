// Ported from: sdk/cliproxy/auth/conductor_retry_round_test.go
// Skipped cases: TestExecuteHomeRetryRoundCredentialWindows (Home dispatcher not ported).
import { expect, test } from "bun:test";
import type { StreamResult } from "../../../src/executor/types.ts";
import { auth, fakeExecutor, newManager, opts, registerModels, rejection, req, statusError, streamOf, type TestManager } from "./helpers.ts";

function registerRetryRoundLocalAuths(tm: TestManager, provider: string, model: string, limits: Record<string, number>): string[] {
  const ids = Object.keys(limits).sort();
  for (const id of ids) {
    registerModels(tm.registry, id, provider, model);
    tm.manager.register(auth({ id, provider, metadata: { request_retry: limits[id], disable_cooling: true } }));
  }
  return ids;
}

function counts(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

const failure = () => statusError(500, "retry-round test failure");

test("ExecuteRetryRoundCredentialWindows", async () => {
  const paths: Array<{ name: string; kind: "executeCalls" | "countCalls" | "streamCalls"; invoke: (tm: TestManager) => Promise<unknown> }> = [
    { name: "non-stream", kind: "executeCalls", invoke: (tm) => tm.manager.execute(["retry-round-test"], req("retry-round-model"), opts()) },
    { name: "count-tokens", kind: "countCalls", invoke: (tm) => tm.manager.executeCount(["retry-round-test"], req("retry-round-model"), opts()) },
    { name: "stream", kind: "streamCalls", invoke: (tm) => tm.manager.executeStream(["retry-round-test"], req("retry-round-model"), opts({ stream: true })) },
  ];
  for (const path of paths) {
    const tm = newManager();
    tm.manager.setRetryConfig(3, 0, 0);
    const executor = fakeExecutor({
      identifier: "retry-round-test",
      execute: () => Promise.reject(failure()),
      count: () => Promise.reject(failure()),
      stream: () => Promise.reject(failure()),
    });
    tm.manager.registerExecutor(executor);
    registerRetryRoundLocalAuths(tm, "retry-round-test", "retry-round-model", { "retry-round-a": 3, "retry-round-b": 2, "retry-round-c": 2 });

    const err = await rejection(path.invoke(tm));
    expect(err).toBeDefined();
    const got = counts(executor[path.kind]);
    expect(got, path.name).toEqual({ "retry-round-a": 4, "retry-round-b": 3, "retry-round-c": 3 });
  }
});

test("ExecuteRetryRoundMaxCredentialsAgesSkippedAuths", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(2, 0, 3);
  const executor = fakeExecutor({ identifier: "retry-round-test", execute: () => Promise.reject(failure()) });
  tm.manager.registerExecutor(executor);
  registerRetryRoundLocalAuths(tm, "retry-round-test", "retry-round-model-cap", { "retry-cap-a": 1, "retry-cap-b": 1, "retry-cap-c": 1, "retry-cap-d": 2 });

  await rejection(tm.manager.execute(["retry-round-test"], req("retry-round-model-cap"), opts()));
  const calls = executor.executeCalls;
  expect(calls).toHaveLength(7);
  const got = counts(calls);
  expect(got["retry-cap-a"]!).toBeLessThanOrEqual(2);
  expect(got["retry-cap-b"]!).toBeLessThanOrEqual(2);
  expect(got["retry-cap-c"]!).toBeLessThanOrEqual(2);
  expect(got["retry-cap-d"]!).toBeLessThanOrEqual(3);
  expect(calls[calls.length - 1]).toBe("retry-cap-d");
});

test("ExecuteSnapshotsDefaultRequestRetry", async () => {
  const paths: Array<{ name: string; invoke: (tm: TestManager) => Promise<unknown> }> = [
    { name: "non-stream", invoke: (tm) => tm.manager.execute(["retry-config-snapshot"], req("retry-config-snapshot-model"), opts()) },
    { name: "count-tokens", invoke: (tm) => tm.manager.executeCount(["retry-config-snapshot"], req("retry-config-snapshot-model"), opts()) },
    { name: "stream", invoke: (tm) => tm.manager.executeStream(["retry-config-snapshot"], req("retry-config-snapshot-model"), opts({ stream: true })) },
  ];
  const scenarios = [
    { name: "decrease after request starts", initial: 1, next: 0, wantCalls: 2, wantSuccess: true },
    { name: "increase after request starts", initial: 0, next: 1, wantCalls: 1, wantSuccess: false },
  ];
  for (const path of paths) {
    for (const scenario of scenarios) {
      const tm = newManager();
      tm.manager.setRetryConfig(scenario.initial, 0, 0);
      let calls = 0;
      const recordCall = () => {
        calls++;
        if (calls === 1) tm.manager.setRetryConfig(scenario.next, 0, 0);
        return calls;
      };
      const executor = fakeExecutor({
        identifier: "retry-config-snapshot",
        execute: () => (recordCall() === 1 ? Promise.reject(statusError(500, "retry config changed")) : { payload: "ok" }),
        count: () => (recordCall() === 1 ? Promise.reject(statusError(500, "retry config changed")) : { payload: "ok" }),
        stream: (): Promise<StreamResult> => (recordCall() === 1 ? Promise.reject(statusError(500, "retry config changed")) : Promise.resolve(streamOf([]))),
      });
      tm.manager.registerExecutor(executor);
      registerModels(tm.registry, "retry-config-snapshot-auth", "retry-config-snapshot", "retry-config-snapshot-model");
      tm.manager.register(auth({ id: "retry-config-snapshot-auth", provider: "retry-config-snapshot", metadata: { disable_cooling: true } }));

      let errExecute: unknown;
      try {
        await path.invoke(tm);
      } catch (err) {
        errExecute = err;
      }
      const label = `${path.name}/${scenario.name}`;
      if (scenario.wantSuccess) expect(errExecute, label).toBeUndefined();
      else expect((errExecute as { statusCode?: number })?.statusCode, label).toBe(500);
      expect(calls, label).toBe(scenario.wantCalls);
    }
  }
});

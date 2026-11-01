// Ported from: sdk/cliproxy/auth/conductor_stream_overload_failover_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import type { StreamResult } from "../../../src/executor/types.ts";
import { auth, drain, fakeExecutor, newManager, opts, registerModels, req, statusError, streamOf, type TestManager } from "./helpers.ts";

/** Registers n active codex credentials with descending priority so the pick order is deterministic. */
function registerOverloadAuths(tm: TestManager, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `auth-overload-${i + 1}`;
    registerModels(tm.registry, id, "codex", "gpt-5.6-terra");
    tm.manager.register(auth({ id, provider: "codex", attributes: { priority: String(100 - i) } }));
    ids.push(id);
  }
  return ids;
}

const overloadStatusError = () => statusError(503, `{"error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null}}`);
const capacityStatusError = () => statusError(429, `{"error":{"message":"Selected model is at capacity. Please try a different model."}}`);
const successStreamResult = (): StreamResult => streamOf([`data: {"type":"response.output_item.added"}`, `data: {"type":"response.completed"}`], new Headers({ "Content-Type": "text/event-stream" }));

test("ExecuteStream_BootstrapOverload_SkipsConsecutiveOverloadedCredentials", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 0, 6);
  const ids = registerOverloadAuths(tm, 6);
  const overloaded = new Set(ids.slice(0, 3));
  const order: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a) => {
        order.push(a.id);
        if (overloaded.has(a.id)) return Promise.reject(overloadStatusError());
        return successStreamResult();
      },
    }),
  );
  const result = await tm.manager.executeStream(["codex"], req("gpt-5.6-terra"), opts({ stream: true }));
  const drained = await drain(result);
  expect(drained.error).toBeUndefined();
  expect(order).toHaveLength(4);
  for (let i = 0; i < 3; i++) expect(overloaded.has(order[i]!)).toBe(true);
  expect(overloaded.has(order[3]!)).toBe(false);
});

test("ExecuteStream_BootstrapCapacity_SkipsConsecutiveOverloadedCredentials", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 0, 6);
  const ids = registerOverloadAuths(tm, 6);
  const atCapacity = new Set(ids.slice(0, 3));
  const order: string[] = [];
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: (a) => {
        order.push(a.id);
        if (atCapacity.has(a.id)) return Promise.reject(capacityStatusError());
        return successStreamResult();
      },
    }),
  );
  const result = await tm.manager.executeStream(["codex"], req("gpt-5.6-terra"), opts({ stream: true }));
  const drained = await drain(result);
  expect(drained.error).toBeUndefined();
  expect(order).toHaveLength(4);
  for (let i = 0; i < 3; i++) expect(atCapacity.has(order[i]!)).toBe(true);
  expect(atCapacity.has(order[3]!)).toBe(false);
});

test("ExecuteStream_BootstrapOverload_StopsAtCredentialBudget", async () => {
  const tm = newManager();
  // Six credentials exist and only four may be attempted in one round.
  tm.manager.setRetryConfig(5, 0, 4);
  registerOverloadAuths(tm, 6);
  let attempts = 0;
  tm.manager.registerExecutor(
    fakeExecutor({
      stream: () => {
        attempts++;
        return Promise.reject(overloadStatusError());
      },
    }),
  );
  let errStream: unknown;
  try {
    await tm.manager.executeStream(["codex"], req("gpt-5.6-terra"), opts({ stream: true }));
  } catch (err) {
    errStream = err;
  }
  expect(errStream).toBeDefined();
  // A no-wait retry round may consume the remaining two credentials after the first four-credential sweep.
  expect(attempts).toBeGreaterThanOrEqual(4);
  expect(attempts).toBeLessThanOrEqual(6);
});

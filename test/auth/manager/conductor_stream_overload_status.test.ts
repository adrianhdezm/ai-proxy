// Ported from: sdk/cliproxy/auth/conductor_stream_overload_status_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { statusCodeOf } from "../../../src/executor/types.ts";
import { auth, drain, fakeExecutor, newManager, opts, registerModels, req, statusError, streamOf, type TestManager } from "./helpers.ts";

function registerOverloadAuths(tm: TestManager, n: number): void {
  for (let i = 0; i < n; i++) {
    const id = `auth-overload-${i + 1}`;
    registerModels(tm.registry, id, "codex", "gpt-5.6-terra");
    tm.manager.register(auth({ id, provider: "codex", attributes: { priority: String(100 - i) } }));
  }
}

const overloadStatusError = () => statusError(503, `{"error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null}}`);

// When every credential is exhausted by overload rejections the caller must receive a real
// error carrying 503, not a committed 200 stream.
test("ExecuteStream_AllCredentialsOverloaded_ReturnsStatusError", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 0, 3);
  registerOverloadAuths(tm, 3);
  tm.manager.registerExecutor(fakeExecutor({ stream: () => Promise.reject(overloadStatusError()) }));
  let err: unknown;
  try {
    await tm.manager.executeStream(["codex"], req("gpt-5.6-terra"), opts({ stream: true }));
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(statusCodeOf(err)).toBe(503);
});

// The unbuffered path commits the first payload first, so the rejection can only be relayed in-stream.
test("ExecuteStream_UnbufferedOverload_StaysCommittedStream", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 0, 3);
  registerOverloadAuths(tm, 3);
  tm.manager.registerExecutor(fakeExecutor({ stream: () => streamOf([`data: {"type":"response.created"}`, overloadStatusError()], new Headers({ "Content-Type": "text/event-stream" })) }));
  const result = await tm.manager.executeStream(["codex"], req("gpt-5.6-terra"), opts({ stream: true }));
  const drained = await drain(result);
  expect(drained.error).toBeDefined();
  expect(drained.chunks).toHaveLength(1);
});

// An error delivered as the first stream item is downgraded to a committed stream carrying the error.
test("ExecuteStream_ErrorAsFirstChunk_IsDowngradedToCommittedStream", async () => {
  const tm = newManager();
  tm.manager.setRetryConfig(5, 0, 3);
  registerOverloadAuths(tm, 3);
  const executor = fakeExecutor({ stream: () => streamOf([overloadStatusError()], new Headers({ "Content-Type": "text/event-stream" })) });
  tm.manager.registerExecutor(executor);
  const result = await tm.manager.executeStream(["codex"], req("gpt-5.6-terra"), opts({ stream: true }));
  const drained = await drain(result);
  expect(drained.error).toBeDefined();
  expect(statusCodeOf(drained.error)).toBe(503);
  // Every credential was tried before the error stream was handed back.
  expect(executor.streamCalls).toHaveLength(3);
});

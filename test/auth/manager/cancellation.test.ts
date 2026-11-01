// Ported from: sdk/cliproxy/auth/conductor_claude_cancellation_test.go, sdk/cliproxy/auth/conductor_fast_error_test.go
// Ported from: sdk/cliproxy/auth/conductor_execution_error_priority_test.go
// Skipped cases: TestManagerClaudePrepareCancellationStopsWithoutCooldown (RequestAuthPreparer / PrepareRequestAuth not
// ported), TestClaudeRequestCancellationDoesNotChangeOtherProviders (Go helper claudeOAuthRequestCancellation; in this port
// every provider treats an aborted request the same way), TestHomeRetryPreservesTerminalContextErrorAfterUpstreamFailure
// and TestHomePreferredUpstreamErrorPreservesCurrentRetryAfter (Home dispatcher not ported). Go context cancellation is an
// AbortSignal; a Claude request-scoped cancellation in the stream tail becomes a DOMException AbortError (classified as
// connection_lifecycle here, request_scoped in Go: both skip cooldown). RequestTerminatedError (a direct upstream response)
// becomes a request-scoped StatusError carrying the status and body.
import { expect, test } from "bun:test";
import { AuthManagerError, ErrorCodeConnectionLifecycle } from "../../../src/auth/manager/index.ts";
import { StatusError, statusCodeOf, type StreamResult } from "../../../src/executor/types.ts";
import { auth, drain, fakeExecutor, newManager, opts, registerModels, rejection, req, streamOf, type FakeExecutorSpec, type TestManager } from "./helpers.ts";

const model = "claude-cancel-model";
const authId = "claude-cancel-auth";

function claudeManager(spec: FakeExecutorSpec) {
  const tm = newManager();
  tm.manager.setRetryConfig(0, 0, 0);
  const executor = fakeExecutor({ identifier: "claude", ...spec });
  tm.manager.registerExecutor(executor);
  registerModels(tm.registry, authId, "claude", model);
  tm.manager.register(auth({ id: authId, provider: "claude", attributes: { auth_kind: "oauth" }, metadata: { access_token: "access-token", refresh_token: "refresh-token", request_retry: 0 } }));
  return { tm, executor };
}

function requireNeutral(tm: TestManager): void {
  const current = tm.manager.getById(authId)!;
  expect(current.unavailable).toBe(false);
  expect(current.nextRetryAfter).toBe(0);
  const state = current.modelStates?.[model];
  if (state) {
    expect(state.unavailable).toBe(false);
    expect(state.nextRetryAfter).toBe(0);
    expect(state.quota.exceeded).toBe(false);
  }
}

type Kind = "execute" | "count" | "stream";
async function run(tm: TestManager, kind: Kind, signal?: AbortSignal): Promise<unknown> {
  try {
    if (kind === "execute") await tm.manager.execute(["claude"], req(model), opts({ signal }));
    else if (kind === "count") await tm.manager.executeCount(["claude"], req(model), opts({ signal }));
    else {
      const { error } = await drain(await tm.manager.executeStream(["claude"], req(model), opts({ stream: true, signal })));
      return error;
    }
  } catch (err) {
    return err;
  }
  return undefined;
}

test("ManagerClaudeRefreshCancellationStopsWithoutCooldown", async () => {
  for (const kind of ["execute", "count", "stream"] as const) {
    const controller = new AbortController();
    const unauthorized = () => new AuthManagerError("", "unauthorized", { httpStatus: 401 });
    let upstreamCalls = 0;
    const { tm, executor } = claudeManager({
      execute: () => {
        upstreamCalls++;
        throw unauthorized();
      },
      count: () => {
        upstreamCalls++;
        throw unauthorized();
      },
      stream: () => {
        upstreamCalls++;
        throw unauthorized();
      },
      refresh: () => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    const err = await run(tm, kind, controller.signal);
    expect((err as Error).name).toBe("AbortError");
    expect(executor.refreshCalls).toBe(1);
    expect(upstreamCalls).toBe(1);
    requireNeutral(tm);
  }
});

test("ManagerClaudeStreamTailCancellationIsAvailabilityNeutral", async () => {
  const controller = new AbortController();
  const { tm } = claudeManager({
    stream: (): StreamResult => {
      async function* chunks(): AsyncGenerator<string> {
        yield "first";
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return { chunks: chunks() };
    },
  });
  const results: Array<{ success: boolean; code?: string; status?: number }> = [];
  const original = tm.manager.markResult.bind(tm.manager);
  tm.manager.markResult = (result) => {
    results.push({ success: result.success, code: result.error?.code, status: result.error?.httpStatus });
    original(result);
  };
  const stream = await tm.manager.executeStream(["claude"], req(model), opts({ stream: true, signal: controller.signal }));
  const { chunks, error } = await drain(stream);
  expect(chunks).toEqual(["first"]);
  expect((error as Error).name).toBe("AbortError");
  expect(results).toEqual([{ success: false, code: ErrorCodeConnectionLifecycle, status: undefined }]);
  requireNeutral(tm);
});

test("ManagerClaudeUpstreamFailureStillCoolsCredential", async () => {
  const { tm } = claudeManager({
    execute: () => {
      throw new AuthManagerError("", "upstream failure", { httpStatus: 500 });
    },
  });
  const err = await run(tm, "execute");
  expect(statusCodeOf(err)).toBe(500);
  const state = tm.manager.getById(authId)!.modelStates![model]!;
  expect(state.unavailable).toBe(true);
  expect(state.nextRetryAfter).not.toBe(0);
});

// --- conductor_fast_error_test.go ---

for (const [label, firstError] of [
  ["Local", () => new StatusError(400, "decode Fast response", { requestScoped: true })],
  ["Direct", () => new StatusError(401, `{"type":"error","error":{"message":"Fast denied"}}`, { requestScoped: true, headers: new Headers({ "Content-Type": "application/json" }) })],
] as const) {
  test(`ManagerFast${label}ErrorDoesNotRefreshRetryOrCoolCredential`, async () => {
    for (const kind of ["execute", "stream"] as const) {
      let calls = 0;
      const { tm, executor } = claudeManager({
        execute: () => {
          if (++calls === 1) throw firstError();
          return { payload: `{"type":"message","content":[]}` };
        },
        stream: () => {
          if (++calls === 1) throw firstError();
          return streamOf(["ok"]);
        },
      });
      const err = await run(tm, kind);
      expect(err).toBeDefined();
      if (label === "Direct") expect(statusCodeOf(err)).toBe(401);
      expect(calls).toBe(1);
      expect(executor.refreshCalls).toBe(0);
      requireNeutral(tm);
      expect(await run(tm, kind)).toBeUndefined();
      expect(calls).toBe(2);
      requireNeutral(tm);
    }
  });
}

// --- conductor_execution_error_priority_test.go ---

test("ManagerRetryPreservesTerminalContextErrorAfterUpstreamFailure", async () => {
  for (const kind of ["execute", "count", "stream"] as const) {
    for (const terminal of ["canceled", "deadline-exceeded"] as const) {
      const provider = `retry-terminal-priority-${kind}-${terminal}`;
      const controller = new AbortController();
      const upstreamErr = new AuthManagerError("", "first retry round reached upstream", { httpStatus: 503 });
      const terminalErr = terminal === "canceled" ? new DOMException("The operation was aborted.", "AbortError") : new DOMException("The operation timed out.", "TimeoutError");
      let calls = 0;
      const next = () => {
        if (++calls === 1) throw upstreamErr;
        if (terminal === "canceled") controller.abort(terminalErr);
        throw terminalErr;
      };
      const tm = newManager();
      tm.manager.setRetryConfig(1, 0, 0);
      tm.manager.registerExecutor(fakeExecutor({ identifier: provider, execute: next, count: next, stream: next }));
      registerModels(tm.registry, `${provider}-auth`, provider, `${provider}-model`);
      tm.manager.register(auth({ id: `${provider}-auth`, provider, metadata: { request_retry: 1, disable_cooling: true } }));
      const signal = terminal === "canceled" ? controller.signal : undefined;
      let err: unknown;
      if (kind === "execute") err = await rejection(tm.manager.execute([provider], req(`${provider}-model`), opts({ signal })));
      else if (kind === "count") err = await rejection(tm.manager.executeCount([provider], req(`${provider}-model`), opts({ signal })));
      else err = await rejection(tm.manager.executeStream([provider], req(`${provider}-model`), opts({ stream: true, signal })));
      expect(err).toBe(terminalErr);
      expect(calls).toBe(2);
    }
  }
});

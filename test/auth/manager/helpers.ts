// Shared fakes for the auth manager tests: a controllable clock, a private model
// registry, an in-memory token store and a scriptable ProviderExecutor (the
// stand-in for the Go mock executors spread across the conductor tests).
import { StatusError, type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, type StreamResult } from "../../../src/executor/types.ts";
import { ModelRegistry } from "../../../src/registry/index.ts";
import type { TokenStore } from "../../../src/store/types.ts";
import { AuthManager, type AuthManagerOptions } from "../../../src/auth/manager/index.ts";
import { type Auth, cloneAuth, emptyQuotaState } from "../../../src/auth/types.ts";

export const baseNow = Date.parse("2026-10-28T12:00:00Z");

export const Minute = 60_000;
export const Hour = 3_600_000;

/** A clock the tests advance explicitly. */
export class Clock {
  t: number;
  constructor(start = baseNow) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function newRegistry(now?: () => number): ModelRegistry {
  return new ModelRegistry(now ? { now } : {});
}

export function registerModels(registry: ModelRegistry, clientId: string, provider: string, ...models: string[]): void {
  registry.registerClient(
    clientId,
    provider,
    models.map((id) => ({ id, type: provider })),
  );
}

/** Auth literal helper: fills the required fields with zero values (like the Go struct literal). */
export function auth(partial: Partial<Auth> & Pick<Auth, "id">): Auth {
  return {
    provider: "",
    status: "active",
    disabled: false,
    unavailable: false,
    attributes: {},
    metadata: {},
    quota: emptyQuotaState(),
    createdAt: 0,
    updatedAt: 0,
    lastRefreshedAt: 0,
    nextRefreshAfter: 0,
    nextRetryAfter: 0,
    ...partial,
  };
}

export class MemoryStore implements TokenStore {
  readonly kind = "memory";
  readonly saved: Auth[] = [];
  items: Auth[] = [];
  failWith?: Error;
  async save(record: Auth): Promise<string> {
    if (this.failWith) throw this.failWith;
    this.saved.push(cloneAuth(record));
    return record.id;
  }
  async list(): Promise<Auth[]> {
    return this.items.map((a) => cloneAuth(a));
  }
  async delete(): Promise<void> {}
}

export interface TestManager {
  manager: AuthManager;
  clock: Clock;
  registry: ModelRegistry;
}

/** A manager wired to a private clock and registry; sleeps between retry rounds are instant. */
export function newManager(options: Partial<AuthManagerOptions> & { clock?: Clock } = {}): TestManager {
  const clock = options.clock ?? new Clock();
  const registry = options.registry ?? newRegistry(clock.now);
  const manager = new AuthManager({
    now: clock.now,
    registry,
    sleep: async () => {},
    random: () => 0,
    ...options,
  });
  return { manager, clock, registry };
}

export const opts = (extra: Partial<ExecOptions> = {}): ExecOptions => ({ stream: false, sourceFormat: "claude", ...extra });

export const req = (model: string, payload = "{}"): ExecRequest => ({ model, payload, format: "claude" });

export interface FakeExecutor extends ProviderExecutor {
  executeCalls: string[];
  streamCalls: string[];
  countCalls: string[];
  refreshCalls: number;
  refreshedIds: string[];
}

export type ExecuteFn = (auth: Auth, req: ExecRequest, opts: ExecOptions) => Promise<ExecResponse> | ExecResponse;
export type StreamFn = (auth: Auth, req: ExecRequest, opts: ExecOptions) => Promise<StreamResult> | StreamResult;
export type RefreshFn = (auth: Auth) => Promise<Auth> | Auth;

export interface FakeExecutorSpec {
  identifier?: string;
  execute?: ExecuteFn;
  stream?: StreamFn;
  count?: ExecuteFn;
  refresh?: RefreshFn;
}

const notImplemented = () => Promise.reject(new StatusError(501, "not implemented"));

/** A scriptable executor recording the auth ids it was called with. */
export function fakeExecutor(spec: FakeExecutorSpec = {}): FakeExecutor {
  const exec: FakeExecutor = {
    identifier: spec.identifier ?? "codex",
    executeCalls: [],
    streamCalls: [],
    countCalls: [],
    refreshCalls: 0,
    refreshedIds: [],
    async execute(a, r, o) {
      exec.executeCalls.push(a.id);
      if (!spec.execute) return notImplemented();
      return spec.execute(a, r, o);
    },
    async executeStream(a, r, o) {
      exec.streamCalls.push(a.id);
      if (!spec.stream) return notImplemented();
      return spec.stream(a, r, o);
    },
    async countTokens(a, r, o) {
      exec.countCalls.push(a.id);
      if (!spec.count) return notImplemented();
      return spec.count(a, r, o);
    },
    async refresh(a) {
      exec.refreshCalls++;
      exec.refreshedIds.push(a.id);
      if (!spec.refresh) return a;
      return spec.refresh(a);
    },
  };
  return exec;
}

export function statusError(
  status: number,
  body: string,
  extra: { retryAfterMs?: number; credentialScoped?: boolean; transientRateLimit?: boolean; requestScoped?: boolean; streamTruncated?: boolean; headers?: Headers } = {},
): StatusError {
  return new StatusError(status, body, { body, ...extra });
}

/** Builds a StreamResult that yields the strings in order and throws at the first Error entry. */
export function streamOf(items: Array<string | Error>, headers?: Headers): StreamResult {
  async function* chunks(): AsyncGenerator<string> {
    for (const item of items) {
      if (item instanceof Error) throw item;
      yield item;
    }
  }
  return { headers, chunks: chunks() };
}

/** Reads a stream to the end, collecting payload and the terminal error (like `for chunk := range result.Chunks`). */
export async function drain(result: StreamResult): Promise<{ payload: string; chunks: string[]; error?: unknown }> {
  const chunks: string[] = [];
  let error: unknown;
  try {
    for await (const chunk of result.chunks) chunks.push(chunk);
  } catch (err) {
    error = err;
  }
  return { payload: chunks.join(""), chunks, error };
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

/** Yields to the event loop so fire-and-forget callbacks run. */
export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A deferred used to hold a fake upstream call open. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

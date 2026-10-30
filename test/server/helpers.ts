// Shared fakes for the server tests: a private manager + registry, scriptable
// ProviderExecutors (stand-ins for the Go mock executors in code_handlers_error_test.go),
// chunk iterators and SSE body helpers.
import { AuthManager } from "../../src/auth/manager/index.ts";
import { emptyQuotaState, type Auth } from "../../src/auth/types.ts";
import { StatusError, type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, type StreamResult } from "../../src/executor/types.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import { forwardClaudeStream, type ExecutionManager } from "../../src/server/claude_handlers.ts";
import type { ErrorMessage } from "../../src/executor/types.ts";
import { isObject, tryParse, type JSONObject } from "../../src/util/json.ts";
import { claudeErrorBody } from "../../src/server/errors.ts";

export const baseNow = Date.parse("2026-10-28T12:00:00Z");

export function testAuth(partial: Partial<Auth> & Pick<Auth, "id">): Auth {
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

/** A manager with a private registry, instant retry sleeps and no retry rounds (Go: NewManager + SetRetryConfig(0,0,0)). */
export function newTestManager(now: () => number = () => baseNow): { manager: AuthManager; registry: ModelRegistry } {
  const registry = new ModelRegistry({ now });
  const manager = new AuthManager({ registry, now, sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(0, 0, 0);
  return { manager, registry };
}

/** Registers an active auth for `provider` serving `model` in both the manager and the registry. */
export function registerFakeAuth(manager: AuthManager, registry: ModelRegistry, id: string, provider: string, ...models: string[]): Auth {
  const auth = manager.register(testAuth({ id, provider, metadata: { disable_cooling: true } }));
  registry.registerClient(
    id,
    provider,
    models.map((model) => ({ id: model, type: provider })),
  );
  return auth;
}

/** An async iterator over `chunks` that throws `terminal` afterwards when given. */
export async function* chunkIterator(chunks: string[], terminal?: unknown): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
  if (terminal !== undefined) throw terminal;
}

export function chunkStream(chunks: string[], terminal?: unknown, headers?: Headers): StreamResult {
  return { headers, chunks: chunkIterator(chunks, terminal) };
}

export type ExecuteFn = (auth: Auth, req: ExecRequest, opts: ExecOptions) => Promise<ExecResponse> | ExecResponse;
export type StreamFn = (auth: Auth, req: ExecRequest, opts: ExecOptions) => Promise<StreamResult> | StreamResult;

export interface FakeExecutorSpec {
  identifier?: string;
  execute?: ExecuteFn;
  stream?: StreamFn;
  count?: ExecuteFn;
}

export interface FakeExecutor extends ProviderExecutor {
  executeCalls: ExecRequest[];
  streamCalls: ExecRequest[];
  countCalls: ExecRequest[];
  lastOptions?: ExecOptions;
}

const notImplemented = () => Promise.reject(new StatusError(501, "not implemented"));

/** A scriptable executor recording the requests it received. */
export function fakeExecutor(spec: FakeExecutorSpec = {}): FakeExecutor {
  const exec: FakeExecutor = {
    identifier: spec.identifier ?? "claude",
    executeCalls: [],
    streamCalls: [],
    countCalls: [],
    async execute(a, r, o) {
      exec.executeCalls.push(r);
      exec.lastOptions = o;
      return spec.execute ? spec.execute(a, r, o) : notImplemented();
    },
    async executeStream(a, r, o) {
      exec.streamCalls.push(r);
      exec.lastOptions = o;
      return spec.stream ? spec.stream(a, r, o) : notImplemented();
    },
    async countTokens(a, r, o) {
      exec.countCalls.push(r);
      exec.lastOptions = o;
      return spec.count ? spec.count(a, r, o) : notImplemented();
    },
    async refresh(a) {
      return a;
    },
  };
  return exec;
}

/** A streaming executor that replays `chunks` and then throws `terminal` (Go: preFTKeepAliveClaudeExecutor). */
export function streamExecutor(identifier: string, chunks: string[], terminal?: unknown): FakeExecutor {
  return fakeExecutor({ identifier, stream: () => chunkStream(chunks, terminal) });
}

/** A minimal ExecutionManager for server-level tests that do not need failover. */
export function fakeManager(spec: { execute?: (providers: string[], req: ExecRequest, opts: ExecOptions) => Promise<ExecResponse>; stream?: (providers: string[], req: ExecRequest, opts: ExecOptions) => Promise<StreamResult>; count?: (providers: string[], req: ExecRequest, opts: ExecOptions) => Promise<ExecResponse> } = {}): ExecutionManager & { calls: { kind: string; providers: string[]; req: ExecRequest; opts: ExecOptions }[] } {
  const calls: { kind: string; providers: string[]; req: ExecRequest; opts: ExecOptions }[] = [];
  return {
    calls,
    async execute(providers, req, opts) {
      calls.push({ kind: "execute", providers, req, opts });
      if (!spec.execute) throw new StatusError(501, "not implemented");
      return spec.execute(providers, req, opts);
    },
    async executeStream(providers, req, opts) {
      calls.push({ kind: "stream", providers, req, opts });
      if (!spec.stream) throw new StatusError(501, "not implemented");
      return spec.stream(providers, req, opts);
    },
    async executeCount(providers, req, opts) {
      calls.push({ kind: "count", providers, req, opts });
      if (!spec.count) throw new StatusError(501, "not implemented");
      return spec.count(providers, req, opts);
    },
  };
}

export function messagesBody(model: string, stream: boolean, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 64, ...(stream ? { stream: true } : {}), ...extra });
}

export function messagesRequest(model: string, stream: boolean, init: { headers?: Record<string, string>; path?: string; extra?: Record<string, unknown>; signal?: AbortSignal } = {}): Request {
  return new Request(`http://proxy.test${init.path ?? "/v1/messages"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: messagesBody(model, stream, init.extra),
    signal: init.signal,
  });
}

export async function readText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

/** The parsed JSON `data:` payload of the last `event: error` frame, if any. */
export function lastErrorFrame(body: string): JSONObject | undefined {
  let found: JSONObject | undefined;
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n");
    if (!lines.some((line) => line.trim() === "event: error")) continue;
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    const parsed = tryParse(data);
    if (isObject(parsed)) found = parsed;
  }
  return found;
}

export function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export interface ForwardOutcome {
  body: string;
  terminal: ErrorMessage | undefined;
}

/**
 * Drives forwardClaudeStream the way the Go tests drive forwardClaudeStream with
 * data/errs channels: the chunks are the data channel, `terminal` the error sent
 * on errs. The first chunk is pre-read like the handler does.
 */
export async function forwardFromChunks(chunks: string[], terminal?: unknown, signal?: AbortSignal): Promise<ForwardOutcome> {
  const iterator = chunkIterator(chunks, terminal);
  const first = await iterator.next();
  let outcome: ErrorMessage | undefined;
  const stream = forwardClaudeStream({ first, iterator, signal, errorBody: (msg) => claudeErrorBody(msg), onDone: (err) => (outcome = err) });
  const body = await readText(stream);
  return { body, terminal: outcome };
}

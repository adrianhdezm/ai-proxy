// Ported from: sdk/api/handlers/openai/openai_responses_interrupt_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_late_interrupt_test.go
// Skipped cases: the steering_true variant of TestResponsesInterruptInFlight (duplex response steering is not
// ported; the steering_false variant is covered by responses_websocket.test.ts "response.interrupt on a websocket
// upstream" and repeated here end to end), TestResponsesInterruptUsesHomeSessionAuth (Home).
// TestResponsesInterruptDiagnosticsAreSanitized and the outcome checks of TestResponsesLateInterruptDoesNotPoisonNextCreate
// read the websocket timeline through ResponsesWebsocketHandler's onTimeline hook (Go: the request-log timeline body).
import { afterEach, describe, expect, test } from "bun:test";
import { AuthManager } from "../../src/auth/manager/index.ts";
import { newAuth } from "../../src/auth/types.ts";
import { CodexWebsocketSessionStore, createCodexAutoExecutor } from "../../src/executor/codex/index.ts";
import { NoActiveUpstreamWebsocketError } from "../../src/executor/codex/websockets/context.ts";
import type { ProviderExecutor, StreamResult } from "../../src/executor/types.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import { ResponsesWebsocketHandler } from "../../src/server/responses_websocket.ts";
import { createServer, type ProxyServer } from "../../src/server/server.ts";
import { TestWebsocketClient, eventually, startFakeCodexWebsocket, type FakeCodexWebsocket } from "../executor/codex/websocket_helpers.ts";
import { newTestManager, registerFakeAuth } from "./helpers.ts";

type Obj = Record<string, unknown>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A scripted client of the websocket handler without a socket (sent frames are collected). */
function connectHandler(handler: ResponsesWebsocketHandler) {
  const sent: string[] = [];
  let closed: number | undefined;
  const connection = handler.connect({ request: new Request("http://localhost/v1/responses") });
  connection.open({ send: (text) => sent.push(text), close: (code) => (closed = code ?? 1000) });
  const parsed = (i: number) => JSON.parse(sent[i]!) as Obj;
  const waitFor = async (predicate: (msg: Obj) => boolean, from = 0): Promise<number> => {
    let found = -1;
    await eventually(() => {
      for (let i = from; i < sent.length; i++) {
        if (predicate(parsed(i))) {
          found = i;
          return true;
        }
      }
      return false;
    });
    return found;
  };
  return {
    sent,
    connection,
    closed: () => closed,
    send: (frame: unknown) => connection.message(typeof frame === "string" ? frame : JSON.stringify(frame)),
    parsed,
    waitForType: (type: string, from = 0) => waitFor((m) => m.type === type, from),
  };
}

test("TestResponsesInterruptStopsHTTPUpstream", async () => {
  const { manager, registry } = newTestManager();
  let calls = 0;
  let canceled = false;
  const executor: ProviderExecutor & { interruptExecutionSession(): Promise<void> } = {
    identifier: "codex",
    execute: () => Promise.reject(new Error("not implemented")),
    countTokens: () => Promise.reject(new Error("not implemented")),
    refresh: () => Promise.reject(new Error("not implemented")),
    interruptExecutionSession: () => Promise.reject(new NoActiveUpstreamWebsocketError()),
    executeStream: async (_auth, _req, opts): Promise<StreamResult> => {
      calls++;
      if (calls > 1) {
        return {
          chunks: (async function* () {
            yield `data: {"type":"response.created","response":{"id":"r-http-2"}}\n\n`;
            yield `data: {"type":"response.completed","response":{"id":"r-http-2","status":"completed","output":[]}}\n\n`;
          })(),
        };
      }
      return {
        chunks: (async function* () {
          yield `data: {"type":"response.created","response":{"id":"r-http"}}\n\n`;
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) resolve();
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          canceled = true;
        })(),
      };
    },
  };
  manager.registerExecutor(executor);
  manager.register(newAuth({ id: "interrupt-http-auth", provider: "codex", attributes: { api_key: "test-key" } }));
  registry.registerClient("interrupt-http-auth", "codex", [{ id: "interrupt-http-model", type: "codex" }]);
  const client = connectHandler(new ResponsesWebsocketHandler({ manager, registry }));
  cleanups.push(() => client.connection.close(1000, ""));

  client.send({ type: "response.create", model: "interrupt-http-model", input: [] });
  const created = await client.waitForType("response.created");
  client.send(`{"type":"response.interrupt","response_id":"r-http","mode":"discard_partial_items"}`);
  const interrupted = await client.waitForType("response.incomplete", created + 1);
  const response = client.parsed(interrupted).response as Obj;
  expect(response.id).toBe("r-http");
  expect((response.incomplete_details as Obj).reason).toBe("interrupted");
  await eventually(() => canceled);

  client.send({ type: "response.create", model: "interrupt-http-model", previous_response_id: "r-http", input: [] });
  const followCreated = await client.waitForType("response.created", interrupted + 1);
  await client.waitForType("response.completed", followCreated + 1);
});

describe("TestResponsesInterruptInFlight (steering_false)", () => {
  test("the interrupt reaches the upstream socket unchanged and the turn ends with its acknowledgement", async () => {
    const interrupt = `{"type":"response.interrupt","response_id":"r1","mode":"discard_partial_items","extension":"keep"}`;
    const upstream = startFakeCodexWebsocket({
      onMessage(conn, message) {
        const frame = JSON.parse(message) as Obj;
        if (frame.type === "response.create") conn.send(`{"type":"response.created","response":{"id":"r1"}}`);
        if (frame.type === "response.interrupt") conn.send(`{"type":"response.incomplete","response":{"id":"r1","status":"incomplete","incomplete_details":{"reason":"interrupted"},"output":[]}}`);
      },
    });
    cleanups.push(() => upstream.close());
    const { url } = proxyFor(upstream, "interrupt-model");
    const client = new TestWebsocketClient(url);
    cleanups.push(() => client.close());
    await client.opened;
    client.send({ type: "response.create", model: "interrupt-model", input: [] });
    const created = await client.waitForType("response.created");
    client.send(interrupt);
    const incomplete = await client.waitForType("response.incomplete", created + 1);
    expect(((client.parsed(incomplete).response as Obj).incomplete_details as Obj).reason).toBe("interrupted");
    expect(upstream.connections).toHaveLength(1);
    expect(upstream.connections[0]!.received[1]).toBe(interrupt);
  });
});

function proxyFor(upstream: FakeCodexWebsocket, model: string, onTimeline?: (id: string, text: string) => void): { url: string; manager: AuthManager; proxy: ProxyServer } {
  const registry = new ModelRegistry();
  const manager = new AuthManager({ registry, sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(0, 0, 0);
  manager.registerExecutor(createCodexAutoExecutor({ disableImageGeneration: true, store: new CodexWebsocketSessionStore() }));
  manager.register(newAuth({ id: "late-interrupt-integration", provider: "codex", attributes: { api_key: "synthetic-key", base_url: upstream.url, websockets: "true" }, metadata: { disable_cooling: true } }));
  registry.registerClient("late-interrupt-integration", "codex", [{ id: model, type: "codex" } as never]);
  const proxy = createServer({ manager, registry, host: "127.0.0.1", port: 0 });
  if (onTimeline) (proxy.responsesWebsocketHandler as unknown as { onTimeline?: unknown }).onTimeline = onTimeline;
  const server = proxy.start();
  cleanups.push(() => proxy.stop());
  return { url: `ws://127.0.0.1:${server.port}/v1/responses`, manager, proxy };
}

test("TestResponsesLateInterruptDoesNotPoisonNextCreate", async () => {
  let httpCanceled = false;
  const upstream = startFakeCodexWebsocket({
    reject(request) {
      if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") return undefined;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"type":"response.created","response":{"id":"r-http"}}\n\n`));
        },
        cancel() {
          httpCanceled = true;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
    onMessage(conn, message) {
      const frame = JSON.parse(message) as Obj;
      const creates = conn.received.filter((m) => (JSON.parse(m) as Obj).type === "response.create").length;
      if (frame.type === "response.create") {
        const id = `r${creates}`;
        conn.send(`{"type":"response.created","response":{"id":"${id}"}}`);
        if (id === "r1") conn.send(`{"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`);
        return;
      }
      // Only the active r2 interrupt may reach upstream: it is the barrier proving the duplicate r1 ones were consumed downstream.
      if (frame.type === "response.interrupt") {
        expect(frame.response_id).toBe("r2");
        conn.send(`{"type":"response.completed","response":{"id":"r2","status":"completed","output":[]}}`);
      }
    },
  });
  cleanups.push(() => upstream.close());
  let timeline = "";
  const { url, manager } = proxyFor(upstream, "late-interrupt-model", (_id, text) => (timeline = text));
  const client = new TestWebsocketClient(url);
  cleanups.push(() => client.close());
  await client.opened;

  const expectNext = async (type: string, id: string, from: number): Promise<number> => {
    const index = await client.waitFor(() => true, from);
    const msg = client.parsed(index);
    expect(msg.type).toBe(type);
    if (id !== "") expect((msg.response as Obj).id).toBe(id);
    return index + 1;
  };
  let next = 0;
  client.send({ type: "response.create", model: "late-interrupt-model", input: [] });
  next = await expectNext("response.created", "r1", next);
  next = await expectNext("response.completed", "r1", next);
  client.send({ type: "response.interrupt", response_id: "unknown" });
  next = await expectNext("error", "", next);
  client.send(`{"type":"response.interrupt","response_id":"r1","mode":"discard_partial_items"}`);
  client.send({ type: "response.create", model: "late-interrupt-model", previous_response_id: "r1", input: [] });
  next = await expectNext("response.created", "r2", next);
  for (let i = 0; i < 2; i++) client.send(`{"type":"response.interrupt","response_id":"r1","mode":"discard_partial_items"}`);
  client.send(`{"type":"response.interrupt","response_id":"r2","mode":"discard_partial_items"}`);
  next = await expectNext("response.completed", "r2", next);

  // Switching the next turn to HTTP leaves an idle websocket cached: a terminal r1 interrupt is a no-op,
  // while r-http cancels locally.
  const auth = manager.getById("late-interrupt-integration")!;
  manager.update({ ...auth, attributes: { ...auth.attributes, websockets: "false" } });
  client.send({ type: "response.create", model: "late-interrupt-model", input: [{ role: "user", content: "next turn" }] });
  next = await expectNext("response.created", "r-http", next);
  client.send({ type: "response.interrupt", response_id: "r1" });
  client.send({ type: "response.interrupt", response_id: "r-http" });
  next = await expectNext("response.incomplete", "r-http", next);
  await eventually(() => httpCanceled);
  expect(upstream.connections).toHaveLength(1);

  client.close();
  await eventually(() => timeline !== "");
  for (const outcome of ["handled", "local_http", "rejected"]) expect(timeline).toContain(`"outcome":"${outcome}"`);
});

test("TestResponsesInterruptDiagnosticsAreSanitized", async () => {
  const { manager, registry } = newTestManager();
  registerFakeAuth(manager, registry, "unused", "codex", "unused-model");
  let timeline = "";
  const handler = new ResponsesWebsocketHandler({ manager, registry, onTimeline: (_id, text) => (timeline = text) });
  const client = connectHandler(handler);
  client.send(`{"type":"response.interrupt","response_id":"private-id-token","mode":"secret-mode","authorization":"Bearer secret-credential","input":"private-conversation"}`);
  const index = await client.waitForType("error");
  expect(index).toBe(0);
  client.connection.close(1000, "");
  await eventually(() => timeline !== "");
  for (const event of ["Event: websocket.interrupt", "Event: websocket.interrupt.outcome", `"outcome":"rejected"`]) expect(timeline).toContain(event);
  for (const secret of ["private-id-token", "secret-mode", "secret-credential", "private-conversation"]) expect(timeline).not.toContain(secret);
});

// Ported from: sdk/api/handlers/openai/openai_responses_websocket_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_websocket_loss_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_websocket_metadata_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_websocket_late_local_interrupt_test.go
// Ported from: sdk/api/handlers/openai/openai_responses_websocket_unknown_interrupt_test.go
// Skipped cases (socket level; the pure helpers are in responses_websocket_requests.test.ts):
//   every duplex / steering case (TestResponsesWebsocketDuplexLoss*, TestResponsesWebsocketLossCarriesEventIDWithoutSteering's
//   steering half, TestResponsesWebsocketDuplexTurnAuthLeavesContextIdentity) — response steering is not ported;
//   plugin, provider-route, Home and xAI cases (TestResponsesWebsocket*PluginRoute*, *ProviderRoute*, *HomeRuntime*,
//   TestResponsesWebsocketHomeSelectedAuthCallbackPinsAndReusesFirstSelection, TestResponsesWebsocketXAI*,
//   TestWebsocketUpstreamSupportsIncrementalInputForXAI, TestResponsesWebsocketUsesUpstreamWebsocketPassthroughForXAI,
//   TestResponsesWebsocketFullRequestCanRouteFromNativeWebsocketToBuiltInProvider, TestResponsesWebsocketHidesProviderRouteAuthFailure,
//   TestResponsesWebsocketDeltaRouteToBuiltInProviderRequiresFullReplay, TestResponsesWebsocketSwitchesPinnedAuthAcrossProviders);
//   compression (openai_responses_websocket_compression_test.go: no permessage-deflate switch on Bun's client);
//   TestResponsesWebsocketReauthorizesEachTurnAndKeepsSocketOpen (needs hot-reloadable access providers; the per-frame
//   check is wired but the key set is static); TestResponsesWebsocketQueuedInputBeforeIdleEOFIsNotSent /
//   TestResponsesInterruptRacingWebsocketLossIsNotAnsweredLocally / TestResponsesWebsocketQueuedContinuationBeforeIdleEOFIs409
//   (need a model-router barrier to hold a queued turn); TCP-level writer races (TestResponsesWebsocketWriterCloseDoesNotWaitForActiveDataWriter,
//   TestResponsesWebsocketGenericDisconnectDoesNotWaitForActiveDataWriter, TestForwardResponsesWebsocketLogsAttemptedResponseOnWriteFailure,
//   TestForwardResponsesWebsocketPrefersBufferedErrorOverClosedData: single-threaded writer, no channel race);
//   TestWebsocketClientAddress* (gin client IP); the observed-compaction auth bookkeeping cases beyond the one below.
//   Close codes: Go dropped the TCP connection (client saw 1006) for hidden errors; the port closes with 1011.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuthManager } from "../../src/auth/manager/index.ts";
import { newAuth } from "../../src/auth/types.ts";
import { CodexWebsocketSessionStore, createCodexAutoExecutor } from "../../src/executor/codex/index.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import { ResponsesWebsocketHandler, websocketUpgradeHeaders } from "../../src/server/responses_websocket.ts";
import { createServer, type ProxyServer } from "../../src/server/server.ts";
import { type FakeCodexWebsocket, TestWebsocketClient, codexTurnEvents, eventually, startFakeCodexWebsocket } from "../executor/codex/websocket_helpers.ts";
import { type CapturedRequest, startUpstream } from "../executor/codex/helpers.ts";
import { chunkStream, registerFakeAuth, newTestManager } from "./helpers.ts";
import type { ProviderExecutor, StreamResult } from "../../src/executor/types.ts";

type Obj = Record<string, unknown>;

interface Harness {
  manager: AuthManager;
  registry: ModelRegistry;
  proxy: ProxyServer;
  url: string;
  client(headers?: Record<string, string>): TestWebsocketClient;
  stop(): Promise<void>;
}

interface AuthSpec {
  id: string;
  key: string;
  baseURL: string;
  websockets?: boolean;
  priority?: number;
}

function harness(model: string, auths: AuthSpec[], options: { maxRetryCredentials?: number; streamBootstrapBuffering?: boolean; apiKeys?: string[] } = {}): Harness {
  const registry = new ModelRegistry();
  const manager = new AuthManager({ registry, sleep: async () => {}, random: () => 0 });
  manager.setRetryConfig(0, 0, options.maxRetryCredentials ?? 0);
  manager.registerExecutor(createCodexAutoExecutor({ disableImageGeneration: true, store: new CodexWebsocketSessionStore(), streamBootstrapBuffering: options.streamBootstrapBuffering }));
  for (const spec of auths) {
    const attributes: Record<string, string> = { api_key: spec.key, base_url: spec.baseURL };
    if (spec.websockets) attributes.websockets = "true";
    if (spec.priority !== undefined) attributes.priority = String(spec.priority);
    manager.register(newAuth({ id: spec.id, provider: "codex", attributes, metadata: { disable_cooling: true } }));
    registry.registerClient(spec.id, "codex", [{ id: model, type: "codex" } as never]);
  }
  const proxy = createServer({ manager, registry, host: "127.0.0.1", port: 0, apiKeys: options.apiKeys });
  const server = proxy.start();
  const url = `ws://127.0.0.1:${server.port}/v1/responses`;
  const clients: TestWebsocketClient[] = [];
  return {
    manager,
    registry,
    proxy,
    url,
    client(headers = {}) {
      const client = new TestWebsocketClient(url, headers);
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients) client.close();
      await proxy.stop();
    },
  };
}

const userInput = (text: string, id = `msg-${text}`) => ({ type: "message", id, role: "user", content: text });

describe("e2e: two response.create turns over one upstream websocket", () => {
  let upstream: FakeCodexWebsocket;
  let h: Harness;
  let turn = 0;
  beforeAll(() => {
    upstream = startFakeCodexWebsocket({
      onMessage(conn) {
        turn++;
        for (const event of codexTurnEvents(`resp_${turn}`, `answer ${turn}`)) conn.send(event);
      },
    });
    h = harness("gpt-5-e2e", [{ id: "codex-ws-e2e", key: "key-e2e", baseURL: upstream.url, websockets: true }]);
  });
  afterAll(async () => {
    await h.stop();
    upstream.close();
  });

  test("each turn completes and the second reuses the upstream socket", async () => {
    const client = h.client();
    await client.opened;
    client.send({ type: "response.create", model: "gpt-5-e2e", input: [userInput("first")] });
    const first = await client.waitForType("response.completed");
    expect((client.parsed(first).response as Obj).id).toBe("resp_1");
    expect(((client.parsed(first).response as Obj).output as Obj[])[0]!.type).toBe("message");

    client.send({ type: "response.create", model: "gpt-5-e2e", previous_response_id: "resp_1", input: [userInput("second")] });
    const second = await client.waitForType("response.completed", first + 1);
    expect((client.parsed(second).response as Obj).id).toBe("resp_2");

    expect(upstream.connections.length).toBe(1);
    const conn = upstream.connections[0]!;
    expect(conn.received.length).toBe(2);
    const firstFrame = JSON.parse(conn.received[0]!);
    expect(firstFrame.type).toBe("response.create");
    expect(firstFrame.input).toEqual([userInput("first")]);
    const secondFrame = JSON.parse(conn.received[1]!);
    // Native passthrough: the incremental input and previous_response_id reach the same socket.
    expect(secondFrame.previous_response_id).toBe("resp_1");
    expect(secondFrame.input).toEqual([userInput("second")]);
    expect(conn.headers.get("authorization")).toBe("Bearer key-e2e");
    expect(conn.headers.get("openai-beta")).toContain("responses_websockets=");

    // Closing the client releases the upstream execution session.
    client.close();
    await eventually(() => conn.closed);
  });
});

describe("HTTP upstreams", () => {
  const bodies: string[] = [];
  let hanging: ((signal: AbortSignal) => void) | undefined;
  let upstream: ReturnType<typeof startUpstream>;
  let h: Harness;
  let n = 0;
  beforeAll(() => {
    upstream = startUpstream((req: CapturedRequest) => {
      bodies.push(req.body);
      n++;
      const id = `resp_http_${n}`;
      const events = codexTurnEvents(id, `http ${n}`);
      const lastInput = (JSON.parse(req.body).input as Obj[]).at(-1);
      if (lastInput?.content === "hang please") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[0])}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "partial", role: "assistant", content: [] } })}\n\n`));
          },
          cancel() {
            hanging?.(AbortSignal.abort());
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    });
    h = harness("gpt-5-http", [{ id: "codex-http", key: "key-http", baseURL: upstream.url }]);
  });
  afterAll(async () => {
    await h.stop();
    upstream.close();
  });

  test("TestResponsesWebsocketMergesTranscriptForNonPassthroughUpstream", async () => {
    bodies.length = 0;
    const client = h.client();
    await client.opened;
    client.send({ type: "response.create", model: "gpt-5-http", instructions: "be brief", input: [userInput("one")] });
    const first = await client.waitForType("response.completed");
    const firstID = (client.parsed(first).response as Obj).id as string;
    client.send({ type: "response.create", previous_response_id: firstID, input: [userInput("two")] });
    await client.waitForType("response.completed", first + 1);
    expect(bodies.length).toBe(2);
    const second = JSON.parse(bodies[1]!);
    expect(second.previous_response_id).toBeUndefined();
    expect(second.instructions).toBe("be brief");
    expect(second.input.map((i: Obj) => i.id ?? i.type)).toEqual(["msg-one", `msg_${firstID}`, "msg-two"]);
  });

  test("TestResponsesWebsocketPrewarmHandledLocallyForSSEUpstream", async () => {
    bodies.length = 0;
    const client = h.client();
    await client.opened;
    client.send({ type: "response.create", model: "gpt-5-http", generate: false, input: [userInput("warm")] });
    const created = await client.waitForType("response.created");
    const completed = await client.waitForType("response.completed", created + 1);
    const prewarmID = (client.parsed(completed).response as Obj).id as string;
    expect(prewarmID.startsWith("resp_prewarm_")).toBe(true);
    expect(bodies.length).toBe(0);

    client.send({ type: "response.create", previous_response_id: prewarmID, input: [userInput("go")] });
    await client.waitForType("response.completed", completed + 1);
    expect(bodies.length).toBe(1);
    const body = JSON.parse(bodies[0]!);
    expect(body.generate).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.input.map((i: Obj) => i.id)).toEqual(["msg-warm", "msg-go"]);
  });

  test("a continuation of an unknown prewarm is refused (Go: responsesWebsocketPreviousResponseNotFoundError)", async () => {
    const client = h.client();
    await client.opened;
    client.send({ type: "response.create", model: "gpt-5-http", generate: false, input: [] });
    const completed = await client.waitForType("response.completed");
    client.send({ type: "response.create", previous_response_id: "resp_other", input: [] });
    const err = await client.waitForType("error", completed + 1);
    expect((client.parsed(err).error as Obj).code).toBe("previous_response_not_found");
    expect(client.parsed(err).status).toBe(409);
  });

  test("TestResponsesWebsocketRejectsUnknownPreviousResponseOnNewSocket", async () => {
    const client = h.client();
    await client.opened;
    client.send({ type: "response.create", model: "gpt-5-http", previous_response_id: "resp_unknown", input: [userInput("x")] });
    const err = await client.waitForType("error");
    expect((client.parsed(err).error as Obj).code).toBe("previous_response_not_found");
    // The socket stays open for a full create.
    client.send({ type: "response.create", model: "gpt-5-http", input: [userInput("y")] });
    await client.waitForType("response.completed", err + 1);
  });

  test("invalid frames are answered with an error and the socket stays open", async () => {
    const client = h.client();
    await client.opened;
    client.send({ type: "response.bogus" });
    const unsupported = await client.waitForType("error");
    expect(client.parsed(unsupported).status).toBe(400);
    expect((client.parsed(unsupported).error as Obj).message).toBe("unsupported websocket request type: response.bogus");
    client.send({ type: "response.interrupt" });
    const noID = await client.waitForType("error", unsupported + 1);
    expect((client.parsed(noID).error as Obj).message).toBe("response.interrupt requires response_id");
    client.send({ type: "response.interrupt", response_id: "resp-nothing" });
    const idle = await client.waitForType("error", noID + 1);
    expect(client.parsed(idle).status).toBe(400);
    client.send({ type: "response.create", model: "gpt-5-http", input: [userInput("ok")] });
    await client.waitForType("response.completed", idle + 1);
  });

  test("response.interrupt cancels an HTTP turn locally with response.incomplete", async () => {
    let aborted = false;
    hanging = () => {
      aborted = true;
    };
    const client = h.client();
    await client.opened;
    client.send({ type: "response.create", model: "gpt-5-http", input: [userInput("hang please")] });
    const created = await client.waitForType("response.created");
    const responseID = (client.parsed(created).response as Obj).id as string;
    await client.waitForType("response.output_item.done", created + 1);
    client.send({ type: "response.interrupt", response_id: responseID });
    const incomplete = await client.waitForType("response.incomplete", created + 1);
    const response = client.parsed(incomplete).response as Obj;
    expect(response.id).toBe(responseID);
    expect((response.incomplete_details as Obj).reason).toBe("interrupted");
    expect((response.output as Obj[]).map((i) => i.id)).toEqual(["partial"]);
    await eventually(() => aborted);
    // TestForwardResponsesWebsocketRejectsLocalInterruptAfterCompletion: a late interrupt is rejected, the socket lives on.
    client.send({ type: "response.interrupt", response_id: responseID });
    const late = await client.waitForType("error", incomplete + 1);
    expect(client.parsed(late).status).toBe(400);
    client.send({ type: "response.create", input: [userInput("after interrupt")] });
    await client.waitForType("response.completed", late + 1);
  });
});

describe("websocket upstream failures", () => {
  test("TestResponsesWebsocketUpstreamLossKeepsDownstreamOpen", async () => {
    const upstream = startFakeCodexWebsocket({
      onMessage(conn) {
        if (upstream.connections.indexOf(conn) === 0) {
          conn.send(`{"type":"response.created","response":{"id":"r1","output":[]}}`);
          setTimeout(() => conn.terminate(), 10);
          return;
        }
        conn.send(`{"type":"response.completed","response":{"id":"r2","output":[]}}`);
      },
    });
    const h = harness("loss-model", [
      { id: "loss-key-a", key: "key-a", baseURL: upstream.url, websockets: true },
      { id: "loss-key-b", key: "key-b", baseURL: upstream.url, websockets: true },
    ]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "loss-model", event_id: "evt-1", input: [] });
      const lost = await client.waitForType("error");
      expect((client.parsed(lost).error as Obj).code).toBe("upstream_websocket_lost");
      expect((client.parsed(lost).error as Obj).event_id).toBe("evt-1");
      // A continuation cannot resume the lost socket; the full create reconnects on the same credential.
      client.send({ type: "response.create", model: "loss-model", previous_response_id: "r1", input: [] });
      client.send({ type: "response.create", model: "loss-model", input: [] });
      const refused = await client.waitForType("error", lost + 1);
      expect((client.parsed(refused).error as Obj).code).toBe("previous_response_not_found");
      await client.waitForType("response.completed", refused + 1);
      expect(upstream.connections.length).toBe(2);
      expect(upstream.connections[0]!.headers.get("authorization")).toBe(upstream.connections[1]!.headers.get("authorization"));
      expect(upstream.connections[1]!.received.length).toBe(1);
      expect(client.closeCode).toBeUndefined();
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  test("TestResponsesWebsocketIdleUpstreamEOFIsSilent", async () => {
    const upstream = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"response.completed","response":{"id":"r2","output":[]}}`);
        if (upstream.connections.indexOf(conn) === 0) setTimeout(() => conn.terminate(), 10);
      },
    });
    const h = harness("idle-model", [{ id: "idle-auth", key: "key-idle", baseURL: upstream.url, websockets: true }]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "idle-model", input: [] });
      const done = await client.waitForType("response.completed");
      await eventually(() => upstream.connections[0]!.closed);
      await Bun.sleep(20);
      expect(client.messages.length).toBe(done + 1);
      client.send({ type: "response.create", model: "idle-model", previous_response_id: "r2", input: [] });
      const refused = await client.waitForType("error", done + 1);
      expect((client.parsed(refused).error as Obj).code).toBe("previous_response_not_found");
      client.send({ type: "response.create", model: "idle-model", input: [] });
      await client.waitForType("response.completed", refused + 1);
      expect(upstream.connections.length).toBe(2);
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  test("TestResponsesWebsocketHidesNonClientUpstreamDisconnectErrors: an idle upstream close closes the client silently", async () => {
    const upstream = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"response.completed","response":{"id":"r1","output":[]}}`);
        setTimeout(() => conn.close(1011, "server going away"), 10);
      },
    });
    const h = harness("hide-model", [{ id: "hide-auth", key: "key-hide", baseURL: upstream.url, websockets: true }]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "hide-model", input: [] });
      const done = await client.waitForType("response.completed");
      await client.waitClosed();
      expect(client.messages.length).toBe(done + 1);
      expect(client.closeCode).toBe(1011);
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  test("TestResponsesWebsocketMirrorsUpstreamMessageTooBigDisconnect", async () => {
    const upstream = startFakeCodexWebsocket({ onMessage: (conn) => conn.close(1009, "message too big") });
    const h = harness("big-model", [{ id: "big-auth", key: "key-big", baseURL: upstream.url, websockets: true }]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "big-model", input: [userInput("huge")] });
      await client.waitClosed();
      expect(client.closeCode).toBe(1009);
      // The disconnect notification (raw close text) and the turn error (mapped body message) race like in Go.
      expect(["message too big", "upstream websocket message too big"]).toContain(client.closeReason!);
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  test("TestForwardResponsesWebsocketTreatsErrorPayloadAsTerminal: a request fault is reported before the close", async () => {
    const upstream = startFakeCodexWebsocket({
      onMessage: (conn) => conn.send(`{"type":"error","status":400,"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"too long"}}`),
    });
    const h = harness("fault-model", [{ id: "fault-auth", key: "key-fault", baseURL: upstream.url, websockets: true }]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "fault-model", input: [userInput("x")] });
      const err = await client.waitForType("error");
      expect(client.parsed(err).status).toBe(400);
      expect((client.parsed(err).error as Obj).code).toBe("context_length_exceeded");
      await client.waitClosed();
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  for (const [frameName, frame] of [
    ["error_frame", `{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_in_seconds":600}}`],
    ["response_failed", `{"type":"response.failed","response":{"error":{"type":"usage_limit_reached","status_code":429,"message":"The usage limit has been reached","plan_type":"plus","resets_in_seconds":600}}}`],
  ] as const) {
    for (const buffering of [false, true]) {
      test(`TestResponsesWebsocketEarly429RetriesAnotherCredentialWithoutClosingDownstream/${frameName}/buffering=${buffering}`, async () => {
        const creates = { "key-a": 0, "key-b": 0 } as Record<string, number>;
        const conns = { "key-a": 0, "key-b": 0 } as Record<string, number>;
        const fail429 = { "key-a": true, "key-b": false } as Record<string, boolean>;
        const upstream = startFakeCodexWebsocket({
          onOpen(conn) {
            conns[(conn.headers.get("authorization") ?? "").replace("Bearer ", "")]!++;
          },
          onMessage(conn, message) {
            if (JSON.parse(message).type !== "response.create") return;
            const key = (conn.headers.get("authorization") ?? "").replace("Bearer ", "");
            const turn = ++creates[key]!;
            const letter = key === "key-a" ? "a" : "b";
            if (fail429[key]) {
              if (buffering && key === "key-a" && turn === 1) {
                conn.send(`{"type":"response.created","response":{"id":"resp-a-buffered","status":"in_progress","output":[]}}`);
                conn.send(`{"type":"response.in_progress","response":{"id":"resp-a-buffered","status":"in_progress","output":[]}}`);
              }
              conn.send(frame);
              return;
            }
            const id = `resp-${letter}-${turn}`;
            conn.send(`{"type":"response.created","response":{"id":"${id}","status":"in_progress","output":[]}}`);
            conn.send(`{"type":"response.completed","response":{"id":"${id}","status":"completed","output":[{"id":"msg-${letter}-${turn}","type":"message","role":"assistant","content":[{"type":"output_text","text":"from-${letter}"}]}]}}`);
          },
        });
        const model = `codex-early-429-${frameName}-${buffering}`;
        const h = harness(
          model,
          [
            { id: `auth-a-${model}`, key: "key-a", baseURL: upstream.url, websockets: true, priority: 4 },
            { id: `auth-b-${model}`, key: "key-b", baseURL: upstream.url, websockets: true, priority: 3 },
          ],
          { maxRetryCredentials: 2, streamBootstrapBuffering: buffering },
        );
        try {
          // 1. Auth A answers 429 first; the same downstream turn fails over to auth B.
          const conn1 = h.client();
          await conn1.opened;
          conn1.send({ type: "response.create", model, input: [{ type: "message", id: "msg-1", role: "user", content: "hello" }] });
          const c1 = await conn1.waitForType("response.completed");
          expect(conn1.messages.some((m) => m.includes("resp-a-buffered"))).toBe(false);
          expect((conn1.parsed(c1).response as Obj).id).toBe("resp-b-1");
          expect([creates["key-a"], creates["key-b"]]).toEqual([1, 1]);
          conn1.send({ type: "response.create", model, previous_response_id: "resp-b-1", input: [{ type: "message", id: "msg-1b", role: "user", content: "followup on b" }] });
          const c1b = await conn1.waitForType("response.completed", c1 + 1);
          expect((conn1.parsed(c1b).response as Obj).id).toBe("resp-b-2");
          expect([conns["key-b"], creates["key-b"]]).toEqual([1, 2]);

          // 2. An independent socket selects auth A again (cooling disabled).
          fail429["key-a"] = false;
          const conn2 = h.client();
          await conn2.opened;
          conn2.send({ type: "response.create", model, input: [{ type: "message", id: "msg-2", role: "user", content: "independent" }] });
          const c2 = await conn2.waitForType("response.completed");
          expect((conn2.parsed(c2).response as Obj).id).toBe("resp-a-2");

          // 3. A pinned continuation refuses cross-credential replay: close 1012.
          fail429["key-a"] = true;
          conn2.send({ type: "response.create", model, previous_response_id: "resp-a-2", input: [{ type: "message", id: "msg-3", role: "user", content: "continuation" }] });
          await conn2.waitClosed();
          expect(conn2.closeCode).toBe(1012);
          expect(conn2.closeReason).toBe("upstream requires HTTP replay");
          expect([creates["key-a"], creates["key-b"]]).toEqual([3, 2]);

          // 4. Every credential answers 429: the socket closes without an error event.
          fail429["key-b"] = true;
          const conn3 = h.client();
          await conn3.opened;
          conn3.send({ type: "response.create", model, input: [{ type: "message", id: "msg-4", role: "user", content: "exhausted" }] });
          await conn3.waitClosed();
          expect(conn3.messages).toEqual([]);
          expect(conn3.closeCode).toBe(1011);
          expect([creates["key-a"], creates["key-b"]]).toEqual([4, 3]);
        } finally {
          await h.stop();
          upstream.close();
        }
      });
    }
  }

  test("TestResponsesWebsocketClosesForHTTPReplayWhenWebsocketEligibilityChanges", async () => {
    const upstream = startFakeCodexWebsocket({ onMessage: (conn) => conn.send(`{"type":"response.completed","response":{"id":"resp-ws","output":[]}}`) });
    const h = harness("elig-model", [{ id: "elig-auth", key: "key-elig", baseURL: upstream.url, websockets: true }]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "elig-model", input: [] });
      await client.waitForType("response.completed");
      const auth = h.manager.getById("elig-auth")!;
      h.manager.update({ ...auth, attributes: { ...auth.attributes, websockets: "false" } });
      client.send({ type: "response.create", model: "elig-model", previous_response_id: "resp-ws", input: [] });
      await client.waitClosed();
      expect(client.closeCode).toBe(1012);
    } finally {
      await h.stop();
      upstream.close();
    }
  });
});

describe("response.interrupt on a websocket upstream", () => {
  test("the interrupt is written to the upstream socket and the turn ends with its acknowledgement", async () => {
    const upstream = startFakeCodexWebsocket({
      onMessage(conn, message) {
        const frame = JSON.parse(message);
        if (frame.type === "response.create") {
          conn.send(`{"type":"response.created","response":{"id":"resp-int","output":[]}}`);
          return;
        }
        if (frame.type === "response.interrupt") {
          conn.send(`{"type":"response.incomplete","response":{"id":"resp-int","status":"incomplete","incomplete_details":{"reason":"interrupted"},"output":[]}}`);
        }
      },
    });
    const h = harness("int-model", [{ id: "int-auth", key: "key-int", baseURL: upstream.url, websockets: true }]);
    try {
      const client = h.client();
      await client.opened;
      client.send({ type: "response.create", model: "int-model", input: [] });
      const created = await client.waitForType("response.created");
      const interrupt = `{"type":"response.interrupt","response_id":"resp-int","mode":"discard_partial_items"}`;
      client.send(interrupt);
      const incomplete = await client.waitForType("response.incomplete", created + 1);
      expect(((client.parsed(incomplete).response as Obj).incomplete_details as Obj).reason).toBe("interrupted");
      // The original frame reached upstream unchanged.
      expect(upstream.connections[0]!.received[1]).toBe(interrupt);
      // TestResponsesUnknownInterruptDoesNotCancelWebsocketTurn: an interrupt for another id is rejected.
      client.send({ type: "response.create", model: "int-model", previous_response_id: "resp-int", input: [] });
      const next = await client.waitForType("response.created", incomplete + 1);
      client.send({ type: "response.interrupt", response_id: "resp-unknown" });
      const rejected = await client.waitForType("error", next + 1);
      expect(client.parsed(rejected).status).toBe(400);
      expect((client.parsed(rejected).error as Obj).message).toBe("response.interrupt does not target the active upstream response");
      expect(upstream.connections[0]!.received.filter((m) => m.includes("resp-unknown"))).toEqual([]);
      expect(client.closeCode).toBeUndefined();
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  test("TestResponsesWebsocketFiltersModerationMetadataForStandardClients", async () => {
    const upstream = startFakeCodexWebsocket({
      onMessage(conn) {
        conn.send(`{"type":"response.created","response":{"id":"resp-meta","output":[]}}`);
        conn.send(`{"type":"response.metadata","metadata":{"moderation":"x"}}`);
        conn.send(`{"type":"response.subscription_usage","usage":{}}`);
        conn.send(`{"type":"response.completed","response":{"id":"resp-meta","output":[]}}`);
      },
    });
    const h = harness("meta-model", [{ id: "meta-auth", key: "key-meta", baseURL: upstream.url, websockets: true }]);
    try {
      const standard = h.client();
      await standard.opened;
      standard.send({ type: "response.create", model: "meta-model", input: [] });
      await standard.waitForType("response.completed");
      expect(standard.messages.map((m) => JSON.parse(m).type)).toEqual(["response.created", "response.completed"]);
      const codex = h.client({ Originator: "codex_cli_rs", "User-Agent": "codex_cli_rs/0.120.0 (Mac OS 15.0.0; arm64) iTerm.app/3.5.0" });
      await codex.opened;
      codex.send({ type: "response.create", model: "meta-model", input: [] });
      await codex.waitForType("response.completed");
      expect(codex.messages.map((m) => JSON.parse(m).type)).toEqual(["response.created", "response.metadata", "response.completed"]);
    } finally {
      await h.stop();
      upstream.close();
    }
  });
});

describe("upgrade", () => {
  test("the upgrade uses the inbound API-key check", async () => {
    const upstream = startFakeCodexWebsocket({ onMessage: (conn) => conn.send(`{"type":"response.completed","response":{"id":"r","output":[]}}`) });
    const h = harness("auth-model", [{ id: "auth-auth", key: "key-auth", baseURL: upstream.url, websockets: true }], { apiKeys: ["inbound-key"] });
    try {
      const denied = h.client();
      await expect(denied.opened).rejects.toThrow(/401/);
      const allowed = h.client({ Authorization: "Bearer inbound-key" });
      await allowed.opened;
      allowed.send({ type: "response.create", model: "auth-model", input: [] });
      await allowed.waitForType("response.completed");
      // A plain GET without the upgrade is not served.
      const plain = await h.proxy.fetch(new Request("http://localhost/v1/responses", { headers: { Authorization: "Bearer inbound-key" } }));
      expect(plain.status).toBe(400);
    } finally {
      await h.stop();
      upstream.close();
    }
  });

  test("websocketUpgradeHeaders echoes x-codex-turn-state", () => {
    expect(websocketUpgradeHeaders(new Request("http://x/v1/responses", { headers: { "x-codex-turn-state": "sticky" } })).get("x-codex-turn-state")).toBe("sticky");
    expect([...websocketUpgradeHeaders(new Request("http://x/v1/responses")).keys()]).toEqual([]);
  });
});

describe("handler with a scripted executor", () => {
  test("the timeline records requests and responses; a stream closed early is a hidden 408 close", async () => {
    const { manager, registry } = newTestManager();
    let streams = 0;
    const executor: ProviderExecutor = {
      identifier: "fake-ws",
      execute: () => Promise.reject(new Error("unused")),
      countTokens: () => Promise.reject(new Error("unused")),
      refresh: async (auth) => auth,
      executeStream: async (): Promise<StreamResult> => {
        streams++;
        if (streams === 1) return chunkStream([`data: {"type":"response.created","response":{"id":"r1"}}\n\n`, `data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","id":"m1"}]}}\n\n`]);
        return chunkStream([`data: {"type":"response.created","response":{"id":"r2"}}\n\n`]);
      },
    };
    manager.registerExecutor(executor);
    registerFakeAuth(manager, registry, "fake-auth", "fake-ws", "fake-model");
    let timeline = "";
    const handler = new ResponsesWebsocketHandler({ manager, registry, onTimeline: (_id, text) => (timeline = text), newId: () => "conn-1" });
    const sent: string[] = [];
    let closed: number | undefined;
    const connection = handler.connect({ request: new Request("http://localhost/v1/responses") });
    connection.open({ send: (t) => sent.push(t), close: (code) => (closed = code ?? 1000) });
    connection.message(JSON.stringify({ type: "response.create", model: "fake-model", input: [] }));
    await eventually(() => sent.some((s) => s.includes(`"response.completed"`)));
    connection.message(JSON.stringify({ type: "response.create", input: [] }));
    await connection.done;
    expect(closed).toBe(1011);
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(["response.created", "response.completed", "response.created"]);
    expect(timeline).toContain("Event: websocket.request");
    expect(timeline).toContain("Event: websocket.response");
    expect(timeline).toContain("Event: websocket.disconnect");
    expect(connection.sessionId).toBe("conn-1");
  });
});

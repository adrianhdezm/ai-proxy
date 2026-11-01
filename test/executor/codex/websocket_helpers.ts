// Fake Codex Responses websocket backend on Bun.serve (port 0) for the
// websocket executor and handler tests (Go: httptest.NewServer + websocket.Upgrader).
import type { ServerWebSocket } from "bun";

export interface FakeCodexConn {
  /** Handshake headers of the upgrade request. */
  headers: Headers;
  path: string;
  /** Text messages received from the proxy, in order. */
  received: string[];
  /** Sends a text message (objects are JSON encoded). */
  send(message: unknown): void;
  /** Closes with a close frame. */
  close(code?: number, reason?: string): void;
  /** Drops the TCP connection without a close frame (the client sees 1006). */
  terminate(): void;
  /** Resolves with the n-th (0-based) received message. */
  message(index: number): Promise<string>;
  readonly closed: boolean;
}

export interface FakeCodexWebsocketOptions {
  /** Answers the upgrade request instead of upgrading (handshake rejection). */
  reject?(request: Request): Response | undefined;
  onOpen?(conn: FakeCodexConn): void;
  onMessage?(conn: FakeCodexConn, message: string): void;
}

export interface FakeCodexWebsocket {
  /** base_url for the credential (http://127.0.0.1:port). */
  url: string;
  connections: FakeCodexConn[];
  /** Upgrade attempts, including rejected ones. */
  handshakes: Request[];
  close(): void;
}

interface ConnData {
  conn: FakeCodexConn;
}

class Conn implements FakeCodexConn {
  received: string[] = [];
  closed = false;
  ws?: ServerWebSocket<ConnData>;
  private waiters: Array<{ index: number; resolve: (msg: string) => void }> = [];

  constructor(
    readonly headers: Headers,
    readonly path: string,
  ) {}

  push(message: string): void {
    this.received.push(message);
    const ready = this.waiters.filter((w) => w.index < this.received.length);
    this.waiters = this.waiters.filter((w) => w.index >= this.received.length);
    for (const w of ready) w.resolve(this.received[w.index]!);
  }

  send(message: unknown): void {
    this.ws?.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  close(code = 1000, reason = ""): void {
    this.ws?.close(code, reason);
  }

  terminate(): void {
    this.ws?.terminate();
  }

  message(index: number): Promise<string> {
    if (index < this.received.length) return Promise.resolve(this.received[index]!);
    return new Promise((resolve) => this.waiters.push({ index, resolve }));
  }
}

export function startFakeCodexWebsocket(options: FakeCodexWebsocketOptions = {}): FakeCodexWebsocket {
  const connections: FakeCodexConn[] = [];
  const handshakes: Request[] = [];
  const server = Bun.serve<ConnData>({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(request, srv) {
      handshakes.push(request);
      const rejected = options.reject?.(request);
      if (rejected) return rejected;
      const conn = new Conn(request.headers, new URL(request.url).pathname);
      if (srv.upgrade(request, { data: { conn } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        const conn = ws.data.conn as Conn;
        conn.ws = ws;
        connections.push(conn);
        options.onOpen?.(conn);
      },
      message(ws, message) {
        const conn = ws.data.conn as Conn;
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        conn.push(text);
        options.onMessage?.(conn, text);
      },
      close(ws) {
        (ws.data.conn as Conn).closed = true;
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    connections,
    handshakes,
    close() {
      server.stop(true);
    },
  };
}

/** A minimal Codex response: created, one output text item, completed. */
export function codexTurnEvents(responseID: string, text = "ok"): unknown[] {
  const item = { type: "message", id: `msg_${responseID}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id: responseID, object: "response", status: "in_progress", output: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: responseID, object: "response", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ];
}

/** Resolves once `predicate` holds, polling on the event loop (bounded). */
export async function eventually(predicate: () => boolean, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

/** A downstream test client on Bun's WebSocket with an awaitable message log. */
export class TestWebsocketClient {
  readonly messages: string[] = [];
  closeCode?: number;
  closeReason?: string;
  private waiters: Array<() => void> = [];
  private readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closedPromise: Promise<void>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers } as unknown as string[]);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (event) => reject(new Error((event as unknown as { message?: string }).message ?? "websocket error")));
    });
    this.closedPromise = new Promise((resolve) => {
      this.ws.addEventListener("close", (event) => {
        this.closeCode = event.code;
        this.closeReason = event.reason;
        this.wake();
        resolve();
      });
    });
    this.ws.addEventListener("message", (event) => {
      this.messages.push(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }

  /** Waits until a message satisfies `predicate` (searching from `from`) and returns its index. */
  async waitFor(predicate: (message: Record<string, unknown>) => boolean, from = 0): Promise<number> {
    for (;;) {
      for (let i = from; i < this.messages.length; i++) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(this.messages[i]!);
        } catch {
          continue;
        }
        if (parsed && typeof parsed === "object" && predicate(parsed as Record<string, unknown>)) return i;
      }
      if (this.closeCode !== undefined) throw new Error(`socket closed (${this.closeCode}) before the expected message; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Waits for a message of `type`. */
  waitForType(type: string, from = 0): Promise<number> {
    return this.waitFor((m) => m.type === type, from);
  }

  parsed(index: number): Record<string, unknown> {
    return JSON.parse(this.messages[index]!) as Record<string, unknown>;
  }

  /** Waits for the close event. */
  async waitClosed(): Promise<void> {
    await this.closedPromise;
  }
}

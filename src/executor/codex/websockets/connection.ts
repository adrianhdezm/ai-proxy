// Upstream websocket connection for the Codex executor. Port of the transport
// half of internal/runtime/executor/codex_websockets_connection.go
// (dialCodexWebsocket, newProxyAwareWebsocketDialer, mapCodexWebsocketReadError,
// mapCodexWebsocketWriteError, codexWebsocketTurnTransportError,
// codexWebsocketTurnEventID, shouldRetryCodexWebsocketSend) on Bun's built-in
// WebSocket client instead of gorilla/websocket.
//
// Deviations forced by the Bun client:
//   - A rejected handshake only reports its status code (parsed from the
//     "Expected 101 status code: N" error); the response headers and body are
//     not exposed, so handshake rejections are classified by status alone.
//   - Compression: the client always offers permessage-deflate and has no
//     switch, so Go's codex.websocket-compression toggle is not ported.
//   - Ping/pong is answered by the client itself; there is no ping hook.
//   - The proxy URL is handed to the client's `proxy` option (Bun ignores it
//     where unsupported); SOCKS5 proxies are not dialed specially.
import { getAt, gstr } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import { StatusError, statusCodeOf } from "../../types.ts";
import { asUpstreamWebsocketTurnError, isUpstreamWebsocketTurnError, UpstreamWebsocketTurnError } from "./context.ts";

/** Handshake ceiling (Go: codexResponsesWebsocketHandshakeTO). */
export const codexResponsesWebsocketHandshakeTimeoutMs = 30_000;
/** Read deadline between upstream messages (Go: codexResponsesWebsocketIdleTimeout). */
export const codexResponsesWebsocketIdleTimeoutMs = 5 * 60_000;

/** Close codes (RFC 6455) used by the executor and the handler. */
export const CloseNormalClosure = 1000;
export const CloseGoingAway = 1001;
export const CloseNoStatusReceived = 1005;
export const CloseAbnormalClosure = 1006;
export const CloseMessageTooBig = 1009;
export const CloseInternalServerErr = 1011;
export const CloseServiceRestart = 1012;

/** A close frame or a dropped connection (Go: *websocket.CloseError). */
export class CodexWebsocketCloseError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string) {
    super(`websocket: close ${code}${reason !== "" ? ": " + reason : code === CloseAbnormalClosure ? " (abnormal closure): unexpected EOF" : ""}`);
    this.name = "CodexWebsocketCloseError";
    this.code = code;
    this.reason = reason;
  }
}

/** A write on a connection that is already closed (Go: net.ErrClosed / websocket.ErrCloseSent). */
export class CodexWebsocketTransportError extends Error {
  constructor(message = "websocket: close sent") {
    super(message);
    this.name = "CodexWebsocketTransportError";
  }
}

/** The upstream read deadline passed without a message (Go: i/o timeout). */
export class CodexWebsocketTimeoutError extends Error {
  constructor(message = "codex websockets executor: read i/o timeout") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A failed handshake; statusCode is 0 for transport failures (Go: dial error + *http.Response). */
export class CodexWebsocketHandshakeError extends Error {
  readonly statusCode: number;
  readonly headers?: Headers;
  readonly body: string;

  constructor(message: string, statusCode: number, opts: { headers?: Headers; body?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CodexWebsocketHandshakeError";
    this.statusCode = statusCode;
    this.headers = opts.headers;
    this.body = opts.body ?? "";
  }
}

export interface CodexWebsocketConnHandlers {
  message(data: string, binary: boolean): void;
  close(err: CodexWebsocketCloseError): void;
}

/** The subset of the WebSocket API the connection wrapper needs (Bun's client, or a test double). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "open" | "error", listener: (event: Event) => void): void;
}

let nextConnId = 1;

/**
 * One upstream websocket. Events that arrive before a reader attaches are
 * queued; after the close event no further event is delivered.
 */
export class CodexWebsocketConn {
  readonly id = nextConnId++;
  private handlers?: CodexWebsocketConnHandlers;
  private readonly pending: Array<{ data?: string; binary?: boolean; close?: CodexWebsocketCloseError }> = [];
  private closeErr?: CodexWebsocketCloseError;
  private closeRequested = false;

  constructor(private readonly ws: WebSocketLike) {
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      if (typeof data === "string") this.dispatch({ data, binary: false });
      else this.dispatch({ data: "", binary: true });
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      if (this.closeErr) return;
      this.closeErr = new CodexWebsocketCloseError(event.code || CloseAbnormalClosure, event.reason ?? "");
      this.dispatch({ close: this.closeErr });
    });
  }

  private dispatch(event: { data?: string; binary?: boolean; close?: CodexWebsocketCloseError }): void {
    if (!this.handlers) {
      this.pending.push(event);
      return;
    }
    if (event.close) this.handlers.close(event.close);
    else this.handlers.message(event.data ?? "", event.binary === true);
  }

  /** Attaches the single reader and replays what arrived before it. */
  attach(handlers: CodexWebsocketConnHandlers): void {
    this.handlers = handlers;
    const queued = this.pending.splice(0);
    for (const event of queued) this.dispatch(event);
  }

  /** The close the peer (or the transport) reported, if any. */
  get closeError(): CodexWebsocketCloseError | undefined {
    return this.closeErr;
  }

  get open(): boolean {
    return !this.closeErr && !this.closeRequested && this.ws.readyState === 1;
  }

  /** Sends one text message; throws CodexWebsocketTransportError on a closed socket. */
  send(text: string): void {
    if (!this.open) throw new CodexWebsocketTransportError(this.closeErr ? `websocket: connection closed (${this.closeErr.code})` : "websocket: close sent");
    try {
      this.ws.send(text);
    } catch (err) {
      throw new CodexWebsocketTransportError(`websocket: write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Closes the socket (idempotent; Go: websocketConnectionCloser.Close). */
  close(code = CloseNormalClosure, reason = ""): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    try {
      this.ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

export interface CodexWebsocketDialOptions {
  proxyUrl?: string;
  signal?: AbortSignal;
  handshakeTimeoutMs?: number;
}

/** Opens an upstream websocket (injectable for tests). */
export type CodexWebsocketDialer = (url: string, headers: Headers, options: CodexWebsocketDialOptions) => Promise<CodexWebsocketConn>;

function headersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Bun's client reports a rejected upgrade as "... Expected 101 status code: N". */
function handshakeStatusFromMessage(message: string): number {
  const match = /Expected 101 status code:?\s*(\d{3})/i.exec(message);
  return match ? Number(match[1]) : 0;
}

/** Dials with Bun's WebSocket client (Go: dialCodexWebsocket). */
export const dialBunCodexWebsocket: CodexWebsocketDialer = (url, headers, options) =>
  new Promise<CodexWebsocketConn>((resolve, reject) => {
    const init: Record<string, unknown> = { headers: headersRecord(headers) };
    const proxy = (options.proxyUrl ?? "").trim();
    if (proxy !== "" && proxy.toLowerCase() !== "direct" && proxy.toLowerCase() !== "none") init.proxy = proxy;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, init as unknown as string[]);
    } catch (err) {
      reject(new CodexWebsocketHandshakeError(`codex websockets executor: dial failed: ${err instanceof Error ? err.message : String(err)}`, 0, { cause: err }));
      return;
    }
    const conn = new CodexWebsocketConn(ws as unknown as WebSocketLike);
    let settled = false;
    let errorMessage = "";
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) {
        conn.close();
        reject(err);
      } else {
        resolve(conn);
      }
    };
    const timeoutMs = options.handshakeTimeoutMs ?? codexResponsesWebsocketHandshakeTimeoutMs;
    const timer = setTimeout(() => finish(new CodexWebsocketHandshakeError("codex websockets executor: websocket handshake timeout", 0)), timeoutMs);
    const onAbort = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => finish());
    ws.addEventListener("error", (event: Event) => {
      const message = (event as unknown as { message?: unknown }).message;
      if (typeof message === "string") errorMessage = message;
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      if (settled) return;
      const status = handshakeStatusFromMessage(errorMessage);
      const detail = errorMessage !== "" ? errorMessage : `websocket closed during handshake (${event.code})`;
      finish(new CodexWebsocketHandshakeError(`codex websockets executor: ${detail}`, status));
    });
  });

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const messageTooBigBody = `{"error":{"message":"upstream websocket message too big","type":"invalid_request_error","code":"message_too_big"}}`;

/** Close 1009 becomes a request-scoped 413 message_too_big (Go: mapCodexWebsocketReadError). */
export function mapCodexWebsocketReadError(err: unknown): unknown {
  if (err instanceof CodexWebsocketCloseError && err.code === CloseMessageTooBig) {
    // Like Go's codexWebsocketMessageTooBigError the close is not kept as the cause: the
    // handler mirrors 1009 with the body's message as the reason.
    return new StatusError(413, messageTooBigBody, { body: messageTooBigBody, requestScoped: true });
  }
  return err;
}

/**
 * A failed write is reported as message_too_big only when the current
 * connection itself was closed with 1009 (Go: mapCodexWebsocketWriteError).
 */
export function mapCodexWebsocketWriteError(closeError: CodexWebsocketCloseError | undefined, err: unknown): unknown {
  if (err === undefined || !closeError || closeError.code !== CloseMessageTooBig) return err;
  return mapCodexWebsocketReadError(closeError);
}

/** Retry a failed send on a fresh socket unless the failure is request scoped (Go: shouldRetryCodexWebsocketSend). */
export function shouldRetryCodexWebsocketSend(err: unknown): boolean {
  if (err === undefined || err === null) return false;
  return !(err instanceof StatusError && err.requestScoped);
}

/**
 * A transport loss (EOF, reset, abnormal close 1006, write on a dead socket)
 * becomes the turn error that keeps the downstream websocket open; status,
 * policy and other close codes are returned unchanged
 * (Go: codexWebsocketTurnTransportError).
 */
export function codexWebsocketTurnTransportError(err: unknown): unknown {
  if (err === undefined || err === null || isUpstreamWebsocketTurnError(err)) return err;
  const status = statusCodeOf(err);
  if (status !== undefined && status !== 0) return err;
  if (err instanceof CodexWebsocketCloseError) {
    if (err.code !== CloseAbnormalClosure) return err;
  } else if (!(err instanceof CodexWebsocketTransportError)) {
    return err;
  }
  return new UpstreamWebsocketTurnError({ cause: err });
}

/** Lets a lost turn's error carry the create's event_id (Go: codexWebsocketTurnEventID). */
export function codexWebsocketTurnEventID(err: unknown, payload: string): unknown {
  const turnErr = asUpstreamWebsocketTurnError(err);
  if (!turnErr || turnErr.eventId !== "") return err;
  return turnErr.withEventID(gstr(getAt(tryParse(payload), "event_id")));
}

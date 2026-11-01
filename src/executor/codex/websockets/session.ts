// Codex upstream websocket sessions. Port of
// internal/runtime/executor/codex_websockets_session.go: one session per
// downstream execution session id holds the upstream socket across turns, a
// single reader routes messages to the active turn, and the session tracks the
// running response (for response.interrupt), terminal read errors and the
// one-shot upstream disconnect notification the handler subscribes to.
//
// Go goroutines and channels map to callbacks and an async queue: the reader is
// the connection's message handler, the active "channel" is a ReadQueue, and
// reqMu is a promise-chain lock held for one turn. Execution lifecycles (Home)
// and the multi-agent v2 / SIWC bookkeeping are not ported.
import { log } from "../../../log.ts";
import { getAt, gstr } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import { type WebsocketExecutionContext, isUpstreamWebsocketTurnError, notifyWebsocketInputLoss } from "./context.ts";
import { type CodexWebsocketCloseError, type CodexWebsocketConn, CodexWebsocketTimeoutError, codexResponsesWebsocketIdleTimeoutMs } from "./connection.ts";

/** One upstream read delivered to a turn (Go: codexWebsocketRead). */
export interface CodexWebsocketRead {
  conn: CodexWebsocketConn;
  payload: string;
  binary: boolean;
  err?: unknown;
}

/** Unbounded FIFO with an async consumer (Go: chan codexWebsocketRead). */
export class ReadQueue<T> {
  private readonly items: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closedFlag = false;

  push(item: T): boolean {
    if (this.closedFlag) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter({ value: undefined, done: true });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** The next item; `done` once closed and drained. Rejects with the signal's reason on abort. */
  next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.closedFlag) return Promise.resolve({ value: undefined, done: true });
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const waiter = (value: IteratorResult<T>) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(abortReason(signal!));
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Timer hooks so tests can drive the read deadline deterministically. */
export interface CodexWebsocketTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: CodexWebsocketTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function isTerminalEvent(eventType: string): boolean {
  switch (eventType) {
    case "response.completed":
    case "response.done":
    case "response.incomplete":
    case "response.failed":
    case "error":
      return true;
    default:
      return false;
  }
}

/** Disconnect notification hook of a session (Go: upstreamDisconnectCh). */
interface DisconnectSignal {
  promise: Promise<unknown>;
  resolve: (err: unknown) => void;
  fired: boolean;
}

function newDisconnectSignal(): DisconnectSignal {
  let resolve!: (err: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve, fired: false };
}

export class CodexWebsocketSession {
  readonly sessionId: string;
  private lockTail: Promise<void> = Promise.resolve();

  /** The current turn belongs to a downstream websocket: a transport loss ends the turn only. */
  recoverTransport = false;
  /** Websocket context of the current downstream turn (Go: turnContext). */
  turnContext?: WebsocketExecutionContext;
  conn?: CodexWebsocketConn;
  wsURL = "";
  authID = "";
  proxyURL = "";
  readerConn?: CodexWebsocketConn;

  activeConn?: CodexWebsocketConn;
  activeQueue?: ReadQueue<CodexWebsocketRead>;
  terminalConn?: CodexWebsocketConn;
  terminalErr?: unknown;

  responseStateConn?: CodexWebsocketConn;
  terminalResponseIDs = new Set<string>();
  /** The newest response known to run on responseStateConn ("" before response.created). */
  activeResponseID = "";
  activeResponseTerminal = false;

  private disconnect = newDisconnectSignal();
  private upstreamDisconnectErrConn?: CodexWebsocketConn;
  private upstreamDisconnectErr?: unknown;
  private lastEventConn?: CodexWebsocketConn;
  private lastEventType = "";

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Serialises turns on the session (Go: reqMu). Returns an idempotent release. */
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.lockTail;
    this.lockTail = previous.then(() => next);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  get kind(): string {
    return this.sessionId.trim() !== "" ? "persistent" : "ephemeral";
  }

  /** Starts routing reads of `conn` to a fresh queue (Go: activate). */
  activate(conn: CodexWebsocketConn): ReadQueue<CodexWebsocketRead> {
    const queue = new ReadQueue<CodexWebsocketRead>();
    if (this.terminalConn === conn && this.terminalErr !== undefined) {
      queue.push({ conn, payload: "", binary: false, err: this.terminalErr });
      queue.close();
      return queue;
    }
    this.activeConn = conn;
    this.activeQueue = queue;
    this.activeResponseID = "";
    this.activeResponseTerminal = false;
    return queue;
  }

  /** Stops routing to `queue` if it is still the active one (Go: clearActive). */
  clearActive(conn: CodexWebsocketConn | undefined, queue: ReadQueue<CodexWebsocketRead> | undefined): boolean {
    if (this.activeConn !== conn || this.activeQueue !== queue) return false;
    this.activeConn = undefined;
    this.activeQueue = undefined;
    this.activeResponseID = "";
    this.activeResponseTerminal = false;
    return true;
  }

  activeForConn(conn: CodexWebsocketConn): ReadQueue<CodexWebsocketRead> | undefined {
    return this.activeConn === conn ? this.activeQueue : undefined;
  }

  resetTerminalError(conn: CodexWebsocketConn): void {
    this.terminalConn = conn;
    this.terminalErr = undefined;
    if (this.responseStateConn !== conn) {
      this.responseStateConn = conn;
      this.terminalResponseIDs = new Set();
    }
  }

  /** Records the read error that ended `conn` while it is the session's socket (Go: markTerminalError). */
  markTerminalError(conn: CodexWebsocketConn, err: unknown): boolean {
    if (this.conn !== conn || err === undefined) return false;
    this.terminalConn = conn;
    this.terminalErr = err;
    return true;
  }

  resetUpstreamDisconnectError(conn: CodexWebsocketConn): void {
    this.upstreamDisconnectErrConn = conn;
    this.upstreamDisconnectErr = undefined;
    this.lastEventConn = conn;
    this.lastEventType = "";
  }

  setUpstreamDisconnectError(conn: CodexWebsocketConn, err: unknown): void {
    if (this.upstreamDisconnectErrConn === conn && this.upstreamDisconnectErr === undefined) this.upstreamDisconnectErr = err;
  }

  upstreamDisconnectError(conn: CodexWebsocketConn | undefined): unknown {
    if (!conn || this.upstreamDisconnectErrConn !== conn) return undefined;
    return this.upstreamDisconnectErr;
  }

  setLastEventType(conn: CodexWebsocketConn, eventType: string): void {
    if (eventType !== "" && this.lastEventConn === conn) this.lastEventType = eventType;
  }

  getLastEventType(conn: CodexWebsocketConn | undefined): string {
    return conn && this.lastEventConn === conn ? this.lastEventType : "";
  }

  /** Resolves once with the error that tore the upstream down (Go: UpstreamDisconnectChan). */
  get upstreamDisconnect(): Promise<unknown> {
    return this.disconnect.promise;
  }

  /** Go: notifyUpstreamDisconnect; turn errors are reported by the active turn instead. */
  notifyUpstreamDisconnect(err: unknown): void {
    if (isUpstreamWebsocketTurnError(err)) return;
    if (this.disconnect.fired) return;
    this.disconnect.fired = true;
    this.disconnect.resolve(err);
  }

  /** Whether the session's socket targets the same credential, URL and proxy (Go: websocketSessionTargetMatches). */
  targetMatches(authID: string, wsURL: string, proxyURL: string): boolean {
    return this.authID.trim() === authID.trim() && this.wsURL.trim() === wsURL.trim() && this.proxyURL.trim() === proxyURL.trim();
  }

  /** Detaches `conn` without closing it; returns whether it was the session's socket. */
  detachConnection(conn: CodexWebsocketConn): boolean {
    if (this.conn !== conn) return false;
    this.conn = undefined;
    if (this.readerConn === conn) this.readerConn = undefined;
    return true;
  }

  /**
   * Tracks the running response before delivery (Go: the response bookkeeping
   * in readUpstreamLoop): response.created starts it, a terminal event ends its
   * own response; an id-less failure ends the running one.
   */
  trackResponseEvent(conn: CodexWebsocketConn, eventType: string, root: unknown): void {
    let responseID = gstr(getAt(root, "response.id"));
    if (eventType === "response.created") {
      if (responseID !== "" && this.responseStateConn === conn && this.activeConn === conn && this.activeQueue) {
        this.activeResponseID = responseID;
        this.activeResponseTerminal = false;
      }
      return;
    }
    if (!isTerminalEvent(eventType)) return;
    const failure = eventType === "error" || eventType === "response.failed";
    if (failure && responseID === "") responseID = gstr(getAt(root, "response_id"));
    if (responseID === "" && !failure) return;
    if (this.responseStateConn !== conn) return;
    const terminalID = responseID !== "" ? responseID : this.activeResponseID;
    if (terminalID !== "" && eventType !== "error") this.terminalResponseIDs.add(terminalID);
    if (terminalID !== "" && this.activeResponseID === terminalID) this.activeResponseTerminal = true;
  }
}

/** All persistent sessions of one executor (Go: codexWebsocketSessionStore). */
export class CodexWebsocketSessionStore {
  readonly sessions = new Map<string, CodexWebsocketSession>();

  getOrCreate(sessionId: string): CodexWebsocketSession | undefined {
    const id = sessionId.trim();
    if (id === "") return undefined;
    let sess = this.sessions.get(id);
    if (!sess) {
      sess = new CodexWebsocketSession(id);
      this.sessions.set(id, sess);
    }
    return sess;
  }

  get(sessionId: string): CodexWebsocketSession | undefined {
    return this.sessions.get(sessionId.trim());
  }

  take(sessionId: string): CodexWebsocketSession | undefined {
    const id = sessionId.trim();
    const sess = this.sessions.get(id);
    this.sessions.delete(id);
    return sess;
  }
}

/** The process-wide store every executor uses unless given its own (Go: globalCodexWebsocketSessionStore). */
export const globalCodexWebsocketSessionStore = new CodexWebsocketSessionStore();

export interface InvalidateOptions {
  reason: string;
  err?: unknown;
  /** Publish the disconnect to the downstream handler (Go: invalidateUpstreamConnWithNotify notify). */
  notify: boolean;
}

/**
 * Drops `conn` from the session, advances the input loss epoch for a lost
 * turn, notifies the handler and closes the socket (Go: invalidateUpstreamConnWithNotify).
 */
export function invalidateUpstreamConn(sess: CodexWebsocketSession, conn: CodexWebsocketConn, options: InvalidateOptions): void {
  if (sess.conn !== conn) return;
  const turnContext = sess.turnContext;
  sess.turnContext = undefined;
  sess.detachConnection(conn);
  if (isUpstreamWebsocketTurnError(options.err)) notifyWebsocketInputLoss(turnContext);
  logDisconnected(sess, options.reason, sess.getLastEventType(conn), options.err);
  if (options.notify) sess.notifyUpstreamDisconnect(options.err);
  conn.close();
}

/** Detaches and closes the session's socket (Go: closeCodexWebsocketSession). */
export function closeCodexWebsocketSession(sess: CodexWebsocketSession | undefined, reason: string): void {
  if (!sess) return;
  const conn = sess.conn;
  if (!conn) return;
  sess.detachConnection(conn);
  logDisconnected(sess, reason.trim() || "session_closed", sess.getLastEventType(conn), undefined);
  conn.close();
}

function logDisconnected(sess: CodexWebsocketSession, reason: string, lastEvent: string, err: unknown): void {
  const fields: Record<string, unknown> = { session: sess.sessionId, auth: sess.authID, session_object: sess.kind, reason, is_terminal: isTerminalEvent(lastEvent) };
  if (lastEvent !== "") fields.last_event = lastEvent;
  if (err !== undefined) fields.error = err instanceof Error ? err.name : "error";
  log.debug("codex websockets: upstream disconnected", fields);
}

export interface ReaderHooks {
  /** Wraps a read error for the session's current turn (Go: codexWebsocketTurnTransportError when recoverTransport). */
  mapReadError(err: unknown): unknown;
  idleTimeoutMs?: number;
  timers?: CodexWebsocketTimers;
}

/**
 * Attaches the single reader of `conn` (Go: configureConn + readUpstreamLoop).
 * Every data message re-arms the read deadline; a read error, an unexpected
 * binary message or the deadline ends the connection: the active turn gets the
 * error and the socket is invalidated.
 */
export function startUpstreamReader(sess: CodexWebsocketSession, conn: CodexWebsocketConn, hooks: ReaderHooks): void {
  sess.resetTerminalError(conn);
  sess.resetUpstreamDisconnectError(conn);
  const timers = hooks.timers ?? realTimers;
  const idleMs = hooks.idleTimeoutMs ?? codexResponsesWebsocketIdleTimeoutMs;
  let ended = false;
  let timer: unknown;
  const arm = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = idleMs > 0 ? timers.set(() => fail(new CodexWebsocketTimeoutError(), "upstream_disconnected"), idleMs) : undefined;
  };

  const fail = (rawErr: unknown, reason: string) => {
    if (ended) return;
    ended = true;
    if (timer !== undefined) timers.clear(timer);
    let err = rawErr;
    if (reason === "upstream_disconnected" && sess.recoverTransport) err = hooks.mapReadError(rawErr);
    sess.markTerminalError(conn, err);
    const invalidate = () => invalidateUpstreamConn(sess, conn, { reason, err, notify: true });
    let invalidated = false;
    if (isUpstreamWebsocketTurnError(err)) {
      // Drop the dead connection before the turn error is visible, so the next create reconnects.
      invalidate();
      invalidated = true;
    }
    const queue = sess.activeForConn(conn);
    if (queue) {
      queue.push({ conn, payload: "", binary: false, err });
      if (sess.clearActive(conn, queue)) queue.close();
    }
    if (!invalidated) invalidate();
    conn.close();
  };

  conn.attach({
    message(data, binary) {
      if (ended) return;
      arm();
      if (binary) {
        fail(new Error("codex websockets executor: unexpected binary message"), "unexpected_binary");
        return;
      }
      const payload = data.trim();
      if (payload.length > 0) {
        const root = tryParse(payload);
        const eventType = gstr(getAt(root, "type"));
        if (eventType !== "") sess.setLastEventType(conn, eventType);
        sess.trackResponseEvent(conn, eventType, root);
      }
      sess.activeForConn(conn)?.push({ conn, payload, binary: false });
    },
    close(closeErr: CodexWebsocketCloseError) {
      sess.setUpstreamDisconnectError(conn, closeErr);
      fail(closeErr, "upstream_disconnected");
    },
  });
  arm();
}

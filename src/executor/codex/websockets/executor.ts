// Codex executor over the Responses websocket transport (provider key "codex").
// Port of internal/runtime/executor/codex_websockets_execute.go (Execute),
// codex_websockets_stream.go (ExecuteStream, prepareCodexWebsocketStream, the
// stream bootstrap buffering), codex_websockets_executor.go
// (InterruptExecutionSession) and the store half of codex_websockets_session.go
// (getOrCreateSession, ensureUpstreamConn, CloseExecutionSession,
// CloseAuthExecutionSessions, UpstreamDisconnectChan).
//
// Transport rules:
//   - With an execution session id (ExecOptions.metadata.execution_session_id,
//     set by the downstream websocket handler) the upstream socket is kept in
//     the session and reused by later turns while the credential, URL and proxy
//     stay the same; otherwise an ephemeral socket lives for one request.
//   - A request marked requiredUpstreamWebsocket (an incremental continuation)
//     never dials: without the session's live socket it fails with the 426
//     replay signal, or 409 previous_response_not_found after an upstream loss.
//   - A downstream websocket turn passes the upstream events through as bare
//     JSON chunks (completion output restored, usage details ensured); any
//     other caller gets the events translated like the HTTP executor.
//   - A transport loss during a downstream websocket turn becomes an
//     UpstreamWebsocketTurnError (the downstream socket stays open) and
//     advances the connection's input loss epoch.
//   - A 426 handshake falls back to the HTTP executor unless the request comes
//     from a downstream websocket.
//
// Not ported: duplex response steering (codex_websockets_duplex.go; see the
// handler for what is missing), SIWC, Home execution lifecycles, multi-agent v2
// optimisation, usage reporting, request logging, the payload finalizer,
// encrypted-reasoning sanitising and websocket compression settings.
import type { Auth } from "../../../auth/types.ts";
import { CodexAuthenticator } from "../../../auth/codex/index.ts";
import { type CodexReasoningReplayCache, defaultCodexReasoningReplayCache } from "../../../cache/codex_reasoning_replay_cache.ts";
import { log } from "../../../log.ts";
import { parseSuffix } from "../../../thinking/index.ts";
import { defaultRegistry } from "../../../translator/registry.ts";
import { FormatCodex, FormatOpenAIResponse, type Format, type TranslateContext, type TranslatorState } from "../../../translator/types.ts";
import "../../../translator/codex/claude/index.ts";
import "../../../translator/codex/openai/responses/index.ts";
import { getAt, gstr, isObj } from "../../../util/gpath.ts";
import { tryParse } from "../../../util/json.ts";
import { ensureResponsesUsageDetails } from "../../responses.ts";
import { type ExecOptions, type ExecRequest, type ExecResponse, type ProviderExecutor, StatusError, type StreamResult, responseFormatOrSource } from "../../types.ts";
import { codexBootstrapMaxBufferedBytes, codexBootstrapMaxBufferedFrames, isCodexBootstrapBufferableEvent, newCodexBootstrapOverloadErr } from "../bootstrap.ts";
import { codexAuthUsesAPIKey, codexBaseURL, codexCreds, isNativeCodexRequest } from "../creds.ts";
import {
  codexTerminalFailureErrWithCooling,
  hasMeaningfulCodexOutputDelta,
  isCodexOverloadBootstrapFailure,
  isCodexTerminalEmptyIncomplete,
  isCodexUsageLimitError,
  newCodexEmptyIncompleteStreamError,
  newCodexStatusErrWithHeadersAndCooling,
} from "../errors.ts";
import { CodexCompactAlt, CodexExecutor, type CodexExecutorOptions } from "../executor.ts";
import { applyCodexRoutingHint, applyModelHeaderOverrides, type CodexHeaderPolicy } from "../headers.ts";
import { stripImageGenerationTools } from "../images.ts";
import { sanitizeCodexInputItemIDs } from "../input_ids.ts";
import {
  type CodexReasoningReplayScope,
  applyCodexReasoningReplayCache,
  cacheCodexReasoningReplayFromCompleted,
  clearCodexReasoningReplayOnInvalidSignature,
} from "../reasoning_replay.ts";
import {
  collectCodexOutputItemDone,
  collectedOutputItemCount,
  deleteFields,
  ensureImageGenerationTool,
  ensureWebSearchToolForHistory,
  newCollectedOutputItems,
  normalizeCodexInstructions,
  patchCodexCompletedOutput,
  setBoolIfDifferent,
  setStringIfDifferent,
  translateCodexRequestPair,
} from "../request.ts";
import { utf8Len } from "../sse_scanner.ts";
import { asRequestError, applyRequestThinking, resolvedModelInfo } from "../thinking.ts";
import { normalizeCodexToolSchemas } from "../tool_schema.ts";
import {
  CodexWebsocketCloseError,
  type CodexWebsocketConn,
  type CodexWebsocketDialer,
  CodexWebsocketHandshakeError,
  codexWebsocketTurnEventID,
  codexWebsocketTurnTransportError,
  dialBunCodexWebsocket,
  mapCodexWebsocketReadError,
  mapCodexWebsocketWriteError,
  shouldRetryCodexWebsocketSend,
} from "./connection.ts";
import {
  CloseAllExecutionSessionsID,
  type ExecutionSessionCapableExecutor,
  NoActiveUpstreamWebsocketError,
  UpstreamWebsocketInterruptRejectedError,
  UpstreamWebsocketReplayRequiredError,
  UpstreamWebsocketTurnError,
  type WebsocketExecutionContext,
  executionSessionIDFromOptions,
  isUpstreamWebsocketTurnError,
  websocketAuthEnabled,
  websocketContextOf,
  websocketInputLossError,
} from "./context.ts";
import { clearCodexReasoningReplayOnWebsocketError, encodeCodexWebsocketAsSSE, normalizeCodexWebsocketCompletion, parseCodexWebsocketErrorWithCooling } from "./errors.ts";
import { applyCodexPromptCacheHeaders, applyCodexWebsocketHeaders, buildCodexResponsesWebsocketURL, frameCodexWebsocketRequestBody, normalizeCodexWebsocketParallelToolCalls } from "./request.ts";
import {
  type CodexWebsocketRead,
  CodexWebsocketSession,
  CodexWebsocketSessionStore,
  type CodexWebsocketTimers,
  type ReadQueue,
  abortReason,
  closeCodexWebsocketSession,
  globalCodexWebsocketSessionStore,
  invalidateUpstreamConn,
  startUpstreamReader,
} from "./session.ts";

export interface CodexWebsocketsExecutorOptions extends CodexExecutorOptions {
  /** Opens upstream sockets (default: Bun's WebSocket client). */
  dialer?: CodexWebsocketDialer;
  /** Session store (default: the process-wide globalCodexWebsocketSessionStore, shared like Go's). */
  store?: CodexWebsocketSessionStore;
  /** Upstream read deadline in ms (default 5 minutes; 0 disables). */
  idleTimeoutMs?: number;
  /** Handshake ceiling in ms (default 30 s). */
  handshakeTimeoutMs?: number;
  /** Timer hooks for the read deadline (tests). */
  timers?: CodexWebsocketTimers;
  /** HTTP executor used for /responses/compact and the 426 fallback. */
  httpExecutor?: CodexExecutor;
}

/** The request pipeline output (Go: codexWebsocketPrepared). */
interface WebsocketPrepared {
  from: Format;
  responseFormat: Format;
  preserveNativeOutput: boolean;
  originalPayload: string;
  body: string;
  wsURL: string;
  headers: Headers;
  replayScope: CodexReasoningReplayScope;
}

/** One upstream exchange on a session socket. */
interface WsTurn {
  sess: CodexWebsocketSession;
  conn: CodexWebsocketConn;
  queue: ReadQueue<CodexWebsocketRead>;
  release: () => void;
  ephemeral: boolean;
  downstream: boolean;
  signal?: AbortSignal;
}

type PayloadOutcome =
  | { kind: "ws_error"; error: StatusError }
  | { kind: "terminal_failure"; error: StatusError; body: string }
  | { kind: "empty_incomplete"; error: StatusError }
  | { kind: "event"; eventType: string; chunks: string[]; terminal: boolean };

interface Bootstrap {
  chunks: string[];
  terminal: boolean;
  error?: unknown;
}

/** Go: CodexWebsocketsExecutor. */
export class CodexWebsocketsExecutor implements ProviderExecutor, ExecutionSessionCapableExecutor {
  readonly identifier = "codex";
  readonly store: CodexWebsocketSessionStore;
  readonly http: CodexExecutor;
  private readonly options: CodexWebsocketsExecutorOptions;
  private readonly dialer: CodexWebsocketDialer;
  private readonly now: () => number;
  private readonly replayCache: CodexReasoningReplayCache;

  constructor(options: CodexWebsocketsExecutorOptions = {}) {
    this.options = options;
    this.store = options.store ?? globalCodexWebsocketSessionStore;
    this.http = options.httpExecutor ?? new CodexExecutor(options);
    this.dialer = options.dialer ?? dialBunCodexWebsocket;
    this.now = options.now ?? Date.now;
    this.replayCache = options.reasoningReplayCache ?? defaultCodexReasoningReplayCache;
  }

  private get modelLevelCooling(): boolean {
    return this.options.modelLevelCooling === true;
  }

  private get headerPolicy(): CodexHeaderPolicy {
    return { disableCloaking: this.options.disableCloaking, headerDefaults: this.options.headerDefaults };
  }

  /** Go: prepareCodexWebsocketStream (stream) and the head of Execute (non-stream). */
  prepare(auth: Auth, req: ExecRequest, opts: ExecOptions, stream: boolean): WebsocketPrepared {
    const baseModel = parseSuffix(req.model).modelName;
    const { apiKey } = codexCreds(auth);
    const baseURL = codexBaseURL(auth);
    const from = opts.sourceFormat;
    const responseFormat = responseFormatOrSource(opts);
    const preserveNativeOutput = isNativeCodexRequest(req.payload, from, responseFormat, opts.headers);
    const originalPayload = opts.originalRequest && opts.originalRequest.length > 0 ? opts.originalRequest : req.payload;
    const isCompat = resolvedModelInfo(req)?.isCompat === true;
    let body: string;
    try {
      body = translateCodexRequestPair(from, FormatCodex, baseModel, originalPayload, req.payload, stream, isCompat).body;
      body = setStringIfDifferent(body, "model", baseModel);
      body = applyRequestThinking(body, req, opts, from, FormatCodex, this.identifier);
    } catch (err) {
      throw asRequestError(err);
    }
    body = setStringIfDifferent(body, "model", baseModel);
    if (!stream) {
      body = setBoolIfDifferent(body, "stream", true);
      body = deleteFields(body, "prompt_cache_retention", "safety_identifier");
    }
    body = ensureWebSearchToolForHistory(body, opts.headers);
    body = normalizeCodexInstructions(body, preserveNativeOutput);
    if (this.options.disableImageGeneration !== true) body = ensureImageGenerationTool(body, baseModel, auth, opts.headers);
    body = normalizeCodexWebsocketParallelToolCalls(body, opts.headers);
    body = normalizeCodexToolSchemas(body);
    const replay = applyCodexReasoningReplayCache(this.replayCache, from, req, opts, body);
    body = replay.body;
    const wsURL = buildCodexResponsesWebsocketURL(baseURL.replace(/\/+$/, "") + "/responses");
    const cached = applyCodexPromptCacheHeaders(from, req, body);
    body = sanitizeCodexInputItemIDs(cached.body);
    if (this.options.disableImageGeneration === true) body = stripImageGenerationTools(body);
    const headers = applyCodexWebsocketHeaders(cached.headers, auth, apiKey, this.headerPolicy, preserveNativeOutput, opts.headers);
    applyCodexRoutingHint(headers, auth, baseModel, body, opts.headers);
    applyModelHeaderOverrides(headers, baseModel);
    return { from, responseFormat, preserveNativeOutput, originalPayload, body, wsURL, headers, replayScope: replay.scope };
  }

  /** Go: executionProxyURL. */
  private proxyURL(auth: Auth, opts: ExecOptions): string {
    return (opts.proxyUrl ?? auth.proxyUrl ?? "").trim();
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** The session's healthy socket for the same target, if any (Go: existingWebsocketSessionConn). */
  existingSessionConn(sess: CodexWebsocketSession, authID: string, wsURL: string, proxyURL: string): CodexWebsocketConn | undefined {
    const conn = sess.conn;
    if (!conn || !sess.targetMatches(authID, wsURL, proxyURL)) return undefined;
    if (sess.upstreamDisconnectError(conn) !== undefined || conn.closeError) return undefined;
    return conn;
  }

  /** Reuses the session's socket or dials a new one (Go: ensureUpstreamConnWithSIWC). */
  async ensureUpstreamConn(sess: CodexWebsocketSession, auth: Auth, wsURL: string, headers: Headers, opts: ExecOptions): Promise<CodexWebsocketConn> {
    const authID = auth.id;
    const proxyURL = this.proxyURL(auth, opts);
    const stale = sess.conn;
    if (stale && !sess.targetMatches(authID, wsURL, proxyURL)) {
      sess.detachConnection(stale);
      log.debug("codex websockets: upstream disconnected", { session: sess.sessionId, reason: "target_changed" });
      stale.close();
    }
    const current = sess.conn;
    if (current) {
      if (sess.readerConn !== current) {
        sess.readerConn = current;
        this.startReader(sess, current);
      }
      log.debug("codex websockets: upstream connected", { session: sess.sessionId, session_object: sess.kind, reused: true });
      return current;
    }
    const lossErr = websocketInputLossError(websocketContextOf(opts));
    if (lossErr) throw lossErr;
    const conn = await this.dialer(wsURL, headers, { proxyUrl: proxyURL, signal: opts.signal, handshakeTimeoutMs: this.options.handshakeTimeoutMs });
    if (sess.conn && sess.targetMatches(authID, wsURL, proxyURL)) {
      conn.close();
      return sess.conn;
    }
    sess.conn = conn;
    sess.wsURL = wsURL;
    sess.authID = authID;
    sess.proxyURL = proxyURL;
    sess.readerConn = conn;
    this.startReader(sess, conn);
    log.debug("codex websockets: upstream connected", { session: sess.sessionId, session_object: sess.kind, reused: false });
    return conn;
  }

  private startReader(sess: CodexWebsocketSession, conn: CodexWebsocketConn): void {
    startUpstreamReader(sess, conn, {
      mapReadError: codexWebsocketTurnTransportError,
      idleTimeoutMs: this.options.idleTimeoutMs,
      timers: this.options.timers,
    });
  }

  private invalidate(sess: CodexWebsocketSession, conn: CodexWebsocketConn, reason: string, err: unknown, notify: boolean): void {
    invalidateUpstreamConn(sess, conn, { reason, err, notify });
  }

  /** Go: readCodexWebsocketMessage (session branch). */
  private async readMessage(turn: WsTurn): Promise<CodexWebsocketRead> {
    for (;;) {
      const next = await turn.queue.next(turn.signal);
      if (next.done) throw new Error("codex websockets executor: session read channel closed");
      const ev = next.value;
      if (ev.conn !== turn.conn) continue;
      if (ev.err !== undefined) throw ev.err;
      return ev;
    }
  }

  private finishTurn(turn: WsTurn, reason: string): void {
    turn.sess.clearActive(turn.conn, turn.queue);
    turn.release();
    if (turn.ephemeral) closeCodexWebsocketSession(turn.sess, reason);
  }

  /**
   * Maps a failed dial (Go: the errDial branch of Execute / ExecuteStream). A
   * 426 handshake falls back to HTTP unless the request is a downstream
   * websocket turn; other rejections become classified status errors.
   */
  private async dialFailure<T>(err: unknown, prepared: WebsocketPrepared, downstream: boolean, fallback: () => Promise<T>): Promise<T> {
    if (isUpstreamWebsocketTurnError(err)) throw codexWebsocketTurnEventID(err, prepared.originalPayload);
    if (err instanceof CodexWebsocketHandshakeError && err.statusCode > 0) {
      if (err.statusCode === 426) {
        if (!downstream) return fallback();
        throw new StatusError(426, err.body, { body: err.body });
      }
      throw newCodexStatusErrWithHeadersAndCooling(err.statusCode, err.headers, err.body, this.modelLevelCooling, this.now());
    }
    throw err;
  }

  /**
   * Opens the turn: session lock, socket (dialed, reused, or the required
   * existing one) and the active read queue. Returns a StreamResult/response
   * from the HTTP fallback when the handshake answered 426.
   */
  private async openTurn<T>(auth: Auth, opts: ExecOptions, prepared: WebsocketPrepared, fallback: () => Promise<T>): Promise<{ turn: WsTurn } | { fallback: T }> {
    const wsCtx = websocketContextOf(opts);
    const downstream = wsCtx?.downstreamWebsocket === true;
    const sessionId = executionSessionIDFromOptions(opts);
    const ephemeral = sessionId === "";
    const sess = ephemeral ? new CodexWebsocketSession("") : this.store.getOrCreate(sessionId)!;
    const release = ephemeral ? () => {} : await sess.lock();
    sess.recoverTransport = downstream;
    sess.turnContext = wsCtx;
    let conn: CodexWebsocketConn;
    if (wsCtx?.requiredUpstreamWebsocket) {
      const existing = this.existingSessionConn(sess, auth.id, prepared.wsURL, this.proxyURL(auth, opts));
      if (!existing) {
        release();
        if (downstream && isUpstreamWebsocketTurnError(sess.terminalErr)) throw new UpstreamWebsocketTurnError({ fullContextRequired: true });
        throw new UpstreamWebsocketReplayRequiredError();
      }
      conn = existing;
    } else {
      try {
        conn = await this.ensureUpstreamConn(sess, auth, prepared.wsURL, prepared.headers, opts);
      } catch (err) {
        release();
        return { fallback: await this.dialFailure(err, prepared, downstream, fallback) };
      }
    }
    const queue = sess.activate(conn);
    return { turn: { sess, conn, queue, release, ephemeral, downstream, signal: opts.signal } };
  }

  /**
   * Writes the response.create frame, retrying once on a fresh socket for a
   * persistent session (Go: the writeCodexWebsocketMessage error branches).
   */
  private async sendCreate(turn: WsTurn, auth: Auth, opts: ExecOptions, prepared: WebsocketPrepared, frame: string, turnErrors: boolean): Promise<void> {
    const { sess } = turn;
    try {
      turn.conn.send(frame);
      return;
    } catch (rawErr) {
      let errSend = mapCodexWebsocketWriteError(sess.upstreamDisconnectError(turn.conn) as CodexWebsocketCloseError | undefined, rawErr);
      const required = websocketContextOf(opts)?.requiredUpstreamWebsocket === true;
      if (!turn.ephemeral && turnErrors) {
        // A failed write may still have delivered the create: never send it again.
        const turnErr = codexWebsocketTurnEventID(codexWebsocketTurnTransportError(errSend), prepared.originalPayload);
        if (isUpstreamWebsocketTurnError(turnErr)) {
          sess.markTerminalError(turn.conn, turnErr);
          this.invalidate(sess, turn.conn, "send_error", turnErr, true);
          sess.clearActive(turn.conn, turn.queue);
          turn.release();
          throw turnErr;
        }
        errSend = turnErr;
      }
      if (turn.ephemeral) {
        this.invalidate(sess, turn.conn, "send_error", errSend, true);
        this.finishTurn(turn, "send_error");
        throw errSend;
      }
      if (required) {
        this.invalidate(sess, turn.conn, "send_error", errSend, false);
        sess.clearActive(turn.conn, turn.queue);
        turn.release();
        if (!shouldRetryCodexWebsocketSend(errSend)) throw errSend;
        throw new UpstreamWebsocketReplayRequiredError();
      }
      this.invalidate(sess, turn.conn, "send_error", errSend, true);
      if (!shouldRetryCodexWebsocketSend(errSend)) {
        sess.clearActive(turn.conn, turn.queue);
        turn.release();
        throw errSend;
      }
      // Retry once on a new socket for the same execution session.
      let retryConn: CodexWebsocketConn;
      try {
        retryConn = await this.ensureUpstreamConn(sess, auth, prepared.wsURL, prepared.headers, opts);
      } catch (errDial) {
        sess.clearActive(turn.conn, turn.queue);
        turn.release();
        throw errDial;
      }
      sess.clearActive(turn.conn, turn.queue);
      turn.conn = retryConn;
      turn.queue = sess.activate(retryConn);
      try {
        retryConn.send(frame);
      } catch (rawRetryErr) {
        const errRetry = mapCodexWebsocketWriteError(sess.upstreamDisconnectError(retryConn) as CodexWebsocketCloseError | undefined, rawRetryErr);
        this.invalidate(sess, retryConn, "send_error", errRetry, true);
        sess.clearActive(retryConn, turn.queue);
        turn.release();
        throw errRetry;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Execute (non-stream)
  // -------------------------------------------------------------------------

  async execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    if (opts.alt === CodexCompactAlt) return this.http.execute(auth, req, opts);
    const prepared = this.prepare(auth, req, opts, false);
    const opened = await this.openTurn(auth, opts, prepared, () => this.http.execute(auth, req, opts));
    if ("fallback" in opened) return opened.fallback;
    const turn = opened.turn;
    let reason = "completed";
    try {
      await this.sendCreate(turn, auth, opts, prepared, frameCodexWebsocketRequestBody(prepared.body), false);
      const items = newCollectedOutputItems();
      let sawOutputDelta = false;
      for (;;) {
        if (opts.signal?.aborted) throw abortReason(opts.signal);
        let ev: CodexWebsocketRead;
        try {
          ev = await this.readMessage(turn);
        } catch (errRead) {
          reason = "read_error";
          throw mapCodexWebsocketReadError(errRead);
        }
        const payload = ev.payload;
        if (payload.length === 0) continue;
        const wsErr = parseCodexWebsocketErrorWithCooling(payload, this.modelLevelCooling, this.now());
        if (wsErr) {
          reason = "upstream_error";
          this.invalidate(turn.sess, turn.conn, "upstream_error", wsErr, true);
          clearCodexReasoningReplayOnWebsocketError(this.replayCache, prepared.replayScope, payload);
          throw wsErr;
        }
        const failure = codexTerminalFailureErrWithCooling(payload, this.modelLevelCooling, this.now());
        if (failure) {
          reason = "terminal_failure";
          turn.release();
          this.invalidate(turn.sess, turn.conn, "terminal_failure", failure.error, true);
          clearCodexReasoningReplayOnInvalidSignature(this.replayCache, prepared.replayScope, failure.error.statusCode, failure.body);
          throw failure.error;
        }
        const normalized = normalizeCodexWebsocketCompletion(payload);
        const root = tryParse<unknown>(normalized);
        const eventType = gstr(getAt(root, "type"));
        if (hasMeaningfulCodexOutputDelta(root)) sawOutputDelta = true;
        if (eventType === "response.output_item.done") {
          collectCodexOutputItemDone(root, items);
          continue;
        }
        if (eventType !== "response.completed" && eventType !== "response.done" && eventType !== "response.incomplete") continue;
        if (isCodexTerminalEmptyIncomplete(root, collectedOutputItemCount(items), sawOutputDelta)) {
          reason = "terminal_empty_incomplete";
          this.invalidate(turn.sess, turn.conn, "terminal_empty_incomplete", undefined, true);
          throw newCodexEmptyIncompleteStreamError();
        }
        const completed = patchCompleted(normalized, root, items);
        if (eventType !== "response.incomplete") cacheCodexReasoningReplayFromCompleted(this.replayCache, prepared.replayScope, completed);
        const state: TranslatorState = {};
        let out = defaultRegistry.translateNonStream({ signal: opts.signal }, FormatCodex, prepared.responseFormat, req.model, prepared.originalPayload, prepared.body, completed, state);
        if (prepared.responseFormat === FormatOpenAIResponse) out = ensureResponsesUsageDetails(out);
        return { payload: out };
      }
    } catch (err) {
      if (reason === "completed") reason = "error";
      throw err;
    } finally {
      this.finishTurn(turn, reason);
    }
  }

  // -------------------------------------------------------------------------
  // ExecuteStream
  // -------------------------------------------------------------------------

  async executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    if (opts.alt === CodexCompactAlt) throw new StatusError(400, "streaming not supported for /responses/compact", { requestScoped: true });
    const prepared = this.prepare(auth, req, opts, true);
    const opened = await this.openTurn(auth, opts, prepared, () => this.http.executeStream(auth, req, opts));
    if ("fallback" in opened) return opened.fallback;
    const turn = opened.turn;
    const wsCtx = websocketContextOf(opts);
    if (!turn.ephemeral && turn.downstream) {
      const lossErr = websocketInputLossError(wsCtx);
      if (lossErr) {
        turn.sess.clearActive(turn.conn, turn.queue);
        turn.release();
        throw codexWebsocketTurnEventID(lossErr, prepared.originalPayload);
      }
    }
    await this.sendCreate(turn, auth, opts, prepared, frameCodexWebsocketRequestBody(prepared.body), turn.downstream);
    const processor = new WebsocketPayloadProcessor(this, req, opts, prepared, turn.downstream);
    let bootstrap: Bootstrap = { chunks: [], terminal: false };
    if (this.options.streamBootstrapBuffering === true) bootstrap = await this.bootstrapStream(turn, processor, prepared);
    if (bootstrap.error !== undefined) {
      // The socket was already released in the terminal branch of the bootstrap.
      if (turn.ephemeral) closeCodexWebsocketSession(turn.sess, "bootstrap_terminal_error");
    } else if (bootstrap.terminal) {
      this.finishTurn(turn, "completed");
    }
    return { chunks: guardedIterable(this.streamChunks(turn, processor, prepared, bootstrap), () => this.finishTurn(turn, "context_done")) };
  }

  /**
   * The buffered head of ExecuteStream (Go: the `if buffering` loop): handshake
   * frames are held until the first generated event so an overload or usage
   * limit rejection fails over before any chunk exists.
   */
  private async bootstrapStream(turn: WsTurn, processor: WebsocketPayloadProcessor, prepared: WebsocketPrepared): Promise<Bootstrap> {
    const timeout = Math.max(0, this.options.streamBootstrapTimeoutMs ?? 0);
    const start = this.now();
    let bufferedFrames = 0;
    let bufferedBytes = 0;
    const buffered: string[] = [];
    for (;;) {
      if (turn.signal?.aborted) {
        this.finishTurn(turn, "context_done");
        throw abortReason(turn.signal);
      }
      let ev: CodexWebsocketRead;
      try {
        ev = await this.readMessage(turn);
      } catch (errRead) {
        if (turn.signal?.aborted) {
          this.finishTurn(turn, "context_done");
          throw abortReason(turn.signal);
        }
        const mapped = codexWebsocketTurnEventID(mapCodexWebsocketReadError(errRead), prepared.originalPayload);
        this.invalidate(turn.sess, turn.conn, "read_error", mapped, true);
        this.finishTurn(turn, "read_error");
        throw mapped;
      }
      bufferedFrames++;
      const timeoutReached = timeout > 0 && this.now() - start >= timeout;
      const windowOpen = bufferedFrames <= codexBootstrapMaxBufferedFrames && !timeoutReached;
      const payload = ev.payload;
      if (payload.length === 0) {
        if (!windowOpen) break;
        continue;
      }
      const outcome = processor.process(payload);
      if (outcome.kind === "ws_error") {
        this.invalidate(turn.sess, turn.conn, "upstream_error", outcome.error, timeoutReached && buffered.length > 0);
        turn.sess.clearActive(turn.conn, turn.queue);
        turn.release();
        clearCodexReasoningReplayOnWebsocketError(this.replayCache, prepared.replayScope, payload);
        if (timeoutReached) return { chunks: buffered, terminal: false, error: outcome.error };
        if (turn.ephemeral) closeCodexWebsocketSession(turn.sess, "upstream_error");
        throw outcome.error;
      }
      if (outcome.kind === "terminal_failure") {
        const overloadFailover = isCodexOverloadBootstrapFailure(outcome.body);
        const usageLimitFailover = isCodexUsageLimitError(outcome.body);
        const failoverPending = (overloadFailover || usageLimitFailover) && !timeoutReached;
        const notify = !failoverPending && buffered.length > 0;
        this.invalidate(turn.sess, turn.conn, "terminal_failure", outcome.error, notify);
        turn.sess.clearActive(turn.conn, turn.queue);
        turn.release();
        clearCodexReasoningReplayOnInvalidSignature(this.replayCache, prepared.replayScope, outcome.error.statusCode, outcome.body);
        if (failoverPending) {
          if (turn.ephemeral) closeCodexWebsocketSession(turn.sess, "bootstrap_overload");
          throw overloadFailover ? newCodexBootstrapOverloadErr(outcome.body) : outcome.error;
        }
        return { chunks: buffered, terminal: false, error: outcome.error };
      }
      if (outcome.kind === "empty_incomplete") {
        this.invalidate(turn.sess, turn.conn, "terminal_empty_incomplete", outcome.error, true);
        turn.sess.clearActive(turn.conn, turn.queue);
        turn.release();
        return { chunks: buffered, terminal: false, error: outcome.error };
      }
      if (windowOpen && isCodexBootstrapBufferableEvent(outcome.eventType, payload) && !outcome.terminal) {
        let frameBytes = utf8Len(payload);
        for (const chunk of outcome.chunks) frameBytes += utf8Len(chunk);
        if (bufferedBytes + frameBytes <= codexBootstrapMaxBufferedBytes) {
          bufferedBytes += frameBytes;
          buffered.push(...outcome.chunks);
          continue;
        }
        log.debug("codex websockets executor: bootstrap byte limit reached, releasing stream", { frames: bufferedFrames, bytes: bufferedBytes });
      }
      return { chunks: [...buffered, ...outcome.chunks], terminal: outcome.terminal };
    }
    return { chunks: buffered, terminal: false };
  }

  /** The stream after the (optional) bootstrap (Go: the ExecuteStream reader goroutine). */
  private async *streamChunks(turn: WsTurn, processor: WebsocketPayloadProcessor, prepared: WebsocketPrepared, bootstrap: Bootstrap): AsyncGenerator<string> {
    let reason = "completed";
    let emitted = false;
    try {
      for (const chunk of bootstrap.chunks) {
        if (chunk.length === 0) continue;
        emitted = true;
        yield chunk;
      }
      if (bootstrap.error !== undefined) throw bootstrap.error;
      if (bootstrap.terminal) return;
      for (;;) {
        if (turn.signal?.aborted) {
          reason = "context_done";
          throw abortReason(turn.signal);
        }
        let ev: CodexWebsocketRead;
        try {
          ev = await this.readMessage(turn);
        } catch (errRead) {
          if (turn.signal?.aborted) {
            reason = "context_done";
            throw abortReason(turn.signal);
          }
          reason = "read_error";
          throw codexWebsocketTurnEventID(mapCodexWebsocketReadError(errRead), prepared.originalPayload);
        }
        const payload = ev.payload;
        if (payload.length === 0) continue;
        const outcome = processor.process(payload);
        if (outcome.kind === "ws_error" || outcome.kind === "terminal_failure") {
          reason = "upstream_error";
          // The disconnect notification closes the downstream client, so it must
          // follow the delivery of the error; before any payload the manager may
          // still fail over on the same downstream socket, so no notification.
          this.invalidate(turn.sess, turn.conn, outcome.kind === "ws_error" ? "upstream_error" : "terminal_failure", outcome.error, false);
          turn.sess.clearActive(turn.conn, turn.queue);
          turn.release();
          if (outcome.kind === "ws_error") clearCodexReasoningReplayOnWebsocketError(this.replayCache, prepared.replayScope, payload);
          else clearCodexReasoningReplayOnInvalidSignature(this.replayCache, prepared.replayScope, outcome.error.statusCode, outcome.body);
          if (emitted) {
            const sess = turn.sess;
            const error = outcome.error;
            setTimeout(() => sess.notifyUpstreamDisconnect(error), 0);
          }
          throw outcome.error;
        }
        if (outcome.kind === "empty_incomplete") {
          reason = "terminal_empty_incomplete";
          this.invalidate(turn.sess, turn.conn, "terminal_empty_incomplete", outcome.error, true);
          turn.release();
          throw outcome.error;
        }
        for (const chunk of outcome.chunks) {
          if (chunk.length === 0) continue;
          emitted = true;
          yield chunk;
        }
        if (outcome.terminal) return;
      }
    } catch (err) {
      if (reason === "completed") reason = "error";
      throw err;
    } finally {
      this.finishTurn(turn, reason);
    }
  }

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  /**
   * Writes the client's response.interrupt frame unchanged to the session's
   * current socket when it runs the targeted response (Go:
   * CodexWebsocketsExecutor.InterruptExecutionSession). Never dials, replays or
   * selects another credential.
   */
  async interruptExecutionSession(sessionId: string, payload: string, ctx?: WebsocketExecutionContext): Promise<void> {
    const id = sessionId.trim();
    if (id === "") throw new NoActiveUpstreamWebsocketError();
    const sess = this.store.get(id);
    if (!sess) throw new NoActiveUpstreamWebsocketError();
    const conn = sess.conn;
    if (!conn) throw new NoActiveUpstreamWebsocketError();
    const authEnabled = websocketAuthEnabled(ctx, sess.authID);
    if (sess.conn !== conn) throw new NoActiveUpstreamWebsocketError();
    const targetID = gstr(getAt(tryParse(payload), "response_id"));
    const alreadyTerminal = sess.terminalResponseIDs.has(targetID) && sess.responseStateConn === conn;
    const liveChannel = sess.activeConn === conn && sess.activeQueue !== undefined;
    const active = liveChannel && !sess.activeResponseTerminal && (sess.activeResponseID === "" || sess.activeResponseID === targetID);
    const disconnectErr = sess.terminalConn === conn ? sess.terminalErr : undefined;
    if (disconnectErr !== undefined) throw disconnectErr;
    if (alreadyTerminal) {
      log.debug("codex websockets: response.interrupt handled", { outcome: "already_terminal" });
      return;
    }
    if (!liveChannel) throw new NoActiveUpstreamWebsocketError();
    if (!active) throw new UpstreamWebsocketInterruptRejectedError();
    if (!authEnabled) throw new Error("websocket credential is no longer enabled");
    conn.send(payload);
    log.debug("codex websockets: response.interrupt handled", { outcome: "forwarded" });
  }

  /** Go: UpstreamDisconnectChan. */
  upstreamDisconnect(sessionId: string): Promise<unknown> | undefined {
    return this.store.getOrCreate(sessionId)?.upstreamDisconnect;
  }

  /** Releases one execution session, or all of them for CloseAllExecutionSessionsID (Go: CloseExecutionSession). */
  closeExecutionSession(sessionId: string): void {
    const id = sessionId.trim();
    if (id === "") return;
    if (id === CloseAllExecutionSessionsID) {
      for (const key of [...this.store.sessions.keys()]) closeCodexWebsocketSession(this.store.take(key), "executor_shutdown");
      return;
    }
    closeCodexWebsocketSession(this.store.take(id), "session_closed");
  }

  /** Closes every session bound to a removed credential (Go: CloseAuthExecutionSessions). */
  closeAuthExecutionSessions(authId: string): void {
    const id = authId.trim();
    if (id === "") return;
    for (const [key, sess] of [...this.store.sessions.entries()]) {
      if (sess.authID.trim() !== id) continue;
      this.store.take(key);
      closeCodexWebsocketSession(sess, "auth_removed");
    }
  }

  countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    return this.http.countTokens(auth, req, opts);
  }

  refresh(auth: Auth): Promise<Auth> {
    if (codexAuthUsesAPIKey(auth)) return Promise.resolve(auth);
    return new CodexAuthenticator().refresh(auth, { fetch: this.options.fetch, now: this.options.now });
  }

  /** @internal */
  get internals() {
    return { modelLevelCooling: this.modelLevelCooling, now: this.now, replayCache: this.replayCache };
  }
}

/**
 * Classifies and shapes one upstream payload (shared by the bootstrap and the
 * streaming phase of ExecuteStream).
 */
class WebsocketPayloadProcessor {
  private readonly items = newCollectedOutputItems();
  private sawOutputDelta = false;
  private readonly state: TranslatorState = {};
  private readonly ctx: TranslateContext;

  constructor(
    private readonly executor: CodexWebsocketsExecutor,
    private readonly req: ExecRequest,
    opts: ExecOptions,
    private readonly prepared: WebsocketPrepared,
    private readonly downstream: boolean,
  ) {
    this.ctx = { signal: opts.signal };
  }

  process(payload: string): PayloadOutcome {
    const { modelLevelCooling, now, replayCache } = this.executor.internals;
    const wsErr = parseCodexWebsocketErrorWithCooling(payload, modelLevelCooling, now());
    if (wsErr) return { kind: "ws_error", error: wsErr };
    const failure = codexTerminalFailureErrWithCooling(payload, modelLevelCooling, now());
    if (failure) return { kind: "terminal_failure", error: failure.error, body: failure.body };
    const root = tryParse<unknown>(payload);
    const eventType = gstr(getAt(root, "type"));
    const completion = eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete";
    const terminal = completion || eventType === "response.failed" || eventType === "error";
    if (hasMeaningfulCodexOutputDelta(root)) this.sawOutputDelta = true;
    if (isCodexTerminalEmptyIncomplete(root, collectedOutputItemCount(this.items), this.sawOutputDelta)) {
      return { kind: "empty_incomplete", error: newCodexEmptyIncompleteStreamError() };
    }
    if (eventType === "response.output_item.done") collectCodexOutputItemDone(root, this.items);
    let out = payload;
    if (completion) {
      let completed = normalizeCodexWebsocketCompletion(payload);
      if (!this.prepared.preserveNativeOutput) completed = patchCompleted(completed, tryParse(completed), this.items);
      if (eventType !== "response.incomplete") cacheCodexReasoningReplayFromCompleted(replayCache, this.prepared.replayScope, completed);
      out = completed;
    }
    if (this.downstream) return { kind: "event", eventType, chunks: [ensureResponsesUsageDetails(out)], terminal };
    if (!completion) out = normalizeCodexWebsocketCompletion(out);
    let chunks = defaultRegistry.translateStream(this.ctx, FormatCodex, this.prepared.responseFormat, this.req.model, this.prepared.originalPayload, this.prepared.body, encodeCodexWebsocketAsSSE(out), this.state);
    if (this.prepared.responseFormat === FormatOpenAIResponse) chunks = chunks.map(ensureResponsesUsageDetails);
    return { kind: "event", eventType, chunks, terminal };
  }
}

/** The completion with its output rebuilt from collected items (Go: patchCodexCompletedOutput); unchanged bytes when nothing changed. */
function patchCompleted(payload: string, root: unknown, items: ReturnType<typeof newCollectedOutputItems>): string {
  if (!isObj(root)) return payload;
  const before = JSON.stringify(root);
  patchCodexCompletedOutput(root, items);
  const after = JSON.stringify(root);
  return after === before ? payload : after;
}

/**
 * An async iterable whose cleanup also runs when the consumer returns before
 * the first next() (a generator never started skips its finally block).
 */
function guardedIterable(gen: AsyncGenerator<string>, cleanup: () => void): AsyncIterable<string> {
  let started = false;
  let done = false;
  const iterator: AsyncIterator<string> = {
    next() {
      started = true;
      return gen.next().then((r) => {
        if (r.done) done = true;
        return r;
      });
    },
    async return(value?: unknown) {
      if (!started && !done) {
        done = true;
        cleanup();
        return { value: value as string, done: true };
      }
      done = true;
      return gen.return(value as string);
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

/** Builds the websocket executor. */
export function createCodexWebsocketsExecutor(options: CodexWebsocketsExecutorOptions = {}): CodexWebsocketsExecutor {
  return new CodexWebsocketsExecutor(options);
}

// The /v1/responses websocket transport (GET /v1/responses with an Upgrade).
// Port of sdk/api/handlers/openai/openai_responses_websocket.go (ResponsesWebsocket),
// openai_responses_websocket_input.go (readResponsesWebsocketInput,
// forwardResponsesWebsocketInterrupt) and openai_responses_websocket_session.go.
//
// Protocol: the client sends `response.create` (and `response.append`) frames
// and receives the Responses events as JSON text messages. Turns run one at a
// time; the connection keeps the session state across turns:
//   - HTTP upstreams: the previous request and response output are merged into
//     each follow-up (full transcript), compacted transcripts replace it, tool
//     call/output pairs are repaired from the session's tool caches and a
//     response.create with generate:false is answered locally (prewarm).
//   - Websocket upstreams (Codex credentials with websockets enabled): after a
//     turn completed on the upstream socket, follow-ups are passed through
//     natively (incremental input, previous_response_id) on the same upstream
//     socket and credential; a continuation that cannot reach it closes the
//     client with 1012 ("upstream requires HTTP replay").
//   - response.interrupt is written to the live upstream socket, or answered
//     locally for an HTTP turn with a synthetic response.incomplete.
//   - Errors: request faults are reported with an `error` event before the
//     socket closes; credential/quota/transport failures close it silently so
//     the client reconnects; an upstream websocket loss reports
//     upstream_websocket_lost and keeps the client socket open.
//
// Dropped from upstream: duplex response steering (codex.response-steering:
// the duplex input channel, per-frame authorizer and acknowledgement draining),
// plugin and provider-route overrides, Home runtime credentials, multi-agent v2
// and orphan delegation preparation, xAI websockets, compression settings and
// the request-log file timeline (the timeline is kept in memory and handed to
// an optional sink).
import { SelectedAuthCallbackMetadataKey } from "../auth/manager/index.ts";
import { StatusDisabled, type Auth } from "../auth/types.ts";
import { isCodexResponsesLiteRequest } from "../executor/codex/creds.ts";
import { websocketsEnabledFor } from "../executor/codex/websockets/auto.ts";
import { CloseNormalClosure } from "../executor/codex/websockets/connection.ts";
import {
  ExecutionSessionMetadataKey,
  type ExecutionSessionCapableExecutor,
  NoActiveUpstreamWebsocketError,
  UpstreamWebsocketReplayRequiredError,
  UpstreamWebsocketTurnError,
  type WebsocketExecutionContext,
  type WebsocketInputEpoch,
  WebsocketContextMetadataKey,
  asUpstreamWebsocketTurnError,
} from "../executor/codex/websockets/context.ts";
import { ReadQueue } from "../executor/codex/websockets/session.ts";
import { PinnedAuthMetadataKey, RequestPathMetadataKey, RequestedModelMetadataKey, type ErrorMessage, type ExecOptions, type ExecRequest, type ProviderExecutor, type StreamResult } from "../executor/types.ts";
import { log } from "../log.ts";
import { getGlobalRegistry, type ModelRegistry } from "../registry/index.ts";
import { parseSuffix } from "../thinking/suffix.ts";
import { FormatOpenAIResponse } from "../translator/types.ts";
import { isObject, tryParse, type JSONObject } from "../util/json.ts";
import { RequestUsageRecorder } from "../usage/recorder.ts";
import type { UsageStatistics } from "../usage/statistics.ts";
import { CallerAPIKeyMetadataKey, type ExecutionManager } from "./claude_handlers.ts";
import { enrichAuthSelectionError, executionErrorMessage } from "./errors.ts";
import { openAIErrorMessage } from "./images_handlers.ts";
import { parseResponsesUsageNode, responsesForwardableHeaders } from "./responses_handlers.ts";
import { isCodexResponsesClientRequest } from "./responses_sse.ts";
import {
  ResponsesLocalInterrupt,
  ResponsesWebsocketWriter,
  type ResponsesWebsocketTransport,
  type TurnSource,
  type TurnSourceItem,
  WebsocketTimelineLog,
  appendResponsesInterruptDiagnostic,
  appendWebsocketTimelineDisconnect,
  buildResponsesWebsocketErrorPayload,
  forwardResponsesWebsocket,
  isWebsocketCloseSent,
  shouldReleaseResponsesWebsocketPinnedAuth,
  shouldReplayResponsesWebsocketPinnedAuthFailure,
  websocketPayloadEventType,
  writeResponsesWebsocketError,
  writeResponsesWebsocketPayload,
} from "./responses_websocket_forward.ts";
import {
  inputContainsFullTranscript,
  jsonString,
  normalizeResponseCreateRequest,
  normalizeResponseTranscriptReplacement,
  normalizeResponsesWebsocketPassthroughRequest,
  normalizeResponsesWebsocketPrewarmFollowup,
  normalizeResponsesWebsocketRequestWithIncrementalState,
  parseFrame,
  requestType,
  shouldHandleResponsesWebsocketPrewarmLocally,
  syntheticResponsesWebsocketPrewarmPayloads,
  wsErrorMessage,
  wsRequestTypeAppend,
  wsRequestTypeCreate,
} from "./responses_websocket_requests.ts";
import { prepareResponsesWebsocketFallbackTurn, releaseResponsesWebsocketToolCaches, retainResponsesWebsocketToolCaches, websocketDownstreamSessionKey } from "./responses_websocket_toolcall_repair.ts";

/** Echoed on the upgrade response so reconnects keep the sticky turn state (Go: wsTurnStateHeader). */
export const wsTurnStateHeader = "x-codex-turn-state";

const upstreamModeUnknown = "";
const upstreamModeWS = "websocket";
const upstreamModeHTTP = "http";

/** What the handler needs from the AuthManager beyond executions. */
export interface ResponsesWebsocketManager extends ExecutionManager {
  executor?(provider: string): ProviderExecutor | undefined;
  list?(): Auth[];
  closeExecutionSession?(sessionId: string): void;
}

export interface ResponsesWebsocketHandlerOptions {
  manager: ResponsesWebsocketManager;
  registry?: ModelRegistry;
  usage?: UsageStatistics;
  now?: () => number;
  /** Ping interval while a turn waits for upstream output (0 = off, Go: streaming keep-alive). */
  keepAliveIntervalMs?: number;
  /** Receives each connection's timeline when it closes; enables the timeline (Go: request-log timeline). */
  onTimeline?: (sessionId: string, timeline: string) => void;
  /** Id factory for connection ids and synthetic prewarm responses (tests). */
  newId?: () => string;
}

export interface ResponsesWebsocketUpgrade {
  /** The upgrade request; its headers are the connection's client headers. */
  request: Request;
  /** The inbound key the upgrade authenticated with ("" when open). */
  clientKey?: string;
  /** Re-checks the inbound credential for every frame (Go: authenticateResponsesWebsocketTurn). */
  authenticateTurn?: (payload: string) => ErrorMessage | undefined;
}

/** Headers for the upgrade response (Go: websocketUpgradeHeaders). */
export function websocketUpgradeHeaders(request: Request): Headers {
  const headers = new Headers();
  const turnState = (request.headers.get(wsTurnStateHeader) ?? "").trim();
  if (turnState !== "") headers.set(wsTurnStateHeader, turnState);
  return headers;
}

/** Whether a request asks for the /v1/responses websocket upgrade. */
export function isResponsesWebsocketUpgradeRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== "GET") return false;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path !== "/v1/responses") return false;
  return (request.headers.get("Upgrade") ?? "").toLowerCase().split(",").some((token) => token.trim() === "websocket");
}

/** Go: responsesWebsocketPreviousResponseNotFoundError. */
export function responsesWebsocketPreviousResponseNotFoundError(): ErrorMessage {
  return {
    statusCode: 409,
    error: new Error(
      `{"error":{"message":"Previous response is not available on this websocket; resend the full conversation input without previous_response_id","type":"invalid_request_error","code":"previous_response_not_found","param":"previous_response_id"}}`,
    ),
  };
}

/** Go: responsesWebsocketRequestRequiresCurrentUpstream. */
export function responsesWebsocketRequestRequiresCurrentUpstream(root: JSONObject): boolean {
  return jsonString(root.previous_response_id).trim() !== "" || requestType(root) === wsRequestTypeAppend;
}

/** Go: responsesWebsocketNativePassthroughAllowed. */
export function responsesWebsocketNativePassthroughAllowed(upstreamMode: string, useUpstreamWebsocket: boolean, pinnedAuthID: string, upstreamAuthID: string): boolean {
  return upstreamMode === upstreamModeWS && useUpstreamWebsocket && pinnedAuthID.trim() !== "" && pinnedAuthID.trim() === upstreamAuthID.trim();
}

/** Go: responsesWebsocketAuthAvailableForModel. */
export function responsesWebsocketAuthAvailableForModel(auth: Auth | undefined, modelName: string, nowMs: number): boolean {
  if (!auth || auth.disabled || auth.status === StatusDisabled) return false;
  if (modelName !== "" && auth.modelStates && Object.keys(auth.modelStates).length > 0) {
    let state = auth.modelStates[modelName];
    if (!state) {
      const base = parseSuffix(modelName).modelName.trim();
      if (base !== "" && base !== modelName) state = auth.modelStates[base];
    }
    if (state) {
      if (state.status === StatusDisabled) return false;
      if (state.unavailable && state.nextRetryAfter > 0 && state.nextRetryAfter > nowMs) return false;
      return true;
    }
  }
  if (auth.unavailable && auth.nextRetryAfter > 0 && auth.nextRetryAfter > nowMs) return false;
  return true;
}

interface PinnedAuthState {
  authID: string;
  modelKey: string;
}

interface ObservedCompaction {
  modelName: string;
  modelKey: string;
  authID: string;
}

const emptyCompaction = (): ObservedCompaction => ({ modelName: "", modelKey: "", authID: "" });

/** The OpenAI Responses websocket handler (Go: OpenAIResponsesAPIHandler.ResponsesWebsocket). */
export class ResponsesWebsocketHandler {
  readonly manager: ResponsesWebsocketManager;
  readonly registry: ModelRegistry;
  readonly usage: UsageStatistics | undefined;
  readonly now: () => number;
  readonly keepAliveIntervalMs: number;
  readonly onTimeline?: (sessionId: string, timeline: string) => void;
  readonly newId: () => string;

  constructor(options: ResponsesWebsocketHandlerOptions) {
    this.manager = options.manager;
    this.registry = options.registry ?? getGlobalRegistry();
    this.usage = options.usage;
    this.now = options.now ?? Date.now;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? 0;
    this.onTimeline = options.onTimeline;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** A connection for an accepted upgrade; call open() with the socket. */
  connect(upgrade: ResponsesWebsocketUpgrade): ResponsesWebsocketConnection {
    return new ResponsesWebsocketConnection(this, upgrade);
  }

  authByID(id: string): Auth | undefined {
    const key = id.trim();
    if (key === "") return undefined;
    return this.manager.getById?.(key);
  }

  /** Go: responsesWebsocketProviderSetForModel. */
  providerSetForModel(resolvedModelName: string): { providers: Set<string>; modelKey: string } {
    const base = parseSuffix(resolvedModelName).modelName.trim();
    let providers = base === "" ? [] : this.registry.getModelProviders(base);
    if (providers.length === 0 && base !== resolvedModelName && resolvedModelName.trim() !== "") providers = this.registry.getModelProviders(resolvedModelName);
    const set = new Set<string>();
    for (const provider of providers) {
      const key = provider.trim().toLowerCase();
      if (key !== "") set.add(key);
    }
    return { providers: set, modelKey: base !== "" ? base : resolvedModelName.trim() };
  }

  /** Credentials that may serve the model now (Go: responsesWebsocketAvailableAuthsForModel). */
  availableAuthsForModel(modelName: string): Auth[] {
    const { providers, modelKey } = this.providerSetForModel(modelName);
    if (providers.size === 0 || !this.manager.list) return [];
    const now = this.now();
    return this.manager.list().filter((auth) => {
      if (!providers.has((auth.provider ?? "").trim().toLowerCase())) return false;
      if (modelKey !== "" && !this.registry.clientSupportsModel(auth.id, modelKey)) return false;
      return responsesWebsocketAuthAvailableForModel(auth, modelKey, now);
    });
  }

  /** Every candidate is a websocket-enabled Codex credential (Go: responsesWebsocketUsesUpstreamWebsocketPassthrough). */
  usesUpstreamWebsocketPassthrough(modelName: string): boolean {
    if (modelName.trim() === "") return false;
    const auths = this.availableAuthsForModel(modelName);
    if (auths.length === 0) return false;
    for (const auth of auths) {
      if ((auth.provider ?? "").trim().toLowerCase() !== "codex") return false;
      if (!websocketsEnabledFor(auth.attributes, auth.metadata)) return false;
    }
    return this.manager.executor?.("codex") !== undefined;
  }

  /** Every candidate consumes compacted replays (Go: websocketUpstreamSupportsCompactionReplayForModel). */
  supportsCompactionReplayForModel(modelName: string): boolean {
    const auths = this.availableAuthsForModel(modelName);
    return auths.length > 0 && auths.every((auth) => (auth.provider ?? "").trim().toLowerCase() === "codex");
  }

  /** Go: responsesWebsocketPinnedAuthMatchesModel (non-Home branch). */
  pinnedAuthMatchesModel(auth: Auth | undefined, modelName: string): boolean {
    if (!auth) return false;
    const { providers, modelKey } = this.providerSetForModel(modelName);
    if (!providers.has((auth.provider ?? "").trim().toLowerCase())) return false;
    if (!responsesWebsocketAuthAvailableForModel(auth, modelKey, this.now())) return false;
    return this.registry.clientSupportsModel(auth.id, modelKey);
  }

  upstreamModeForAuth(auth: Auth | undefined): string {
    if (auth && websocketsEnabledFor(auth.attributes, auth.metadata) && (auth.provider ?? "").trim().toLowerCase() === "codex") return upstreamModeWS;
    return upstreamModeHTTP;
  }

  /** Go: getRequestDetails. */
  requestDetails(modelName: string): { providers: string[]; model: string } | { error: ErrorMessage } {
    const base = parseSuffix(modelName).modelName.trim();
    let providers = base === "" ? [] : this.registry.getModelProviders(base);
    if (providers.length === 0 && base !== modelName) providers = this.registry.getModelProviders(modelName);
    if (providers.length === 0) {
      return { error: openAIErrorMessage(400, { message: `unknown provider for model ${modelName}`, type: "invalid_request_error", code: "model_not_found", param: "model" }) };
    }
    return { providers, model: modelName };
  }
}

interface InputFrame {
  payload: string;
  epoch: number;
}

/** One downstream websocket (Go: the body of ResponsesWebsocket). */
export class ResponsesWebsocketConnection {
  readonly sessionId: string;
  readonly timeline: WebsocketTimelineLog;
  /** Resolves when the connection's turn loop ended. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private writer!: ResponsesWebsocketWriter;
  private readonly socketAbort = new AbortController();
  private readonly inputEpoch: WebsocketInputEpoch = { value: 0 };
  private readonly input = new ReadQueue<InputFrame>();
  private readerChain: Promise<void> = Promise.resolve();
  private readonly local = new ResponsesLocalInterrupt();
  private readonly clientHeaders: Headers;
  private readonly downstreamSessionKey: string;
  private readonly codexClient: boolean;
  private opened = false;
  private finished = false;

  // Session state across turns (Go: the locals of ResponsesWebsocket).
  private lastRequest = "";
  private lastResponseOutput = "[]";
  private observedCompaction: ObservedCompaction = emptyCompaction();
  private lastResponseID = "";
  private pendingPrewarmID = "";
  private lastResponsePendingToolCallIDs: string[] = [];
  private pinnedAuthID = "";
  private readonly pinnedAuthByProvider = new Map<string, PinnedAuthState>();
  private passthroughModelName = "";
  private upstreamMode = upstreamModeUnknown;
  private upstreamWebsocketAuthID = "";

  constructor(
    private readonly handler: ResponsesWebsocketHandler,
    private readonly upgrade: ResponsesWebsocketUpgrade,
  ) {
    this.sessionId = handler.newId();
    this.timeline = new WebsocketTimelineLog(handler.onTimeline !== undefined);
    this.clientHeaders = upgrade.request.headers;
    this.downstreamSessionKey = websocketDownstreamSessionKey(this.clientHeaders);
    this.codexClient = isCodexResponsesClientRequest(this.clientHeaders);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** The socket signal: aborted once the client socket is gone. */
  get signal(): AbortSignal {
    return this.socketAbort.signal;
  }

  /** Starts the connection on its socket. */
  open(transport: ResponsesWebsocketTransport): void {
    if (this.opened) return;
    this.opened = true;
    // A writer-initiated close ends the connection like Go's reader failing on the closed conn.
    this.writer = new ResponsesWebsocketWriter({
      send: (text) => transport.send(text),
      ping: transport.ping ? () => transport.ping!() : undefined,
      close: (code, reason) => {
        try {
          transport.close(code, reason);
        } finally {
          this.abortSocket(new Error(`downstream websocket closed by proxy (${code ?? CloseNormalClosure})`));
        }
      },
    });
    retainResponsesWebsocketToolCaches(this.downstreamSessionKey);
    log.info(`responses websocket: client connected id=${this.sessionId}`);
    this.watchUpstreamDisconnect();
    void this.run();
  }

  /** A text (or binary) frame from the client. */
  message(data: string | ArrayBuffer | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    this.readerChain = this.readerChain.then(() => this.readFrame(text)).catch(() => {});
  }

  /** The client socket closed. */
  close(code: number, reason: string): void {
    this.abortSocket(new Error(`downstream websocket closed (${code}${reason ? ": " + reason : ""})`));
  }

  private abortSocket(reason: unknown): void {
    if (!this.socketAbort.signal.aborted) this.socketAbort.abort(reason);
    this.input.close();
  }

  private get codexExecutor(): (ProviderExecutor & ExecutionSessionCapableExecutor) | undefined {
    return this.handler.manager.executor?.("codex") as (ProviderExecutor & ExecutionSessionCapableExecutor) | undefined;
  }

  /** Closes the client when the session's upstream socket dies between turns (Go: the UpstreamDisconnectChan goroutine). */
  private watchUpstreamDisconnect(): void {
    const disconnect = this.codexExecutor?.upstreamDisconnect?.(this.sessionId);
    disconnect?.then((err) => {
      if (this.finished || this.socketAbort.signal.aborted) return;
      this.writer.closeForUpstreamDisconnect(err, (e) => executionErrorMessage(e));
    });
  }

  // -------------------------------------------------------------------------
  // Reader (Go: readResponsesWebsocketInput)
  // -------------------------------------------------------------------------

  private async readFrame(payload: string): Promise<void> {
    if (this.socketAbort.signal.aborted) return;
    const epoch = this.inputEpoch.value;
    const root = tryParse(payload);
    // Control frames bypass normalisation: response_id, mode and extensions reach upstream unchanged.
    if (isObject(root) && root.type === "response.interrupt") {
      const now = this.handler.now();
      appendResponsesInterruptDiagnostic(this.timeline, payload, "", now);
      try {
        await this.forwardInterrupt(root, payload);
        appendResponsesInterruptDiagnostic(this.timeline, payload, "handled", this.handler.now());
        return;
      } catch (err) {
        if (err instanceof NoActiveUpstreamWebsocketError && this.local.deliver(payload)) {
          appendResponsesInterruptDiagnostic(this.timeline, payload, "local_http", this.handler.now());
          return;
        }
        appendResponsesInterruptDiagnostic(this.timeline, payload, "rejected", this.handler.now());
        try {
          writeResponsesWebsocketError(this.writer, undefined, { statusCode: 400, error: err instanceof Error ? err : new Error(String(err)) }, this.handler.now());
        } catch (errWrite) {
          this.abortSocket(errWrite);
        }
        return;
      }
    }
    this.input.push({ payload, epoch });
  }

  /** Go: forwardResponsesWebsocketInterrupt. */
  private async forwardInterrupt(root: JSONObject, payload: string): Promise<void> {
    if (typeof root.response_id !== "string" || root.response_id.trim() === "") throw new Error("response.interrupt requires response_id");
    const executor = this.codexExecutor;
    if (!executor) throw new NoActiveUpstreamWebsocketError();
    if (typeof executor.interruptExecutionSession !== "function") throw new Error("upstream executor does not support response.interrupt");
    const ctx: WebsocketExecutionContext = {
      downstreamWebsocket: true,
      authEnabled: (authId) => {
        const auth = this.handler.authByID(authId);
        return !!auth && !auth.disabled && auth.status !== StatusDisabled;
      },
    };
    await executor.interruptExecutionSession(this.sessionId, payload, ctx);
  }

  // -------------------------------------------------------------------------
  // Turn loop
  // -------------------------------------------------------------------------

  private async run(): Promise<void> {
    let terminateErr: unknown;
    try {
      for (;;) {
        let next: IteratorResult<InputFrame>;
        try {
          next = await this.input.next(this.socketAbort.signal);
        } catch {
          return;
        }
        if (next.done) return;
        const { payload, epoch } = next.value;
        if (epoch < this.inputEpoch.value) {
          // Read before an upstream loss: never sent, the client resends.
          try {
            this.writePreviousResponseNotFound(payload);
          } catch (err) {
            terminateErr = err;
            return;
          }
          continue;
        }
        const outcome = await this.handleTurn(payload, epoch);
        if (outcome.terminate) {
          terminateErr = outcome.err;
          return;
        }
      }
    } catch (err) {
      terminateErr = err;
      log.warn("responses websocket: turn loop failed", { id: this.sessionId, error: err instanceof Error ? err.name : "error" });
    } finally {
      this.finished = true;
      releaseResponsesWebsocketToolCaches(this.downstreamSessionKey);
      if (terminateErr !== undefined) appendWebsocketTimelineDisconnect(this.timeline, terminateErr, this.handler.now());
      log.info(`responses websocket: session closing id=${this.sessionId}`);
      this.handler.manager.closeExecutionSession?.(this.sessionId);
      if (!this.writer.closing && !this.socketAbort.signal.aborted) this.writer.closeWithoutError();
      this.abortSocket(new Error("responses websocket: session closed"));
      if (this.handler.onTimeline) {
        try {
          this.handler.onTimeline(this.sessionId, this.timeline.toString());
        } catch {
          // a failing sink never breaks the close
        }
      }
      this.resolveDone();
    }
  }

  private writeErrorMessage(msg: ErrorMessage): void {
    writeResponsesWebsocketError(this.writer, this.timeline, msg, this.handler.now());
  }

  /** Go: writeResponsesWebsocketPreviousResponseNotFound. */
  private writePreviousResponseNotFound(payload: string): void {
    const root = parseFrame(payload);
    let msg = responsesWebsocketPreviousResponseNotFoundError();
    if (requestType(root) === wsRequestTypeCreate && !responsesWebsocketRequestRequiresCurrentUpstream(root)) {
      msg = executionErrorMessage(new UpstreamWebsocketTurnError({ notSent: true }));
    }
    const body = tryParse(buildResponsesWebsocketErrorPayload(msg)) as JSONObject;
    const eventID = jsonString(root.event_id);
    if (eventID !== "" && isObject(body.error)) body.error.event_id = eventID;
    writeResponsesWebsocketPayload(this.writer, this.timeline, JSON.stringify(body), this.handler.now());
  }

  /** Reports a lost upstream on the still-open client socket (Go: writeResponsesWebsocketUpstreamLoss). */
  private writeUpstreamLoss(msg: ErrorMessage): unknown {
    const turnErr = asUpstreamWebsocketTurnError(msg.error);
    if (!turnErr) return undefined;
    const failures: ErrorMessage[] = turnErr.idle ? [] : [msg];
    for (const abandoned of turnErr.abandoned) failures.push(executionErrorMessage(abandoned));
    for (const failure of failures) {
      try {
        this.writeErrorMessage(failure);
      } catch (err) {
        return err;
      }
    }
    return undefined;
  }

  private rememberPinnedAuth(authID: string, modelName: string): void {
    const id = authID.trim();
    const auth = this.handler.authByID(id);
    if (id === "" || !auth) return;
    this.pinnedAuthID = id;
    const providerKey = (auth.provider ?? "").trim().toLowerCase();
    const { modelKey } = this.handler.providerSetForModel(modelName);
    if (providerKey !== "") this.pinnedAuthByProvider.set(providerKey, { authID: id, modelKey });
  }

  private forgetPinnedAuth(): void {
    for (const [providerKey, state] of this.pinnedAuthByProvider) if (state.authID === this.pinnedAuthID) this.pinnedAuthByProvider.delete(providerKey);
    this.pinnedAuthID = "";
  }

  private closeForReplay(): { terminate: true; err: unknown } {
    const replayErr = new UpstreamWebsocketReplayRequiredError();
    const close = this.writer.closeForUpstreamError(replayErr);
    if (!close.matched) this.writer.closeWithoutError();
    return { terminate: true, err: replayErr };
  }

  /** One client frame (Go: one iteration of the ResponsesWebsocket loop). */
  private async handleTurn(payload: string, msgEpoch: number): Promise<{ terminate: boolean; err?: unknown }> {
    const handler = this.handler;
    this.timeline.append("request", payload, handler.now());
    const root = parseFrame(payload);
    const explicitRequestModelName = jsonString(root.model).trim();
    let requestModelName = explicitRequestModelName;
    if (requestModelName === "") requestModelName = this.passthroughModelName;
    if (requestModelName === "") requestModelName = jsonString(parseFrame(this.lastRequest).model).trim();

    const authErr = this.upgrade.authenticateTurn?.(payload);
    if (authErr) {
      try {
        this.writeErrorMessage(authErr);
      } catch (err) {
        return { terminate: true, err };
      }
      return { terminate: false };
    }
    if (msgEpoch < this.inputEpoch.value) {
      try {
        this.writePreviousResponseNotFound(payload);
      } catch (err) {
        return { terminate: true, err };
      }
      return { terminate: false };
    }

    // Pinned credential affinity per provider.
    if (this.pinnedAuthID !== "") {
      const pinnedAuth = handler.authByID(this.pinnedAuthID);
      const providerKey = (pinnedAuth?.provider ?? "").trim().toLowerCase();
      const state = this.pinnedAuthByProvider.get(providerKey);
      if (!pinnedAuth || !state || state.authID !== this.pinnedAuthID || !handler.pinnedAuthMatchesModel(pinnedAuth, requestModelName)) this.pinnedAuthID = "";
    }
    if (this.pinnedAuthID === "") {
      const { providers } = handler.providerSetForModel(requestModelName);
      if (providers.size === 1) {
        for (const providerKey of providers) {
          const state = this.pinnedAuthByProvider.get(providerKey);
          const candidate = state ? handler.authByID(state.authID) : undefined;
          if (state && candidate && handler.pinnedAuthMatchesModel(candidate, requestModelName)) this.pinnedAuthID = state.authID;
          else this.pinnedAuthByProvider.delete(providerKey);
        }
      }
    }
    let useUpstreamWebsocketPassthrough = handler.usesUpstreamWebsocketPassthrough(requestModelName);
    if (this.pinnedAuthID !== "") {
      const pinnedAuth = handler.authByID(this.pinnedAuthID);
      if (pinnedAuth && websocketsEnabledFor(pinnedAuth.attributes, pinnedAuth.metadata)) useUpstreamWebsocketPassthrough = (pinnedAuth.provider ?? "").trim().toLowerCase() === "codex";
    }
    const nativeWebsocketPassthrough = responsesWebsocketNativePassthroughAllowed(this.upstreamMode, useUpstreamWebsocketPassthrough, this.pinnedAuthID, this.upstreamWebsocketAuthID);
    const requiresCurrentUpstream = responsesWebsocketRequestRequiresCurrentUpstream(root);
    if (this.upstreamMode === upstreamModeWS && !nativeWebsocketPassthrough && requiresCurrentUpstream) {
      // The continuation only exists on an upstream socket this turn cannot use.
      return this.closeForReplay();
    }
    if (explicitRequestModelName !== "" && !useUpstreamWebsocketPassthrough) this.passthroughModelName = "";

    // A completed compaction response proves the target consumes compacted replays.
    let observedCompactionReplayAuthID = "";
    let observedCompactionSupported = false;
    const observed = this.observedCompaction;
    if (observed.modelName !== "" && observed.modelName === requestModelName && observed.authID !== "") {
      if (this.pinnedAuthID !== "") {
        if (this.pinnedAuthID === observed.authID) {
          observedCompactionSupported = true;
          observedCompactionReplayAuthID = observed.authID;
        }
      } else if (handler.pinnedAuthMatchesModel(handler.authByID(observed.authID), requestModelName)) {
        observedCompactionSupported = true;
        observedCompactionReplayAuthID = observed.authID;
      }
    }
    let allowCompactionReplayBypass = observedCompactionSupported;
    if (!nativeWebsocketPassthrough) {
      if (this.pinnedAuthID !== "") {
        const pinnedAuth = handler.authByID(this.pinnedAuthID);
        if (pinnedAuth) allowCompactionReplayBypass ||= (pinnedAuth.provider ?? "").trim().toLowerCase() === "codex";
      } else {
        allowCompactionReplayBypass ||= handler.supportsCompactionReplayForModel(requestModelName);
      }
    }

    let requestJSON: string | undefined;
    let updatedLastRequest = "";
    let errMsg: ErrorMessage | undefined;
    const previousResponseID = jsonString(root.previous_response_id).trim();
    const isPrewarm = !useUpstreamWebsocketPassthrough && shouldHandleResponsesWebsocketPrewarmLocally(root, false);
    const replacementCreate = () => {
      if ("input" in root && !Array.isArray(root.input)) return { error: wsErrorMessage(400, "websocket request requires array field: input") };
      // A self-contained create without a parent reference is a new transcript root.
      return normalizeResponseCreateRequest(JSON.stringify(normalizeResponseTranscriptReplacement(root, this.lastRequest)));
    };
    let normalized: { request?: string; lastRequest?: string; error?: ErrorMessage };
    if (this.pendingPrewarmID !== "" && previousResponseID !== "") {
      normalized = previousResponseID !== this.pendingPrewarmID ? { error: responsesWebsocketPreviousResponseNotFoundError() } : normalizeResponsesWebsocketPrewarmFollowup(payload, this.lastRequest);
    } else if (isPrewarm && previousResponseID === "") {
      normalized = replacementCreate();
    } else if (this.pendingPrewarmID !== "" && requestType(root) === wsRequestTypeCreate) {
      normalized = replacementCreate();
    } else if (nativeWebsocketPassthrough) {
      normalized = normalizeResponsesWebsocketPassthroughRequest(payload, requestModelName);
    } else if (this.lastRequest.length === 0 && previousResponseID !== "") {
      normalized = { error: responsesWebsocketPreviousResponseNotFoundError() };
    } else {
      normalized = normalizeResponsesWebsocketRequestWithIncrementalState(payload, this.lastRequest, this.lastResponseOutput, this.lastResponseID, this.lastResponsePendingToolCallIDs, false, allowCompactionReplayBypass);
    }
    requestJSON = normalized.request;
    updatedLastRequest = normalized.lastRequest ?? "";
    errMsg = normalized.error;
    if (errMsg || requestJSON === undefined) {
      const msg = errMsg ?? wsErrorMessage(400, "invalid websocket request");
      try {
        const written = writeResponsesWebsocketError(this.writer, this.timeline, msg, handler.now());
        log.info(`responses websocket: downstream_out id=${this.sessionId} event=${websocketPayloadEventType(written)}`);
      } catch (err) {
        return { terminate: true, err };
      }
      return { terminate: false };
    }

    if (isPrewarm) {
      requestJSON = withoutField(requestJSON, "generate");
      updatedLastRequest = withoutField(updatedLastRequest, "generate");
      this.lastRequest = updatedLastRequest;
      this.lastResponseOutput = "[]";
      this.observedCompaction = emptyCompaction();
      this.lastResponseID = "";
      this.lastResponsePendingToolCallIDs = [];
      const payloads = syntheticResponsesWebsocketPrewarmPayloads(requestJSON, handler.now(), handler.newId);
      for (const prewarm of payloads) {
        try {
          writeResponsesWebsocketPayload(this.writer, this.timeline, prewarm, handler.now());
        } catch (err) {
          return { terminate: true, err };
        }
      }
      const createdEvent = parseFrame(payloads[0]!);
      this.pendingPrewarmID = isObject(createdEvent.response) ? jsonString(createdEvent.response.id) : "";
      return { terminate: false };
    }

    let toolCacheTurn: ReturnType<typeof prepareResponsesWebsocketFallbackTurn>["turn"];
    let nextLastRequest = this.lastRequest;
    if (nativeWebsocketPassthrough) {
      const model = jsonString(parseFrame(requestJSON).model).trim();
      if (model !== "") this.passthroughModelName = model;
    } else {
      const prepared = prepareResponsesWebsocketFallbackTurn(this.downstreamSessionKey, requestJSON);
      requestJSON = prepared.payload;
      toolCacheTurn = prepared.turn;
      nextLastRequest = requestJSON;
    }

    const modelName = jsonString(parseFrame(requestJSON).model);
    let lastAttemptedAuthID = this.pinnedAuthID;
    let attemptedUpstreamMode = upstreamModeUnknown;
    let selectedAuthObserved = false;
    const nativeRequest = isCodexResponsesLiteRequest(payload, this.clientHeaders);
    let preserveNativeOutput = false;
    let pinnedAuthAttempted = false;
    const turnStartEpoch = this.inputEpoch.value;
    const wsCtx: WebsocketExecutionContext = {
      downstreamWebsocket: true,
      requiredUpstreamWebsocket: nativeWebsocketPassthrough && requiresCurrentUpstream,
      inputEpoch: this.inputEpoch,
      messageEpoch: msgEpoch,
    };
    const onSelectedAuth = (rawID: string) => {
      preserveNativeOutput = false;
      const authID = rawID.trim();
      if (authID === "") return;
      lastAttemptedAuthID = authID;
      selectedAuthObserved = true;
      pinnedAuthAttempted ||= this.pinnedAuthID !== "" && authID === this.pinnedAuthID;
      const selected = handler.authByID(authID);
      if (!selected) return;
      attemptedUpstreamMode = handler.upstreamModeForAuth(selected);
      preserveNativeOutput = nativeRequest && (selected.provider ?? "").trim().toLowerCase() === "codex";
    };
    const executionAuthID = this.pinnedAuthID !== "" ? this.pinnedAuthID : observedCompactionReplayAuthID;

    // The turn's cancellation follows the client socket (Go: cliCtx derived from the socket context).
    const turnAbort = new AbortController();
    const onSocketAbort = () => turnAbort.abort(this.socketAbort.signal.reason);
    if (this.socketAbort.signal.aborted) onSocketAbort();
    else this.socketAbort.signal.addEventListener("abort", onSocketAbort, { once: true });

    const usageStart = handler.now();
    let started: StreamResult | undefined;
    let startErr: ErrorMessage | undefined;
    let providers: string[] = [];
    let execModel = modelName;
    const details = handler.requestDetails(modelName);
    if ("error" in details) {
      startErr = details.error;
    } else {
      providers = details.providers;
      execModel = details.model;
      const metadata: Record<string, unknown> = {
        [RequestedModelMetadataKey]: modelName,
        [RequestPathMetadataKey]: "/v1/responses",
        [ExecutionSessionMetadataKey]: this.sessionId,
        [WebsocketContextMetadataKey]: wsCtx,
        [SelectedAuthCallbackMetadataKey]: onSelectedAuth,
      };
      if (this.upgrade.clientKey) metadata[CallerAPIKeyMetadataKey] = this.upgrade.clientKey;
      if (executionAuthID !== "") metadata[PinnedAuthMetadataKey] = executionAuthID;
      const req: ExecRequest = { model: execModel, payload: requestJSON, format: FormatOpenAIResponse };
      const opts: ExecOptions = {
        stream: true,
        headers: responsesForwardableHeaders(this.clientHeaders),
        query: new URL(this.upgrade.request.url).searchParams,
        originalRequest: requestJSON,
        sourceFormat: FormatOpenAIResponse,
        metadata,
        signal: turnAbort.signal,
      };
      try {
        started = await handler.manager.executeStream(providers, req, opts);
      } catch (err) {
        startErr = executionErrorMessage(enrichAuthSelectionError(err, providers, execModel));
      }
    }
    // Routes that bypass auth selection keep the canonical HTTP mode.
    if (!selectedAuthObserved) attemptedUpstreamMode = upstreamModeHTTP;

    const iterator = started?.chunks[Symbol.asyncIterator]();
    let iteratorDone = false;
    const source: TurnSource = {
      async next(): Promise<TurnSourceItem> {
        if (startErr) {
          const err = startErr;
          startErr = undefined;
          iteratorDone = true;
          return { kind: "error", errMsg: err };
        }
        if (!iterator || iteratorDone) return { kind: "done" };
        try {
          const next = await iterator.next();
          if (next.done) {
            iteratorDone = true;
            return { kind: "done" };
          }
          return { kind: "chunk", chunk: typeof next.value === "string" ? next.value : "" };
        } catch (err) {
          iteratorDone = true;
          return { kind: "error", errMsg: executionErrorMessage(enrichAuthSelectionError(err, providers, execModel)) };
        }
      },
    };
    const cancel = (reason?: unknown) => {
      if (!turnAbort.signal.aborted) turnAbort.abort(reason ?? new DOMException("The operation was aborted.", "AbortError"));
      if (iterator && !iteratorDone) {
        iteratorDone = true;
        iterator.return?.().catch(() => {});
      }
    };

    // A connection-scoped continuation cannot rotate credentials in place.
    let lossWriteErr: unknown;
    const replayPinnedAuthFailure = (msg: ErrorMessage): boolean => {
      const turnErr = asUpstreamWebsocketTurnError(msg.error);
      if (turnErr) {
        // The upstream websocket was lost: report it, keep the client socket
        // open and fence the input read before the loss.
        if (turnErr.eventId === "" && !turnErr.idle && turnErr.abandoned.length === 0) turnErr.eventId = jsonString(root.event_id).trim();
        if (!turnErr.fullContextRequired && !turnErr.notSent && this.inputEpoch.value === turnStartEpoch) this.inputEpoch.value += 1;
        lossWriteErr = this.writeUpstreamLoss(msg);
        return true;
      }
      return nativeWebsocketPassthrough && requiresCurrentUpstream && pinnedAuthAttempted && shouldReplayResponsesWebsocketPinnedAuthFailure(msg);
    };

    // Usage: one record per turn.
    let recorder: RequestUsageRecorder | undefined;
    if (handler.usage?.enabled) {
      const manager = handler.manager;
      recorder = new RequestUsageRecorder({
        statistics: handler.usage,
        now: handler.now,
        start: usageStart,
        endpoint: "GET /v1/responses",
        model: execModel,
        alias: requestModelName,
        clientKey: this.upgrade.clientKey ?? "",
        sessionId: this.downstreamSessionKey,
        stream: true,
        metadata: { [ExecutionSessionMetadataKey]: this.sessionId },
        providers,
        lookupAuth: manager.getById ? (id) => manager.getById!(id) : undefined,
      });
    }
    const usageStream = recorder?.startStream(this.socketAbort.signal);

    let result;
    try {
      result = await forwardResponsesWebsocket(
        { writer: this.writer, timeline: this.timeline, source, cancel, socketSignal: this.socketAbort.signal },
        {
          preserveCompletionOutput: () => preserveNativeOutput,
          toolCacheTurn,
          suppressError: replayPinnedAuthFailure,
          keepAliveIntervalMs: handler.keepAliveIntervalMs,
          localInterrupt: this.local,
          websocketOwned: () => attemptedUpstreamMode === upstreamModeWS,
          codexClient: this.codexClient,
          downstreamSessionKey: this.downstreamSessionKey,
          now: handler.now,
          onPayload: usageStream
            ? (event) => {
                const type = jsonString(event.type);
                const response = isObject(event.response) ? event.response : undefined;
                if (response && typeof response.model === "string" && response.model.trim() !== "") usageStream.observer.responseModel = response.model.trim();
                if (type === "response.completed" || type === "response.incomplete" || type === "response.done") {
                  if (response && isObject(response.usage)) usageStream.observer.observeUsage(parseResponsesUsageNode(response.usage));
                  usageStream.observer.sawMessageStop = true;
                }
              }
            : undefined,
        },
      );
    } finally {
      this.socketAbort.signal.removeEventListener("abort", onSocketAbort);
    }
    if (usageStream) usageStream.delivery.finish(result.errMsg ? { statusCode: result.errMsg.statusCode, error: result.errMsg.error } : undefined);

    if (result.terminateErr !== undefined) {
      if (!isWebsocketCloseSent(result.terminateErr)) log.debug(`responses websocket: forward ended id=${this.sessionId}`);
      return { terminate: true, err: result.terminateErr };
    }
    const forwardErr = result.errMsg;
    if (forwardErr && asUpstreamWebsocketTurnError(forwardErr.error)) {
      if (lossWriteErr !== undefined) return { terminate: true, err: lossWriteErr };
      // Keep the credential: the next full create reconnects on it, never on another one.
      if ((attemptedUpstreamMode === upstreamModeWS || this.upstreamMode === upstreamModeWS) && lastAttemptedAuthID !== "") {
        this.upstreamMode = upstreamModeWS;
        this.upstreamWebsocketAuthID = lastAttemptedAuthID;
        this.rememberPinnedAuth(lastAttemptedAuthID, modelName);
        this.passthroughModelName = modelName;
      }
      return { terminate: false };
    }
    if (forwardErr) {
      if (pinnedAuthAttempted && shouldReleaseResponsesWebsocketPinnedAuth(forwardErr)) this.forgetPinnedAuth();
      if (replayPinnedAuthFailure(forwardErr)) return this.closeForReplay();
      return { terminate: false };
    }

    toolCacheTurn?.commit();
    this.pendingPrewarmID = "";
    this.upstreamMode = attemptedUpstreamMode;
    if (this.upstreamMode === upstreamModeWS) {
      this.upstreamWebsocketAuthID = lastAttemptedAuthID;
      if (lastAttemptedAuthID !== "") this.rememberPinnedAuth(lastAttemptedAuthID, modelName);
      this.passthroughModelName = modelName;
      this.lastRequest = "";
      this.lastResponseOutput = "[]";
      this.observedCompaction = emptyCompaction();
      this.lastResponseID = "";
      this.lastResponsePendingToolCallIDs = [];
    } else {
      this.upstreamWebsocketAuthID = "";
      this.lastRequest = nextLastRequest;
      this.lastResponseOutput = result.completedOutput;
      if (inputContainsFullTranscript(tryParse(result.completedOutput))) {
        this.observedCompaction = { modelName, modelKey: handler.providerSetForModel(modelName).modelKey, authID: lastAttemptedAuthID };
      } else if (this.observedCompaction.modelName !== "") {
        const prior = this.observedCompaction;
        const mismatch = prior.modelName !== modelName || (prior.authID !== "" && lastAttemptedAuthID !== "" && prior.authID !== lastAttemptedAuthID);
        if (mismatch) this.observedCompaction = emptyCompaction();
      }
      this.lastResponseID = result.completedResponseID.trim();
      this.lastResponsePendingToolCallIDs = [...result.pendingToolCallIDs];
    }
    return { terminate: false };
  }
}

function withoutField(json: string, field: string): string {
  const root = tryParse(json);
  if (!isObject(root) || !(field in root)) return json;
  delete root[field];
  return JSON.stringify(root);
}

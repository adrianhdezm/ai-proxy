// Forwarding one websocket turn to the downstream client. Port of
// sdk/api/handlers/openai/openai_responses_websocket_forward.go, the writer of
// openai_responses_websocket.go (responsesWebsocketWriter,
// websocketClosePayloadForUpstreamError, truncateWebsocketCloseReason), the
// local interrupt of openai_responses_websocket_input.go and the payload/timeline
// helpers of openai_responses_websocket_timeline.go.
//
// Deviation: Go tore the TCP connection down (the client saw close 1006) when
// it ended a socket after an error; Bun's server socket is closed with a close
// frame instead: 1011 for those error closes, 1009 / 1012 where Go mirrored a
// close code.
import { createHash } from "node:crypto";
import { isRequestFault, isTerminalAuthError } from "../auth/manager/index.ts";
import { asUpstreamWebsocketTurnError, isUpstreamWebsocketReplayRequired } from "../executor/codex/websockets/context.ts";
import { CloseInternalServerErr, CloseMessageTooBig, CloseServiceRestart, CodexWebsocketCloseError } from "../executor/codex/websockets/connection.ts";
import { type ErrorMessage, statusCodeOf } from "../executor/types.ts";
import { log } from "../log.ts";
import { isObject, tryParse, type JSONObject } from "../util/json.ts";
import { httpStatusFromError, httpStatusText } from "./errors.ts";
import { openAIErrorBody } from "./images_handlers.ts";
import { isResponsesToolCallType, jsonString } from "./responses_websocket_requests.ts";
import { type ResponsesWebsocketToolCacheTurn, isCompleteResponsesWebsocketToolCall, recordResponsesWebsocketToolCallsFromPayload } from "./responses_websocket_toolcall_repair.ts";

export const wsEventTypeError = "error";
export const wsEventTypeCompleted = "response.completed";
export const wsEventTypeDone = "response.done";
export const wsDoneMarker = "[DONE]";
export const wsCloseReasonMaxBytes = 123;
export const wsHTTPReplayRequiredCloseReason = "upstream requires HTTP replay";

// ---------------------------------------------------------------------------
// Transport and writer
// ---------------------------------------------------------------------------

/** The downstream socket (Bun's ServerWebSocket, or a test double). */
export interface ResponsesWebsocketTransport {
  /** Sends one text message; throws when the socket is gone. */
  send(text: string): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
}

/** A write after the writer started closing (Go: websocket.ErrCloseSent). */
export class WebsocketCloseSentError extends Error {
  constructor() {
    super("websocket: close sent");
    this.name = "WebsocketCloseSentError";
  }
}

export function isWebsocketCloseSent(err: unknown): boolean {
  return err instanceof WebsocketCloseSentError;
}

/** Truncates a close reason to maxBytes of valid UTF-8 (Go: truncateWebsocketCloseReason). */
export function truncateWebsocketCloseReason(reason: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(reason).length <= maxBytes) return reason;
  let out = "";
  let remaining = maxBytes;
  for (const ch of reason) {
    const size = encoder.encode(ch).length;
    if (size > remaining) break;
    out += ch;
    remaining -= size;
  }
  return out;
}

/**
 * The close frame mirrored to the client for an upstream error, if any (Go:
 * websocketClosePayloadForUpstreamError): 1012 for the HTTP replay signal, 1009
 * for a message_too_big close or 413 rejection.
 */
export function websocketClosePayloadForUpstreamError(err: unknown): { code: number; reason: string } | undefined {
  if (err === undefined || err === null) return undefined;
  if (isUpstreamWebsocketReplayRequired(err)) return { code: CloseServiceRestart, reason: truncateWebsocketCloseReason(wsHTTPReplayRequiredCloseReason, wsCloseReasonMaxBytes) };
  let reason = "";
  const closeErr = findCause(err, (e): e is CodexWebsocketCloseError => e instanceof CodexWebsocketCloseError);
  if (closeErr && closeErr.code === CloseMessageTooBig) {
    reason = closeErr.reason;
  } else {
    const text = err instanceof Error ? err.message : String(err);
    const parsed = tryParse(text);
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : undefined;
    if (statusCodeOf(err) !== 413 || jsonString(error?.code) !== "message_too_big") return undefined;
    reason = jsonString(error?.message).trim();
  }
  if (reason === "") reason = "message too big";
  return { code: CloseMessageTooBig, reason: truncateWebsocketCloseReason(reason, wsCloseReasonMaxBytes) };
}

function findCause<T>(err: unknown, match: (e: unknown) => e is T): T | undefined {
  const seen = new Set<unknown>();
  let current = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (match(current)) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** Serialises downstream writes and the one-shot close (Go: responsesWebsocketWriter). */
export class ResponsesWebsocketWriter {
  private closingFlag = false;

  constructor(readonly transport: ResponsesWebsocketTransport) {}

  get closing(): boolean {
    return this.closingFlag;
  }

  /** Go: writeResponsesWebsocketPayload (the timeline half lives in the caller). */
  writePayload(payload: string): void {
    if (this.closingFlag) throw new WebsocketCloseSentError();
    this.transport.send(payload);
  }

  writePing(): void {
    if (this.closingFlag) throw new WebsocketCloseSentError();
    this.transport.ping?.();
  }

  /** Mirrors an upstream close code; `matched` false when the error has none (Go: closeForUpstreamError). */
  closeForUpstreamError(err: unknown): { matched: boolean; error?: unknown } {
    const close = websocketClosePayloadForUpstreamError(err);
    if (!close) return { matched: false };
    if (this.closingFlag) return { matched: true };
    this.closingFlag = true;
    try {
      this.transport.close(close.code, close.reason);
    } catch (errClose) {
      return { matched: true, error: errClose };
    }
    return { matched: true };
  }

  /** Go: closeWithoutError; false when already closing. */
  closeWithoutError(): boolean {
    if (this.closingFlag) return false;
    this.closingFlag = true;
    try {
      this.transport.close(CloseInternalServerErr, "");
    } catch {
      // already gone
    }
    return true;
  }

  /** Writes a final payload and closes (Go: closeWithPayload); true when the payload was written. */
  closeWithPayload(payload: string): boolean {
    if (this.closingFlag) return false;
    this.closingFlag = true;
    let wrote = false;
    try {
      this.transport.send(payload);
      wrote = true;
    } catch {
      // the client is gone
    }
    try {
      this.transport.close(CloseInternalServerErr, "");
    } catch {
      // already gone
    }
    return wrote;
  }

  /**
   * Closes after the upstream socket went away between turns (Go:
   * closeForUpstreamDisconnect): mirrored close codes first, then the error
   * payload for exposable errors, else a plain close.
   */
  closeForUpstreamDisconnect(err: unknown, toErrorMessage: (err: unknown) => ErrorMessage): void {
    if (this.closeForUpstreamError(err).matched) return;
    const msg = toErrorMessage(err);
    if (!shouldExposeResponsesUpstreamError(msg)) {
      this.closeWithoutError();
      return;
    }
    const payload = buildResponsesWebsocketErrorPayload(msg);
    if (this.closeWithPayload(payload)) log.info(`responses websocket: downstream_out disconnect_error event=${websocketPayloadEventType(payload)}`);
  }
}

// ---------------------------------------------------------------------------
// Timeline (Go: openai_responses_websocket_timeline.go, in-memory variant)
// ---------------------------------------------------------------------------

export interface WebsocketTimelineAppender {
  append(eventType: string, payload: string, timestampMs: number): void;
}

/** "Timestamp / Event / payload" blocks (Go: formatWebsocketTimelineEvent). */
export function formatWebsocketTimelineEvent(eventType: string, payload: string, timestampMs: number): string {
  const trimmed = payload.trim();
  if (trimmed === "") return "";
  return `Timestamp: ${new Date(timestampMs).toISOString()}\nEvent: websocket.${eventType}\n${trimmed}\n`;
}

/**
 * The per-connection request/response timeline (Go: websocketTimelineLog
 * without the request-log file parts). Disabled timelines record nothing.
 */
export class WebsocketTimelineLog implements WebsocketTimelineAppender {
  private text = "";

  constructor(readonly enabled: boolean) {}

  append(eventType: string, payload: string, timestampMs: number): void {
    if (!this.enabled) return;
    const block = formatWebsocketTimelineEvent(eventType, payload, timestampMs);
    if (block === "") return;
    if (this.text.length > 0) this.text += "\n";
    this.text += block;
  }

  toString(): string {
    return this.enabled ? this.text : "";
  }
}

/** Go: appendWebsocketTimelineDisconnect. */
export function appendWebsocketTimelineDisconnect(timeline: WebsocketTimelineAppender | undefined, err: unknown, timestampMs: number): void {
  if (err === undefined || err === null || !timeline) return;
  timeline.append("disconnect", err instanceof Error ? err.message : String(err), timestampMs);
}

/**
 * Hashed interrupt diagnostics (Go: appendResponsesInterruptDiagnostic): only
 * the type, a hash of the response_id and the outcome are recorded.
 */
export function appendResponsesInterruptDiagnostic(timeline: WebsocketTimelineAppender | undefined, payload: string, outcome: string, nowMs: number): void {
  if (!timeline) return;
  const root = tryParse(payload);
  const responseID = isObject(root) ? jsonString(root.response_id) : "";
  const hash = createHash("sha256").update(responseID).digest("hex").slice(0, 16);
  const diagnostic: JSONObject = { type: "response.interrupt", response_id_hash: hash };
  if (outcome !== "") diagnostic.outcome = outcome;
  timeline.append(outcome !== "" ? "interrupt.outcome" : "interrupt", JSON.stringify(diagnostic), nowMs);
}

export function websocketPayloadEventType(payload: string): string {
  const root = tryParse(payload);
  const type = isObject(root) ? jsonString(root.type).trim() : "";
  return type === "" ? "-" : type;
}

export function isResponsesWebsocketCompletionEvent(eventType: string): boolean {
  return eventType === wsEventTypeCompleted || eventType === wsEventTypeDone;
}

// ---------------------------------------------------------------------------
// Error payloads
// ---------------------------------------------------------------------------

/** An upstream error event forwarded as the turn's terminal error (Go: responsesWebsocketPayloadError). */
export class ResponsesWebsocketPayloadError extends Error {
  readonly statusCode: number;
  readonly payload: string;

  constructor(status: number, payload: string) {
    super(payload);
    this.name = "ResponsesWebsocketPayloadError";
    this.statusCode = status;
    this.payload = payload;
  }
}

/** Go: responsesWebsocketErrorMessageFromPayload. */
export function responsesWebsocketErrorMessageFromPayload(payload: string): ErrorMessage {
  const root = tryParse(payload);
  const intOf = (v: unknown) => (typeof v === "number" ? Math.trunc(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : 0);
  let status = isObject(root) ? intOf(root.status) : 0;
  if (status <= 0 && isObject(root)) status = intOf(root.status_code);
  if (status <= 0) status = 500;
  const trimmed = payload.trim();
  if (trimmed.length > 0) return { statusCode: status, error: new ResponsesWebsocketPayloadError(status, trimmed) };
  return { statusCode: status, error: new Error(httpStatusText(status)) };
}

/** Go: responsesWebsocketErrorStatus. */
export function responsesWebsocketErrorStatus(msg: ErrorMessage | undefined): number {
  if (!msg) return 0;
  if (msg.statusCode > 0) return msg.statusCode;
  return httpStatusFromError(msg.error);
}

/**
 * Only request-shape failures and terminal credential failures reach the
 * client; credential, quota and transport failures close silently so the
 * client reconnects and retries (Go: shouldExposeResponsesUpstreamError).
 */
export function shouldExposeResponsesUpstreamError(msg: ErrorMessage | undefined): boolean {
  if (!msg) return false;
  if (isTerminalAuthError(msg.error)) return true;
  return isRequestFault(responsesWebsocketErrorStatus(msg), msg.error);
}

/** `{"type":"error","status":N,"error":{...}}` (Go: buildResponsesWebsocketErrorPayload). */
export function buildResponsesWebsocketErrorPayload(msg: ErrorMessage | undefined): string {
  let status = 500;
  let errText = httpStatusText(status);
  if (msg) {
    if (msg.statusCode > 0) {
      status = msg.statusCode;
      errText = httpStatusText(status);
    }
    const message = msg.error instanceof Error ? msg.error.message : "";
    if (message.trim() !== "") errText = message;
  }
  const body = openAIErrorBody(status, errText, msg?.error);
  const payload: JSONObject = { type: wsEventTypeError, status };
  if (msg?.addon) {
    const headers: JSONObject = {};
    let any = false;
    msg.addon.forEach((value, key) => {
      headers[key] = value;
      any = true;
    });
    if (any) payload.headers = headers;
  }
  const parsedBody = tryParse(body);
  if (parsedBody !== undefined) payload.error = isObject(parsedBody) && "error" in parsedBody ? parsedBody.error : parsedBody;
  if (!("error" in payload)) payload.error = { type: "server_error", message: errText };
  const turnErr = asUpstreamWebsocketTurnError(msg?.error);
  if (turnErr && turnErr.eventId !== "" && isObject(payload.error)) payload.error.event_id = turnErr.eventId;
  return JSON.stringify(payload);
}

/** Go: shouldReplayResponsesWebsocketPinnedAuthFailure. */
export function shouldReplayResponsesWebsocketPinnedAuthFailure(msg: ErrorMessage | undefined): boolean {
  const status = responsesWebsocketErrorStatus(msg);
  return status === 401 || status === 429;
}

/** Go: shouldReleaseResponsesWebsocketPinnedAuth. */
export function shouldReleaseResponsesWebsocketPinnedAuth(msg: ErrorMessage | undefined): boolean {
  if (!msg) return false;
  switch (responsesWebsocketErrorStatus(msg)) {
    case 401:
    case 402:
    case 403:
    case 429:
    case 408:
    case 502:
    case 503:
    case 504:
      return true;
  }
  const text = (msg.error instanceof Error ? msg.error.message : "").toLowerCase();
  return ["stream closed before response.completed", "previous_response_not_found", "ws_failed", "upstream stream closed before first payload", "empty_stream"].some((needle) => text.includes(needle));
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

/** JSON payloads of a chunk: SSE data lines or plain JSON (Go: websocketJSONPayloadsFromChunk). */
export function websocketJSONPayloadsFromChunk(chunk: string): string[] {
  const payloads: string[] = [];
  for (const rawLine of chunk.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("event:")) continue;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (line.length === 0 || line === wsDoneMarker) continue;
    if (tryParse(line) !== undefined) payloads.push(line);
  }
  if (payloads.length > 0) return payloads;
  let trimmed = chunk.trim();
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (trimmed.length > 0 && trimmed !== wsDoneMarker && tryParse(trimmed) !== undefined) payloads.push(trimmed);
  return payloads;
}

/** Collected response.output_item.done items (Go: outputItemsByIndex + outputItemsFallback). */
export interface CollectedWebsocketOutput {
  byIndex: Map<number, string>;
  fallback: string[];
}

export function newCollectedWebsocketOutput(): CollectedWebsocketOutput {
  return { byIndex: new Map(), fallback: [] };
}

/** Go: collectResponsesWebsocketOutputItem. */
export function collectResponsesWebsocketOutputItem(payload: JSONObject, collected: CollectedWebsocketOutput): void {
  if (jsonString(payload.type) !== "response.output_item.done") return;
  if (!isObject(payload.item)) return;
  const raw = JSON.stringify(payload.item);
  if (payload.output_index !== undefined) {
    const index = typeof payload.output_index === "number" ? Math.trunc(payload.output_index) : Number.parseInt(jsonString(payload.output_index), 10) || 0;
    collected.byIndex.set(index, raw);
    return;
  }
  collected.fallback.push(raw);
}

function orderedCollected(collected: CollectedWebsocketOutput): string[] {
  const indexes = [...collected.byIndex.keys()].sort((a, b) => a - b);
  return [...indexes.map((index) => collected.byIndex.get(index)!), ...collected.fallback];
}

function responseOutput(payload: JSONObject): unknown {
  return isObject(payload.response) ? payload.response.output : undefined;
}

/** The completed output, or the collected items without incomplete tool calls (Go: responseCompletedOutputFromPayload). */
export function responseCompletedOutputFromPayload(payload: JSONObject, collected: CollectedWebsocketOutput): string {
  const output = responseOutput(payload);
  if (Array.isArray(output) && output.length > 0) return JSON.stringify(output);
  if (collected.byIndex.size === 0 && collected.fallback.length === 0) return "[]";
  const items: unknown[] = [];
  for (const raw of orderedCollected(collected)) {
    const item = tryParse(raw);
    if (isObject(item) && isResponsesToolCallType(jsonString(item.type)) && !isCompleteResponsesWebsocketToolCall(item)) continue;
    items.push(item);
  }
  return JSON.stringify(items);
}

/**
 * The completion with its output restored from collected items when empty, or
 * its tool calls reconciled with the complete collected ones (Go:
 * restoreResponsesWebsocketCompletionOutput). Returns the payload unchanged otherwise.
 */
export function restoreResponsesWebsocketCompletionOutput(payloadText: string, payload: JSONObject, collected: CollectedWebsocketOutput): string {
  const response = isObject(payload.response) ? payload.response : undefined;
  const output = response?.output;
  if (Array.isArray(output) && output.length > 0) {
    const reconciled = reconcileResponsesWebsocketCompletionToolCalls(output, collected);
    if (!reconciled || !response) return payloadText;
    response.output = reconciled;
    return JSON.stringify(payload);
  }
  if (collected.byIndex.size === 0 && collected.fallback.length === 0) return payloadText;
  const restored = tryParse(responseCompletedOutputFromPayload(payload, collected));
  if (!response) payload.response = { output: restored };
  else response.output = restored;
  return JSON.stringify(payload);
}

/** Go: reconcileResponsesWebsocketCompletionToolCalls. */
export function reconcileResponsesWebsocketCompletionToolCalls(output: unknown[], collected: CollectedWebsocketOutput): unknown[] | undefined {
  const toolCalls = new Map<string, string>();
  for (const raw of orderedCollected(collected)) {
    const item = tryParse(raw);
    if (!isCompleteResponsesWebsocketToolCall(item)) continue;
    toolCalls.set(jsonString((item as JSONObject).call_id).trim(), raw);
  }
  if (toolCalls.size === 0) return undefined;
  let changed = false;
  const reconciled = output.map((item) => {
    if (!isObject(item) || !isResponsesToolCallType(jsonString(item.type))) return item;
    const collectedRaw = toolCalls.get(jsonString(item.call_id).trim());
    if (collectedRaw === undefined || collectedRaw === JSON.stringify(item)) return item;
    changed = true;
    return tryParse(collectedRaw);
  });
  return changed ? reconciled : undefined;
}

/** Go: recordPendingToolCallIDsFromPayload. */
export function recordPendingToolCallIDsFromPayload(pending: Set<string>, payload: JSONObject): void {
  updatePendingToolCallIDsFromItem(pending, payload.item);
  const output = responseOutput(payload);
  if (Array.isArray(output)) for (const item of output) updatePendingToolCallIDsFromItem(pending, item);
}

function updatePendingToolCallIDsFromItem(pending: Set<string>, item: unknown): void {
  if (!isObject(item)) return;
  switch (jsonString(item.type).trim()) {
    case "function_call":
    case "custom_tool_call":
      if (isCompleteResponsesWebsocketToolCall(item)) pending.add(jsonString(item.call_id).trim());
      return;
    case "function_call_output":
    case "custom_tool_call_output": {
      const callID = jsonString(item.call_id).trim();
      if (callID !== "") pending.delete(callID);
    }
  }
}

export function sortedStringSet(values: Set<string>): string[] {
  return [...values].map((v) => v.trim()).filter((v) => v !== "").sort();
}

// ---------------------------------------------------------------------------
// Local interrupt (Go: responsesLocalInterrupt)
// ---------------------------------------------------------------------------

/**
 * Cancels an in-flight HTTP turn on response.interrupt. A claimed frame is
 * never dropped: the forward loop consumes it, or deliver() returns false and
 * the reader answers the interrupt itself. While a turn runs on an upstream
 * websocket no frame may claim the local path.
 */
export class ResponsesLocalInterrupt {
  private activeFlag = false;
  private wsTurnActive = false;
  private frame: string | undefined;
  private readonly listeners = new Set<() => void>();

  /** Activates claims and records the turn's ownership atomically (Go: begin). */
  begin(websocketOwned: boolean): void {
    this.activeFlag = true;
    this.wsTurnActive = websocketOwned;
  }

  /** Reopens claims for the next response of the same turn (Go: reactivate). */
  reactivate(): void {
    this.activeFlag = true;
  }

  endWebsocketTurn(): void {
    this.wsTurnActive = false;
  }

  /** Stops new claims; a claimed frame stays consumable (Go: stopClaims / end / deactivate). */
  stopClaims(): void {
    this.activeFlag = false;
  }

  end(): void {
    this.stopClaims();
  }

  deactivate(): void {
    this.stopClaims();
  }

  isActive(): boolean {
    return this.activeFlag;
  }

  /** Claims a frame only when it is retained (one slot) (Go: deliver). */
  deliver(payload: string): boolean {
    if (!this.activeFlag || this.wsTurnActive) return false;
    if (this.frame !== undefined) return false;
    this.frame = payload;
    for (const wake of [...this.listeners]) wake();
    return true;
  }

  /** Consumes a claimed frame; the caller answers it exactly once (Go: takeClaimed). */
  takeClaimed(): string | undefined {
    const frame = this.frame;
    this.frame = undefined;
    return frame;
  }

  /** Calls `wake` when a frame is claimed (at once when one is pending); returns the unsubscribe. */
  onFrame(wake: () => void): () => void {
    if (this.frame !== undefined) {
      wake();
      return () => {};
    }
    this.listeners.add(wake);
    return () => this.listeners.delete(wake);
  }
}

// ---------------------------------------------------------------------------
// Forward loop
// ---------------------------------------------------------------------------

/** One step of a turn's upstream output. */
export type TurnSourceItem = { kind: "chunk"; chunk: string } | { kind: "done" } | { kind: "error"; errMsg: ErrorMessage };

export interface TurnSource {
  next(): Promise<TurnSourceItem>;
}

export interface ForwardOptions {
  /** Keep the completion output as the upstream sent it (native Codex requests). */
  preserveCompletionOutput?: () => boolean;
  toolCacheTurn?: ResponsesWebsocketToolCacheTurn;
  /** Swallows a terminal error the caller reports itself (Go: suppressError). */
  suppressError?: (msg: ErrorMessage) => boolean;
  /** Ping interval while waiting for upstream output (0 disables). */
  keepAliveIntervalMs?: number;
  localInterrupt?: ResponsesLocalInterrupt;
  /** Whether the turn runs on an upstream websocket (no local interrupt claims). */
  websocketOwned?: () => boolean;
  /** Official Codex client: response.metadata events are forwarded. */
  codexClient: boolean;
  downstreamSessionKey: string;
  /** Observes every payload written downstream (usage). */
  onPayload?: (payload: JSONObject) => void;
  now?: () => number;
}

export interface ForwardContext {
  writer: ResponsesWebsocketWriter;
  timeline?: WebsocketTimelineAppender;
  source: TurnSource;
  /** Ends the turn upstream (Go: cliCancel). */
  cancel: (reason?: unknown) => void;
  /** Aborted when the downstream socket goes away. */
  socketSignal: AbortSignal;
}

export interface ForwardResult {
  completedOutput: string;
  completedResponseID: string;
  pendingToolCallIDs: string[];
  /** The turn's terminal error, if any. */
  errMsg?: ErrorMessage;
  /** Set when the downstream socket must end (Go: errForward). */
  terminateErr?: unknown;
}

/** Writes a payload and records it in the timeline (Go: writeResponsesWebsocketPayload). */
export function writeResponsesWebsocketPayload(writer: ResponsesWebsocketWriter, timeline: WebsocketTimelineAppender | undefined, payload: string, nowMs: number): void {
  timeline?.append("response", payload, nowMs);
  writer.writePayload(payload);
}

/** Go: writeResponsesWebsocketError. */
export function writeResponsesWebsocketError(writer: ResponsesWebsocketWriter, timeline: WebsocketTimelineAppender | undefined, msg: ErrorMessage, nowMs: number): string {
  const payload = buildResponsesWebsocketErrorPayload(msg);
  writeResponsesWebsocketPayload(writer, timeline, payload, nowMs);
  return payload;
}

/**
 * Ends the downstream socket for a terminal error: exposable errors are
 * written first, others close silently (Go: writeResponsesWebsocketTerminalError).
 * The returned error is always set: the socket is closing.
 */
export function writeResponsesWebsocketTerminalError(
  writer: ResponsesWebsocketWriter,
  timeline: WebsocketTimelineAppender | undefined,
  msg: ErrorMessage,
  payload: string | undefined,
  nowMs: number,
): { payload?: string; wrote: boolean; error: unknown } {
  if (!shouldExposeResponsesUpstreamError(msg)) {
    appendWebsocketTimelineDisconnect(timeline, msg.error, nowMs);
    writer.closeWithoutError();
    return { wrote: false, error: new WebsocketCloseSentError() };
  }
  const body = payload ?? buildResponsesWebsocketErrorPayload(msg);
  const wrote = writer.closeWithPayload(body);
  if (wrote) timeline?.append("response", body, nowMs);
  return { payload: body, wrote, error: new WebsocketCloseSentError() };
}

const noActiveResponseToInterrupt = (): ErrorMessage => ({ statusCode: 400, error: new Error("no active response to interrupt") });

type RaceResult = { k: "source"; item: TurnSourceItem } | { k: "interrupt" } | { k: "closed" } | { k: "ping" };

/**
 * Forwards one turn (Go: forwardResponsesWebsocket): upstream payloads are
 * written as JSON text messages; completion events get their output restored;
 * an `error` payload or a stream failure ends the downstream socket (exposed
 * when it is the request's fault); a stream that closes before a terminal event
 * ends it with a hidden 408; a claimed local interrupt answers with a synthetic
 * response.incomplete and cancels the turn.
 */
export async function forwardResponsesWebsocket(ctx: ForwardContext, opts: ForwardOptions): Promise<ForwardResult> {
  const { writer, timeline, source, cancel, socketSignal } = ctx;
  const now = opts.now ?? Date.now;
  let completed = false;
  let turnEnded = false;
  let completedOutput = "[]";
  let completedResponseID = "";
  let collected = newCollectedWebsocketOutput();
  let pending = new Set<string>();
  const result = (errMsg?: ErrorMessage, terminateErr?: unknown): ForwardResult => ({
    completedOutput,
    completedResponseID,
    pendingToolCallIDs: sortedStringSet(pending),
    errMsg,
    terminateErr,
  });

  const local = opts.localInterrupt;
  const websocketOwned = !!local && opts.websocketOwned?.() === true;
  local?.begin(websocketOwned);

  const keepAliveMs = Math.max(0, opts.keepAliveIntervalMs ?? 0);
  /**
   * Waits for the next source item, a claimed interrupt, the socket closing or
   * the keep-alive interval (re-armed on every wait, like Go's ticker reset).
   * Listeners are removed after each wait so long streams do not accumulate them.
   */
  const waitNext = (nextPromise: Promise<TurnSourceItem>): Promise<RaceResult> =>
    new Promise<RaceResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const onAbort = () => finish({ k: "closed" });
      const finish = (r: RaceResult) => {
        if (settled) return;
        settled = true;
        socketSignal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        if (timer !== undefined) clearTimeout(timer);
        resolve(r);
      };
      nextPromise.then((item) => finish({ k: "source", item }));
      if (socketSignal.aborted) {
        finish({ k: "closed" });
        return;
      }
      socketSignal.addEventListener("abort", onAbort, { once: true });
      if (local) unsubscribe = local.onFrame(() => finish({ k: "interrupt" }));
      if (keepAliveMs > 0 && !settled) timer = setTimeout(() => finish({ k: "ping" }), keepAliveMs);
    });

  const completeLocalInterrupt = (frame: string): ForwardResult => {
    const root = tryParse(frame);
    const responseID = isObject(root) ? jsonString(root.response_id).trim() : "";
    const output = responseCompletedOutputFromPayload({ response: { output: [] } }, collected);
    const incomplete = { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "interrupted" }, id: responseID, output: tryParse(output) } };
    completedOutput = output;
    completedResponseID = responseID;
    try {
      writeResponsesWebsocketPayload(writer, timeline, JSON.stringify(incomplete), now());
    } catch (errWrite) {
      cancel(errWrite);
      return result(undefined, errWrite);
    }
    cancel(new DOMException("The operation was aborted.", "AbortError"));
    return result();
  };

  const handleErr = (errMsg: ErrorMessage): ForwardResult => {
    if (opts.suppressError?.(errMsg)) {
      cancel(errMsg.error);
      return result(errMsg);
    }
    const close = writer.closeForUpstreamError(errMsg.error);
    if (close.matched) {
      cancel(errMsg.error);
      return result(errMsg, close.error ?? new WebsocketCloseSentError());
    }
    const terminal = writeResponsesWebsocketTerminalError(writer, timeline, errMsg, undefined, now());
    if (terminal.wrote && terminal.payload) log.info(`responses websocket: downstream_out event=${websocketPayloadEventType(terminal.payload)}`);
    cancel(errMsg.error);
    return result(errMsg, terminal.error);
  };

  try {
    let nextPromise: Promise<TurnSourceItem> | undefined;
    for (;;) {
      nextPromise ??= source.next();
      const raced = await waitNext(nextPromise);

      if (raced.k === "closed") {
        const reason = socketSignal.reason ?? new Error("downstream websocket closed");
        cancel(reason);
        return result(undefined, reason);
      }
      if (raced.k === "ping") {
        try {
          writer.writePing();
        } catch (errPing) {
          cancel(errPing);
          return result(undefined, errPing);
        }
        continue;
      }
      if (raced.k === "interrupt") {
        const frame = local?.takeClaimed();
        if (frame === undefined) continue;
        if (turnEnded) {
          // Claimed before the terminal payload landed: the response is over.
          try {
            writeResponsesWebsocketError(writer, timeline, noActiveResponseToInterrupt(), now());
          } catch (errWrite) {
            cancel(errWrite);
            return result(undefined, errWrite);
          }
          continue;
        }
        return completeLocalInterrupt(frame);
      }

      nextPromise = undefined;
      const item = raced.item;
      if (item.kind === "error") return handleErr(item.errMsg);
      if (item.kind === "done") {
        if (!completed) {
          const errMsg: ErrorMessage = { statusCode: 408, error: new Error("stream closed before response.completed") };
          writer.closeWithoutError();
          cancel(errMsg.error);
          return result(errMsg, new WebsocketCloseSentError());
        }
        cancel(undefined);
        return result();
      }

      // A queued local interrupt belongs to the running HTTP turn.
      if (local) {
        const frame = local.takeClaimed();
        if (frame !== undefined) {
          if (!turnEnded) return completeLocalInterrupt(frame);
          try {
            writeResponsesWebsocketError(writer, timeline, noActiveResponseToInterrupt(), now());
          } catch (errWrite) {
            cancel(errWrite);
            return result(undefined, errWrite);
          }
        }
      }

      for (let payloadText of websocketJSONPayloadsFromChunk(item.chunk)) {
        const parsed = tryParse(payloadText);
        const payload: JSONObject = isObject(parsed) ? parsed : {};
        const eventType = jsonString(payload.type);
        if (eventType === "response.subscription_usage" || (eventType === "response.metadata" && !opts.codexClient)) continue;
        if (eventType === "response.created") {
          completed = false;
          turnEnded = false;
          local?.reactivate();
          collected = newCollectedWebsocketOutput();
          pending = new Set();
        }
        collectResponsesWebsocketOutputItem(payload, collected);
        if (isResponsesWebsocketCompletionEvent(eventType) && opts.preserveCompletionOutput?.() !== true) {
          payloadText = restoreResponsesWebsocketCompletionOutput(payloadText, payload, collected);
        }
        if (opts.toolCacheTurn) opts.toolCacheTurn.recordResponse(payload);
        else recordResponsesWebsocketToolCallsFromPayload(opts.downstreamSessionKey, payload);
        recordPendingToolCallIDsFromPayload(pending, payload);

        let payloadErr: ErrorMessage | undefined;
        if (eventType === wsEventTypeError) {
          payloadErr = responsesWebsocketErrorMessageFromPayload(payloadText);
          if (opts.suppressError?.(payloadErr)) {
            cancel(payloadErr.error);
            return result(payloadErr);
          }
        } else if (isResponsesWebsocketCompletionEvent(eventType) || eventType === "response.incomplete") {
          // response.incomplete (e.g. an interrupt acknowledgement) also ends the turn.
          completed = true;
          turnEnded = true;
          completedOutput = responseCompletedOutputFromPayload(payload, collected);
          completedResponseID = isObject(payload.response) ? jsonString(payload.response.id).trim() : "";
        } else if (eventType === "response.failed") {
          turnEnded = true;
        }
        if (payloadErr) {
          const close = writer.closeForUpstreamError(payloadErr.error);
          if (close.matched) {
            cancel(payloadErr.error);
            return result(payloadErr, close.error ?? new WebsocketCloseSentError());
          }
          const terminal = writeResponsesWebsocketTerminalError(writer, timeline, payloadErr, payloadText, now());
          cancel(payloadErr.error);
          return result(payloadErr, terminal.error);
        }
        // Stop claiming local interrupts before the client can see the terminal event.
        if (turnEnded && local?.isActive()) local.deactivate();
        opts.onPayload?.(payload);
        try {
          writeResponsesWebsocketPayload(writer, timeline, payloadText, now());
        } catch (errWrite) {
          log.debug(`responses websocket: downstream_out write failed event=${eventType || "-"}`);
          cancel(errWrite);
          return result(undefined, errWrite);
        }
      }
    }
  } finally {
    if (local) {
      if (websocketOwned) local.endWebsocketTurn();
      local.end();
      // A frame claimed between the last iteration and this return was already
      // treated as handled locally: answer it instead of dropping it.
      if (!socketSignal.aborted) {
        const claimed = local.takeClaimed();
        if (claimed !== undefined) {
          try {
            writeResponsesWebsocketError(writer, timeline, noActiveResponseToInterrupt(), now());
          } catch {
            // the socket is going away
          }
        }
      }
    }
  }
}

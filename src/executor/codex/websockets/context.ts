// Execution-session contract between the downstream websocket handler, the
// AuthManager and the Codex websocket executor. Port of
// sdk/cliproxy/executor/websocket.go, websocket_input.go and the websocket half
// of context.go (WithDownstreamWebsocket, WithRequiredUpstreamWebsocket).
//
// Go carried these values on context.Context; the port carries them on
// ExecOptions.metadata so the frozen ExecOptions contract is untouched:
//   - ExecutionSessionMetadataKey ("execution_session_id"): the downstream
//     connection id; the executor keeps one upstream socket per id.
//   - WebsocketContextMetadataKey: a WebsocketExecutionContext object (the
//     downstream-websocket marker, the required-upstream marker, the input loss
//     epoch and the live credential check).
//
// Dropped: the duplex input channel (WithWebsocketInput) and the per-turn
// authorizer (WithWebsocketTurnAuthorizer), which only serve response steering,
// and the upstream attempt tracker (no consumer in this port).
import { StatusError, type ExecOptions } from "../../types.ts";
import { ExecutionSessionMetadataKey } from "../reasoning_replay.ts";

export { ExecutionSessionMetadataKey };

/** ExecOptions.metadata key carrying the WebsocketExecutionContext of a downstream websocket turn. */
export const WebsocketContextMetadataKey = "cliproxy.websocket_context";

/** The downstream input loss epoch of one websocket connection (Go: *atomic.Uint64). */
export interface WebsocketInputEpoch {
  value: number;
}

export interface WebsocketExecutionContext {
  /** The request comes from a downstream websocket (Go: WithDownstreamWebsocket). */
  downstreamWebsocket: boolean;
  /**
   * The request's incremental context only exists on the current upstream
   * socket, so no HTTP fallback or new dial is allowed (Go: WithRequiredUpstreamWebsocket).
   */
  requiredUpstreamWebsocket?: boolean;
  /** Advanced on every upstream loss (Go: WithWebsocketInputEpoch epoch). */
  inputEpoch?: WebsocketInputEpoch;
  /** The epoch at which this turn's input was read (Go: messageEpoch). */
  messageEpoch?: number;
  /** Live account check for a bound connection (Go: WithWebsocketAuthCheck). */
  authEnabled?: (authId: string) => boolean;
}

/** The websocket context of an execution, if any. */
export function websocketContextOf(opts: ExecOptions | undefined): WebsocketExecutionContext | undefined {
  const value = opts?.metadata?.[WebsocketContextMetadataKey];
  if (!value || typeof value !== "object") return undefined;
  return value as WebsocketExecutionContext;
}

/** Go: DownstreamWebsocket. */
export function isDownstreamWebsocket(opts: ExecOptions | undefined): boolean {
  return websocketContextOf(opts)?.downstreamWebsocket === true;
}

/** Go: RequiredUpstreamWebsocket. */
export function isRequiredUpstreamWebsocket(opts: ExecOptions | undefined): boolean {
  return websocketContextOf(opts)?.requiredUpstreamWebsocket === true;
}

/** The execution session id of a request ("" when none) (Go: executionSessionIDFromOptions). */
export function executionSessionIDFromOptions(opts: ExecOptions | undefined): string {
  const raw = opts?.metadata?.[ExecutionSessionMetadataKey];
  if (typeof raw === "string") return raw.trim();
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw).trim();
  return "";
}

/** Advances the connection's loss epoch (Go: NotifyWebsocketInputLoss). */
export function notifyWebsocketInputLoss(ctx: WebsocketExecutionContext | undefined): void {
  if (ctx?.inputEpoch) ctx.inputEpoch.value += 1;
}

/** Whether this turn's input was read before an upstream loss (Go: WebsocketInputPredatesLoss). */
export function websocketInputPredatesLoss(ctx: WebsocketExecutionContext | undefined): boolean {
  if (!ctx?.inputEpoch) return false;
  return (ctx.messageEpoch ?? 0) < ctx.inputEpoch.value;
}

/**
 * The turn error for input read before the latest upstream loss, undefined
 * otherwise (Go: WebsocketInputLossError).
 */
export function websocketInputLossError(ctx: WebsocketExecutionContext | undefined): UpstreamWebsocketTurnError | undefined {
  if (!websocketInputPredatesLoss(ctx)) return undefined;
  if (ctx?.requiredUpstreamWebsocket) return new UpstreamWebsocketTurnError({ fullContextRequired: true });
  return new UpstreamWebsocketTurnError({ notSent: true });
}

/** Go: WebsocketAuthEnabled; true without a check. */
export function websocketAuthEnabled(ctx: WebsocketExecutionContext | undefined, authId: string): boolean {
  return !ctx?.authEnabled || ctx.authEnabled(authId);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const upstreamWebsocketReplayRequiredMessage = `{"error":{"message":"upstream transport requires full HTTP replay","type":"server_error","code":"upstream_http_replay_required","status":426}}`;

/**
 * An incremental request cannot continue because its upstream websocket is no
 * longer reusable: the client must replay the full turn (Go:
 * UpstreamWebsocketReplayRequiredError; 426, request scoped).
 */
export class UpstreamWebsocketReplayRequiredError extends StatusError {
  constructor() {
    super(426, upstreamWebsocketReplayRequiredMessage, { requestScoped: true });
    this.name = "UpstreamWebsocketReplayRequiredError";
  }
}

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let current = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return out;
}

/** Go: IsUpstreamWebsocketReplayRequired (errors.As). */
export function isUpstreamWebsocketReplayRequired(err: unknown): boolean {
  return causeChain(err).some((e) => e instanceof UpstreamWebsocketReplayRequiredError);
}

const turnFullContextMessage = `{"error":{"message":"Previous response is not available on this websocket; resend the full conversation input without previous_response_id","type":"invalid_request_error","code":"previous_response_not_found","param":"previous_response_id"}}`;
const turnNotSentMessage = `{"error":{"message":"Operation was not sent because the upstream websocket was lost. Send a new response.create with full conversation input.","type":"invalid_request_error","code":"upstream_websocket_not_sent"}}`;
const turnLostMessage = `{"error":{"message":"Upstream websocket disconnected. The turn was not replayed and its outcome may be unknown. Send a new response.create with full conversation input without previous_response_id.","type":"server_error","code":"upstream_websocket_lost"}}`;

export interface UpstreamWebsocketTurnErrorInit {
  cause?: unknown;
  fullContextRequired?: boolean;
  notSent?: boolean;
  eventId?: string;
  idle?: boolean;
  abandoned?: UpstreamWebsocketTurnError[];
}

/**
 * Ends one downstream websocket turn after the upstream websocket was lost; the
 * downstream socket stays open and the turn is never replayed. The cause is
 * kept for logging only (Go: UpstreamWebsocketTurnError; 409 when the full
 * context is required, 502 otherwise; request scoped).
 */
export class UpstreamWebsocketTurnError extends StatusError {
  readonly fullContextRequired: boolean;
  readonly notSent: boolean;
  eventId: string;
  readonly idle: boolean;
  readonly abandoned: UpstreamWebsocketTurnError[];

  constructor(init: UpstreamWebsocketTurnErrorInit = {}) {
    const message = init.fullContextRequired ? turnFullContextMessage : init.notSent ? turnNotSentMessage : turnLostMessage;
    super(init.fullContextRequired ? 409 : 502, message, { requestScoped: true, cause: init.cause });
    this.name = "UpstreamWebsocketTurnError";
    this.fullContextRequired = init.fullContextRequired === true;
    this.notSent = init.notSent === true;
    this.eventId = init.eventId ?? "";
    this.idle = init.idle === true;
    this.abandoned = init.abandoned ?? [];
  }

  /** A copy carrying `eventId` (Go: withID := *turnErr). */
  withEventID(eventId: string): UpstreamWebsocketTurnError {
    return new UpstreamWebsocketTurnError({
      cause: this.cause,
      fullContextRequired: this.fullContextRequired,
      notSent: this.notSent,
      eventId,
      idle: this.idle,
      abandoned: this.abandoned,
    });
  }
}

/** The turn error in an error chain (Go: errors.As(err, &turnErr)). */
export function asUpstreamWebsocketTurnError(err: unknown): UpstreamWebsocketTurnError | undefined {
  return causeChain(err).find((e): e is UpstreamWebsocketTurnError => e instanceof UpstreamWebsocketTurnError);
}

/** Go: IsUpstreamWebsocketTurnError. */
export function isUpstreamWebsocketTurnError(err: unknown): boolean {
  return asUpstreamWebsocketTurnError(err) !== undefined;
}

/** response.interrupt has no live upstream socket (Go: ErrNoActiveUpstreamWebsocket). */
export class NoActiveUpstreamWebsocketError extends Error {
  constructor() {
    super("no active upstream websocket for response.interrupt");
    this.name = "NoActiveUpstreamWebsocketError";
  }
}

/**
 * A live upstream socket owns the turn but the interrupt does not target its
 * running response; handlers must reject the frame without a local fallback
 * (Go: ErrUpstreamWebsocketInterruptRejected).
 */
export class UpstreamWebsocketInterruptRejectedError extends Error {
  constructor() {
    super("response.interrupt does not target the active upstream response");
    this.name = "UpstreamWebsocketInterruptRejectedError";
  }
}

/**
 * The optional executor capabilities the handler and the manager look for
 * (Go: ExecutionSessionCloser, AuthExecutionSessionCloser,
 * UpstreamDisconnectChan and InterruptExecutionSession).
 */
export interface ExecutionSessionCapableExecutor {
  closeExecutionSession?(sessionId: string): void;
  closeAuthExecutionSessions?(authId: string): void;
  /** Resolves once with the error that tore down the session's upstream socket. */
  upstreamDisconnect?(sessionId: string): Promise<unknown> | undefined;
  interruptExecutionSession?(sessionId: string, payload: string, ctx?: WebsocketExecutionContext): Promise<void>;
}

/** Closes every execution session of an executor (Go: CloseAllExecutionSessionsID). */
export const CloseAllExecutionSessionsID = "__all_execution_sessions__";

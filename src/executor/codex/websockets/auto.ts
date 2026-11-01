// Transport selection for the "codex" provider. Port of CodexAutoExecutor and
// codexWebsocketsEnabled (internal/runtime/executor/codex_websockets_executor.go).
//
// The websocket transport is used only when the request comes from a
// downstream websocket AND the selected credential enables websockets
// (attributes.websockets, else metadata.websockets). Every other request uses
// the HTTP/SSE executor; a continuation that requires the current upstream
// websocket fails with the 426 replay signal instead of silently switching to
// HTTP.
import type { Auth } from "../../../auth/types.ts";
import type { ExecOptions, ExecRequest, ExecResponse, ProviderExecutor, StreamResult } from "../../types.ts";
import { CodexExecutor } from "../executor.ts";
import { type ExecutionSessionCapableExecutor, UpstreamWebsocketReplayRequiredError, type WebsocketExecutionContext, isDownstreamWebsocket, isRequiredUpstreamWebsocket } from "./context.ts";
import { CodexWebsocketsExecutor, type CodexWebsocketsExecutorOptions } from "./executor.ts";

/** Go strconv.ParseBool. */
export function parseGoBool(raw: string): boolean | undefined {
  switch (raw.trim()) {
    case "1":
    case "t":
    case "T":
    case "TRUE":
    case "true":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "FALSE":
    case "false":
    case "False":
      return false;
    default:
      return undefined;
  }
}

/**
 * Whether a credential enables the upstream websocket transport (Go:
 * codexWebsocketsEnabled, also websocketUpstreamSupportsIncrementalInput).
 */
export function websocketsEnabledFor(attributes: Record<string, string> | undefined, metadata: Record<string, unknown> | undefined): boolean {
  const attr = (attributes?.websockets ?? "").trim();
  if (attr !== "") {
    const parsed = parseGoBool(attr);
    if (parsed !== undefined) return parsed;
  }
  const raw = metadata?.websockets;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return parseGoBool(raw.trim()) ?? false;
  return false;
}

export function codexWebsocketsEnabled(auth: Auth | undefined): boolean {
  if (!auth) return false;
  return websocketsEnabledFor(auth.attributes, auth.metadata);
}

/** Go: CodexAutoExecutor. */
export class CodexAutoExecutor implements ProviderExecutor, ExecutionSessionCapableExecutor {
  readonly identifier = "codex";
  readonly httpExecutor: CodexExecutor;
  readonly wsExecutor: CodexWebsocketsExecutor;

  constructor(options: CodexWebsocketsExecutorOptions = {}) {
    this.httpExecutor = options.httpExecutor ?? new CodexExecutor(options);
    this.wsExecutor = new CodexWebsocketsExecutor({ ...options, httpExecutor: this.httpExecutor });
  }

  private useWebsocket(auth: Auth, opts: ExecOptions): boolean {
    return isDownstreamWebsocket(opts) && codexWebsocketsEnabled(auth);
  }

  execute(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    if (this.useWebsocket(auth, opts)) return this.wsExecutor.execute(auth, req, opts);
    if (isRequiredUpstreamWebsocket(opts)) return Promise.reject(new UpstreamWebsocketReplayRequiredError());
    return this.httpExecutor.execute(auth, req, opts);
  }

  executeStream(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    if (this.useWebsocket(auth, opts)) return this.wsExecutor.executeStream(auth, req, opts);
    if (isRequiredUpstreamWebsocket(opts)) return Promise.reject(new UpstreamWebsocketReplayRequiredError());
    return this.httpExecutor.executeStream(auth, req, opts);
  }

  refresh(auth: Auth): Promise<Auth> {
    return this.httpExecutor.refresh(auth);
  }

  countTokens(auth: Auth, req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    return this.httpExecutor.countTokens(auth, req, opts);
  }

  closeExecutionSession(sessionId: string): void {
    this.wsExecutor.closeExecutionSession(sessionId);
  }

  closeAuthExecutionSessions(authId: string): void {
    this.wsExecutor.closeAuthExecutionSessions(authId);
  }

  upstreamDisconnect(sessionId: string): Promise<unknown> | undefined {
    return this.wsExecutor.upstreamDisconnect(sessionId);
  }

  /** Forwards response.interrupt on the current upstream socket (never dials or replays). */
  interruptExecutionSession(sessionId: string, payload: string, ctx?: WebsocketExecutionContext): Promise<void> {
    return this.wsExecutor.interruptExecutionSession(sessionId, payload, ctx);
  }
}

export function createCodexAutoExecutor(options: CodexWebsocketsExecutorOptions = {}): CodexAutoExecutor {
  return new CodexAutoExecutor(options);
}

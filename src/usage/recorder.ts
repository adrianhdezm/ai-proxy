// Per-request usage recording at the HTTP layer. Upstream published records from
// inside every executor (helps.UsageReporter: Publish / PublishFailure /
// EnsurePublished, StreamUsageBuffer for streams). This port observes the
// Claude-shaped responses the server already sends instead, so one record is
// published per /v1/messages request after the response completes, without
// touching the executors.
import { accountInfo } from "../auth/manager/classification.ts";
import type { Auth } from "../auth/types.ts";
import { SelectedAuthMetadataKey } from "../executor/types.ts";
import { isObject, type JSONObject } from "../util/json.ts";
import { hideAPIKey } from "../util/provider.ts";
import { newDetail, type Detail } from "./accounting.ts";
import { ClaudeStreamUsageObserver, parseClaudeUsage, statusFromClaudeErrorType } from "./claude.ts";
import { FailureClientClosedCode, FailureStreamTruncatedCode } from "./record.ts";
import type { UsageStatistics } from "./statistics.ts";
import { StreamDelivery } from "./stream_delivery.ts";

/** Status used for requests the client abandoned (nginx's 499, as upstream's StatusClientClosedRequest). */
const statusClientClosedRequest = 499;

export interface RequestUsageInit {
  statistics: UsageStatistics;
  now: () => number;
  /** Request start (epoch ms). */
  start: number;
  /** "METHOD /path". */
  endpoint: string;
  /** Requested model after decoding cloaked ids. */
  model: string;
  /** Model string as the client sent it. */
  alias: string;
  /** Raw inbound client key (masked by the statistics store). */
  clientKey: string;
  sessionId: string;
  stream: boolean;
  /** The ExecOptions metadata; the selected credential id is read from it when the request finishes. */
  metadata: Record<string, unknown> | undefined;
  /** Candidate providers of the requested model (used when no credential was selected). */
  providers: string[];
  /** Credential lookup (AuthManager.getById). */
  lookupAuth?: (id: string) => Auth | undefined;
}

/** Terminal outcome of a forwarded stream, as forwardClaudeStream reports it. */
export interface StreamTerminal {
  statusCode: number;
  error?: Error;
}

/** Collects what one request needs for its usage record and publishes it exactly once (Go: UsageReporter's once). */
export class RequestUsageRecorder {
  private published = false;

  constructor(private readonly init: RequestUsageInit) {}

  /** Non-stream success: usage from the Claude JSON body (Go: Publish(ParseClaudeUsage(body))). */
  recordResponse(payload: string): void {
    const detail = parseClaudeUsage(payload);
    this.publish(detail, false, 0, "", responseModelOf(payload));
  }

  /** Failure before or instead of a response (Go: PublishFailure). */
  recordFailure(statusCode: number, code = ""): void {
    this.publish(newDetail(), true, statusCode, code, "");
  }

  /**
   * Starts observing a committed stream. Feed every forwarded chunk to the
   * returned observer and resolve the returned delivery on every exit; the
   * record is published when the delivery resolves (Go: StreamUsageBuffer +
   * WaitStreamDelivery).
   */
  startStream(signal?: AbortSignal): { observer: ClaudeStreamUsageObserver; delivery: StreamDelivery } {
    const observer = new ClaudeStreamUsageObserver();
    const delivery = new StreamDelivery();
    const onAbort = () => delivery.finish(new DOMException("client closed the request", "AbortError"));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    delivery.onFinish(({ error }) => {
      signal?.removeEventListener("abort", onAbort);
      observer.flush();
      this.publishStream(observer, error);
    });
    return { observer, delivery };
  }

  private publishStream(observer: ClaudeStreamUsageObserver, error: unknown): void {
    const detail = observer.usage() ?? newDetail();
    const responseModel = observer.responseModel;
    if (observer.sawErrorEvent) {
      this.publish(detail, true, statusFromClaudeErrorType(observer.errorType), "", responseModel);
      return;
    }
    const terminal = asStreamTerminal(error);
    if (terminal) {
      const code = !observer.sawMessageStop && terminal.statusCode === 502 ? FailureStreamTruncatedCode : "";
      this.publish(detail, true, terminal.statusCode, code, responseModel);
      return;
    }
    if (observer.sawMessageStop) {
      this.publish(detail, false, 0, "", responseModel);
      return;
    }
    // Closed without message_stop and without a terminal error frame: the
    // forwarder only does that when the client went away (signal abort) or
    // cancelled the response body.
    this.publish(detail, true, statusClientClosedRequest, FailureClientClosedCode, responseModel);
  }

  private publish(detail: Detail, failed: boolean, statusCode: number, code: string, responseModel: string): void {
    if (this.published) return;
    this.published = true;
    const init = this.init;
    const authId = selectedAuthId(init.metadata);
    const auth = authId !== "" ? init.lookupAuth?.(authId) : undefined;
    let provider = (auth?.provider ?? "").trim();
    if (provider === "" && init.providers.length === 1) provider = init.providers[0]!;
    init.statistics.record({
      timestamp: init.start,
      provider,
      model: init.model,
      alias: init.alias,
      responseModel,
      endpoint: init.endpoint,
      authId,
      authIndex: (auth?.label ?? "").trim(),
      source: usageSource(auth),
      clientKey: init.clientKey,
      sessionId: init.sessionId,
      stream: init.stream,
      failed,
      fail: { statusCode, code },
      latencyMs: init.now() - init.start,
      detail,
    });
  }
}

function asStreamTerminal(error: unknown): StreamTerminal | undefined {
  if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number") return error as StreamTerminal;
  return undefined;
}

function selectedAuthId(metadata: Record<string, unknown> | undefined): string {
  const value = metadata?.[SelectedAuthMetadataKey];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The account identity of a credential (Go: resolveUsageSource): the OAuth
 * email, or the upstream API key masked, or the label. Raw keys never leave here.
 */
export function usageSource(auth: Auth | undefined): string {
  if (!auth) return "";
  const [kind, value] = accountInfo(auth);
  if (value.trim() !== "") return kind === "api_key" ? hideAPIKey(value.trim()) : value.trim();
  const email = auth.metadata?.email;
  if (typeof email === "string" && email.trim() !== "") return email.trim();
  return (auth.label ?? "").trim();
}

function responseModelOf(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isObject(parsed) && typeof parsed.model === "string") return parsed.model.trim();
  } catch {
    // not JSON
  }
  return "";
}

/**
 * The client session id of a Claude request: the X-Claude-Code-Session-Id
 * header, or the session part of metadata.user_id (legacy
 * `user_<hash>_account_<uuid>_session_<uuid>` or the JSON form with session_id).
 */
export function claudeSessionID(headers: Headers, body: JSONObject): string {
  const header = headers.get("X-Claude-Code-Session-Id")?.trim();
  if (header) return header;
  const metadata = body.metadata;
  if (!isObject(metadata) || typeof metadata.user_id !== "string") return "";
  const userID = metadata.user_id.trim();
  if (userID.startsWith("{")) {
    try {
      const parsed = JSON.parse(userID) as unknown;
      if (isObject(parsed) && typeof parsed.session_id === "string") return parsed.session_id.trim();
    } catch {
      return "";
    }
    return "";
  }
  const idx = userID.lastIndexOf("_session_");
  return idx >= 0 ? userID.slice(idx + "_session_".length).trim() : "";
}

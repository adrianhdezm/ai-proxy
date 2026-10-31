// Usage record of one proxied request. Port of usage.Record / usage.Failure from
// sdk/cliproxy/usage/manager.go, reduced to the fields this port can observe at
// the HTTP layer. The inbound client key is masked on the way in; the record
// never holds a raw secret.
import { hideAPIKey } from "../util/provider.ts";
import { newDetail, type Detail } from "./accounting.ts";

/** Marks a locally synthesized failure for a stream that ended without its terminal frame (Go: FailureStreamTruncatedCode). */
export const FailureStreamTruncatedCode = "stream_truncated";
/** Marks a request the client abandoned before the response completed (port-only). */
export const FailureClientClosedCode = "client_closed";

/** HTTP failure metadata (Go: usage.Failure without the body, which may echo request content). */
export interface Failure {
  statusCode: number;
  code: string;
}

export interface UsageRecord {
  /** Unique id of this record (UUID v4). */
  requestId: string;
  /** Request start, epoch milliseconds (Go: RequestedAt). */
  timestamp: number;
  /** Provider of the credential that served the request ("unknown" when none was selected). */
  provider: string;
  /** Requested model, after decoding cloaked ids. */
  model: string;
  /** Model string exactly as the client sent it (Go: Alias, the client-requested name). */
  alias: string;
  /** Model reported by the upstream response, when known (Go: ResponseModel). */
  responseModel: string;
  /** "METHOD /path" of the inbound request. */
  endpoint: string;
  /** Id of the selected credential (ExecOptions metadata selected_auth_id). */
  authId: string;
  /** Credential label (Go: AuthIndex). */
  authIndex: string;
  /** Account identity of the credential: OAuth email, or the masked upstream API key (Go: Source). */
  source: string;
  /** Masked inbound client API key ("" when access is open). */
  apiKey: string;
  /** Client session id when the request carried one. */
  sessionId: string;
  stream: boolean;
  failed: boolean;
  fail: Failure;
  latencyMs: number;
  detail: Detail;
}

/** Input to UsageStatistics.record: like UsageRecord, but with the raw client key, which is masked before storage. */
export interface UsageRecordInput {
  requestId?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  alias?: string;
  responseModel?: string;
  endpoint?: string;
  authId?: string;
  authIndex?: string;
  source?: string;
  /** Raw inbound client API key; stored masked as `apiKey`. */
  clientKey?: string;
  sessionId?: string;
  stream?: boolean;
  failed?: boolean;
  fail?: Partial<Failure>;
  latencyMs?: number;
  detail?: Detail;
}

/** Masks an inbound client key for storage and display; short keys are fully hidden. */
export function maskClientKey(key: string | undefined): string {
  const trimmed = (key ?? "").trim();
  if (trimmed === "") return "";
  if (trimmed.length <= 8) return "****";
  return hideAPIKey(trimmed);
}

/** Normalises an input into a stored record (Go: Manager.Publish back-filling + the queue plugin defaults). */
export function normalizeRecord(input: UsageRecordInput, now: () => number, newId: () => string): UsageRecord {
  const failed = input.failed ?? false;
  const model = (input.model ?? "").trim() || "unknown";
  let statusCode = Math.trunc(input.fail?.statusCode ?? 0);
  if (!failed) statusCode = 200;
  else if (statusCode <= 0) statusCode = 500;
  return {
    requestId: (input.requestId ?? "").trim() || newId(),
    timestamp: input.timestamp && input.timestamp > 0 ? input.timestamp : now(),
    provider: (input.provider ?? "").trim() || "unknown",
    model,
    alias: (input.alias ?? "").trim() || model,
    responseModel: (input.responseModel ?? "").trim(),
    endpoint: (input.endpoint ?? "").trim(),
    authId: (input.authId ?? "").trim(),
    authIndex: (input.authIndex ?? "").trim(),
    source: (input.source ?? "").trim(),
    apiKey: maskClientKey(input.clientKey),
    sessionId: (input.sessionId ?? "").trim(),
    stream: input.stream ?? false,
    failed,
    fail: { statusCode, code: failed ? (input.fail?.code ?? "").trim() : "" },
    latencyMs: Math.max(0, Math.trunc(input.latencyMs ?? 0)),
    detail: input.detail ? { ...input.detail } : newDetail(),
  };
}

// OpenAI Responses SSE framing and stream error envelopes. Port of
// sdk/api/handlers/openai/openai_responses_handlers.go (writeResponsesSSEChunk,
// responsesSSEFramer and its helpers, isCodexResponsesClientRequest, the
// responsesStream* sanitisers) and sdk/api/handlers/openai_responses_stream_error.go
// (BuildOpenAIResponsesStreamErrorChunk / BuildOpenAIResponsesStreamFailedChunk).
//
// The framer accepts both shapes the executors produce: complete SSE frames
// ("event: x\ndata: {...}\n\n", the Claude / OpenAI / Gemini translators) and
// raw SSE lines without their blank separator ("event: x", "data: {...}", the
// Codex pair). It re-frames them, drops private upstream events, repairs an
// empty response.completed output from the response.output_item.done items and
// turns error payloads into one sanitised terminal `error` / `response.failed` event.
//
// Strings stand in for Go's byte slices; positions are JS string indices.
// Number literals inside JSON that is rewritten are preserved verbatim
// (rawjson), as Go's gjson/sjson and json.Number did.
import { parseRawJSON, stringifyRawJSON, RawNumber } from "../executor/codex/rawjson.ts";
import type { ErrorMessage } from "../executor/types.ts";
import { httpStatusText } from "./errors.ts";

type JSONObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small JSON helpers (gjson stand-ins)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

/** json.Valid. */
export function jsonValid(text: string): boolean {
  if (text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** parseRawJSON without throwing. */
function tryParseRaw(text: string): unknown {
  try {
    return parseRawJSON(text);
  } catch {
    return undefined;
  }
}

function rawGet(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** gjson Result.String() for scalar values. */
function scalarString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof RawNumber) return v.raw;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** gjson Result.Int() for a numeric (or numeric string) value. */
function intOf(v: unknown): number | undefined {
  if (v instanceof RawNumber) {
    const n = Number(v.raw);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined;
}

function skipWS(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
    else break;
  }
  return i;
}

/** Reads a JSON string starting at s[i] === '"'; returns the decoded value and the index after it. */
function readJSONString(s: string, i: number): { value: string; end: number } | undefined {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') {
      try {
        return { value: JSON.parse(s.slice(i, j + 1)) as string, end: j + 1 };
      } catch {
        return { value: s.slice(i + 1, j), end: j + 1 };
      }
    }
    j++;
  }
  return undefined;
}

/**
 * The top-level string value of `key` in possibly malformed JSON (gjson reads
 * lazily, so a truncated object still yields its leading fields).
 */
function looseTopLevelString(s: string, key: string): string {
  let i = skipWS(s, 0);
  if (s[i] !== "{") return "";
  i++;
  let depth = 1;
  let keyPos = true;
  while (i < s.length && depth > 0) {
    const c = s[i]!;
    if (c === '"') {
      const str = readJSONString(s, i);
      if (!str) return "";
      i = str.end;
      if (depth === 1 && keyPos) {
        const j = skipWS(s, i);
        if (s[j] === ":") {
          keyPos = false;
          const v = skipWS(s, j + 1);
          if (str.value === key) {
            if (s[v] === '"') return readJSONString(s, v)?.value ?? "";
            const m = /^[-0-9A-Za-z.+]+/.exec(s.slice(v));
            return m && m[0] !== "null" ? m[0] : "";
          }
          i = v;
        }
      }
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 1) keyPos = true;
    i++;
  }
  return "";
}

/** gjson.GetBytes(payload, "type").String(): parsed when valid, loose otherwise. */
function payloadTypeOf(payload: string): string {
  const parsed = tryParseRaw(payload);
  if (parsed !== undefined) return scalarString(rawGet(parsed, ["type"]));
  return looseTopLevelString(payload, "type");
}

// ---------------------------------------------------------------------------
// Stream error chunks (openai_responses_stream_error.go)
// ---------------------------------------------------------------------------

const clientErrorType = "invalid_request_error";
const serverErrorType = "server_error";

const streamErrorClasses: Record<number, { code: string; errorType: string }> = {
  401: { code: "invalid_api_key", errorType: clientErrorType },
  403: { code: "insufficient_quota", errorType: clientErrorType },
  429: { code: "rate_limit_exceeded", errorType: clientErrorType },
  404: { code: "model_not_found", errorType: clientErrorType },
  // A stream cut in transit (Codex 408) is retryable: never a client error.
  408: { code: "request_timeout", errorType: serverErrorType },
};

/** The OpenAI (code, type) pair a status is reported as (Go: openAIResponsesStreamErrorClassFor). */
export function openAIResponsesStreamErrorClassFor(status: number): { code: string; errorType: string } {
  const known = streamErrorClasses[status];
  if (known) return known;
  if (status >= 500) return { code: "internal_server_error", errorType: serverErrorType };
  if (status >= 400) return { code: "invalid_request_error", errorType: clientErrorType };
  return { code: "unknown_error", errorType: clientErrorType };
}

/** fmt.Sprint for a decoded JSON value used as an error code. */
function sprint(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof RawNumber) return v.raw;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "";
  return stringifyRawJSON(v);
}

function applyNestedErrorCode(detail: JSONObject): JSONObject {
  const existing = detail.code;
  if (existing !== undefined && existing !== null && sprint(existing).trim() !== "") return detail;
  // Anthropic reports input overflow by message only; Responses clients key on this code.
  const message = typeof detail.message === "string" ? detail.message : "";
  if (detail.type === "invalid_request_error" && message.startsWith("prompt is too long")) detail.code = "context_length_exceeded";
  return detail;
}

function streamErrorDetail(status: number, errText: string, code: string, message: string): JSONObject {
  const trimmed = errText.trim();
  let payload: JSONObject | undefined;
  if (trimmed !== "") {
    const parsed = tryParseRaw(trimmed);
    if (isPlainObject(parsed)) {
      payload = parsed;
      if (isPlainObject(parsed.error)) return applyNestedErrorCode(parsed.error);
      const response = parsed.response;
      if (isPlainObject(response) && isPlainObject(response.error)) return applyNestedErrorCode(response.error);
      if (typeof parsed.message === "string" && parsed.message.trim() !== "") message = parsed.message.trim();
      const rawCode = parsed.code;
      if (rawCode !== undefined && rawCode !== null) {
        if (typeof rawCode === "string" && rawCode.trim() !== "") code = rawCode.trim();
        else code = sprint(rawCode).trim();
      }
    }
  }
  const detail: JSONObject = { type: openAIResponsesStreamErrorClassFor(status).errorType, code, message, param: null };
  if (payload) {
    if (typeof payload.type === "string" && payload.type.trim() !== "" && payload.type.trim() !== "error") detail.type = payload.type.trim();
    if ("param" in payload) detail.param = payload.param;
  }
  return detail;
}

function sequenceFromText(text: string): number | undefined {
  const parsed = tryParseRaw(text.trim());
  if (!isPlainObject(parsed) || !("sequence_number" in parsed)) return undefined;
  const v = parsed.sequence_number;
  if (v instanceof RawNumber || typeof v === "number") return intOf(v);
  return undefined;
}

/** The `{"type":"error","error":{...},"sequence_number":N}` Responses stream event (Go: BuildOpenAIResponsesStreamErrorChunk). */
export function buildOpenAIResponsesStreamErrorChunk(status: number, errText: string, sequenceNumber: number): string {
  if (status <= 0) status = 500;
  if (sequenceNumber < 0) sequenceNumber = 0;
  let message = errText.trim();
  if (message === "") message = httpStatusText(status);
  let code = openAIResponsesStreamErrorClassFor(status).code;
  const fromText = sequenceFromText(errText);
  if (fromText !== undefined) sequenceNumber = fromText;
  if (code.trim() === "") code = "unknown_error";
  const detail = streamErrorDetail(status, errText, code, message);
  return stringifyRawJSON({ type: "error", error: detail, sequence_number: sequenceNumber });
}

/** The terminal `response.failed` event official Codex clients expect (Go: BuildOpenAIResponsesStreamFailedChunk). */
export function buildOpenAIResponsesStreamFailedChunk(status: number, errText: string, sequenceNumber: number): string {
  if (status <= 0) status = 500;
  if (sequenceNumber < 0) sequenceNumber = 0;
  const errorChunk = parseRawJSON(buildOpenAIResponsesStreamErrorChunk(status, errText, sequenceNumber)) as JSONObject;
  const seq = intOf(errorChunk.sequence_number) ?? sequenceNumber;
  let detail = errorChunk.error;
  if (!isPlainObject(detail)) {
    const message = errText.trim() || httpStatusText(status);
    detail = streamErrorDetail(status, errText, openAIResponsesStreamErrorClassFor(status).code, message);
  }
  return stringifyRawJSON({ type: "response.failed", sequence_number: seq, response: { status: "failed", error: detail } });
}

// ---------------------------------------------------------------------------
// Error text sanitising (openai_responses_handlers.go)
// ---------------------------------------------------------------------------

export const responsesStreamErrorMessageLimit = 2048;
export const responsesStreamErrorFieldLimit = 256;

const sensitiveValuePattern = /((?:"?(?:api[_-]?key|access[_-]?token|token|authorization|secret)"?)\s*[=:]\s*"?)([^\s"&,;}]+)/gi;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function truncateErrorText(text: string, limit: number): string {
  const runes = Array.from(text);
  if (runes.length <= limit) return text;
  return runes.slice(0, limit).join("") + "…";
}

function redactErrorText(text: string): string {
  return text.replace(sensitiveValuePattern, "$1[REDACTED]").replace(bearerPattern, "Bearer [REDACTED]");
}

/** A bounded, redacted event name for diagnostics (Go: sanitizeResponsesStreamEventName). */
export function sanitizeResponsesStreamEventName(eventName: string): string {
  return truncateErrorText(redactErrorText(eventName.trim()), responsesStreamErrorFieldLimit);
}

function isSensitiveKey(key: string): boolean {
  const k = key.trim().toLowerCase().replaceAll("-", "_");
  if (k.includes("tokens") || k.includes("token_count") || k.includes("token_limit") || k.includes("token_usage")) return false;
  switch (k) {
    case "authorization":
    case "secret":
    case "password":
    case "passwd":
    case "api_key":
    case "apikey":
    case "token":
    case "access_token":
    case "refresh_token":
    case "id_token":
    case "auth_token":
    case "session_token":
    case "api_token":
    case "client_secret":
    case "client_key":
      return true;
  }
  return k.endsWith("_secret") || k.endsWith("_password") || k.endsWith("_api_key") || k.endsWith("_token");
}

function sanitizeErrorNode(value: unknown): unknown {
  if (typeof value === "string") return truncateErrorText(redactErrorText(value), responsesStreamErrorMessageLimit);
  if (Array.isArray(value)) return value.map((item) => sanitizeErrorNode(item));
  if (isPlainObject(value)) {
    const cleaned: JSONObject = {};
    for (const [k, item] of Object.entries(value)) cleaned[k] = isSensitiveKey(k) ? "[REDACTED]" : sanitizeErrorNode(item);
    return cleaned;
  }
  return value;
}

/** The text of an ErrorMessage's error: the upstream body when it carries one, otherwise the message. */
export function errorMessageText(err: Error | undefined | null): string {
  if (!err) return "";
  const provider = err as { responseBody?: unknown; body?: unknown };
  if (typeof provider.responseBody === "function") {
    const body = (provider.responseBody as () => unknown).call(err);
    if (typeof body === "string" && body.length > 0) return body;
  }
  if (typeof provider.body === "string" && provider.body.length > 0) return provider.body;
  return err.message;
}

/**
 * The sanitised, bounded error text of a stream failure: a JSON error keeps
 * only its error object (plus sequence_number) with secrets redacted and long
 * strings truncated; plain text is redacted and truncated (Go: responsesStreamErrorText).
 */
export function responsesStreamErrorText(msg: ErrorMessage | undefined | null, status: number): string {
  let text = httpStatusText(status);
  const fromError = msg?.error ? errorMessageText(msg.error).trim() : "";
  if (fromError !== "") text = fromError;
  const trimmed = text.trim();
  const root = jsonValid(trimmed) ? tryParseRaw(trimmed) : undefined;
  if (!isPlainObject(root)) return truncateErrorText(redactErrorText(trimmed), responsesStreamErrorMessageLimit);
  let errorNode: unknown = isPlainObject(root.error) ? root.error : undefined;
  if (errorNode === undefined && isPlainObject(root.response) && isPlainObject(root.response.error)) errorNode = root.response.error;
  if (errorNode !== undefined) {
    const out: JSONObject = { error: sanitizeErrorNode(errorNode) };
    if ("sequence_number" in root) out.sequence_number = root.sequence_number;
    return stringifyRawJSON(out);
  }
  return stringifyRawJSON(sanitizeErrorNode(root));
}

/** An error whose message is the sanitised text; the original stays reachable as the cause. */
export class ResponsesStreamSanitizedError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ResponsesStreamSanitizedError";
  }
}

/** Normalises status into 400..599 and replaces the error text with the sanitised one (Go: sanitizeResponsesStreamErrorMessage). */
export function sanitizeResponsesStreamErrorMessage(msg: ErrorMessage | undefined): ErrorMessage | undefined {
  if (!msg) return undefined;
  let status = msg.statusCode;
  if (status < 400 || status > 599) status = 500;
  return { statusCode: status, error: new ResponsesStreamSanitizedError(responsesStreamErrorText(msg, status), msg.error), addon: msg.addon };
}

/** A pre-formatted direct body survives; anything else is sanitised (Go: sanitizeResponsesInitialErrorMessage). */
export function sanitizeResponsesInitialErrorMessage(msg: ErrorMessage | undefined): ErrorMessage | undefined {
  if (msg && msg.directBody !== undefined) return msg;
  return sanitizeResponsesStreamErrorMessage(msg);
}

// ---------------------------------------------------------------------------
// Client detection
// ---------------------------------------------------------------------------

/** Official Codex client User-Agents (Go: multiagentv2.IsCodexClientUserAgent). */
export function isCodexClientUserAgent(userAgent: string): boolean {
  const ua = userAgent.trim();
  return ua.startsWith("Codex Desktop/") || ua.startsWith("codex-tui/") || ua === "codex_cli_rs" || ua.startsWith("codex_cli_rs/") || ua.startsWith("codex_exec/");
}

/** Official Codex clients get `response.failed` terminal events instead of `error` (Go: isCodexResponsesClientRequest). */
export function isCodexResponsesClientRequest(headers: Headers): boolean {
  if (isCodexClientUserAgent(headers.get("User-Agent") ?? "")) return true;
  const originator = (headers.get("Originator") ?? "").trim().toLowerCase();
  switch (originator) {
    case "codex desktop":
    case "codex-tui":
    case "codex_cli_rs":
      return true;
    default:
      return originator.startsWith("codex desktop/") || originator.startsWith("codex-tui/") || originator.startsWith("codex_cli_rs/");
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Appends a chunk, completing it to an SSE frame boundary (Go: writeResponsesSSEChunk). */
export function responsesSSEChunkWithBoundary(chunk: string): string {
  if (chunk.length === 0) return "";
  if (chunk.endsWith("\n\n") || chunk.endsWith("\r\n\r\n")) return chunk;
  if (chunk.endsWith("\r\n")) return chunk + "\r\n";
  if (chunk.endsWith("\n")) return chunk + "\n";
  return chunk + "\n\n";
}

function trimLeftSSE(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\r" || s[i] === "\n")) i++;
  return i === 0 ? s : s.slice(i);
}

function trimLeftBlank(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i === 0 ? s : s.slice(i);
}

/** The joined `data:` payload of a frame (Go: responsesSSEDataPayload). */
export function responsesSSEDataPayload(frame: string): { payload: string; found: boolean } {
  const parts: string[] = [];
  let found = false;
  for (let line of frame.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    parts.push(trimmed.slice(5).trim());
    found = true;
  }
  return { payload: parts.join("\n"), found };
}

function frameWithData(frame: string, payload: string): string {
  let out = "";
  for (let line of frame.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("data:")) continue;
    out += line + "\n";
  }
  for (const line of payload.split("\n")) out += "data: " + line + "\n";
  return out + "\n";
}

function recoverJSONFrame(frame: string, syntheticBreaks: number[]): string {
  if (syntheticBreaks.length === 0) return frame;
  const { payload, found } = responsesSSEDataPayload(frame);
  if (found && jsonValid(payload)) return frame;
  // Consider only newlines inserted at chunk boundaries when recovering invalid JSON.
  const positions = syntheticBreaks.filter((pos) => pos >= 0 && pos < frame.length && frame[pos] === "\n");
  const attempt = (candidate: string): string | undefined => {
    const recovered = responsesSSEDataPayload(candidate);
    if (!recovered.found || !jsonValid(recovered.payload)) return undefined;
    return frameWithData(candidate, recovered.payload);
  };
  for (let i = 0; i < positions.length && i < 8; i++) {
    const pos = positions[i]!;
    const recovered = attempt(frame.slice(0, pos) + frame.slice(pos + 1));
    if (recovered !== undefined) return recovered;
  }
  if (positions.length > 1) {
    let candidate = "";
    let start = 0;
    for (const pos of positions) {
      candidate += frame.slice(start, pos);
      start = pos + 1;
    }
    candidate += frame.slice(start);
    const recovered = attempt(candidate);
    if (recovered !== undefined) return recovered;
  }
  return frame;
}

/** Length of the first complete frame (through its blank line), 0 when none (Go: responsesSSEFrameLen). */
export function responsesSSEFrameLen(chunk: string): number {
  if (chunk.length === 0) return 0;
  const lf = chunk.indexOf("\n\n");
  const crlf = chunk.indexOf("\r\n\r\n");
  if (lf < 0) return crlf < 0 ? 0 : crlf + 4;
  if (crlf < 0) return lf + 2;
  return lf < crlf ? lf + 2 : crlf + 4;
}

function hasField(chunk: string, prefix: string): boolean {
  for (const line of chunk.split("\n")) {
    if (line.trim().startsWith(prefix)) return true;
  }
  return false;
}

function needsMoreData(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) return false;
  return hasField(trimmed, "event:") && !hasField(trimmed, "data:");
}

function dataLinesValid(chunk: string): boolean {
  const { payload, found } = responsesSSEDataPayload(chunk);
  if (!found) return true;
  const trimmed = payload.trim();
  return trimmed.length === 0 || trimmed === "[DONE]" || jsonValid(trimmed);
}

function canEmitWithoutDelimiter(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (trimmed.length === 0 || needsMoreData(trimmed) || !hasField(trimmed, "event:") || !hasField(trimmed, "data:")) return false;
  return dataLinesValid(trimmed);
}

/** The field name a chunk starts with: complete when a ':' or line break ends it, partial when the chunk ends first (Go: responsesSSEChunkField). */
function chunkField(chunk: string): { name: string; complete: boolean; partial: boolean } {
  if (chunk.length === 0) return { name: "", complete: false, partial: false };
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i]!;
    if (b === ":" || b === "\n" || b === "\r") return { name: chunk.slice(0, i), complete: true, partial: false };
    if (!/[A-Za-z0-9\-_.]/.test(b)) return { name: "", complete: false, partial: false };
  }
  return { name: "", complete: false, partial: true };
}

function hasEmptyEventData(chunk: string): boolean {
  if (!hasField(chunk, "event:")) return false;
  const { payload, found } = responsesSSEDataPayload(chunk);
  return found && payload.trim().length === 0;
}

function canFlushWithoutDelimiter(chunk: string): boolean {
  const trimmed = chunk.trim();
  return trimmed.length > 0 && hasField(trimmed, "data:") && dataLinesValid(trimmed);
}

function startsNewDataFrame(pending: string, chunk: string): boolean {
  const trimmedPending = pending.trim();
  if (trimmedPending.length === 0 || hasField(trimmedPending, "event:") || !hasField(trimmedPending, "data:") || !dataLinesValid(trimmedPending)) return false;
  return trimLeftSSE(chunk).startsWith("data:");
}

/** The `event:` name of a frame (Go: responsesSSEEventName). */
export function responsesSSEEventName(frame: string): string {
  for (let line of frame.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) return trimmed.slice(6).trim();
  }
  return "";
}

function dataEndsInsideJSONString(chunk: string): boolean {
  const { payload: raw, found } = responsesSSEDataPayload(chunk);
  const payload = raw.trim();
  if (!found || payload.length === 0 || (payload[0] !== "{" && payload[0] !== "[" && payload[0] !== '"')) return false;
  let inString = false;
  let escaped = false;
  for (const b of payload) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && b === "\\") {
      escaped = true;
      continue;
    }
    if (b === '"') inString = !inString;
  }
  return inString;
}

/** Whether a line break must be inserted between `pending` and `chunk` (Go: responsesSSENeedsLineBreak). */
export function responsesSSENeedsLineBreak(pending: string, chunk: string): boolean {
  if (pending.length === 0 || chunk.length === 0) return false;
  if (pending.endsWith("\n") || pending.endsWith("\r")) return false;
  if (chunk[0] === "\n" || chunk[0] === "\r") return false;
  const trimmed = trimLeftBlank(chunk);
  if (trimmed.length === 0) return false;
  for (const prefix of ["data:", "event:", "id:", "retry:", ":"]) {
    if (trimmed.startsWith(prefix)) return !dataEndsInsideJSONString(pending);
  }
  return false;
}

function errorEvent(eventType: string): boolean {
  return eventType === "response.failed" || eventType === "response.error" || eventType === "error";
}

function terminalEventType(eventType: string): boolean {
  switch (eventType) {
    case "response.completed":
    case "response.incomplete":
    case "response.failed":
    case "response.done":
    case "response.error":
    case "error":
      return true;
    default:
      return false;
  }
}

function payloadHasError(root: unknown): boolean {
  for (const path of [["error"], ["response", "error"]]) {
    const v = rawGet(root, path);
    if (v !== undefined && v !== null) return true;
  }
  return isPlainObject(root) && "code" in root && "message" in root;
}

function payloadErrorMessage(payload: string, root: unknown): ErrorMessage {
  let status = 502;
  for (const path of [["status"], ["status_code"], ["error", "status"], ["error", "status_code"], ["response", "error", "status"], ["response", "error", "status_code"]]) {
    const candidate = intOf(rawGet(root, path));
    if (candidate !== undefined && candidate >= 400 && candidate <= 599) {
      status = candidate;
      break;
    }
  }
  return sanitizeResponsesStreamErrorMessage({ statusCode: status, error: new Error(payload) })!;
}

// ---------------------------------------------------------------------------
// Framer
// ---------------------------------------------------------------------------

export interface ResponsesSSEFramerOptions {
  /** "response.failed" for official Codex clients, "error" otherwise. */
  failureEvent?: string;
  isCodexClient?: boolean;
}

/**
 * Re-frames Responses SSE output (Go: responsesSSEFramer). writeChunk and flush
 * return the text to send downstream.
 */
export class ResponsesSSEFramer {
  private pending = "";
  private nextFramePrefix = "";
  private nextFieldSuffix = "";
  private syntheticBreaks: number[] = [];
  private outputItems = new Map<number, unknown>();
  private outputOrder: number[] = [];
  private unindexedOutputItems: unknown[] = [];
  /** Sanitised name of the last event seen (diagnostics). */
  lastEvent = "";
  /** The terminal event written, "" while the stream is open. */
  terminalEvent = "";
  /** The failure carried by an error payload the stream emitted. */
  terminalError: ErrorMessage | undefined;
  failureEvent: string;
  isCodexClient: boolean;
  /** Data frames written so far. */
  dataFrames = 0;
  private out: string[] = [];

  constructor(options: ResponsesSSEFramerOptions = {}) {
    this.failureEvent = options.failureEvent ?? "";
    this.isCodexClient = options.isCodexClient ?? false;
  }

  /** Feeds one chunk; returns the complete frames it released (Go: WriteChunk). */
  writeChunk(chunk: string): string {
    this.out = [];
    this.writeChunkInner(chunk);
    return this.out.join("");
  }

  /** Releases what is pending at the end of the stream (Go: Flush). */
  flush(): string {
    this.out = [];
    this.flushInner();
    return this.out.join("");
  }

  private writeChunkInner(chunk: string): void {
    if (chunk.length === 0 || this.terminalEvent !== "") return;
    if (this.nextFieldSuffix.length > 0) {
      const trimmed = trimLeftSSE(chunk);
      const { complete } = chunkField(trimmed);
      const lastLine = this.nextFramePrefix.slice(this.nextFramePrefix.lastIndexOf("\n") + 1).trim();
      if (complete && lastLine.length > 0 && !lastLine.startsWith("data:")) {
        this.nextFramePrefix += this.nextFieldSuffix;
        this.nextFieldSuffix = "";
      } else {
        this.nextFieldSuffix += chunk;
        if (chunkField(trimLeftSSE(this.nextFieldSuffix)).partial) return;
        chunk = this.nextFieldSuffix;
        this.nextFieldSuffix = "";
      }
    }
    if (this.nextFramePrefix.length > 0) {
      const { payload, found } = responsesSSEDataPayload(this.nextFramePrefix);
      if (found && jsonValid(payload) && payloadTypeOf(payload) === "" && !hasField(this.nextFramePrefix, "event:") && responsesSSEFrameLen(this.nextFramePrefix) === 0) {
        const trimmed = trimLeftSSE(chunk);
        const field = chunkField(trimmed);
        let complete = field.complete;
        const lastLine = this.nextFramePrefix.slice(this.nextFramePrefix.lastIndexOf("\n") + 1).trim();
        const lastPartial = chunkField(lastLine).partial;
        if (complete && lastPartial) {
          const joined = chunkField(lastLine + trimmed);
          if (joined.complete && (isStandardField(joined.name) || (field.name !== "" && !isStandardField(field.name)))) complete = false;
        }
        let newFieldPrefix = lastLine.startsWith("data:");
        for (const prefix of ["event:", "data:", "id:", "retry:"]) newFieldPrefix = newFieldPrefix || (trimmed.length < prefix.length && prefix.startsWith(trimmed));
        if (field.partial && newFieldPrefix) {
          this.nextFieldSuffix += chunk;
          return;
        }
        if (complete && !this.nextFramePrefix.endsWith("\n") && !this.nextFramePrefix.endsWith("\r") && chunk[0] !== "\n" && chunk[0] !== "\r") this.nextFramePrefix += "\n";
      }
      this.nextFramePrefix += chunk;
      chunk = this.nextFramePrefix;
      this.nextFramePrefix = "";
    }
    if (hasEmptyEventData(this.pending)) {
      const trimmed = trimLeftSSE(chunk);
      const field = chunkField(trimmed);
      if (field.partial) {
        this.nextFramePrefix += chunk;
        return;
      }
      let newFrame = field.complete && field.name !== "data";
      if (field.complete && field.name === "data") {
        const { payload } = responsesSSEDataPayload(trimmed);
        const valid = jsonValid(payload);
        if (!valid && payload !== "[DONE]" && responsesSSEFrameLen(trimmed) === 0) {
          this.nextFramePrefix += chunk;
          return;
        }
        const hasEvent = hasField(trimmed, "event:");
        if (valid && hasEvent && responsesSSEEventName(trimmed) === "" && responsesSSEFrameLen(trimmed) === 0) {
          this.nextFramePrefix += chunk;
          return;
        }
        newFrame = payload === "[DONE]" || (valid && (payloadTypeOf(payload) !== "" || hasEvent));
        if (valid && !newFrame && responsesSSEFrameLen(trimmed) === 0) {
          this.nextFramePrefix += chunk;
          return;
        }
      }
      if (newFrame) {
        this.writeFrame(this.pending);
        this.pending = "";
        this.syntheticBreaks = [];
        if (this.terminalEvent !== "") return;
      }
    }
    if (startsNewDataFrame(this.pending, chunk)) {
      this.writeFrame(this.pending);
      this.pending = "";
      this.syntheticBreaks = [];
      if (this.terminalEvent !== "") return;
    }
    this.appendChunk(chunk);
    for (;;) {
      const frameLen = responsesSSEFrameLen(this.pending);
      if (frameLen === 0) break;
      this.writeFrame(this.pending.slice(0, frameLen));
      this.pending = this.pending.slice(frameLen);
      this.syntheticBreaks = this.syntheticBreaks.filter((pos) => pos >= frameLen).map((pos) => pos - frameLen);
      if (this.terminalEvent !== "") {
        this.pending = "";
        return;
      }
    }
    if (this.pending.trim().length === 0) {
      this.pending = "";
      this.syntheticBreaks = [];
      return;
    }
    if (this.pending.length === 0 || hasEmptyEventData(this.pending) || !canEmitWithoutDelimiter(this.pending)) return;
    this.writeFrame(this.pending);
    this.pending = "";
    this.syntheticBreaks = [];
  }

  private flushInner(): void {
    if (this.nextFieldSuffix.length > 0) {
      if (responsesSSENeedsLineBreak(this.nextFramePrefix, this.nextFieldSuffix)) this.nextFramePrefix += "\n";
      this.nextFramePrefix += this.nextFieldSuffix;
      this.nextFieldSuffix = "";
    }
    if (this.nextFramePrefix.length > 0) {
      const trimmed = trimLeftSSE(this.nextFramePrefix);
      if (chunkField(trimmed).partial && !"data".startsWith(trimmed)) {
        this.writeFrame(this.pending);
        this.pending = "";
        this.syntheticBreaks = [];
      }
      this.appendChunk(this.nextFramePrefix);
      this.nextFramePrefix = "";
    }
    if (this.pending.length === 0 || this.terminalEvent !== "") return;
    if (this.pending.trim().length === 0) {
      this.pending = "";
      return;
    }
    const frame = recoverJSONFrame(this.pending, this.syntheticBreaks);
    if (!canFlushWithoutDelimiter(frame)) {
      this.pending = "";
      return;
    }
    this.writeFrame(frame);
    this.pending = "";
    this.syntheticBreaks = [];
  }

  private appendChunk(chunk: string): void {
    if (responsesSSENeedsLineBreak(this.pending, chunk)) {
      this.syntheticBreaks.push(this.pending.length);
      this.pending += "\n";
    }
    this.pending += chunk;
  }

  private writeFrame(frame: string): void {
    const repaired = this.repairFrame(recoverJSONFrame(frame, this.syntheticBreaks));
    if (repaired.length > 0) this.out.push(responsesSSEChunkWithBoundary(repaired));
  }

  private shouldFilterPrivateEvent(streamEvent: string, payloadType: string): boolean {
    const check = (raw: string): boolean => {
      const name = raw.trim();
      if (name === "" || errorEvent(name)) return false;
      // Always filter internal websocket timing telemetry and subscription usage.
      if (name.startsWith("responsesapi.") || name === "response.subscription_usage") return true;
      // Official Codex clients keep codex.response.metadata but not the rate limits.
      if (this.isCodexClient) return name === "codex.rate_limits";
      // Standard clients: private codex.* events and the backend's moderation metadata.
      return name.startsWith("codex.") || name === "response.metadata";
    };
    return check(streamEvent) || check(payloadType);
  }

  private repairFrame(frame: string): string {
    const { payload, found } = responsesSSEDataPayload(frame);
    const streamEvent = responsesSSEEventName(frame);
    if (streamEvent !== "" && this.shouldFilterPrivateEvent(streamEvent, "")) return "";
    if (!found || payload.length === 0) return frame;
    if (payload === "[DONE]") {
      this.dataFrames++;
      return frame;
    }
    const payloadType = payloadTypeOf(payload);
    if (this.shouldFilterPrivateEvent(streamEvent, payloadType)) return "";
    const root = tryParseRaw(payload);
    if (root === undefined) return frame;

    this.dataFrames++;

    if (errorEvent(payloadType) || payloadHasError(root)) {
      if (payloadType !== "") this.lastEvent = sanitizeResponsesStreamEventName(payloadType);
      return this.repairErrorPayload(payload, root);
    }
    let eventType = payloadType;
    if (terminalEventType(streamEvent)) eventType = streamEvent;
    else if (eventType === "") eventType = streamEvent;
    if (eventType !== "") this.lastEvent = sanitizeResponsesStreamEventName(eventType);
    if (errorEvent(eventType)) return this.repairErrorPayload(payload, root);
    if (terminalEventType(eventType)) this.terminalEvent = eventType;

    switch (eventType) {
      case "response.output_item.done":
        this.recordOutputItem(root);
        break;
      case "response.completed": {
        const repaired = this.repairCompletedPayload(root);
        if (repaired !== undefined) return frameWithData(frame, stringifyRawJSON(repaired));
        break;
      }
    }
    return frame;
  }

  private repairErrorPayload(payload: string, root: unknown): string {
    const errMsg = payloadErrorMessage(payload, root);
    const status = errMsg.statusCode;
    this.terminalError = errMsg;
    const isResponseFailed = scalarString(rawGet(root, ["type"])) === "response.failed";
    const failureEvent = isResponseFailed || this.failureEvent === "response.failed" ? "response.failed" : "error";
    this.terminalEvent = failureEvent;
    const errText = responsesStreamErrorText(errMsg, status);
    let seq = 0;
    const own = isPlainObject(root) && "sequence_number" in root ? intOf(root.sequence_number) : undefined;
    const fromText = sequenceFromTextAny(errText);
    if (own !== undefined) seq = own;
    else if (fromText !== undefined) seq = fromText;
    else if (this.dataFrames > 0) seq = this.dataFrames - 1;

    if (failureEvent === "response.failed") {
      let chunk = buildOpenAIResponsesStreamFailedChunk(status, errText, seq);
      const response = rawGet(root, ["response"]);
      if (isResponseFailed && isPlainObject(response)) {
        const repaired = (this.repairCompletedPayload(root) ?? root) as JSONObject;
        const resp = { ...(repaired.response as JSONObject) };
        resp.status = "failed";
        const sanitizedError = rawGet(parseRawJSON(chunk), ["response", "error"]);
        if (sanitizedError !== undefined) resp.error = sanitizedError;
        chunk = stringifyRawJSON({ type: "response.failed", sequence_number: seq, response: resp });
      }
      return `event: response.failed\ndata: ${chunk}\n\n`;
    }
    return `event: error\ndata: ${buildOpenAIResponsesStreamErrorChunk(status, errText, seq)}\n\n`;
  }

  private recordOutputItem(root: unknown): void {
    const item = rawGet(root, ["item"]);
    if (!isPlainObject(item) || scalarString(item.type) === "") return;
    const outputIndex = rawGet(root, ["output_index"]);
    if (outputIndex !== undefined && outputIndex !== null) {
      const index = intOf(outputIndex) ?? 0;
      if (!this.outputItems.has(index)) this.outputOrder.push(index);
      this.outputItems.set(index, item);
      return;
    }
    this.unindexedOutputItems.push(item);
  }

  /** The payload with response.output rebuilt from the done items, or undefined when nothing changes. */
  private repairCompletedPayload(root: unknown): unknown {
    if (this.outputOrder.length === 0 && this.unindexedOutputItems.length === 0) return undefined;
    const output = rawGet(root, ["response", "output"]);
    if (output !== undefined && (!Array.isArray(output) || output.length > 0)) return undefined;
    if (!isPlainObject(root)) return undefined;
    const items: unknown[] = [];
    for (const index of [...this.outputOrder].sort((a, b) => a - b)) {
      if (this.outputItems.has(index)) items.push(this.outputItems.get(index));
    }
    items.push(...this.unindexedOutputItems);
    const response = isPlainObject(root.response) ? { ...root.response } : {};
    response.output = items;
    return { ...root, response };
  }
}

function isStandardField(name: string): boolean {
  return name === "event" || name === "data" || name === "id" || name === "retry";
}

function sequenceFromTextAny(text: string): number | undefined {
  const parsed = tryParseRaw(text.trim());
  if (!isPlainObject(parsed) || !("sequence_number" in parsed)) return undefined;
  return intOf(parsed.sequence_number);
}

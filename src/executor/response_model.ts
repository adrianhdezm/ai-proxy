// Upstream response-model observation shared by every executor. Port of
// internal/runtime/executor/helps/response_model.go (extractResponseModelEvent,
// IsModelSubstituted), the response-model half of helps.UsageReporter
// (ObserveResponseModel, SetResponseModel, ResponseModel, IsResponseModelFinal,
// warnModelSubstitution) and helps/stream_response_model_observer.go.
//
// Upstream kept the observed model on the usage reporter. This port records
// usage at the HTTP layer, so ResponseModelReporter carries only the
// response-model state: executors feed it the raw upstream frames and call
// publish() once per attempt, which emits the substitution warning.
import { log } from "../log.ts";
import { parseSuffix } from "../thinking/index.ts";

/** Defensive bound on an upstream-controlled string reaching logs (Go: maxResponseModelLength). */
export const maxResponseModelLength = 128;

type JSONObject = Record<string, unknown>;

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** The JSON object text of a raw frame or SSE data line, or "" (Go: helps.JSONPayload). */
export function responseJSONPayload(line: string): string {
  let trimmed = line.trim();
  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return "";
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice("data:".length).trim();
  if (trimmed === "" || trimmed[0] !== "{") return "";
  return trimmed;
}

function parse(data: string): JSONObject | undefined {
  try {
    const v = JSON.parse(data) as unknown;
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function at(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (isObject(cur)) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** gjson .String() of a scalar ("" for missing/null). */
function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** A string model value within the length bound, trimmed; undefined otherwise. */
function modelString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return byteLength(s) <= maxResponseModelLength ? s : undefined;
}

export interface ResponseModelEvent {
  model: string;
  terminal: boolean;
}

/**
 * Returns the model an upstream reports serving, read from a raw JSON frame or
 * an SSE line, and whether the event terminates the response
 * (Go: extractResponseModelEvent).
 */
export function extractResponseModelEvent(payload: string, provider: string): ResponseModelEvent {
  const data = responseJSONPayload(payload);
  if (data === "") return { model: "", terminal: false };
  switch (provider.trim().toLowerCase()) {
    case "codex":
      return extractCodexResponseModelEvent(payload);
    case "claude":
      return extractClaudeResponseModelEvent(data);
    case "gemini":
    case "gemini-cli":
    case "gemini-interactions":
    case "vertex":
    case "aistudio":
    case "antigravity":
      return extractGeminiResponseModelEvent(data);
    default:
      return extractGenericResponseModelEvent(data);
  }
}

/** Go: extractClaudeResponseModelEvent. */
export function extractClaudeResponseModelEvent(data: string): ResponseModelEvent {
  const root = parse(data);
  const type = str(at(root, "type"));
  switch (type) {
    case "message_start":
      return { model: modelString(at(root, "message.model")) ?? "", terminal: false };
    case "message_stop":
      return { model: "", terminal: true };
    case "message":
      return { model: modelString(at(root, "model")) ?? "", terminal: true };
    default: {
      if (!root) return { model: "", terminal: false };
      const nested = at(root, "message.model");
      if (typeof nested === "string") return { model: modelString(nested) ?? "", terminal: false };
      return { model: modelString(at(root, "model")) ?? "", terminal: false };
    }
  }
}

function isInteractionsTerminal(eventType: string, status: string): boolean {
  switch (eventType) {
    case "interaction.completed":
    case "interaction.done":
    case "interaction.failed":
    case "interaction.cancelled":
      return true;
  }
  switch (status) {
    case "completed":
    case "incomplete":
    case "cancelled":
    case "failed":
      return true;
  }
  return false;
}

function eventTypeOf(root: unknown): string {
  const eventType = str(at(root, "event_type"));
  return eventType !== "" ? eventType : str(at(root, "type"));
}

/** Go: extractGeminiResponseModelEvent (Gemini, Gemini CLI, AI Studio). */
export function extractGeminiResponseModelEvent(data: string): ResponseModelEvent {
  const root = parse(data);
  if (!root) return { model: "", terminal: false };
  let m: unknown = undefined;
  for (const path of ["response.modelVersion", "modelVersion", "interaction.model", "model"]) {
    m = at(root, path);
    if (typeof m === "string") break;
  }
  const served = modelString(m) ?? "";
  let cand = at(root, "candidates.0.finishReason");
  if (cand === undefined) cand = at(root, "response.candidates.0.finishReason");
  let terminal = cand !== undefined && str(cand) !== "";
  if (!terminal) terminal = str(at(root, "object")) === "chat.completion" || str(at(root, "choices.0.finish_reason")) !== "";
  if (!terminal) terminal = isInteractionsTerminal(eventTypeOf(root), str(at(root, "interaction.status")));
  return { model: served, terminal };
}

/** Go: extractGenericResponseModelEvent (OpenAI chat completions and Responses shapes). */
export function extractGenericResponseModelEvent(data: string): ResponseModelEvent {
  const root = parse(data);
  if (!root) return { model: "", terminal: false };
  let served = modelString(at(root, "response.model"));
  if (served !== undefined) {
    const type = str(at(root, "type"));
    return { model: served, terminal: type === "response.completed" || type === "response.done" || type === "response.incomplete" };
  }
  served = modelString(at(root, "interaction.model"));
  if (served !== undefined) return { model: served, terminal: isInteractionsTerminal(eventTypeOf(root), str(at(root, "interaction.status"))) };
  served = modelString(at(root, "modelVersion"));
  if (served !== undefined) {
    const cand = at(root, "candidates.0.finishReason");
    return { model: served, terminal: cand !== undefined && str(cand) !== "" };
  }
  served = modelString(at(root, "response.modelVersion"));
  if (served !== undefined) {
    const cand = at(root, "response.candidates.0.finishReason");
    return { model: served, terminal: cand !== undefined && str(cand) !== "" };
  }
  served = modelString(at(root, "message.model"));
  if (served !== undefined) return { model: served, terminal: false };
  served = modelString(at(root, "model"));
  if (served !== undefined) {
    const status = str(at(root, "status"));
    const terminal = str(at(root, "object")) === "chat.completion" || str(at(root, "choices.0.finish_reason")) !== "" || status === "completed" || status === "incomplete";
    return { model: served, terminal };
  }
  const eventType = eventTypeOf(root);
  if (isInteractionsTerminal(eventType, str(at(root, "interaction.status"))) || eventType === "message_stop") return { model: "", terminal: true };
  return { model: "", terminal: false };
}

/** Whether a codex event embeds the authoritative response object, and whether it is terminal (Go: codexResponseModelEventKind). */
function codexResponseModelEventKind(eventType: string): { carriesModel: boolean; terminal: boolean } {
  switch (eventType.trim()) {
    case "response.created":
    case "response.in_progress":
      return { carriesModel: true, terminal: false };
    case "response.completed":
    case "response.incomplete":
    case "response.done":
      return { carriesModel: true, terminal: true };
    default:
      return { carriesModel: false, terminal: false };
  }
}

/** Go: extractCodexResponseModelEvent. */
export function extractCodexResponseModelEvent(payload: string): ResponseModelEvent {
  const data = responseJSONPayload(payload);
  if (data === "") return { model: "", terminal: false };
  const root = parse(data);
  if (!root) return { model: "", terminal: false };
  const kind = codexResponseModelEventKind(str(at(root, "type")));
  if (!kind.carriesModel) return { model: "", terminal: false };
  const m = at(root, "response.model");
  if (typeof m !== "string") return { model: "", terminal: kind.terminal };
  const model = m.trim();
  if (byteLength(model) > maxResponseModelLength) return { model: "", terminal: kind.terminal };
  return { model, terminal: kind.terminal };
}

/** Lower-cases a model id and drops its thinking suffix (Go: normalizeModelName). */
function normalizeModelName(model: string): string {
  return parseSuffix(model.trim().toLowerCase()).modelName.trim();
}

function stripModelProviderPrefix(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 && idx < model.length - 1 ? model.slice(idx + 1) : model;
}

function isModelDigits(value: string): boolean {
  return value !== "" && /^[0-9]+$/.test(value);
}

function isModelDateSuffix(suffix: string): boolean {
  if (suffix.length === "YYYY-MM-DD".length) {
    if (suffix[4] !== "-" || suffix[7] !== "-") return false;
    return isModelDigits(suffix.slice(0, 4)) && isModelDigits(suffix.slice(5, 7)) && isModelDigits(suffix.slice(8));
  }
  if (suffix.length === "YYYYMMDD".length) return isModelDigits(suffix);
  return false;
}

function isDatedModelAlias(base: string, dated: string): boolean {
  const prefix = base + "-";
  if (!dated.startsWith(prefix)) return false;
  const suffix = dated.slice(prefix.length);
  return isModelDateSuffix(suffix) || (suffix.length === 3 && isModelDigits(suffix));
}

function sameOrDated(a: string, b: string): boolean {
  return a === b || isDatedModelAlias(a, b) || isDatedModelAlias(b, a);
}

/**
 * Whether the upstream served a model other than the requested one; dated
 * aliases, snapshot pins, provider prefixes and "-latest" are accepted
 * (Go: IsModelSubstituted).
 */
export function isModelSubstituted(requested: string, served: string): boolean {
  const servedModel = normalizeModelName(served);
  if (servedModel === "") return false;
  const requestedModel = normalizeModelName(requested);
  if (requestedModel === "") return false;
  if (sameOrDated(requestedModel, servedModel)) return false;
  const cleanReq = stripModelProviderPrefix(requestedModel);
  const cleanSrv = stripModelProviderPrefix(servedModel);
  if (sameOrDated(cleanReq, cleanSrv)) return false;
  const reqNoLatest = cleanReq.endsWith("-latest") ? cleanReq.slice(0, -"-latest".length) : cleanReq;
  const srvNoLatest = cleanSrv.endsWith("-latest") ? cleanSrv.slice(0, -"-latest".length) : cleanSrv;
  return !sameOrDated(reqNoLatest, srvNoLatest);
}

export interface ResponseModelReporterOptions {
  /** Executor identifier ("claude", "codex", "gemini", "aistudio", "openai", ...). */
  provider: string;
  /** The model the client requested (usage accounting keeps this one). */
  model: string;
  /** Credential index for the warning; never the file name or account. */
  authIndex?: string;
  /** Warning sink (defaults to log.warn). */
  warn?: (message: string) => void;
}

/**
 * Per-attempt response-model state (the response-model half of Go's
 * UsageReporter). publish() emits the substitution warning at most once.
 */
export class ResponseModelReporter {
  readonly provider: string;
  readonly model: string;
  private readonly authIndex: string;
  private readonly warn: (message: string) => void;
  private served = "";
  private final = false;
  private upstreamModel = "";
  private published = false;

  constructor(opts: ResponseModelReporterOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.authIndex = (opts.authIndex ?? "").trim();
    this.warn = opts.warn ?? ((message) => log.warn(message));
  }

  /** Stores the model reported by an upstream frame; payloads without one are ignored (Go: ObserveResponseModel). */
  observeResponseModel(payload: string): void {
    if (this.final) return;
    const { model, terminal } = extractResponseModelEvent(payload, this.provider);
    if (model !== "") this.served = model;
    if (terminal) this.final = true;
  }

  /** Sets the reported model directly when valid and not yet final (Go: SetResponseModel). */
  setResponseModel(model: string): void {
    if (this.final) return;
    const m = model.trim();
    if (m === "" || byteLength(m) > maxResponseModelLength) return;
    this.served = m;
  }

  /** The upstream model expected to be served when it differs from the requested one (Go: SetUpstreamModel). */
  setUpstreamModel(model: string): void {
    this.upstreamModel = model.trim();
  }

  responseModel(): string {
    return this.served;
  }

  isResponseModelFinal(): boolean {
    return this.final;
  }

  /** Ends the attempt: warns once about a silent model swap (Go: Publish -> warnModelSubstitution). */
  publish(): void {
    if (this.published) return;
    this.published = true;
    const served = this.served;
    const expected = this.upstreamModel !== "" ? this.upstreamModel : this.model;
    if (served === "" || !isModelSubstituted(expected, served)) return;
    if (this.model !== "" && !isModelSubstituted(this.model, served)) return;
    const provider = this.provider.trim() !== "" ? this.provider.trim() : "unknown";
    const authIndex = this.authIndex !== "" ? this.authIndex : "nil";
    this.warn(`${provider} executor: upstream served model ${JSON.stringify(served)} for requested model ${JSON.stringify(this.model)} (auth_index=${authIndex})`);
  }
}

export const defaultMaxStreamModelBufferBound = 64 * 1024;
export const defaultMaxLinesPerStreamEvent = 2048;
const streamEventLineOverhead = 32;

/**
 * Feeds arbitrary network chunks to a ResponseModelReporter: complete lines are
 * observed directly and multi-line SSE data events are joined, with bounded
 * buffers (Go: StreamResponseModelObserver).
 */
export class StreamResponseModelObserver {
  private buf = "";
  /** Pending data lines of the current SSE event. */
  frame: string[] = [];
  private frameBytes = 0;
  private overflow = false;
  private eventOverflow = false;

  constructor(
    private readonly reporter: ResponseModelReporter,
    private readonly maxBound = defaultMaxStreamModelBufferBound,
  ) {}

  private bound(): number {
    return this.maxBound > 0 ? this.maxBound : defaultMaxStreamModelBufferBound;
  }

  private dropFrame(): void {
    if (this.frame.length > 0) {
      this.eventOverflow = true;
      this.frame = [];
      this.frameBytes = 0;
    }
  }

  feed(chunk: string): void {
    if (chunk === "") return;
    if (this.reporter.isResponseModelFinal()) {
      this.buf = "";
      this.frame = [];
      return;
    }
    while (chunk.length > 0) {
      if (this.overflow) {
        const idx = chunk.indexOf("\n");
        if (idx < 0) return;
        chunk = chunk.slice(idx + 1);
        this.overflow = false;
        this.buf = "";
        continue;
      }
      const idx = chunk.indexOf("\n");
      if (idx < 0) {
        if (this.buf.length + chunk.length > this.bound()) {
          this.overflow = true;
          this.buf = "";
          this.dropFrame();
        } else {
          this.buf += chunk;
        }
        return;
      }
      const linePart = chunk.slice(0, idx);
      chunk = chunk.slice(idx + 1);
      if (this.buf.length + linePart.length > this.bound()) {
        this.buf = "";
        this.dropFrame();
        continue;
      }
      let line = this.buf + linePart;
      this.buf = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
      if (this.reporter.isResponseModelFinal()) {
        this.buf = "";
        this.frame = [];
        return;
      }
    }
  }

  /** Flushes a pending line or event at the end of the stream. */
  finish(): void {
    if (!this.overflow && this.buf.length > 0) {
      let line = this.buf;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
      this.buf = "";
    }
    this.flushEvent();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") {
      this.flushEvent();
      return;
    }
    if (this.eventOverflow) return;
    this.reporter.observeResponseModel(line);
    if (trimmed.startsWith("data:")) {
      let data = trimmed.slice("data:".length);
      if (data.startsWith(" ")) data = data.slice(1);
      const lineCost = data.length + streamEventLineOverhead;
      if (this.frameBytes + lineCost > this.bound() || this.frame.length >= defaultMaxLinesPerStreamEvent) {
        this.eventOverflow = true;
        this.frame = [];
        this.frameBytes = 0;
        return;
      }
      this.frame.push(data);
      this.frameBytes += lineCost;
    }
  }

  private flushEvent(): void {
    if (this.eventOverflow) {
      this.eventOverflow = false;
      this.frame = [];
      this.frameBytes = 0;
      return;
    }
    if (this.frame.length === 0) return;
    if (this.frame.length > 1) this.reporter.observeResponseModel(this.frame.join("\n"));
    this.frame = [];
    this.frameBytes = 0;
  }
}

/** A reporter for one executor attempt, labelled by the credential's label (Go: NewExecutorUsageReporter). */
export function newResponseModelReporter(provider: string, model: string, auth?: { label?: string }): ResponseModelReporter {
  return new ResponseModelReporter({ provider, model, authIndex: auth?.label });
}

/** Re-yields a translated stream and publishes the reporter when the stream ends, however it ends. */
export async function* publishResponseModelAfter<T>(chunks: AsyncIterable<T>, reporter: ResponseModelReporter): AsyncGenerator<T> {
  try {
    yield* chunks;
  } finally {
    reporter.publish();
  }
}

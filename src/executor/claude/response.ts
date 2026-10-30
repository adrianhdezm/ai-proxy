// Response handling for the Claude upstream: body decoding, model restore, usage
// parsing and SSE terminal-event observation. Port of helps/response_decode.go,
// restoreClaudeResponseModel (claude_executor.go), ParseClaudeUsage
// (helps/usage_helpers.go), observeClaudeSSEEvent / claudeMessageIDFromSSE
// (claude_executor_diagnostics.go) and validateClaudeStreamingResponse
// (claude_executor_stream.go).
import zlib from "node:zlib";
import type { Transform } from "node:stream";
import { getAt, gint, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { StatusError } from "../types.ts";
import { claudeStreamErrorStatus } from "./errors.ts";

/** Content-Encoding value(s) joined like Go's header.Values join (Go: claudeResponseContentEncoding). */
export function claudeResponseContentEncoding(headers: Headers): string {
  return headers.get("Content-Encoding") ?? "";
}

/** Wraps a node:zlib transform as a Web TransformStream. */
function zlibTransform(make: () => Transform): TransformStream<Uint8Array, Uint8Array> {
  let z: Transform;
  let failure: unknown;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      z = make();
      z.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      z.on("error", (err) => {
        failure = err;
        try {
          controller.error(err);
        } catch {
          // already errored
        }
      });
    },
    transform(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure);
        z.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    flush() {
      return new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure);
        z.once("end", () => resolve());
        z.once("error", reject);
        z.end();
      });
    },
  });
}

/**
 * A transform that buffers the first bytes until `select` can pick a decoder
 * (or passthrough with `null`); `undefined` asks for more bytes.
 */
function lazyDecoder(select: (prefix: Uint8Array, eof: boolean) => Transform | null | undefined): TransformStream<Uint8Array, Uint8Array> {
  let buffered: Uint8Array[] = [];
  let inner: TransformStream<Uint8Array, Uint8Array> | null | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let pump: Promise<void> | undefined;
  const concat = (): Uint8Array => {
    const total = buffered.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of buffered) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  };
  const start = (controller: TransformStreamDefaultController<Uint8Array>, decoder: Transform | null): Promise<void> => {
    const prefix = concat();
    buffered = [];
    if (decoder === null) {
      inner = null;
      if (prefix.byteLength > 0) controller.enqueue(prefix);
      return Promise.resolve();
    }
    inner = zlibTransform(() => decoder);
    writer = inner.writable.getWriter();
    const reader = inner.readable.getReader();
    pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
    })();
    pump.catch(() => {});
    return prefix.byteLength > 0 ? writer.write(prefix) : Promise.resolve();
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (inner === null) {
        controller.enqueue(chunk);
        return;
      }
      if (inner) {
        await writer!.write(chunk);
        return;
      }
      buffered.push(chunk);
      const decision = select(concat(), false);
      if (decision === undefined) return;
      await start(controller, decision);
    },
    async flush(controller) {
      if (inner === undefined) {
        const decision = select(concat(), true);
        await start(controller, decision === undefined ? null : decision);
      }
      if (inner) {
        await writer!.close();
        await pump;
      }
    },
  });
}

function isZlibHeader(h: Uint8Array): boolean {
  if (h.length < 2) return false;
  const cmf = h[0]!;
  const flg = h[1]!;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/**
 * Decodes declared encodings in reverse order, or sniffs gzip/zstd magic bytes
 * when no Content-Encoding is present (Go: DecodeResponseBody). Throws
 * synchronously for an unsupported encoding; decoder failures surface while reading.
 */
export function decodeResponseBody(body: ReadableStream<Uint8Array> | null, contentEncoding: string): ReadableStream<Uint8Array> {
  if (body === null) throw new Error("response body is nil");
  if (contentEncoding.trim() === "") {
    return body.pipeThrough(
      lazyDecoder((prefix, eof) => {
        if (prefix.length === 0) return eof ? null : undefined;
        const first = prefix[0];
        if (first !== 0x1f && first !== 0x28) return null;
        if (first === 0x1f) {
          if (prefix.length < 2) return eof ? null : undefined;
          return prefix[1] === 0x8b ? zlib.createGunzip() : null;
        }
        if (prefix.length < 4) return eof ? null : undefined;
        return prefix[1] === 0xb5 && prefix[2] === 0x2f && prefix[3] === 0xfd ? zlib.createZstdDecompress() : null;
      }),
    );
  }
  const encodings = contentEncoding.split(",");
  const stages: Array<TransformStream<Uint8Array, Uint8Array>> = [];
  for (let i = encodings.length - 1; i >= 0; i--) {
    const encoding = encodings[i]!.trim().toLowerCase();
    switch (encoding) {
      case "":
      case "identity":
        continue;
      case "gzip":
        stages.push(zlibTransform(() => zlib.createGunzip()));
        break;
      case "deflate":
        stages.push(lazyDecoder((prefix, eof) => (prefix.length < 2 && !eof ? undefined : isZlibHeader(prefix) ? zlib.createInflate() : zlib.createInflateRaw())));
        break;
      case "br":
        stages.push(zlibTransform(() => zlib.createBrotliDecompress()));
        break;
      case "zstd":
        stages.push(zlibTransform(() => zlib.createZstdDecompress()));
        break;
      default:
        throw new Error(`unsupported content encoding "${encoding}"`);
    }
  }
  let stream = body;
  for (const stage of stages) stream = stream.pipeThrough(stage);
  return stream;
}

/** Reads a whole stream into a string. */
export async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** Decodes and reads a response body in one step. */
export function readDecodedBody(res: Response): Promise<string> {
  return readAllText(decodeResponseBody(res.body, claudeResponseContentEncoding(res.headers)));
}

function setClaudeResponseModel(payload: string, model: string): { payload: string; changed: boolean } {
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root)) return { payload, changed: false };
  let changed = false;
  if (root.model !== undefined) {
    root.model = model;
    changed = true;
  }
  if (isObj(root.message) && root.message.model !== undefined) {
    root.message.model = model;
    changed = true;
  }
  return changed ? { payload: JSON.stringify(root), changed } : { payload, changed };
}

/** Writes the requested model back into a JSON body or an SSE data line (Go: restoreClaudeResponseModel). */
export function restoreClaudeResponseModel(payload: string, model: string): string {
  const direct = setClaudeResponseModel(payload, model);
  if (direct.changed) return direct.payload;
  const trimmed = payload.trimStart();
  if (!trimmed.startsWith("data:")) return payload;
  const dataIndex = payload.indexOf("data:");
  const rawJSON = payload.slice(dataIndex + "data:".length).trim();
  const updated = setClaudeResponseModel(rawJSON, model);
  if (!updated.changed) return payload;
  return payload.slice(0, dataIndex) + "data: " + updated.payload;
}

/** Token usage of a Claude response (Go: usage.Detail fields used by the Claude parser). */
export interface ClaudeUsageDetail {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  /** usage.speed ("fast" or "standard") when reported. */
  responseServiceTier?: string;
}

function parseClaudeUsageNode(usageNode: unknown): ClaudeUsageDetail {
  const cacheRead = gint(getAt(usageNode, "cache_read_input_tokens"));
  const cacheCreation = gint(getAt(usageNode, "cache_creation_input_tokens"));
  const output = gint(getAt(usageNode, "output_tokens"));
  let reasoning = 0;
  for (const path of ["output_tokens_details.thinking_tokens", "output_tokens_details.reasoning_tokens", "thinking_tokens"]) {
    const v = getAt(usageNode, path);
    if (v !== undefined) {
      reasoning = gint(v);
      break;
    }
  }
  if (reasoning < 0) reasoning = 0;
  const detail: ClaudeUsageDetail = {
    inputTokens: gint(getAt(usageNode, "input_tokens")),
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cacheRead,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens: 0,
  };
  const speed = gstr(getAt(usageNode, "speed")).trim();
  if (speed !== "") detail.responseServiceTier = speed;
  if (detail.cachedTokens === 0) detail.cachedTokens = detail.cacheCreationTokens;
  detail.totalTokens = detail.inputTokens + output + detail.cacheReadTokens + detail.cacheCreationTokens;
  return detail;
}

/** Usage of a non-stream Claude response (Go: ParseClaudeUsage). */
export function parseClaudeUsage(data: string): ClaudeUsageDetail {
  const usageNode = getAt(tryParse(data), "usage");
  if (usageNode === undefined) return parseClaudeUsageNode({});
  return parseClaudeUsageNode(usageNode);
}

/** Usage carried by one SSE data payload, if any (Go: ParseClaudeStreamUsage). */
export function parseClaudeStreamUsage(line: string): ClaudeUsageDetail | undefined {
  const payload = jsonPayload(line);
  if (payload === "") return undefined;
  const root = tryParse(payload);
  if (root === undefined) return undefined;
  let usageNode = getAt(root, "usage");
  if (usageNode === undefined) usageNode = getAt(root, "message.usage");
  if (usageNode === undefined) return undefined;
  return parseClaudeUsageNode(usageNode);
}

function jsonPayload(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("data:")) return trimmed.slice("data:".length).trim();
  return trimmed.startsWith("{") ? trimmed : "";
}

/** Mutable terminal-state tracker for one upstream SSE stream. */
export interface ClaudeStreamState {
  messageID: string;
  completed: boolean;
  streamErr?: StatusError;
}

export function newClaudeStreamState(): ClaudeStreamState {
  return { messageID: "", completed: false };
}

function observeClaudeStreamJSONPayload(payload: string, hasDataPrefix: boolean, state: ClaudeStreamState): void {
  const root = tryParse(payload);
  switch (gstr(getAt(root, "type"))) {
    case "message_start": {
      const id = gstr(getAt(root, "message.id")).trim();
      if (id !== "") state.messageID = id;
      break;
    }
    case "message_stop":
      state.completed = true;
      break;
    case "message":
      if (!hasDataPrefix && gstr(getAt(root, "stop_reason")).trim() !== "") {
        const id = gstr(getAt(root, "id")).trim();
        if (id !== "") state.messageID = id;
        state.completed = true;
      }
      break;
  }
}

/**
 * Observes one complete SSE event block (Go: observeClaudeSSEEvent): records the
 * message id, completion (message_stop) and an `error` event, whose payload is
 * mapped to the matching HTTP status.
 */
export function observeClaudeSSEEvent(rawEvent: string, state: ClaudeStreamState): void {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload !== "") dataLines.push(payload);
  }
  if (dataLines.length === 0) {
    const trimmed = rawEvent.trim();
    if (trimmed.startsWith("{") && tryParse(trimmed) !== undefined) observeClaudeStreamJSONPayload(trimmed, false, state);
    return;
  }
  const joined = dataLines.join("\n").trim();
  const root = tryParse(joined);
  if (root === undefined) return;
  observeClaudeStreamJSONPayload(joined, true, state);
  if (!state.streamErr && gstr(getAt(root, "type")) === "error") {
    const errorType = gstr(getAt(root, "error.type"));
    state.streamErr = new StatusError(claudeStreamErrorStatus(errorType), joined, { body: joined });
  }
}

/** The message id of a complete SSE stream, "" when it did not reach message_stop (Go: claudeMessageIDFromSSE). */
export function claudeMessageIDFromSSE(data: string): string {
  const state = newClaudeStreamState();
  let event = "";
  for (const line of data.split("\n")) {
    event += line + "\n";
    if (line.trim() === "") {
      observeClaudeSSEEvent(event, state);
      event = "";
    }
  }
  if (event.length > 0) observeClaudeSSEEvent(event, state);
  return state.completed ? state.messageID : "";
}

export function claudeMessageIDFromResponse(data: string): string {
  return gstr(getAt(tryParse(data), "id")).trim();
}

/** Validates a buffered upstream SSE response before translation (Go: validateClaudeStreamingResponse). */
export function validateClaudeStreamingResponse(data: string): void {
  let hasData = false;
  let hasMessageStart = false;
  let hasMessageDelta = false;
  for (const rawLine of data.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || !line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    hasData = true;
    const root = tryParse(payload);
    if (root === undefined) throw new StatusError(502, "claude executor: upstream returned malformed stream data");
    switch (gstr(getAt(root, "type"))) {
      case "error": {
        let message = gstr(getAt(root, "error.message")).trim();
        if (message === "") message = gstr(getAt(root, "error.type")).trim();
        if (message === "") message = "unknown upstream error";
        throw new StatusError(502, "claude executor: upstream returned error event: " + message);
      }
      case "message_start":
        if (gstr(getAt(root, "message.id")).trim() === "" || gstr(getAt(root, "message.model")).trim() === "") {
          throw new StatusError(502, "claude executor: upstream stream message_start is missing id or model");
        }
        hasMessageStart = true;
        break;
      case "message_delta":
        hasMessageDelta = true;
        break;
    }
  }
  if (!hasData) throw new StatusError(502, "claude executor: upstream returned empty stream response");
  if (!hasMessageStart) throw new StatusError(502, "claude executor: upstream stream response is missing message_start");
  if (!hasMessageDelta) throw new StatusError(502, "claude executor: upstream stream response ended before message completion");
}

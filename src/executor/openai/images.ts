// OpenAI image endpoints for OpenAI API-key credentials. Port of the images
// half of internal/runtime/executor/openai_compat_executor.go (executeImages,
// executeImagesStream, openAICompatImageEndpointPath,
// prepareOpenAICompatImagesPayload, rewriteOpenAICompatImagesMultipartPayload).
//
// Requests arrive in the "openai-image" source format with the inbound path in
// the request_path metadata. JSON bodies get their model and stream flag
// rewritten; multipart bodies (image edits) are re-encoded with the model and
// stream fields first. The upstream answer (JSON or SSE) is passed through
// verbatim to `<base_url>/images/generations` or `/images/edits`.
//
// Multipart payloads travel through ExecRequest.payload (a string by contract)
// as a binary string: one char per byte (latin1). bytesToBinaryString /
// binaryStringToBytes convert losslessly at the HTTP edges.
//
// Not ported: payload-config media rules (ApplyMediaPayloadConfig), usage
// reporting and request logging.
import type { Auth } from "../../auth/types.ts";
import { parseSuffix } from "../../thinking/index.ts";
import { applyCustomHeadersFromAttrs } from "../../util/header_helpers.ts";
import { isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";
import { RequestPathMetadataKey, StatusError, type ExecOptions, type ExecRequest, type ExecResponse, type StreamResult } from "../types.ts";
import { newOpenAICompatStatusError } from "./errors.ts";

/** Source format of the /v1/images/* handlers (Go: openAICompatImageHandlerType / codexOpenAIImageSourceFormat). */
export const FormatOpenAIImage = "openai-image";
export const ImagesGenerationsPath = "/v1/images/generations";
export const ImagesEditsPath = "/v1/images/edits";
export const openAICompatImagesGenerationsPath = "/images/generations";
export const openAICompatImagesEditsPath = "/images/edits";

/** Injectable fetch (same shape as the executors' FetchLike). */
export type ImagesFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Binary payload helpers
// ---------------------------------------------------------------------------

/** Encodes bytes as a binary (latin1) string: one char per byte. */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + step)));
  }
  return out;
}

/** Decodes a binary (latin1) string back to bytes. */
export function binaryStringToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** The inbound request path recorded by the handler (Go: helps.PayloadRequestPath). */
export function payloadRequestPath(opts: ExecOptions): string {
  const raw = opts.metadata?.[RequestPathMetadataKey];
  return typeof raw === "string" ? raw.trim() : "";
}

/** Whether a body is a JSON document (Go: json.Valid). */
export function isJSONPayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (trimmed === "") return false;
  return tryParse(trimmed) !== undefined;
}

/** Media type and boundary of a Content-Type value (Go: mime.ParseMediaType). */
export function parseMultipartContentType(contentType: string): { mediaType: string; boundary: string } | undefined {
  const parts = contentType.split(";");
  const mediaType = (parts[0] ?? "").trim().toLowerCase();
  if (mediaType === "") return undefined;
  let boundary = "";
  for (const param of parts.slice(1)) {
    const idx = param.indexOf("=");
    if (idx < 0) continue;
    if (param.slice(0, idx).trim().toLowerCase() !== "boundary") continue;
    boundary = param.slice(idx + 1).trim();
    if (boundary.startsWith('"') && boundary.endsWith('"') && boundary.length >= 2) boundary = boundary.slice(1, -1);
  }
  return { mediaType, boundary };
}

/** An uploaded file of a multipart form (Go: multipart.FileHeader). */
export interface UploadedFile {
  /** The part's filename. */
  readonly name: string;
  /** The part's Content-Type header ("" when absent). */
  readonly type: string;
  readonly data: Uint8Array;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MultipartValue = string | UploadedFile;

/**
 * A parsed multipart/form-data body in part order. Text fields are parts
 * without a filename (Go: multipart.Form Value vs File). A small parser of our
 * own is used because Bun's FormData replaces a file part's Content-Type with
 * one guessed from the filename extension.
 */
export class MultipartForm {
  constructor(readonly parts: ReadonlyArray<{ name: string; value: MultipartValue }>) {}

  get(key: string): MultipartValue | null {
    return this.parts.find((part) => part.name === key)?.value ?? null;
  }

  getAll(key: string): MultipartValue[] {
    return this.parts.filter((part) => part.name === key).map((part) => part.value);
  }

  *entries(): IterableIterator<[string, MultipartValue]> {
    for (const part of this.parts) yield [part.name, part.value];
  }
}

/** Narrows a form entry to an uploaded file. */
export function isUploadedFile(value: unknown): value is UploadedFile {
  return typeof value === "object" && value !== null && (value as UploadedFile).data instanceof Uint8Array;
}

/** The uploaded files of a form field. */
export function uploadedFiles(form: MultipartForm, key: string): UploadedFile[] {
  return form.getAll(key).filter(isUploadedFile);
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parameters of a header value such as `form-data; name="a"; filename="b.png"` (Go: mime.ParseMediaType params). */
export function parseHeaderParams(value: string): { value: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const semi = value.indexOf(";");
  const head = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase();
  let rest = semi < 0 ? "" : value.slice(semi + 1);
  for (;;) {
    rest = rest.replace(/^[\s;]+/, "");
    if (rest === "") break;
    const eq = rest.indexOf("=");
    if (eq < 0) break;
    const key = rest.slice(0, eq).trim().toLowerCase();
    rest = rest.slice(eq + 1).trimStart();
    let val = "";
    if (rest.startsWith('"')) {
      let i = 1;
      for (; i < rest.length; i++) {
        const ch = rest[i]!;
        if (ch === "\\" && i + 1 < rest.length) {
          val += rest[++i];
          continue;
        }
        if (ch === '"') break;
        val += ch;
      }
      rest = rest.slice(i + 1);
    } else {
      const end = rest.indexOf(";");
      val = (end < 0 ? rest : rest.slice(0, end)).trim();
      rest = end < 0 ? "" : rest.slice(end);
    }
    if (key !== "") params[key] = val;
  }
  return { value: head, params };
}

/** Parses multipart/form-data bytes (Go: multipart.Reader.ReadForm). */
export function parseMultipartBytes(bytes: Uint8Array, boundary: string): MultipartForm {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const delimiter = encoder.encode("--" + boundary);
  const nextDelimiter = encoder.encode("\r\n--" + boundary);
  const headerEnd = encoder.encode("\r\n\r\n");
  const parts: Array<{ name: string; value: MultipartValue }> = [];
  let pos = indexOfBytes(bytes, delimiter, 0);
  if (pos < 0) throw new Error("multipart: NextPart: EOF");
  pos += delimiter.length;
  for (;;) {
    if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break; // closing "--"
    // Skip transport padding and the CRLF after the delimiter.
    while (pos < bytes.length && (bytes[pos] === 0x20 || bytes[pos] === 0x09)) pos++;
    if (bytes[pos] === 0x0d && bytes[pos + 1] === 0x0a) pos += 2;
    else if (bytes[pos] === 0x0a) pos += 1;
    else throw new Error("multipart: malformed part delimiter");
    const headersEndAt = indexOfBytes(bytes, headerEnd, pos);
    if (headersEndAt < 0) throw new Error("multipart: malformed part headers");
    const headers = new Map<string, string>();
    for (const line of decoder.decode(bytes.subarray(pos, headersEndAt)).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const bodyStart = headersEndAt + headerEnd.length;
    const bodyEnd = indexOfBytes(bytes, nextDelimiter, bodyStart);
    if (bodyEnd < 0) throw new Error("multipart: NextPart: EOF");
    const data = bytes.slice(bodyStart, bodyEnd);
    const disposition = parseHeaderParams(headers.get("content-disposition") ?? "");
    const name = disposition.params.name ?? "";
    if (name !== "") {
      if (disposition.params.filename !== undefined) {
        const file: UploadedFile = {
          name: disposition.params.filename,
          type: headers.get("content-type") ?? "",
          data,
          arrayBuffer: async () => data.slice().buffer as ArrayBuffer,
        };
        parts.push({ name, value: file });
      } else {
        parts.push({ name, value: decoder.decode(data) });
      }
    }
    pos = bodyEnd + nextDelimiter.length;
  }
  return new MultipartForm(parts);
}

/** A multipart form parsed from raw bytes and its Content-Type. */
export async function parseMultipartForm(bytes: Uint8Array, contentType: string): Promise<MultipartForm> {
  const media = parseMultipartContentType(contentType);
  if (!media || !media.mediaType.startsWith("multipart/")) throw new StatusError(400, "request Content-Type isn't multipart/form-data", { requestScoped: true });
  if (media.boundary === "") throw new StatusError(400, "no multipart boundary param in Content-Type", { requestScoped: true });
  try {
    return parseMultipartBytes(bytes, media.boundary);
  } catch (err) {
    throw new StatusError(400, `read multipart form failed: ${err instanceof Error ? err.message : String(err)}`, { requestScoped: true });
  }
}

/** Go: multipart escapeQuotes. */
function escapeQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Serialises parts as multipart/form-data (Go: multipart.Writer WriteField / CreatePart). */
export function encodeMultipart(parts: ReadonlyArray<{ name: string; value: MultipartValue }>, boundary = randomBoundary()): { bytes: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(part.name)}"`;
    if (isUploadedFile(part.value)) {
      head += `; filename="${escapeQuotes(part.value.name)}"\r\nContent-Type: ${part.value.type.trim() !== "" ? part.value.type : "application/octet-stream"}`;
      chunks.push(encoder.encode(head + "\r\n\r\n"), part.value.data, encoder.encode("\r\n"));
    } else {
      chunks.push(encoder.encode(head + "\r\n\r\n" + part.value + "\r\n"));
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

function randomBoundary(): string {
  const random = new Uint8Array(30);
  crypto.getRandomValues(random);
  return Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuilds a multipart image form: model and (when streaming) stream=true
 * first, then every other text field, then the files with their original
 * names and content types (application/octet-stream when missing)
 * (Go: rewriteOpenAICompatImagesMultipartPayload / buildOpenAICompatImagesMultipartRequest).
 */
export function rewriteOpenAICompatImagesMultipartForm(form: MultipartForm, model: string, stream: boolean): { bytes: Uint8Array; contentType: string } {
  const out: Array<{ name: string; value: MultipartValue }> = [];
  if (model !== "") out.push({ name: "model", value: model });
  if (stream) out.push({ name: "stream", value: "true" });
  const files: Array<{ name: string; value: UploadedFile }> = [];
  for (const [key, value] of form.entries()) {
    if (isUploadedFile(value)) {
      files.push({ name: key, value });
      continue;
    }
    if (key === "model" || key === "stream") continue;
    out.push({ name: key, value });
  }
  return encodeMultipart([...out, ...files]);
}

export interface PreparedImagesPayload {
  /** JSON text, or multipart bytes as a binary string. */
  body: string;
  /** True when `body` is a binary string (multipart). */
  binary: boolean;
  contentType: string;
}

/**
 * Normalises an image request for an OpenAI-compatible upstream: JSON gets the
 * model and the stream flag (dropped for non-streaming), multipart is
 * re-encoded, anything else passes through (Go: prepareOpenAICompatImagesPayload).
 */
export async function prepareOpenAICompatImagesPayload(payload: string, model: string, contentType: string, stream: boolean): Promise<PreparedImagesPayload> {
  model = model.trim();
  contentType = contentType.trim();
  if (isJSONPayload(payload)) {
    const root = tryParse(payload);
    if (isObj(root)) {
      let changed = false;
      if (model !== "" && root.model !== model) {
        root.model = model;
        changed = true;
      }
      if (stream) {
        if (root.stream !== true) {
          root.stream = true;
          changed = true;
        }
      } else if ("stream" in root) {
        delete root.stream;
        changed = true;
      }
      return { body: changed ? JSON.stringify(root) : payload, binary: false, contentType: "application/json" };
    }
    return { body: payload, binary: false, contentType: "application/json" };
  }
  const media = parseMultipartContentType(contentType);
  if (!media || !media.mediaType.startsWith("multipart/")) return { body: payload, binary: true, contentType };
  if (media.boundary === "") throw new StatusError(400, "multipart boundary is missing", { requestScoped: true });
  const form = await parseMultipartForm(binaryStringToBytes(payload), contentType);
  const rewritten = rewriteOpenAICompatImagesMultipartForm(form, model, stream);
  return { body: bytesToBinaryString(rewritten.bytes), binary: true, contentType: rewritten.contentType };
}

/** The upstream path for an image request, "" when the request is not one (Go: openAICompatImageEndpointPath). */
export function openAICompatImageEndpointPath(opts: ExecOptions): string {
  if (opts.sourceFormat !== FormatOpenAIImage) return "";
  const path = payloadRequestPath(opts);
  if (path.endsWith("/images/edits")) return openAICompatImagesEditsPath;
  if (path.endsWith("/images/generations")) return openAICompatImagesGenerationsPath;
  return openAICompatImagesGenerationsPath;
}

/** The request body for fetch: binary strings go out as bytes. */
export function requestBodyOf(prepared: PreparedImagesPayload): string | Uint8Array {
  return prepared.binary ? binaryStringToBytes(prepared.body) : prepared.body;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** What the OpenAI executor lends the image path. */
export interface OpenAIImagesContext {
  identifier: string;
  fetch: ImagesFetchLike;
  now: () => number;
  /** Global proxy URL ("" for direct). */
  proxyUrl?: string;
  /** Resolves base URL and API key of the credential. */
  credentials(auth: Auth): { baseURL: string; apiKey: string };
  /** Sets the default User-Agent unless the client sent one. */
  ensureUserAgent(target: Headers, clientHeaders: Headers | undefined): void;
}

async function sendImages(ctx: OpenAIImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions, endpointPath: string, stream: boolean): Promise<Response> {
  const baseModel = parseSuffix(req.model).modelName;
  const { baseURL, apiKey } = ctx.credentials(auth);
  if (baseURL === "") throw new StatusError(401, "missing provider baseURL");
  const prepared = await prepareOpenAICompatImagesPayload(req.payload, baseModel, opts.headers?.get("Content-Type") ?? "", stream);
  const contentType = prepared.contentType !== "" ? prepared.contentType : "application/json";

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  if (stream) {
    headers.set("Accept", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
  }
  if (apiKey !== "") headers.set("Authorization", "Bearer " + apiKey);
  ctx.ensureUserAgent(headers, opts.headers);
  applyCustomHeadersFromAttrs(headers, auth.attributes, { clientHeaders: opts.headers });

  const url = baseURL.replace(/\/+$/, "") + endpointPath;
  const init: RequestInit & { proxy?: string } = { method: "POST", headers, body: requestBodyOf(prepared), signal: opts.signal };
  const proxy = (opts.proxyUrl ?? auth.proxyUrl ?? ctx.proxyUrl ?? "").trim();
  if (proxy !== "") init.proxy = proxy;
  return ctx.fetch(url, init);
}

/** Non-streaming image request; the upstream JSON is returned verbatim (Go: executeImages). */
export async function executeOpenAICompatImages(ctx: OpenAIImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions, endpointPath: string): Promise<ExecResponse> {
  const resp = await sendImages(ctx, auth, req, opts, endpointPath, false);
  const body = await resp.text();
  if (resp.status < 200 || resp.status >= 300) {
    log.debug(`${ctx.identifier} executor: images request error`, { status: resp.status });
    throw newOpenAICompatStatusError(resp.status, resp.headers, body, ctx.now());
  }
  return { payload: body, headers: resp.headers };
}

/** Streaming image request; the upstream bytes are forwarded as they arrive (Go: executeImagesStream). */
export async function executeOpenAICompatImagesStream(ctx: OpenAIImagesContext, auth: Auth, req: ExecRequest, opts: ExecOptions, endpointPath: string): Promise<StreamResult> {
  const resp = await sendImages(ctx, auth, req, opts, endpointPath, true);
  if (resp.status < 200 || resp.status >= 300) {
    const body = await resp.text();
    log.debug(`${ctx.identifier} executor: images stream request error`, { status: resp.status });
    throw newOpenAICompatStatusError(resp.status, resp.headers, body, ctx.now());
  }
  return { headers: resp.headers, chunks: rawTextChunks(resp, opts.signal) };
}

/** Yields the response body as decoded text chunks; a transport failure ends it with a 502. */
export async function* rawTextChunks(resp: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const body = resp.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let done = false;
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (err) {
        if (signal?.aborted) return;
        throw new StatusError(502, "upstream stream read error: " + (err instanceof Error ? err.message : String(err)), { cause: err });
      }
      if (result.done) {
        done = true;
        const tail = decoder.decode();
        if (tail !== "") yield tail;
        return;
      }
      const text = decoder.decode(result.value, { stream: true });
      if (text !== "") yield text;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!done) reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

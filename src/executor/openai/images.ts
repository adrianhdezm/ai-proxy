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

/** A multipart form parsed from raw bytes (Bun's multipart parser behind Response.formData). */
export async function parseMultipartForm(bytes: Uint8Array, contentType: string): Promise<FormData> {
  try {
    return await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
  } catch (err) {
    throw new StatusError(400, `read multipart form failed: ${err instanceof Error ? err.message : String(err)}`, { requestScoped: true });
  }
}

/** Serialises a FormData into multipart bytes plus its Content-Type (Go: multipart.Writer). */
export async function encodeMultipartForm(form: FormData): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = new Response(form);
  const contentType = response.headers.get("Content-Type") ?? "multipart/form-data";
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
}

function isFileEntry(value: FormDataEntryValue): value is File {
  return typeof value !== "string";
}

/**
 * Rebuilds a multipart image form: model and (when streaming) stream=true
 * first, then every other text field, then the files with their original
 * names and content types (application/octet-stream when missing)
 * (Go: rewriteOpenAICompatImagesMultipartPayload / buildOpenAICompatImagesMultipartRequest).
 */
export async function rewriteOpenAICompatImagesMultipartForm(form: FormData, model: string, stream: boolean): Promise<{ bytes: Uint8Array; contentType: string }> {
  const out = new FormData();
  if (model !== "") out.append("model", model);
  if (stream) out.append("stream", "true");
  const files: Array<[string, File]> = [];
  for (const [key, value] of form.entries()) {
    if (isFileEntry(value)) {
      files.push([key, value]);
      continue;
    }
    if (key === "model" || key === "stream") continue;
    out.append(key, value);
  }
  for (const [key, file] of files) {
    const type = file.type.trim() !== "" ? file.type : "application/octet-stream";
    const blob = new Blob([await file.arrayBuffer()], { type });
    out.append(key, blob, file.name || "file");
  }
  return encodeMultipartForm(out);
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
  const rewritten = await rewriteOpenAICompatImagesMultipartForm(form, model, stream);
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

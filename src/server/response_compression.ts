// Negotiated downstream response compression. Port of internal/api/response_compression.go
// (responseCompressionMiddleware, negotiateResponseCompression, responseCompressionWriter.decide,
// appendCompressionVary) on Response objects instead of a gin writer.
//
// - zstd is preferred over gzip on a quality tie; quality 0 excludes an encoding, and a
//   refused identity (identity;q=0 or *;q=0 without identity) compresses even small bodies.
// - Server-sent event streams are compressed incrementally: every upstream chunk is flushed
//   so each event is decodable as soon as it is written.
// - Other bodies are held back until min-bytes (default 1024) is reached; a smaller body is
//   sent as is with its Content-Length.
// - Vary gains exactly one Accept-Encoding token on every response once the feature is on,
//   except websocket upgrades.
//
// Encoders are node:zlib streams (zstd and gzip are Bun built-ins); the Go encoder pools are
// a Go allocation concern and are not reproduced.
import { createGzip, createZstdCompress } from "node:zlib";
import type { Transform } from "node:stream";

export interface ResponseCompressionOptions {
  /** Defaults to true (upstream response-compression.enabled). */
  enabled?: boolean;
  /** Minimum non-streaming body size to compress; 0 or negative means 1024 (upstream min-bytes). */
  minBytes?: number;
}

export type ResponseEncoding = "zstd" | "gzip";

export const DefaultResponseCompressionMinBytes = 1024;

export function responseCompressionEnabled(options: ResponseCompressionOptions | undefined): boolean {
  return options?.enabled !== false;
}

export function effectiveResponseCompressionMinBytes(options: ResponseCompressionOptions | undefined): number {
  const min = Math.trunc(options?.minBytes ?? 0);
  return min > 0 ? min : DefaultResponseCompressionMinBytes;
}

/**
 * Picks the encoding by quality with server preference (zstd, gzip) on ties, and reports
 * whether identity is allowed, wildcard exclusions included (Go: negotiateResponseCompression).
 */
export function negotiateResponseCompression(header: string): { encoding: ResponseEncoding | ""; identityAllowed: boolean } {
  const qualities = new Map<string, number>();
  for (const token of header.split(",")) {
    const parts = token.split(";");
    const name = parts[0]!.trim().toLowerCase();
    let quality = 1;
    for (const parameter of parts.slice(1)) {
      const eq = parameter.indexOf("=");
      if (eq === -1 || parameter.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const raw = parameter.slice(eq + 1).trim();
      const parsed = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
      quality = parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    qualities.set(name, quality);
  }
  const identity = qualities.get("identity");
  const wildcard = qualities.get("*");
  const identityAllowed = (identity !== undefined && identity > 0) || (identity === undefined && (wildcard === undefined || wildcard > 0));
  let selected: ResponseEncoding | "" = "";
  let highest = 0;
  for (const encoding of ["zstd", "gzip"] as const) {
    const quality = qualities.get(encoding) ?? wildcard ?? 0;
    if (quality > highest) {
      selected = encoding;
      highest = quality;
    }
  }
  return { encoding: selected, identityAllowed };
}

/** Adds one Accept-Encoding token to Vary, deduplicating case-insensitively (Go: appendCompressionVary). */
export function appendCompressionVary(headers: Headers): void {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of (headers.get("Vary") ?? "").split(",")) {
    const trimmed = token.trim();
    const key = trimmed.toLowerCase();
    if (trimmed !== "" && !seen.has(key)) {
      tokens.push(trimmed);
      seen.add(key);
    }
  }
  if (!seen.has("accept-encoding")) tokens.push("Accept-Encoding");
  headers.set("Vary", tokens.join(", "));
}

function isCompressibleMediaType(contentType: string | null): boolean {
  const mediaType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json")) ||
    mediaType === "application/javascript" ||
    mediaType === "image/svg+xml"
  );
}

function isWebsocketUpgrade(request: Request): boolean {
  return (request.headers.get("Upgrade") ?? "").trim().toLowerCase() === "websocket";
}

/**
 * Applies negotiated compression to a handler response (Go: responseCompressionMiddleware).
 * Returns the response unchanged when the feature is off or for websocket upgrades.
 */
export async function compressResponse(request: Request, response: Response, options: ResponseCompressionOptions | undefined): Promise<Response> {
  if (!responseCompressionEnabled(options) || isWebsocketUpgrade(request)) return response;
  const headers = new Headers(response.headers);
  appendCompressionVary(headers);
  const rebuilt = (body: ReadableStream<Uint8Array> | Uint8Array | null) => new Response(body, { status: response.status, statusText: response.statusText, headers });

  const { encoding, identityAllowed } = negotiateResponseCompression(request.headers.get("Accept-Encoding") ?? "");
  const status = response.status;
  if (
    encoding === "" ||
    request.method.toUpperCase() === "HEAD" ||
    response.body === null ||
    status < 200 ||
    status === 204 ||
    status === 304 ||
    status === 206 ||
    headers.has("Content-Encoding") ||
    !isCompressibleMediaType(headers.get("Content-Type"))
  ) {
    return rebuilt(response.body);
  }

  const minBytes = identityAllowed ? effectiveResponseCompressionMinBytes(options) : 0;
  const streaming = (headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() === "text/event-stream";
  if (!streaming) {
    const declared = Number(headers.get("Content-Length") ?? "");
    if (headers.has("Content-Length") && Number.isFinite(declared) && declared >= 0 && declared < minBytes) return rebuilt(response.body);
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const buffered: Uint8Array[] = [];
  if (!streaming) {
    let size = 0;
    while (size < minBytes) {
      const next = await reader.read();
      if (next.done) return rebuilt(concat(buffered, size));
      buffered.push(next.value);
      size += next.value.byteLength;
    }
  }
  headers.delete("Content-Length");
  headers.set("Content-Encoding", encoding);
  return rebuilt(compressedStream(encoding, buffered, reader));
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One encoder; each write is flushed so its bytes are decodable on arrival. */
class ChunkEncoder {
  private readonly encoder: Transform;
  private output: Buffer[] = [];
  private failure: Error | undefined;
  private readonly ended: Promise<void>;

  constructor(encoding: ResponseEncoding) {
    this.encoder = encoding === "zstd" ? (createZstdCompress() as unknown as Transform) : createGzip();
    this.encoder.on("data", (chunk: Buffer) => this.output.push(chunk));
    this.ended = new Promise<void>((resolve) => {
      this.encoder.on("end", () => resolve());
      this.encoder.on("error", (err: Error) => {
        this.failure = err;
        resolve();
      });
    });
  }

  private take(): Uint8Array {
    if (this.failure) throw this.failure;
    const out = Buffer.concat(this.output);
    this.output = [];
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }

  async write(chunk: Uint8Array): Promise<Uint8Array> {
    this.encoder.write(chunk);
    await new Promise<void>((resolve) => (this.encoder as unknown as { flush(cb: () => void): void }).flush(resolve));
    return this.take();
  }

  async end(): Promise<Uint8Array> {
    this.encoder.end();
    await this.ended;
    return this.take();
  }

  destroy(): void {
    this.encoder.destroy();
  }
}

function compressedStream(encoding: ResponseEncoding, prefix: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new ChunkEncoder(encoding);
  const pending = [...prefix];
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const chunk = pending.shift() ?? (await nextChunk(reader));
          if (chunk === undefined) {
            finished = true;
            const tail = await encoder.end();
            if (tail.byteLength > 0) controller.enqueue(tail);
            controller.close();
            return;
          }
          if (chunk.byteLength === 0) continue;
          const out = await encoder.write(chunk);
          if (out.byteLength > 0) {
            controller.enqueue(out);
            return;
          }
        }
      } catch (err) {
        finished = true;
        encoder.destroy();
        void reader.cancel(err).catch(() => {});
        controller.error(err);
      }
    },
    async cancel(reason) {
      if (!finished) encoder.destroy();
      finished = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}

async function nextChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array | undefined> {
  const next = await reader.read();
  return next.done ? undefined : next.value;
}

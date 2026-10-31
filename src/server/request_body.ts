// Inbound request body reading with the configured size limit and Content-Encoding
// decoding. Port of maxRequestBodyBytesMiddleware (internal/api/server_middleware.go:
// a declared Content-Length over the limit is refused without reading, a chunked body
// is read at most one byte past the limit) and ReadRequestBody / decodeRequestBody /
// decodeZstdRequestBody (sdk/api/handlers/request_body.go: zstd bodies are decoded with
// the decoded size bounded by the same limit; an undecodable body that is valid JSON is
// passed through as is).

export type BodyReadResult = { bytes: Uint8Array } | { tooLarge: true } | { error: string };

export interface ReadBodyOptions {
  /** Decode Content-Encoding (zstd, identity) before returning (Go: ReadRequestBody callers). */
  decodeContentEncoding?: boolean;
}

/** Reads the request body enforcing `maxBytes` (0 or negative disables the limit). */
export async function readBoundedRequestBody(request: Request, maxBytes: number, options: ReadBodyOptions = {}): Promise<BodyReadResult> {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : 0;
  if (limit > 0) {
    const declared = Number(request.headers.get("Content-Length") ?? "");
    if (request.headers.has("Content-Length") && Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  }
  let raw: Uint8Array;
  try {
    const read = await readStream(request.body, limit);
    if (read === "too_large") return { tooLarge: true };
    raw = read;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!options.decodeContentEncoding) return { bytes: raw };
  const encoding = (request.headers.get("Content-Encoding") ?? "").trim();
  if (encoding === "" || encoding.toLowerCase() === "identity") return { bytes: raw };
  const decoded = await decodeRequestBody(raw, encoding, limit);
  if (decoded === "too_large") return { tooLarge: true };
  if (typeof decoded === "string") {
    if (isValidJSON(raw)) return { bytes: raw };
    return { error: decoded };
  }
  return { bytes: decoded };
}

/** Reads a stream to the end, stopping one chunk past `limit` (0 = unbounded). */
async function readStream(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | "too_large"> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
    if (limit > 0 && size > limit) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Decodes a Content-Encoding list from last to first; returns an error message on failure. */
async function decodeRequestBody(raw: Uint8Array, encoding: string, limit: number): Promise<Uint8Array | "too_large" | string> {
  const parts = encoding.split(",");
  let body: Uint8Array = raw;
  for (let i = parts.length - 1; i >= 0; i--) {
    const enc = parts[i]!.trim().toLowerCase();
    if (enc === "" || enc === "identity") continue;
    if (enc !== "zstd") return `unsupported request content encoding: ${enc}`;
    try {
      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("zstd" as ConstructorParameters<typeof DecompressionStream>[0]));
      const decoded = await readStream(stream, limit);
      if (decoded === "too_large") return "too_large";
      body = decoded;
    } catch (err) {
      return `failed to decode zstd request body: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return body;
}

function isValidJSON(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

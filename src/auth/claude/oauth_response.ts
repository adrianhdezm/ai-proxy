// Content-Encoding handling for the Claude OAuth control plane. Port of
// internal/auth/claude/oauth_response.go. The native client advertises
// "gzip, compress, deflate, br"; Anthropic may stack encodings, so the
// Content-Encoding list is decoded from last to first. Requests are issued
// with `decompress: false` so this decoder sees the wire bytes.

async function pump(bytes: Uint8Array, format: Bun.CompressionFormat): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeClaudeOAuthEncoding(encoded: Uint8Array, encoding: string): Promise<Uint8Array> {
  try {
    switch (encoding) {
      case "gzip":
        return await pump(encoded, "gzip");
      case "deflate":
        try {
          return await pump(encoded, "deflate");
        } catch {
          return await pump(encoded, "deflate-raw");
        }
      case "br":
        return await pump(encoded, "brotli");
      case "compress":
        // LZW "compress" has no built-in decoder in Bun; Anthropic never sends it.
        throw new Error("decode Claude OAuth response: unsupported content encoding \"compress\"");
      default:
        throw new Error(`decode Claude OAuth response: unsupported content encoding "${encoding}"`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("decode Claude OAuth")) throw err;
    throw new Error(`decode Claude OAuth ${encoding} response: ${msg}`);
  }
}

/** Decodes every advertised Content-Encoding (comma separated and/or repeated headers). */
export async function decodeClaudeOAuthBody(raw: Uint8Array, contentEncoding: string | string[] | null | undefined): Promise<Uint8Array> {
  const header = Array.isArray(contentEncoding) ? contentEncoding.join(",") : (contentEncoding ?? "");
  const encodings = header.split(",");
  let data = raw;
  for (let i = encodings.length - 1; i >= 0; i--) {
    const encoding = encodings[i]!.trim().toLowerCase();
    if (encoding === "" || encoding === "identity") continue;
    data = await decodeClaudeOAuthEncoding(data, encoding);
  }
  return data;
}

/** Reads and decodes a response obtained with `decompress: false`. */
export async function readClaudeOAuthResponseBody(resp: Response): Promise<string> {
  if (!resp.body && resp.status !== 204) {
    const text = await resp.text().catch(() => "");
    return text;
  }
  const raw = new Uint8Array(await resp.arrayBuffer());
  const headerValues = typeof (resp.headers as Headers & { getAll?: (n: string) => string[] }).getAll === "function"
    ? (resp.headers as Headers & { getAll: (n: string) => string[] }).getAll("content-encoding")
    : resp.headers.get("content-encoding");
  const decoded = await decodeClaudeOAuthBody(raw, headerValues);
  return new TextDecoder().decode(decoded);
}

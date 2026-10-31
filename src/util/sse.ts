// Server-Sent Events helpers shared by executors (reading upstream streams)
// and the HTTP server (writing downstream streams).

export interface SSEEvent {
  /** Value of the `event:` field, "" when absent. */
  event: string;
  /** Joined `data:` lines (joined with "\n"). */
  data: string;
  /** Raw lines of the event block, without the trailing blank line. */
  raw: string;
}

/**
 * Incrementally parses an SSE byte/text stream into events. Feed chunks with
 * push(); each complete event block (terminated by a blank line) is returned.
 * flush() returns a trailing block that was not newline-terminated.
 */
export class SSEParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: string | Uint8Array): SSEEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const events: SSEEvent[] = [];
    for (;;) {
      const idx = findBlockEnd(this.buffer);
      if (!idx) break;
      const block = this.buffer.slice(0, idx.start);
      this.buffer = this.buffer.slice(idx.end);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush(): SSEEvent[] {
    const rest = this.buffer + this.decoder.decode();
    this.buffer = "";
    if (rest.trim() === "") return [];
    const ev = parseBlock(rest.replace(/\r?\n$/, ""));
    return ev ? [ev] : [];
  }

  /** Unparsed bytes still buffered (useful for diagnostics). */
  pending(): string {
    return this.buffer;
  }
}

function findBlockEnd(buf: string): { start: number; end: number } | undefined {
  // A block ends at the first blank line: "\n\n", "\r\n\r\n" or "\r\r".
  const re = /\r\n\r\n|\n\n|\r\r/g;
  const m = re.exec(buf);
  if (!m) return undefined;
  return { start: m.index, end: m.index + m[0].length };
}

function parseBlock(block: string): SSEEvent | undefined {
  const lines = block.split(/\r\n|\n|\r/);
  let event = "";
  const data: string[] = [];
  let sawField = false;
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value;
      sawField = true;
    } else if (field === "data") {
      data.push(value);
      sawField = true;
    }
    // id / retry are ignored.
  }
  if (!sawField) return undefined;
  return { event, data: data.join("\n"), raw: block };
}

/** Async iteration over the SSE events of a fetch Response body. */
export async function* iterateSSE(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  if (!body) return;
  const reader = body.getReader();
  const parser = new SSEParser();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(value)) yield ev;
    }
    for (const ev of parser.flush()) yield ev;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Formats one downstream SSE frame. */
export function formatSSE(event: string | undefined, data: string): string {
  return (event ? `event: ${event}\n` : "") + `data: ${data}\n\n`;
}

/** Splits a translated fragment that may contain several frames into frames. */
export function splitSSEFrames(text: string): string[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f !== "")
    .map((f) => f + "\n\n");
}

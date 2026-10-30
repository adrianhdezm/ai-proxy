// Port of internal/runtime/executor/helps/codex_sse_scanner.go.
//
// Reads an upstream Responses SSE stream line by line (as bufio.Scanner does:
// split on "\n", a trailing "\r" dropped, an unterminated last line delivered at
// EOF) but delivers an event whose data the upstream split across several
// "data:" lines as one "data:" line. A data line that is complete JSON on its
// own, or cannot start JSON at all (an empty value, [DONE]), is delivered as
// read. A data line that opens a JSON object or array without completing it
// starts an event that collects the following data lines until their joined
// value closes its outermost object or array, a blank line ends the event, the
// stream ends, or the collected bytes would exceed the line limit.
//
// A completed event is delivered compacted onto one line; one that never becomes
// valid JSON is delivered as the same multi-line data field. The first such event
// in a stream produces one diagnostic that describes its framing without any of
// its bytes. Non-data lines inside a held event are delivered as soon as they are
// read, i.e. before the event's data.
//
// Dropped from upstream: the bootstrap budget checker and RawLines/RawBytes
// accounting (bootstrap buffering is not ported).

export const codexSSEDataPrefix = "data:";
const codexSSEDiagnosticLines = 8;

/** A bounded, content-free description of an invalid event (Go: diagnose log fields). */
export interface CodexSSEDiagnostic {
  dataLines: number;
  /** Byte lengths of the first lines, e.g. "37,5" or "1,2,+3". */
  lineBytes: string;
  /** Whether each of the first lines is valid JSON on its own. */
  linesValid: string;
  dataBytes: number;
  /** -1 when the runtime does not expose the parse error position. */
  jsonErrorOffset: number;
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function jsonValid(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Removes insignificant whitespace outside strings (Go: json.Compact for valid JSON). */
export function compactJSON(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    out += ch;
  }
  return out;
}

/** One data line's value: the text after "data:" without the one leading space (Go: codexSSEValue). */
function codexSSEValue(line: string): string {
  const rest = line.slice(codexSSEDataPrefix.length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/** Whether joined event data is complete JSON (Go: codexSSEClosed). */
function codexSSEClosed(joined: string): boolean {
  const trimmed = joined.replace(/[ \t\r\n]+$/, "");
  if (trimmed === "") return false;
  const last = trimmed[trimmed.length - 1];
  if (last !== "}" && last !== "]") return false;
  return jsonValid(joined);
}

/** Whether a data line's value starts a JSON object or array it does not complete (Go: codexSSEIncompleteJSON). */
export function codexSSEIncompleteJSON(value: string): boolean {
  if (value.length === 0 || (value[0] !== "{" && value[0] !== "[") || value === "[DONE]") return false;
  return !codexSSEClosed(value);
}

/** Follows the nesting of a JSON text fed in pieces (Go: codexJSONNesting). */
class CodexJSONNesting {
  depth = 0;
  inString = false;
  escaped = false;

  /** Consumes `p` and reports whether the outermost object or array closed within it. */
  feed(p: string): boolean {
    for (const c of p) {
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') this.inString = true;
      else if (c === "{" || c === "[") this.depth++;
      else if (c === "}" || c === "]") {
        this.depth--;
        if (this.depth <= 0) return true;
      }
    }
    return false;
  }
}

export interface CodexSSEScannerOptions {
  /** Bounds the data lines collected for one event (Go: maxBytes). Default 50 MiB. */
  maxBytes?: number;
  /** Receives the one framing diagnostic of a stream. */
  onDiagnostic?: (diag: CodexSSEDiagnostic) => void;
}

export class CodexSSEScanner {
  private readonly maxBytes: number;
  private readonly onDiagnostic?: (diag: CodexSSEDiagnostic) => void;
  private readonly decoder = new TextDecoder();
  /** The incomplete physical line still being read. */
  private partial = "";
  /** Assembly off: every line is delivered as read (Go: stock). */
  private stock = false;
  private held: string[] = [];
  private size = 0;
  private joined = "";
  private nesting = new CodexJSONNesting();
  private warned = false;

  constructor(options: CodexSSEScannerOptions = {}) {
    this.maxBytes = options.maxBytes ?? 52_428_800;
    this.onDiagnostic = options.onDiagnostic;
  }

  /** Turns event assembly on or off; an event already being collected is still completed (Go: SetAssembly). */
  setAssembly(on: boolean): void {
    this.stock = !on;
  }

  /** Number of data lines currently held in an incomplete event (Go: HeldLines). */
  heldLines(): number {
    return this.held.length;
  }

  /** Feeds a chunk and returns the lines delivered so far, in order. */
  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    let buffer = this.partial + text;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      let line = buffer.slice(0, idx);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(idx + 1);
      this.scanLine(line, out);
    }
    this.partial = buffer;
    return out;
  }

  /** Delivers the unterminated last line and any held event at end of stream. */
  flush(): string[] {
    const out: string[] = [];
    const tail = this.partial + this.decoder.decode();
    this.partial = "";
    if (tail !== "") {
      let line = tail;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.scanLine(line, out);
    }
    if (this.held.length > 0) this.release(out);
    return out;
  }

  private scanLine(line: string, out: string[]): void {
    if (!line.startsWith(codexSSEDataPrefix)) {
      if (line === "" && this.held.length > 0) {
        this.release(out, "");
        return;
      }
      out.push(line);
      return;
    }
    if (this.held.length === 0) {
      if (this.stock || !codexSSEIncompleteJSON(codexSSEValue(line).trim())) {
        out.push(line);
        return;
      }
    } else if (this.size + utf8Len(line) > this.maxBytes) {
      // Bounded like a single line: stop collecting and let this line be read on its own.
      this.release(out, line);
      return;
    }
    if (this.hold(line)) this.release(out);
  }

  /** Adds a data line to the held event and reports whether its data has closed (Go: hold). */
  private hold(line: string): boolean {
    const value = codexSSEValue(line);
    if (this.held.length > 0) {
      this.joined += "\n";
      this.nesting.feed("\n");
    }
    this.held.push(line);
    this.joined += value;
    this.size += utf8Len(line);
    return this.nesting.feed(value);
  }

  /** Ends the collection and delivers the event as one line, followed by the line that ended it (Go: release). */
  private release(out: string[], ...end: string[]): void {
    out.push(this.assemble(this.held, this.joined));
    for (const e of end) out.push(e);
    this.held = [];
    this.size = 0;
    this.joined = "";
    this.nesting = new CodexJSONNesting();
  }

  private assemble(held: string[], joined: string): string {
    if (held.length === 1) {
      this.diagnose(held, joined.trim());
      return held[0]!;
    }
    if (jsonValid(joined)) return codexSSEDataPrefix + " " + compactJSON(joined);
    this.diagnose(held, joined);
    return held.join("\n");
  }

  /** One bounded warning for the first invalid event of a stream; never includes data bytes (Go: diagnose). */
  private diagnose(held: string[], data: string): void {
    if (this.warned || data.length === 0 || data === "[DONE]" || jsonValid(data)) return;
    this.warned = true;
    const shown = Math.min(held.length, codexSSEDiagnosticLines);
    const lengths: string[] = [];
    const valid: string[] = [];
    for (let i = 0; i < shown; i++) {
      const value = held[i]!.slice(codexSSEDataPrefix.length).trim();
      lengths.push(String(utf8Len(value)));
      valid.push(String(jsonValid(value)));
    }
    const more = held.length > shown ? ",+" + (held.length - shown) : "";
    const diag: CodexSSEDiagnostic = {
      dataLines: held.length,
      lineBytes: lengths.join(",") + more,
      linesValid: valid.join(",") + more,
      dataBytes: utf8Len(data),
      jsonErrorOffset: jsonErrorOffset(data),
    };
    if (this.onDiagnostic) this.onDiagnostic(diag);
  }
}

/** Best-effort parse error position from the runtime's message; -1 when unavailable. */
function jsonErrorOffset(data: string): number {
  try {
    JSON.parse(data);
    return -1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = /position\s+(\d+)|at offset\s+(\d+)|column\s+(\d+)/i.exec(message);
    if (!match) return -1;
    const n = Number(match[1] ?? match[2] ?? match[3]);
    return Number.isFinite(n) ? n : -1;
  }
}

/** Scans a complete stream text and returns every delivered line (tests and the non-stream path). */
export function scanCodexSSEText(text: string, options: CodexSSEScannerOptions = {}): string[] {
  const scanner = new CodexSSEScanner(options);
  const lines = scanner.push(text);
  lines.push(...scanner.flush());
  return lines;
}

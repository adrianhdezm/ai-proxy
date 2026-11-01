// Tracks what a forwarded Claude SSE stream has already said so the handler can
// decide whether a terminal error frame is still needed and where an SSE event
// boundary is. Port of claudeSSEStreamState from sdk/api/handlers/claude/code_handlers.go.
import { isObject, tryParse } from "../util/json.ts";

export class ClaudeSSEStreamState {
  sawErrorEvent = false;
  sawMessageStop = false;
  sawBareMessageJSON = false;
  /** Number of newline characters (max 2) the written output currently ends with. */
  trailingNewlines = 2;
  private currentEvent = "";
  private eventData: string[] = [];
  private lineBuf = "";

  constructor(init: { sawErrorEvent?: boolean; trailingNewlines?: number } = {}) {
    if (init.sawErrorEvent) this.sawErrorEvent = true;
    if (init.trailingNewlines !== undefined) this.trailingNewlines = init.trailingNewlines;
  }

  /** Observes a chunk that is about to be written downstream (Go: ObserveChunk). */
  observeChunk(chunk: string): void {
    if (chunk.length === 0) return;
    this.trailingNewlines = advanceClaudeSSENewlineCount(this.trailingNewlines, chunk);
    let start = 0;
    for (;;) {
      const idx = chunk.indexOf("\n", start);
      if (idx === -1) {
        this.lineBuf += chunk.slice(start);
        return;
      }
      this.observeLine(this.lineBuf + chunk.slice(start, idx));
      this.lineBuf = "";
      start = idx + 1;
    }
  }

  /** Observes a trailing line that was never newline-terminated and closes the pending event (Go: FlushPendingLine). */
  flushPendingLine(): void {
    if (this.lineBuf.length > 0) {
      this.observeLine(this.lineBuf);
      this.lineBuf = "";
    }
    this.flushEventData();
  }

  private flushEventData(): void {
    if (this.eventData.length === 0) return;
    const joined = this.eventData.join("\n").trim();
    this.eventData = [];
    if (joined.length > 0) {
      const parsed = tryParse(joined);
      if (parsed !== undefined) this.observeJSONPayload(parsed, true);
    }
  }

  /**
   * Returns the text that must be written before a new SSE event so it starts
   * after a blank line, and records the boundary (Go: ensureSSEEventBoundary).
   */
  ensureSSEEventBoundary(): string {
    if (this.sawBareMessageJSON) return "";
    let out = "";
    switch (this.trailingNewlines) {
      case 0:
        out = "\n\n";
        break;
      case 1:
        out = "\n";
        break;
    }
    this.trailingNewlines = 2;
    return out;
  }

  private observeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      this.flushEventData();
      this.currentEvent = "";
      return;
    }
    if (trimmed.startsWith("event:")) {
      this.currentEvent = trimmed.slice("event:".length).trim();
      return;
    }
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice("data:".length).trim();
      if (payload.length > 0) this.eventData.push(payload);
      return;
    }
    if (!trimmed.startsWith("{")) return;
    const parsed = tryParse(trimmed);
    if (parsed === undefined) return;
    this.observeJSONPayload(parsed, false);
  }

  private observeJSONPayload(payload: unknown, hasDataPrefix: boolean): void {
    if (!isObject(payload)) return;
    const type = typeof payload.type === "string" ? payload.type : "";
    switch (type) {
      case "message_stop":
        this.sawMessageStop = true;
        break;
      case "error":
        this.sawErrorEvent = true;
        break;
      case "message":
        if (!hasDataPrefix && typeof payload.stop_reason === "string" && payload.stop_reason.trim() !== "") {
          this.sawMessageStop = true;
          this.sawBareMessageJSON = true;
        }
        break;
      default:
        if (hasDataPrefix && this.currentEvent === "error" && payload.error !== undefined) this.sawErrorEvent = true;
    }
  }
}

/** Counts the trailing newlines (capped at 2) after `chunk` is appended to output ending with `prev` of them. */
export function advanceClaudeSSENewlineCount(prev: number, chunk: string): number {
  let count = prev;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk.charCodeAt(i);
    if (ch === 13) continue; // \r
    if (ch === 10) {
      if (count < 2) count++;
    } else {
      count = 0;
    }
  }
  return count;
}

// Shared gjson-style helpers and the stream harness for the openai/claude translator tests.
import { getAt, gint, gstr } from "../../../src/util/gpath.ts";
import { tryParse } from "../../../src/util/json.ts";
import { emptyContext, type TranslatorState } from "../../../src/translator/types.ts";
import { convertOpenAIResponseToClaude } from "../../../src/translator/openai/claude/index.ts";

/** gjson.Get(body, path).String(). */
export function getString(body: string, path: string): string {
  return gstr(getAt(tryParse(body), path));
}

/** gjson.Get(body, path).Int(). */
export function getInt(body: string, path: string): number {
  return gint(getAt(tryParse(body), path));
}

export function getValue(body: string, path: string): unknown {
  return getAt(tryParse(body), path);
}

export function exists(body: string, path: string): boolean {
  return getValue(body, path) !== undefined;
}

/** gjson Result.Raw (compact JSON) for a path, or "" when absent. */
export function raw(body: string, path: string): string {
  const v = getValue(body, path);
  return v === undefined ? "" : JSON.stringify(v);
}

export function messagesOf(body: string): unknown[] {
  const v = getValue(body, "messages");
  return Array.isArray(v) ? v : [];
}

export interface SSEEvent {
  type: string;
  payload: string;
}

/** Parses the "event: X\ndata: Y\n\n" frames the translator emits. */
export function parseEvents(emitted: string[]): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const s of emitted) {
    if (!s.startsWith("event: ")) continue;
    const nl = s.indexOf("\n");
    if (nl < 0) continue;
    const type = s.slice("event: ".length, nl);
    const rest = s.slice(nl + 1);
    if (!rest.startsWith("data: ")) continue;
    events.push({ type, payload: rest.slice("data: ".length).replace(/\n+$/u, "") });
  }
  return events;
}

/** Go: runStream. Feeds each chunk as "data: <chunk>" then "data: [DONE]" through one state. */
export function runStream(originalReq: string, ...chunks: string[]): SSEEvent[] {
  const state: TranslatorState = {};
  const emitted: string[] = [];
  for (const chunk of chunks) {
    emitted.push(...convertOpenAIResponseToClaude(emptyContext, "", originalReq, "", "data: " + chunk, state));
  }
  emitted.push(...convertOpenAIResponseToClaude(emptyContext, "", originalReq, "", "data: [DONE]", state));
  return parseEvents(emitted);
}

export function countByType(events: SSEEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

export function toolUseStarts(events: SSEEvent[]): SSEEvent[] {
  return events.filter((e) => e.type === "content_block_start" && getString(e.payload, "content_block.type") === "tool_use");
}

export function blockIndices(events: SSEEvent[]): number[] {
  return events.filter((e) => e.type === "content_block_start").map((e) => getInt(e.payload, "index"));
}

export function lastStopReason(events: SSEEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "message_delta") return getString(events[i]!.payload, "delta.stop_reason");
  }
  return "";
}

export function firstMessageDelta(events: SSEEvent[]): SSEEvent | undefined {
  return events.find((e) => e.type === "message_delta");
}

export function inputJSONDeltas(events: SSEEvent[]): SSEEvent[] {
  return events.filter((e) => e.type === "content_block_delta" && getString(e.payload, "delta.type") === "input_json_delta");
}

export function thinkingDeltas(events: SSEEvent[]): string[] {
  return events.filter((e) => e.type === "content_block_delta" && getString(e.payload, "delta.type") === "thinking_delta").map((e) => getString(e.payload, "delta.thinking"));
}

/** Go: assertSequentialContentBlocks. Throws when blocks overlap or stay open. */
export function assertSequentialContentBlocks(events: SSEEvent[]): void {
  let active = -1;
  for (const e of events) {
    const idx = getInt(e.payload, "index");
    switch (e.type) {
      case "content_block_start":
        if (active !== -1) throw new Error(`content_block_start for index ${idx} while block ${active} is still open`);
        active = idx;
        break;
      case "content_block_delta":
        if (active === -1) throw new Error(`content_block_delta for index ${idx} but no block is open`);
        if (idx !== active) throw new Error(`content_block_delta for index ${idx} but active block is ${active}`);
        break;
      case "content_block_stop":
        if (active === -1) throw new Error(`content_block_stop for index ${idx} but no block is open`);
        if (idx !== active) throw new Error(`content_block_stop for index ${idx} but active block is ${active}`);
        active = -1;
        break;
    }
  }
  if (active !== -1) throw new Error(`stream ended with unclosed block ${active}`);
}

export const streamReq = `{"stream":true}`;

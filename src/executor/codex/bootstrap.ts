// Stream bootstrap buffering helpers. Port of the bootstrap part of
// internal/runtime/executor/codex_executor_terminal.go: the frame and byte
// budgets, the closed allow-list of frames that may be held back before the
// downstream stream is committed (isCodexBootstrapBufferableEvent and its
// item/part emptiness checks) and the 503 raised for a buffered overload
// rejection (newCodexBootstrapOverloadErr). isCodexOverloadBootstrapFailure
// lives in errors.ts with the other body classifications.
import type { StatusError } from "../types.ts";
import { getAt, gstr, isArr } from "../../util/gpath.ts";
import { newCodexStatusErr } from "./errors.ts";

/**
 * Upstream lines that may be held back while probing for a rejection embedded
 * in an HTTP 200 stream. Counted per physical line held (comments, event:,
 * blank separators and every data line of a split event), so a heartbeat in the
 * three-line event:/data:/blank framing protects 15 of them.
 */
export const codexBootstrapMaxBufferedFrames = 48;

/** Bytes one bootstrap may retain, counted over the upstream lines and the chunks they translate into. */
export const codexBootstrapMaxBufferedBytes = 1 << 20;

/**
 * Whether a frame may be held back before anything observable has happened
 * (Go: isCodexBootstrapBufferableEvent). The list is closed: an unrecognised
 * frame, generated output or a server-side tool announcement releases the stream.
 */
export function isCodexBootstrapBufferableEvent(eventType: string, payload: string): boolean {
  // An empty data: frame is the SSE heartbeat idiom and carries nothing.
  if (payload.trim().length === 0) return true;
  switch (eventType) {
    case "response.created":
    case "response.in_progress":
    case "codex.rate_limits":
    case "codex.response.metadata":
    case "response.metadata":
    case "keepalive":
      return true;
    case "response.output_item.added":
      return isCodexBufferableOutputItem(payload);
    case "response.content_part.added":
    case "response.reasoning_summary_part.added":
      return isCodexEmptyPart(payload);
    default:
      return false;
  }
}

function parsed(payload: string | unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/**
 * Whether an announced output item is one the model produces by itself and has
 * not started producing (Go: isCodexBufferableOutputItem). Every other item
 * type (web_search_call, file_search_call, ...) releases the stream.
 */
export function isCodexBufferableOutputItem(payload: string | unknown): boolean {
  const item = getAt(parsed(payload), "item");
  switch (gstr(getAt(item, "type"))) {
    case "message":
      return isCodexEmptyContentList(getAt(item, "content"));
    case "reasoning":
      if (gstr(getAt(item, "encrypted_content")) !== "") return false;
      return isCodexEmptyContentList(getAt(item, "summary")) && isCodexEmptyContentList(getAt(item, "content"));
    case "function_call":
      return gstr(getAt(item, "arguments")) === "";
    case "custom_tool_call":
      return gstr(getAt(item, "input")) === "";
    default:
      return false;
  }
}

/**
 * Whether every entry of a content or summary array is a known textual shape
 * that is still empty (Go: isCodexEmptyContentList). A missing or non-array
 * value counts as empty, as gjson's Array() of it is.
 */
export function isCodexEmptyContentList(list: unknown): boolean {
  const entries = isArr(list) ? list : list === undefined || list === null ? [] : [list];
  for (const entry of entries) {
    switch (gstr(getAt(entry, "type"))) {
      case "output_text":
      case "summary_text":
      case "text":
      case "reasoning_text":
        if (gstr(getAt(entry, "text")) !== "") return false;
        break;
      case "refusal":
        if (gstr(getAt(entry, "refusal")) !== "") return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Whether an announced part is a known textual part that is still empty (Go: isCodexEmptyPart). */
export function isCodexEmptyPart(payload: string | unknown): boolean {
  const part = getAt(parsed(payload), "part");
  switch (gstr(getAt(part, "type"))) {
    case "output_text":
    case "summary_text":
    case "text":
    case "reasoning_text":
      return gstr(getAt(part, "text")) === "";
    case "refusal":
      return gstr(getAt(part, "refusal")) === "";
    default:
      return false;
  }
}

/**
 * A buffered overload rejection with the status the upstream hid behind HTTP
 * 200 (Go: newCodexBootstrapOverloadErr). Scoped to the buffered path so the
 * unbuffered classification is unchanged.
 */
export function newCodexBootstrapOverloadErr(body: string): StatusError {
  return newCodexStatusErr(503, body);
}

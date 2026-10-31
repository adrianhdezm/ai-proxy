// Port of internal/runtime/executor/helps/claude_input_tokens.go.
//
// When a Claude client is served by a non-Claude upstream, the translated
// message_start frame reports input_tokens: 0 because OpenAI only sends usage
// at the end of the stream. ClaudeInputTokenState patches the first
// message_start once with an estimate computed from the original Claude
// request.
//
// Deviation: Go counted the collected text segments with the o200k_base
// tokenizer (tiktoken). This port has no tokenizer (no runtime dependencies),
// so the estimate is ceil(characters / 4) over the same segments. The segment
// collection rules (what is counted and what is excluded) are ported verbatim.
import type { Format, TranslateContext, TranslatorState } from "../../translator/types.ts";
import { FormatClaude } from "../../translator/types.ts";
import { translateStream } from "../../translator/registry.ts";
import { getAt, gstr, isArr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { log } from "../../log.ts";

/** Counts estimated tokens of a text: ceil(chars / 4), 0 for "" (stand-in for the o200k_base codec). */
export type TokenCounter = (text: string) => number;

export const estimateTokensByChars: TokenCounter = (text) => (text.length === 0 ? 0 : Math.ceil(text.length / 4));

/**
 * Collects the text segments of a Claude request that count towards the
 * input estimate (Go: collectClaudeInputTokenSegments). Throws on invalid JSON.
 */
export function collectClaudeInputTokenSegments(payload: string): string[] {
  if (payload.trim() === "") return [];
  const root = tryParse<unknown>(payload);
  if (root === undefined) throw new Error("invalid Claude request JSON");
  const segments: string[] = [];
  collectClaudeSystemTokenSegments(getAt(root, "system"), segments);
  collectClaudeMessageTokenSegments(getAt(root, "messages"), segments);
  collectClaudeToolTokenSegments(getAt(root, "tools"), segments);
  collectClaudeToolChoiceTokenSegments(getAt(root, "tool_choice"), segments);
  return segments;
}

/** Estimates the input tokens of a Claude request (Go: CountClaudeInputTokens / countClaudeInputTokens). */
export function countClaudeInputTokens(payload: string, counter: TokenCounter = estimateTokensByChars): number {
  const segments = collectClaudeInputTokenSegments(payload);
  if (segments.length === 0) return 0;
  return counter(segments.join("\n"));
}

function collectClaudeSystemTokenSegments(system: unknown, segments: string[]): void {
  if (typeof system === "string") {
    appendClaudeTokenString(segments, system);
    return;
  }
  if (!isArr(system)) return;
  for (const part of system) {
    if (typeof part === "string") appendClaudeTokenString(segments, part);
    else if (gstr(getAt(part, "type")) === "text") appendClaudeTokenString(segments, gstr(getAt(part, "text")));
  }
}

function collectClaudeMessageTokenSegments(messages: unknown, segments: string[]): void {
  if (!isArr(messages)) return;
  for (const message of messages) {
    appendClaudeTokenString(segments, gstr(getAt(message, "role")));
    collectClaudeContentTokenSegments(getAt(message, "content"), segments);
  }
}

function collectClaudeContentTokenSegments(content: unknown, segments: string[]): void {
  if (content === undefined) return;
  if (typeof content === "string") {
    appendClaudeTokenString(segments, content);
    return;
  }
  if (isArr(content)) {
    for (const part of content) collectClaudeContentTokenSegments(part, segments);
    return;
  }
  if (!isObj(content)) return;

  switch (gstr(content.type)) {
    case "text":
      appendClaudeTokenString(segments, gstr(content.text));
      break;
    case "thinking":
      appendClaudeTokenString(segments, gstr(content.thinking));
      break;
    case "document":
      collectClaudeDocumentTokenSegments(content, segments);
      break;
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      appendClaudeTokenString(segments, gstr(content.id));
      appendClaudeTokenString(segments, gstr(content.name));
      appendClaudeTokenJSON(segments, content.input);
      break;
    case "tool_result":
    case "mcp_tool_result":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
      appendClaudeTokenString(segments, gstr(content.tool_use_id));
      appendClaudeTokenString(segments, gstr(content.tool_call_id));
      collectClaudeContentTokenSegments(content.content, segments);
      break;
    case "web_search_result":
    case "search_result":
      if (typeof content.source === "string") appendClaudeTokenString(segments, content.source);
      appendClaudeTokenString(segments, gstr(content.title));
      appendClaudeTokenString(segments, gstr(content.url));
      appendClaudeTokenString(segments, gstr(content.page_age));
      collectClaudeContentTokenSegments(content.content, segments);
      break;
    case "web_fetch_result":
      appendClaudeTokenString(segments, gstr(content.url));
      appendClaudeTokenString(segments, gstr(content.retrieved_at));
      collectClaudeContentTokenSegments(content.content, segments);
      break;
    case "code_execution_result":
    case "bash_code_execution_result":
    case "text_editor_code_execution_result":
      appendClaudeTokenString(segments, gstr(content.stdout));
      appendClaudeTokenString(segments, gstr(content.stderr));
      appendClaudeTokenString(segments, gstr(content.return_code));
      collectClaudeContentTokenSegments(content.content, segments);
      collectClaudeContentTokenSegments(content.output, segments);
      break;
    case "tool_reference":
      appendClaudeTokenString(segments, gstr(content.tool_name));
      break;
    case "image":
    case "input_audio":
    case "audio":
    case "video":
    case "redacted_thinking":
      return;
    case "":
      appendClaudeTokenJSON(segments, content);
      break;
    default:
      appendClaudeTokenString(segments, gstr(content.text));
  }
}

function collectClaudeDocumentTokenSegments(document: Record<string, unknown>, segments: string[]): void {
  const source = document.source;
  if (gstr(getAt(source, "type")) !== "text") return;
  appendClaudeTokenString(segments, gstr(document.title));
  appendClaudeTokenString(segments, gstr(document.context));
  appendClaudeTokenString(segments, gstr(getAt(source, "data")));
  appendClaudeTokenString(segments, gstr(getAt(source, "content")));
}

function collectClaudeToolTokenSegments(tools: unknown, segments: string[]): void {
  if (!isArr(tools)) return;
  for (const tool of tools) {
    appendClaudeTokenString(segments, gstr(getAt(tool, "type")));
    appendClaudeTokenString(segments, gstr(getAt(tool, "name")));
    appendClaudeTokenString(segments, gstr(getAt(tool, "description")));
    appendClaudeTokenJSON(segments, getAt(tool, "input_schema"));
  }
}

function collectClaudeToolChoiceTokenSegments(toolChoice: unknown, segments: string[]): void {
  if (toolChoice === undefined) return;
  if (typeof toolChoice === "string") {
    appendClaudeTokenString(segments, toolChoice);
    return;
  }
  appendClaudeTokenString(segments, gstr(getAt(toolChoice, "type")));
  appendClaudeTokenString(segments, gstr(getAt(toolChoice, "name")));
}

function appendClaudeTokenString(segments: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed !== "") segments.push(trimmed);
}

function appendClaudeTokenJSON(segments: string[], value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    appendClaudeTokenString(segments, value);
    return;
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) return;
  appendClaudeTokenString(segments, raw);
}

/** Tracks the one-time input token update for a translated Claude stream (Go: ClaudeInputTokenState). */
export class ClaudeInputTokenState {
  readonly upstreamFormat: Format;
  readonly responseFormat: Format;
  readonly originalRequest: string;
  /** Pluggable counter (the Go codec slot); tests inject a failing one. */
  counter: TokenCounter | undefined;
  handled: boolean;

  constructor(sourceFormat: Format, upstreamFormat: Format, responseFormat: Format, originalRequest: string) {
    const enabled = sourceFormat === FormatClaude && upstreamFormat !== FormatClaude && responseFormat === FormatClaude;
    this.upstreamFormat = upstreamFormat;
    this.responseFormat = responseFormat;
    this.originalRequest = originalRequest;
    this.handled = !enabled;
  }

  /** Patches the first message_start among `chunks` once; later calls are no-ops. */
  apply(chunks: string[]): string[] {
    if (this.handled) return chunks;
    for (let i = 0; i < chunks.length; i++) {
      const { chunk, found } = this.applyChunk(chunks[i]!);
      if (!found) continue;
      this.handled = true;
      chunks[i] = chunk;
      break;
    }
    return chunks;
  }

  private applyChunk(chunk: string): { chunk: string; found: boolean } {
    let lineStart = 0;
    while (lineStart < chunk.length) {
      let lineEnd = chunk.indexOf("\n", lineStart);
      if (lineEnd < 0) lineEnd = chunk.length;
      let contentEnd = lineEnd;
      if (contentEnd > lineStart && chunk[contentEnd - 1] === "\r") contentEnd--;
      const line = chunk.slice(lineStart, contentEnd);
      const trimmedLeft = line.replace(/^[ \t]+/, "");
      if (trimmedLeft.startsWith("data:")) {
        let payloadOffset = line.length - trimmedLeft.length + "data:".length;
        while (payloadOffset < line.length && (line[payloadOffset] === " " || line[payloadOffset] === "\t")) payloadOffset++;
        let payloadEnd = line.length;
        while (payloadEnd > payloadOffset && (line[payloadEnd - 1] === " " || line[payloadEnd - 1] === "\t")) payloadEnd--;
        const payload = line.slice(payloadOffset, payloadEnd);
        const parsed = tryParse<unknown>(payload);
        if (gstr(getAt(parsed, "type")) === "message_start") {
          const inputTokens = getAt(parsed, "message.usage.input_tokens");
          if (inputTokens !== undefined && Number(inputTokens) !== 0) return { chunk, found: true };
          let count: number;
          try {
            count = this.estimate();
          } catch (err) {
            this.logEstimateError(err);
            return { chunk, found: true };
          }
          if (count === 0) return { chunk, found: true };
          if (!isObj(parsed)) return { chunk, found: true };
          const message = isObj(parsed.message) ? parsed.message : {};
          const usage = isObj(message.usage) ? message.usage : {};
          usage.input_tokens = count;
          message.usage = usage;
          parsed.message = message;
          const updatedPayload = JSON.stringify(parsed);
          const payloadStart = lineStart + payloadOffset;
          const payloadStop = lineStart + payloadEnd;
          return { chunk: chunk.slice(0, payloadStart) + updatedPayload + chunk.slice(payloadStop), found: true };
        }
      }
      if (lineEnd === chunk.length) break;
      lineStart = lineEnd + 1;
    }
    return { chunk, found: false };
  }

  private estimate(): number {
    return countClaudeInputTokens(this.originalRequest, this.counter ?? estimateTokensByChars);
  }

  private logEstimateError(err: unknown): void {
    // The original request is never logged; only the formats and the error text.
    log.warn("failed to estimate Claude input tokens", { upstream_format: this.upstreamFormat, response_format: this.responseFormat, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Creates request-scoped state for translated Claude input token usage (Go: NewClaudeInputTokenState). */
export function newClaudeInputTokenState(sourceFormat: Format, upstreamFormat: Format, responseFormat: Format, originalRequest: string): ClaudeInputTokenState {
  return new ClaudeInputTokenState(sourceFormat, upstreamFormat, responseFormat, originalRequest);
}

/**
 * Translates a stream chunk and estimates Claude message_start input usage once
 * (Go: TranslateStreamWithClaudeInputTokens, without the Responses usage pass).
 */
export function translateStreamWithClaudeInputTokens(
  ctx: TranslateContext,
  upstreamFormat: Format,
  responseFormat: Format,
  model: string,
  originalRequestRawJSON: string,
  requestRawJSON: string,
  rawJSON: string,
  state: TranslatorState,
  inputTokens: ClaudeInputTokenState | undefined,
): string[] {
  const chunks = translateStream(ctx, upstreamFormat, responseFormat, model, originalRequestRawJSON, requestRawJSON, rawJSON, state);
  if (!inputTokens) return chunks;
  return inputTokens.apply(chunks);
}

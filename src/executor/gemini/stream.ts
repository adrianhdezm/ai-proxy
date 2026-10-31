// Upstream transport and the SSE stream loop shared by the Gemini CLI and AI
// Studio executors. Port of the ExecuteStream goroutines of v7.0.12
// gemini_cli_executor.go and current gemini_executor.go (line scanner ->
// response translator -> "[DONE]" flush), without the usage reporter. For the
// Responses response format the apply_patch tool-input state is initialised
// before the first chunk and finalized at the end of the transport, and a
// retained tool-input failure ends the stream with the sanitised 502
// (Go: InitializeApplyPatchStream / StopApplyPatchStream / EndApplyPatchStream).
import type { FetchLike } from "../../auth/oauth/http.ts";
import { log } from "../../log.ts";
import { defaultRegistry } from "../../translator/registry.ts";
import { FormatClaude, FormatGemini, FormatOpenAI, FormatOpenAIResponse, type Format, type TranslateContext, type TranslatorState } from "../../translator/types.ts";
import { StatusError } from "../types.ts";
import { applyPatchTranslationError, applyPatchUpstreamError, ensureResponsesUsageDetails, finalizeApplyPatchStream, initializeApplyPatchStream } from "../responses.ts";
import {
  geminiPromptBlockErrorMessage,
  geminiStreamHasFinishSignal,
  jsonPayload,
  newGeminiPromptBlockErr,
  translatedClaudeStreamErrorPayload,
} from "./errors.ts";

/** fetch as used by the executors (Bun's `proxy` option is honoured). */
export type ExecutorFetch = FetchLike;

export interface UpstreamRequest {
  url: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
  proxyUrl?: string;
}

/** POSTs the JSON body upstream (proxy "" / "direct" means no proxy). */
export async function postUpstream(fetchFn: ExecutorFetch, req: UpstreamRequest): Promise<Response> {
  const init: RequestInit & { proxy?: string } = { method: "POST", headers: req.headers, body: req.body, signal: req.signal };
  const proxy = (req.proxyUrl ?? "").trim();
  if (proxy !== "" && proxy.toLowerCase() !== "direct") init.proxy = proxy;
  return fetchFn(req.url, init);
}

/** Reads a body as text lines (bufio.Scanner semantics: "\n" separated, trailing "\r" dropped). */
export async function* iterateLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already released or errored
    }
  }
}

/**
 * What happens when the upstream body ends without a finishReason / blockReason:
 * - "truncate" (AI Studio, current upstream): for Claude/OpenAI responses the stream
 *   fails with StatusError 502 "upstream stream closed before finishReason",
 *   streamTruncated (also when nothing was emitted).
 * - "flush" (Gemini CLI, v7.0.12): "[DONE]" is still fed to the translator, which
 *   closes the message normally; a body that produced no output at all fails with
 *   a plain StatusError 502 so the manager can fail over before the first chunk.
 */
export type MissingFinishPolicy = "truncate" | "flush";

export interface GeminiStreamOptions {
  response: Response;
  /** Inbound (client) schema of the request; the response is translated to it. */
  responseFormat: Format;
  /** Model name handed to the translator. */
  model: string;
  originalRequest: string;
  /** The translated (bare Gemini) request body. */
  translatedRequest: string;
  missingFinish: MissingFinishPolicy;
  /** Fail the stream on a promptFeedback.blockReason without candidates (AI Studio). */
  detectPromptBlock: boolean;
  /** Only feed lines that start with "data:" (v7 Gemini CLI); otherwise any JSON line. */
  dataLinesOnly: boolean;
  signal?: AbortSignal;
  ctx?: TranslateContext;
  /** Called with each JSON payload before translation (usage observation). */
  onPayload?: (payload: string) => void;
}

/**
 * Translates an accepted upstream SSE body into downstream frames. A terminal
 * failure is thrown from the iterator (see MissingFinishPolicy and the
 * classification table in index.ts).
 */
export async function* geminiStreamChunks(o: GeminiStreamOptions): AsyncGenerator<string> {
  const state: TranslatorState = {};
  const ctx: TranslateContext = o.ctx ?? { signal: o.signal };
  const translate = (chunk: string): string[] => {
    const out = defaultRegistry.translateStream(ctx, FormatGemini, o.responseFormat, o.model, o.originalRequest, o.translatedRequest, chunk, state);
    // Go: TranslateStreamWithClaudeInputTokens completes Responses usage details on every chunk.
    if (o.responseFormat !== FormatOpenAIResponse || applyPatchTranslationError(state)) return out;
    return out.map(ensureResponsesUsageDetails);
  };
  let sawFinish = false;
  let emitted = false;
  let retained: StatusError | undefined;
  initializeApplyPatchStream(ctx, FormatGemini, o.responseFormat, o.model, o.originalRequest, o.translatedRequest, state);

  const capture = (lines: string[]): void => {
    if (retained) return;
    const payload = translatedClaudeStreamErrorPayload(o.responseFormat, lines);
    if (payload !== undefined) retained = new StatusError(502, payload, { body: payload });
  };

  try {
    for await (const line of iterateLines(o.response.body)) {
      if (o.signal?.aborted) return;
      let chunk: string;
      if (o.dataLinesOnly) {
        if (!line.startsWith("data:")) continue;
        chunk = line;
      } else {
        chunk = jsonPayload(line);
        if (chunk === "") continue;
      }
      const payload = o.dataLinesOnly ? jsonPayload(line) : chunk;
      if (!sawFinish && geminiStreamHasFinishSignal(payload)) sawFinish = true;
      if (payload !== "") o.onPayload?.(payload);
      if (o.detectPromptBlock) {
        const blockMsg = geminiPromptBlockErrorMessage(payload);
        if (blockMsg !== undefined) throw newGeminiPromptBlockErr(blockMsg);
      }
      const lines = translate(chunk);
      capture(lines);
      for (const out of lines) {
        if (out === "") continue;
        emitted = true;
        yield out;
      }
      if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
    }
  } catch (err) {
    if (o.signal?.aborted) return;
    throw err;
  }
  if (o.signal?.aborted) return;
  for (const out of finalizeApplyPatchStream(state)) {
    if (out === "") continue;
    emitted = true;
    yield out;
  }
  if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
  if (retained) throw retained;

  if (o.missingFinish === "truncate" && !sawFinish && (o.responseFormat === FormatClaude || o.responseFormat === FormatOpenAI)) {
    throw new StatusError(502, "upstream stream closed before finishReason", { streamTruncated: true });
  }
  if (o.missingFinish === "flush" && !sawFinish && emitted) {
    log.debug("gemini stream: upstream closed without finishReason; flushing [DONE] (v7 gemini-cli behaviour)");
  }

  const tail = translate("[DONE]");
  capture(tail);
  for (const out of tail) {
    if (out === "") continue;
    emitted = true;
    yield out;
  }
  if (applyPatchTranslationError(state)) throw applyPatchUpstreamError();
  if (retained) throw retained;
  if (o.missingFinish === "flush" && !emitted) {
    throw new StatusError(502, "upstream stream closed before first payload");
  }
}

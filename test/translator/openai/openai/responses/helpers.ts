// Shared gjson-style helpers and stream harness for the openai/openai/responses translator tests.
import { getAt, gint, gstr } from "../../../../../src/util/gpath.ts";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import {
  convertOpenAIChatCompletionsResponseToOpenAIResponses,
  convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream,
  convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError,
} from "../../../../../src/translator/openai/openai/responses/index.ts";

export function parse(body: string): unknown {
  return JSON.parse(body);
}
/** gjson.Get(...).Value(): undefined when absent. */
export function get(body: string | unknown, path: string): unknown {
  return getAt(typeof body === "string" ? JSON.parse(body) : body, path);
}
export function str(body: string | unknown, path: string): string {
  return gstr(get(body, path));
}
export function int(body: string | unknown, path: string): number {
  return gint(get(body, path));
}
export function has(body: string | unknown, path: string): boolean {
  return get(body, path) !== undefined;
}
export function arr(body: string | unknown, path: string): unknown[] {
  const v = get(body, path);
  return Array.isArray(v) ? v : [];
}

/** ConvertOpenAIResponsesRequestToOpenAIChatCompletions ignoring the refusal (Go: `out, _ :=`). */
export function convertReq(input: string, model = "gpt-4o", stream = false): string {
  return convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError(model, input, stream)[0];
}

export interface Event {
  event: string;
  data: unknown;
  raw: string;
}

/** Parses one "event: X\ndata: Y\n\n" frame (Go: parseOpenAIResponsesSSEEvent). */
export function parseEvent(chunk: string): Event {
  const lines = chunk.split("\n");
  if (lines.length < 2 || !lines[0]!.startsWith("event: ") || !lines[1]!.startsWith("data: ")) throw new Error(`unexpected SSE chunk: ${chunk}`);
  const raw = lines[1]!.slice("data: ".length).trim();
  return { event: lines[0]!.slice("event: ".length).trim(), data: JSON.parse(raw), raw };
}

export class Stream {
  state: TranslatorState = {};
  constructor(
    public original: string,
    public translated: string = original,
    public model = "model",
  ) {}
  feedRaw(chunk: string): string[] {
    return convertOpenAIChatCompletionsResponseToOpenAIResponses(emptyContext, this.model, this.original, this.translated, chunk, this.state);
  }
  feed(chunk: string): Event[] {
    return this.feedRaw(chunk).map(parseEvent);
  }
  feedAll(chunks: string[]): Event[] {
    return chunks.flatMap((c) => this.feed(c));
  }
}

export function nonStream(original: string, translated: string, raw: string, state: TranslatorState = {}, model = "model"): string {
  return convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(emptyContext, model, original, translated, raw, state);
}

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Go's fmt %q for plain strings (JSON string encoding). */
export function q(s: string): string {
  return JSON.stringify(s);
}

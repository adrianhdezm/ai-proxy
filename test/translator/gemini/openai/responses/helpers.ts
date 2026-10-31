// Shared helpers for the Responses <-> Gemini translator tests (gjson-style access on strings).
import { expect } from "bun:test";
import { convertOpenAIResponsesRequestToGemini } from "../../../../../src/translator/gemini/openai/responses/request.ts";
import { convertGeminiResponseToOpenAIResponses, convertGeminiResponseToOpenAIResponsesNonStream } from "../../../../../src/translator/gemini/openai/responses/response.ts";
import { decodeGeminiResponsesCarrier } from "../../../../../src/translator/gemini/openai/responses/signature_carrier.ts";
import { emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import { decodeBase64, encodeBase64, stdEncoding } from "../../../../../src/util/base64.ts";
import { garray, getAt, gbool, gint, gstr } from "../../../../../src/util/gpath.ts";

export const testResponsesGeminiThoughtSignature = "EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA";

/** A parsed JSON value with gjson-like accessors. */
export class J {
  constructor(readonly v: unknown) {}
  static parse(raw: string): J {
    try {
      return new J(JSON.parse(raw));
    } catch {
      return new J(undefined);
    }
  }
  get(path: string): J {
    return new J(getAt(this.v, path));
  }
  str(path = ""): string {
    return gstr(path === "" ? this.v : getAt(this.v, path));
  }
  int(path = ""): number {
    return gint(path === "" ? this.v : getAt(this.v, path));
  }
  num(path = ""): number {
    const v = path === "" ? this.v : getAt(this.v, path);
    return typeof v === "number" ? v : Number(gstr(v)) || 0;
  }
  bool(path = ""): boolean {
    return gbool(path === "" ? this.v : getAt(this.v, path));
  }
  exists(path = ""): boolean {
    return (path === "" ? this.v : getAt(this.v, path)) !== undefined;
  }
  arr(path = ""): J[] {
    return garray(path === "" ? this.v : getAt(this.v, path)).map((x) => new J(x));
  }
  isArray(path = ""): boolean {
    return Array.isArray(path === "" ? this.v : getAt(this.v, path));
  }
  get raw(): string {
    return this.v === undefined ? "" : JSON.stringify(this.v);
  }
}

/** gjson.GetBytes(body, path). */
export function g(body: string, path: string): J {
  return J.parse(body).get(path);
}

/** Parses one SSE frame "event: x\ndata: {...}\n\n" into its event name and data. */
export function parseSSEEvent(chunk: string): { event: string; data: J } {
  const lines = chunk.split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const event = lines[0]!.replace(/^event:/, "").trim();
  const dataLine = lines[1]!.replace(/^data:/, "").trim();
  const data = J.parse(dataLine);
  expect(data.exists()).toBe(true);
  return { event, data };
}

/** Converts a Responses request; returns the Gemini JSON (Go returned it alongside an error). */
export function toGemini(model: string, request: string, stream = false): string {
  return convertOpenAIResponsesRequestToGemini(model, request, stream);
}

/** Converts a Responses request, returning [output, error] like Go. */
export function toGeminiErr(model: string, request: string): [string, Error | undefined] {
  try {
    return [convertOpenAIResponsesRequestToGemini(model, request, false), undefined];
  } catch (err) {
    return ["", err as Error];
  }
}

/** One streaming translator call. */
export function streamChunk(model: string, original: string, request: string, chunk: string, state: TranslatorState): string[] {
  return convertGeminiResponseToOpenAIResponses(emptyContext, model, original, request, chunk, state);
}

/** Runs the streaming translator over chunks and returns every emitted frame. */
export function streamAll(model: string, original: string, request: string, chunks: string[], state: TranslatorState = {}): string[] {
  const out: string[] = [];
  for (const chunk of chunks) out.push(...streamChunk(model, original, request, chunk, state));
  return out;
}

/** Runs the streaming translator and returns parsed {event,data} pairs. */
export function streamEvents(model: string, original: string, request: string, chunks: string[], state: TranslatorState = {}): { event: string; data: J }[] {
  return streamAll(model, original, request, chunks, state).map(parseSSEEvent);
}

export function nonStream(model: string, original: string, request: string, raw: string, state?: TranslatorState): string {
  return convertGeminiResponseToOpenAIResponsesNonStream(emptyContext, model, original, request, raw, state);
}

/** testResponsesGeminiThoughtSignature with its last byte flipped. */
export function differentResponsesGeminiThoughtSignature(): string {
  const raw = decodeBase64(testResponsesGeminiThoughtSignature, stdEncoding)!;
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
  return encodeBase64(raw, stdEncoding);
}

export function decodedResponsesCarrierSignature(encryptedContent: string): string {
  const decoded = decodeGeminiResponsesCarrier(encryptedContent);
  if (decoded.marked && !decoded.ok) throw new Error(`invalid Responses carrier envelope: ${encryptedContent}`);
  return decoded.signature;
}

/** The completed (or incomplete) response.output of a stream. */
export function completedOutput(events: { event: string; data: J }[]): J {
  let out = new J(undefined);
  for (const e of events) if (e.event === "response.completed" || e.event === "response.incomplete") out = e.data.get("response.output");
  return out;
}

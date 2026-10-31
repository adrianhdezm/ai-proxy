// Shared gjson-style helpers for the Gemini translator tests.
import { emptyContext } from "../../../src/translator/types.ts";
import type { TranslatorState } from "../../../src/translator/types.ts";
import { convertGeminiResponseToClaude } from "../../../src/translator/gemini/claude/response.ts";
import { garray, getAt, gint, gstr } from "../../../src/util/gpath.ts";
import { tryParse } from "../../../src/util/json.ts";

/** gjson.GetBytes(body, path) value (undefined when absent). */
export function getVal(body: string, path: string): unknown {
  return getAt(tryParse(body), path);
}

/** gjson Result.String(). */
export function getStr(body: string, path: string): string {
  return gstr(getVal(body, path));
}

/** gjson Result.Int(). */
export function getInt(body: string, path: string): number {
  return gint(getVal(body, path));
}

/** gjson Result.Array(). */
export function getArr(body: string, path: string): unknown[] {
  return garray(getVal(body, path));
}

export function exists(body: string, path: string): boolean {
  return getVal(body, path) !== undefined;
}

/** gjson Result.Raw (compact JSON), or "" when absent. */
export function raw(body: string, path: string): string {
  const v = getVal(body, path);
  return v === undefined ? "" : JSON.stringify(v);
}

/** The JSON payloads of every `data:` line in a Claude SSE text. */
export function dataPayloads(streamText: string): string[] {
  const payloads: string[] = [];
  for (const line of streamText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    payloads.push(trimmed.slice("data:".length).trim());
  }
  return payloads;
}

/** Runs the streaming translator over the given chunks (plus an explicit "[DONE]" when included) and joins the output. */
export function streamToClaude(originalRequest: string, translatedRequest: string, chunks: string[], state: TranslatorState = {}, model = "gemini-2.5-pro"): string {
  let out = "";
  for (const chunk of chunks) {
    out += convertGeminiResponseToClaude(emptyContext, model, originalRequest, translatedRequest, chunk, state).join("");
  }
  return out;
}

/** Concatenates every input_json_delta partial_json in a Claude SSE text (Go: geminiClaudeInputJSONDeltas). */
export function inputJSONDeltas(streamText: string): string {
  let out = "";
  for (const payload of dataPayloads(streamText)) {
    if (getStr(payload, "delta.type") === "input_json_delta") out += getStr(payload, "delta.partial_json");
  }
  return out;
}

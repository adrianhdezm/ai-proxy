// Shared helpers for the Responses <-> Claude translator tests (ports of the Go
// helpers spread across internal/translator/claude/openai/responses/*_test.go).
import { afterAll, beforeAll, expect } from "bun:test";
import { defaultRegistry } from "../../../../../src/translator/registry.ts";
import { FormatClaude, FormatOpenAIResponse, emptyContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import {
  clientToolSearchEnabled,
  convertOpenAIResponsesRequestToClaudeResult,
  setClientToolSearchEnabled,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { SignatureProviderClaude, compatibleSignatureForProvider } from "../../../../../src/signature/index.ts";
import { getAt } from "../../../../../src/util/gpath.ts";

export type JSONObject = Record<string, any>;

/**
 * Go's TestMain ran the package with upstream.claude.tool-search on; each test
 * file calls this so the switch is on for its tests and restored afterwards.
 */
export function useClientToolSearchDefault(enabled = true): void {
  let previous = false;
  beforeAll(() => {
    previous = clientToolSearchEnabled();
    setClientToolSearchEnabled(enabled);
  });
  afterAll(() => setClientToolSearchEnabled(previous));
}

/** Runs fn with the tool-search switch set, restoring it afterwards (Go: setClientToolSearchEnabledForTest). */
export function withToolSearch<T>(enabled: boolean, fn: () => T): T {
  const previous = clientToolSearchEnabled();
  setClientToolSearchEnabled(enabled);
  try {
    return fn();
  } finally {
    setClientToolSearchEnabled(previous);
  }
}

/** gjson-style read of a dotted path ("#" is the array length). */
export function get(json: string | unknown, path: string): any {
  const root = typeof json === "string" ? JSON.parse(json) : json;
  return getAt(root, path);
}

/** Go: ConvertOpenAIResponsesRequestToClaude(model, raw, stream) with the error ignored. */
export function convertRequest(model: string, raw: string, stream = false): string {
  return convertOpenAIResponsesRequestToClaudeResult(model, raw, stream, false, clientToolSearchEnabled()).body;
}

/** Go: the request translation with its error. */
export function convertRequestWithError(model: string, raw: string, stream = false): { body: string; err: Error | undefined } {
  return convertOpenAIResponsesRequestToClaudeResult(model, raw, stream, false, clientToolSearchEnabled());
}

export function parseSSEEvent(chunk: string): [string, JSONObject] {
  let event = "";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    else if (line.startsWith("data: ")) data = line.slice("data: ".length);
  }
  expect(data).not.toBe("");
  return [event, JSON.parse(data)];
}

/** Go: translateClaudeResponsesStreamThroughRegistry. */
export function translateStreamThroughRegistry(chunks: string[], state: TranslatorState = {}): string[] {
  const outputs: string[] = [];
  for (const chunk of chunks) {
    outputs.push(...defaultRegistry.translateStream(emptyContext, FormatClaude, FormatOpenAIResponse, "claude-test", "", "", chunk, state));
  }
  return outputs;
}

export function streamEvents(outputs: string[]): [string, JSONObject][] {
  return outputs.map(parseSSEEvent);
}

/** The data of the last terminal event (completed / incomplete / failed). */
export function terminalEvent(outputs: string[], type = "response.completed"): JSONObject | undefined {
  let found: JSONObject | undefined;
  for (const [event, data] of streamEvents(outputs)) if (event === type) found = data;
  return found;
}

/** Content block types of the last Claude assistant message. */
export function claudeAssistantBlockTypes(claudeReq: string): string[] {
  let kinds: string[] = [];
  for (const m of get(claudeReq, "messages") ?? []) {
    if (m.role !== "assistant") continue;
    kinds = Array.isArray(m.content) ? m.content.map((b: JSONObject) => b.type) : [];
  }
  return kinds;
}

export function responsesRequestFromItems(...items: string[]): string {
  return `{"model":"claude-test","input":[${items.join(",")}]}`;
}

export const responsesReasoningItem = (signature: string, text: string): string =>
  `{"type":"reasoning","encrypted_content":${JSON.stringify(signature)},"summary":[{"type":"summary_text","text":${JSON.stringify(text)}}]}`;
export const responsesFunctionCallItem = (callID: string, name: string): string =>
  `{"type":"function_call","call_id":${JSON.stringify(callID)},"name":${JSON.stringify(name)},"arguments":"{}"}`;
export const responsesFunctionCallOutputItem = (callID: string, output: string): string =>
  `{"type":"function_call_output","call_id":${JSON.stringify(callID)},"output":${JSON.stringify(output)}}`;
export const responsesWebSearchCallItem = (id: string, query: string): string =>
  `{"type":"web_search_call","id":${JSON.stringify(id)},"status":"completed","action":{"type":"search","query":${JSON.stringify(query)}}}`;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}
const tag = (num: number, wire: number): number[] => varint((num << 3) | wire);
const bytesField = (num: number, b: number[]): number[] => [...tag(num, 2), ...varint(b.length), ...b];

/** Go: testClaudeResponsesThinkingSignatureForModel -> [raw signature, normalized signature]. */
export function testClaudeThinkingSignatureForModel(model = "claude-sonnet-4-6"): [string, string] {
  const channelBlock = [...tag(1, 0), ...varint(12), ...tag(2, 0), ...varint(2), ...bytesField(6, [...new TextEncoder().encode(model)])];
  const container = bytesField(1, channelBlock);
  const payload = [...bytesField(2, container), ...tag(3, 0), ...varint(1)];
  const raw = Buffer.from(payload).toString("base64");
  const normalized = compatibleSignatureForProvider(SignatureProviderClaude, raw);
  if (normalized === undefined) throw new Error("test Claude signature should be compatible");
  return [raw, normalized];
}

/** Go: testGPTResponsesReasoningSignature. */
export function testGPTReasoningSignature(): string {
  const payload = new Uint8Array(1 + 8 + 16 + 16 + 32);
  payload[0] = 0x80;
  payload[8] = 1;
  for (let i = 9; i < payload.length; i++) payload[i] = i;
  return Buffer.from(payload).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

/** Go: claudeWebSearchStreamChunks. */
export function claudeWebSearchStreamChunks(): string[] {
  return [
    `data: {"type":"message_start","message":{"id":"msg_ws","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"lindorm vector\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","title":"Lindorm Vector","url":"https://example.com/a","encrypted_content":"ENC_A","page_age":"1 day"},{"type":"web_search_result","title":"Docs","url":"https://example.com/b","encrypted_content":"ENC_B"}]}}`,
    `data: {"type":"content_block_stop","index":1}`,
    `data: {"type":"message_stop"}`,
  ];
}

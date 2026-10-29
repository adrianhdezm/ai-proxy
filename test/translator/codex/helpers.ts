// Shared helpers for the Codex <-> Claude translator tests (ports of the Go test
// helpers spread across internal/translator/codex/claude/*_test.go).
import { emptyContext, type TranslatorState } from "../../../src/translator/types.ts";
import { convertCodexResponseToClaude } from "../../../src/translator/codex/claude/index.ts";
import { encodeBase64, urlEncoding } from "../../../src/util/base64.ts";
import { getAt } from "../../../src/util/gpath.ts";

export type JSONObject = Record<string, unknown>;

/** Reads a dotted path out of a JSON string (undefined when absent). */
export function get(json: string, path: string): unknown {
  return getAt(JSON.parse(json), path);
}

/** Feeds each upstream SSE line through the stream translator with one shared state. */
export function runCodexStream(chunks: string[], originalRequest = '{"messages":[]}', model = ""): { outputs: string[]; state: TranslatorState } {
  const state: TranslatorState = {};
  const outputs: string[] = [];
  for (const chunk of chunks) outputs.push(...convertCodexResponseToClaude(emptyContext, model, originalRequest, "", chunk, state));
  return { outputs, state };
}

/** The parsed "data:" payloads of every frame in order (Go: the per-line gjson.Parse loop). */
export function dataEvents(outputs: string[]): JSONObject[] {
  const events: JSONObject[] = [];
  for (const out of outputs) {
    for (const line of out.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      events.push(JSON.parse(line.slice("data: ".length)) as JSONObject);
    }
  }
  return events;
}

export function findClaudeStreamMessageDelta(outputs: string[]): JSONObject | undefined {
  return dataEvents(outputs).find((event) => event.type === "message_delta");
}

export function findClaudeStreamStopReason(outputs: string[]): string | undefined {
  const delta = findClaudeStreamMessageDelta(outputs);
  return delta === undefined ? undefined : (getAt(delta, "delta.stop_reason") as string);
}

export function firstClaudeStreamPayloadForEvent(output: string, event: string): JSONObject | undefined {
  let currentEvent = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
      continue;
    }
    if (currentEvent !== event || !line.startsWith("data: ")) continue;
    return JSON.parse(line.slice("data: ".length)) as JSONObject;
  }
  return undefined;
}

export function countRequestInputItemsByType(result: string, itemType: string): number {
  const input = get(result, "input");
  if (!Array.isArray(input)) return 0;
  return input.filter((item) => getAt(item, "type") === itemType).length;
}

/** A GPT-shaped reasoning signature: 73 bytes, version marker 0x80, flag byte at offset 8. */
export function validCodexReasoningSignature(): string {
  const raw = new Uint8Array(1 + 8 + 16 + 16 + 32);
  raw[0] = 0x80;
  raw[8] = 1;
  return encodeBase64(raw, urlEncoding);
}

/** Shape-valid synthetic Meta envelope; no captured value is embedded. */
export function testMetaClaudeSignature(): string {
  let signature = "Q-PaDgE";
  while (signature.length < 1426) signature += "A";
  return signature;
}

export interface CodexClaudeBlocks {
  text: string[];
  thinking: string[];
  signatures: string[];
}

/** Collects the text/thinking block contents and signature deltas of a stream (Go: collectCodexClaudeBlocks). */
export function collectCodexClaudeBlocks(chunks: string[]): CodexClaudeBlocks {
  const { outputs } = runCodexStream(chunks);
  const blocks: CodexClaudeBlocks = { text: [], thinking: [], signatures: [] };
  let cur = "";
  let curType = "";
  for (const data of dataEvents(outputs)) {
    switch (data.type) {
      case "content_block_start":
        curType = getAt(data, "content_block.type") as string;
        cur = "";
        break;
      case "content_block_delta":
        switch (getAt(data, "delta.type")) {
          case "text_delta":
            cur += getAt(data, "delta.text") as string;
            break;
          case "thinking_delta":
            cur += getAt(data, "delta.thinking") as string;
            break;
          case "signature_delta":
            blocks.signatures.push(getAt(data, "delta.signature") as string);
            break;
        }
        break;
      case "content_block_stop":
        if (curType === "text") blocks.text.push(cur);
        else if (curType === "thinking") blocks.thinking.push(cur);
        curType = "";
        break;
    }
  }
  return blocks;
}

export interface CodexClaudeContentBlock {
  index: number;
  type: string;
  id: string;
  name: string;
  text: string;
  arguments: string;
}

/**
 * Walks the Claude frames and asserts the content block lifecycle: no overlapping
 * blocks, no index reuse, message_delta then message_stop with nothing after.
 * Returns the blocks in start order (Go: assertCodexClaudeContentBlockLifecycle).
 */
export function assertCodexClaudeContentBlockLifecycle(outputs: string[]): CodexClaudeContentBlock[] {
  const open = new Map<number, CodexClaudeContentBlock>();
  const started = new Set<number>();
  const blocks: CodexClaudeContentBlock[] = [];
  let messageState = 0;
  for (const event of dataEvents(outputs)) {
    if (messageState === 2) throw new Error(`event emitted after message_stop: ${JSON.stringify(event)}`);
    const index = typeof event.index === "number" ? event.index : 0;
    switch (event.type) {
      case "content_block_start": {
        if (messageState !== 0) throw new Error(`content block started after message terminal events: ${JSON.stringify(event)}`);
        if (open.size !== 0) throw new Error(`content block start emitted while another block remains open: ${[...open.keys()]}`);
        if (started.has(index)) throw new Error(`content block index ${index} was reused`);
        const block: CodexClaudeContentBlock = {
          index,
          type: (getAt(event, "content_block.type") as string) ?? "",
          id: (getAt(event, "content_block.id") as string) ?? "",
          name: (getAt(event, "content_block.name") as string) ?? "",
          text: "",
          arguments: "",
        };
        open.set(index, block);
        started.add(index);
        blocks.push(block);
        break;
      }
      case "content_block_delta": {
        const block = open.get(index);
        if (block === undefined) throw new Error(`content block delta targets unopened index ${index}`);
        switch (getAt(event, "delta.type")) {
          case "input_json_delta":
            block.arguments += getAt(event, "delta.partial_json") as string;
            break;
          case "text_delta":
            block.text += getAt(event, "delta.text") as string;
            break;
        }
        break;
      }
      case "content_block_stop":
        if (!open.has(index)) throw new Error(`content block stop targets unopened index ${index}`);
        open.delete(index);
        break;
      case "message_delta":
        if (open.size !== 0) throw new Error(`message_delta emitted while content blocks remain open: ${[...open.keys()]}`);
        if (messageState !== 0) throw new Error(`duplicate or out-of-order message_delta: ${JSON.stringify(event)}`);
        messageState = 1;
        break;
      case "message_stop":
        if (open.size !== 0) throw new Error(`message_stop emitted while content blocks remain open: ${[...open.keys()]}`);
        if (messageState !== 1) throw new Error(`message_stop emitted before message_delta: ${JSON.stringify(event)}`);
        messageState = 2;
        break;
    }
  }
  if (open.size !== 0) throw new Error(`content blocks remain open: ${[...open.keys()]}`);
  return blocks;
}

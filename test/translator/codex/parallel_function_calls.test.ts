// Ported from: test/codex_claude_parallel_function_calls_test.go
// Skipped cases: none
//
// Cross-module: drives the Codex -> Claude stream translator through the default
// registry (Go: sdktranslator.TranslateStream), not the function directly.
import { expect, test } from "bun:test";
import "../../../src/translator/codex/claude/index.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { FormatClaude, FormatCodex, type TranslatorState, emptyContext } from "../../../src/translator/types.ts";
import { getAt } from "../../../src/util/gpath.ts";
import { dataEvents } from "./helpers.ts";

test("Codex to Claude parallel function calls have valid lifecycle", () => {
  const chunks = [
    `data: {"type":"response.created","response":{"id":"resp_parallel","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read"},"output_index":1}`,
    `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_b","name":"Read"},"output_index":2}`,
    `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":\\"a\\"}","output_index":1}`,
    `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"a\\"}","output_index":1}`,
    `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},"output_index":1}`,
    `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":\\"b\\"}","output_index":2}`,
    `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"b\\"}","output_index":2}`,
    `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_b","name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"},"output_index":2}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},{"type":"function_call","call_id":"call_b","name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"}]}}`,
  ];

  const originalRequest = `{"stream":true,"tools":[{"name":"Read"}]}`;
  const state: TranslatorState = {};
  const open = new Set<number>();
  const started = new Set<number>();
  const toolIDs = new Map<number, string>();
  const args = new Map<number, string>();
  const startIndices: number[] = [];
  const stopIndices: number[] = [];
  let messageState = 0;

  for (const chunk of chunks) {
    const outputs = defaultRegistry.translateStream(emptyContext, FormatCodex, FormatClaude, "gpt-5", originalRequest, "", chunk, state);
    for (const event of dataEvents(outputs)) {
      expect(messageState, `event emitted after message_stop: ${JSON.stringify(event)}`).not.toBe(2);
      const index = typeof event.index === "number" ? event.index : 0;
      switch (event.type) {
        case "content_block_start":
          expect(messageState, "content block started after message terminal events").toBe(0);
          expect(open.size, "content block start emitted while another block remains open").toBe(0);
          expect(started.has(index), `content block index ${index} was reused`).toBe(false);
          open.add(index);
          started.add(index);
          startIndices.push(index);
          toolIDs.set(index, getAt(event, "content_block.id") as string);
          break;
        case "content_block_delta":
          expect(open.has(index), `content block delta targets unopened index ${index}`).toBe(true);
          if (getAt(event, "delta.type") === "input_json_delta") args.set(index, (args.get(index) ?? "") + (getAt(event, "delta.partial_json") as string));
          break;
        case "content_block_stop":
          expect(open.has(index), `content block stop targets unopened index ${index}`).toBe(true);
          open.delete(index);
          stopIndices.push(index);
          break;
        case "message_delta":
          expect(open.size, "message_delta emitted while content blocks remain open").toBe(0);
          expect(messageState, "duplicate or out-of-order message_delta").toBe(0);
          messageState = 1;
          break;
        case "message_stop":
          expect(open.size, "message_stop emitted while content blocks remain open").toBe(0);
          expect(messageState, "message_stop emitted before message_delta").toBe(1);
          messageState = 2;
          break;
      }
    }
  }

  expect(open.size).toBe(0);
  expect(messageState).toBe(2);
  expect(startIndices).toEqual([0, 1]);
  expect(stopIndices).toEqual([0, 1]);
  expect(toolIDs.get(0)).toBe("call_a");
  expect(toolIDs.get(1)).toBe("call_b");
  expect(args.get(0)).toBe(`{"file_path":"a"}`);
  expect(args.get(1)).toBe(`{"file_path":"b"}`);
});

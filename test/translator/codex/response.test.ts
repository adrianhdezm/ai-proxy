// Ported from: internal/translator/codex/claude/codex_claude_response_test.go
// Skipped cases: none (the int64-overflow usage rows compare against the nearest
// IEEE double since JSON numbers are doubles in TS)
import { describe, expect, test } from "bun:test";
import { emptyContext } from "../../../src/translator/types.ts";
import {
  ConvertCodexResponseToClaudeParams,
  convertCodexResponseToClaude,
  convertCodexResponseToClaudeNonStream,
  extractResponsesUsage,
} from "../../../src/translator/codex/claude/index.ts";
import { getAt } from "../../../src/util/gpath.ts";
import { dataEvents, findClaudeStreamMessageDelta, findClaudeStreamStopReason, firstClaudeStreamPayloadForEvent, get, runCodexStream } from "./helpers.ts";

function nonStream(originalRequest: string, response: string): string {
  return convertCodexResponseToClaudeNonStream(emptyContext, "", originalRequest, "", response, {});
}

test("stream thinking includes signature", () => {
  const { outputs } = runCodexStream([
    `data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-5"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_sig_123"}}`,
  ]);
  let startFound = false;
  let signatureDeltaFound = false;
  let stopFound = false;
  for (const data of dataEvents(outputs)) {
    switch (data.type) {
      case "content_block_start":
        if (getAt(data, "content_block.type") === "thinking") {
          startFound = true;
          expect(getAt(data, "content_block.signature")).toBeUndefined();
        }
        break;
      case "content_block_delta":
        if (getAt(data, "delta.type") === "signature_delta") {
          signatureDeltaFound = true;
          expect(getAt(data, "delta.signature")).toBe("enc_sig_123");
        }
        break;
      case "content_block_stop":
        stopFound = true;
        break;
    }
  }
  expect(startFound).toBe(true);
  expect(signatureDeltaFound).toBe(true);
  expect(stopFound).toBe(true);
});

test("stream cyber policy error", () => {
  const outputs = convertCodexResponseToClaude(
    emptyContext,
    "",
    `{"messages":[]}`,
    "",
    `data: {"type":"error","error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk.","param":null},"sequence_number":3}`,
    {},
  );
  expect(outputs.length).toBe(1);
  const out = outputs[0]!;
  expect(out).toContain("event: error\n");
  const payload = firstClaudeStreamPayloadForEvent(out, "error");
  expect(payload).toBeDefined();
  expect(payload!.type).toBe("error");
  expect(getAt(payload, "error.type")).toBe("invalid_request_error");
  expect(getAt(payload, "error.message")).toBe("This content was flagged for possible cybersecurity risk.");
});

test("stream error type fallback message", () => {
  const outputs = convertCodexResponseToClaude(emptyContext, "", `{"messages":[]}`, "", `data: {"type":"error","error":{},"error_type":"overloaded_error"}`, {});
  expect(outputs.length).toBe(1);
  const payload = firstClaudeStreamPayloadForEvent(outputs[0]!, "error");
  expect(payload).toBeDefined();
  expect(getAt(payload, "error.type")).toBe("overloaded_error");
  expect(getAt(payload, "error.message")).toBe("overloaded_error");
});

test("stream thinking without reasoning item still includes signature field", () => {
  const { outputs } = runCodexStream([
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  let thinkingStartFound = false;
  let thinkingStopFound = false;
  let signatureDeltaFound = false;
  for (const data of dataEvents(outputs)) {
    if (data.type === "content_block_start" && getAt(data, "content_block.type") === "thinking") {
      thinkingStartFound = true;
      expect(getAt(data, "content_block.signature")).toBeUndefined();
    }
    if (data.type === "content_block_stop" && data.index === 0) thinkingStopFound = true;
    if (data.type === "content_block_delta" && getAt(data, "delta.type") === "signature_delta") signatureDeltaFound = true;
  }
  expect(thinkingStartFound).toBe(true);
  expect(thinkingStopFound).toBe(true);
  expect(signatureDeltaFound).toBe(false);
});

interface CodexThinkingStreamDigest {
  starts: number;
  stops: number;
  signatures: string[];
  thinking: string;
  raw: string;
}

function digestCodexThinkingStream(chunks: string[]): CodexThinkingStreamDigest {
  const { outputs } = runCodexStream(chunks);
  const digest: CodexThinkingStreamDigest = { starts: 0, stops: 0, signatures: [], thinking: "", raw: outputs.join("") };
  for (const data of dataEvents(outputs)) {
    switch (data.type) {
      case "content_block_start":
        if (getAt(data, "content_block.type") === "thinking") digest.starts++;
        break;
      case "content_block_delta":
        if (getAt(data, "delta.type") === "thinking_delta") digest.thinking += getAt(data, "delta.thinking") as string;
        if (getAt(data, "delta.type") === "signature_delta") digest.signatures.push(getAt(data, "delta.signature") as string);
        break;
      case "content_block_stop":
        digest.stops++;
        break;
    }
  }
  return digest;
}

test("stream thinking keeps single block across summary parts", () => {
  const digest = digestCodexThinkingStream([
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"First part"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Second part"}`,
  ]);
  expect(digest.starts).toBe(1);
  expect(digest.stops).toBe(0);
  expect(digest.thinking).toBe("First part\n\nSecond part");
});

test("stream thinking emits single signature across multipart reasoning", () => {
  const digest = digestCodexThinkingStream([
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_sig_multipart"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"First part"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Second part"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning"}}`,
  ]);
  expect(digest.starts).toBe(1);
  expect(digest.stops).toBe(1);
  // output_item.done omitted encrypted_content here, so the pre-content fallback is expected.
  expect(digest.signatures).toEqual(["enc_sig_multipart"]);
  expect(digest.thinking).toBe("First part\n\nSecond part");
});

test("stream thinking never emits pre-content encrypted_content", () => {
  const digest = digestCodexThinkingStream([
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_sig_pre_content_snapshot"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Part A"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Part B"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Part C"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_sig_final"}}`,
  ]);
  expect(digest.starts).toBe(1);
  expect(digest.stops).toBe(1);
  expect(digest.signatures).toEqual(["enc_sig_final"]);
  expect(digest.raw).not.toContain("enc_sig_pre_content_snapshot");
  expect(digest.thinking).toBe("Part A\n\nPart B\n\nPart C");
});

test("stream thinking emits one block per reasoning item", () => {
  const digest = digestCodexThinkingStream([
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_pre_1"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"First item"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_final_1"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_pre_2"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Second item"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_final_2"}}`,
  ]);
  expect(digest.starts).toBe(2);
  expect(digest.stops).toBe(2);
  expect(digest.signatures).toEqual(["enc_final_1", "enc_final_2"]);
  expect(digest.raw).not.toContain("enc_pre_1");
  expect(digest.raw).not.toContain("enc_pre_2");
});

test("stream thinking uses early captured signature when done omits it", () => {
  const { outputs } = runCodexStream([
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_sig_early"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning"}}`,
  ]);
  const signatures = dataEvents(outputs)
    .filter((d) => d.type === "content_block_delta" && getAt(d, "delta.type") === "signature_delta")
    .map((d) => getAt(d, "delta.signature"));
  expect(signatures).toEqual(["enc_sig_early"]);
});

test("stream thinking uses final done signature", () => {
  const { outputs } = runCodexStream([
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_sig_initial"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_sig_final"}}`,
  ]);
  let signatureDeltaCount = 0;
  const events: string[] = [];
  for (const data of dataEvents(outputs)) {
    if (data.type === "content_block_start" && getAt(data, "content_block.type") === "thinking") events.push("thinking_start");
    if (data.type === "content_block_delta" && getAt(data, "delta.type") === "thinking_delta") events.push("thinking_delta");
    if (data.type === "content_block_stop" && data.index === 0) events.push("thinking_stop");
    if (data.type !== "content_block_delta" || getAt(data, "delta.type") !== "signature_delta") continue;
    events.push("signature_delta");
    signatureDeltaCount++;
    expect(getAt(data, "delta.signature")).toBe("enc_sig_final");
  }
  expect(signatureDeltaCount).toBe(1);
  expect(events.join(",")).toBe("thinking_start,thinking_delta,signature_delta,thinking_stop");
});

test("stream signature-only reasoning emits thinking signature", () => {
  const { outputs } = runCodexStream([
    `data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_sig_initial"}}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_sig_only"}}`,
    `data: {"type":"response.content_part.added"}`,
    `data: {"type":"response.output_text.delta","delta":"ok"}`,
  ]);
  let thinkingStartFound = false;
  let thinkingDeltaFound = false;
  let signatureDeltaFound = false;
  let thinkingStopFound = false;
  let textStartIndex = -1;
  const events: string[] = [];
  for (const data of dataEvents(outputs)) {
    switch (data.type) {
      case "content_block_start":
        if (getAt(data, "content_block.type") === "thinking") {
          events.push("thinking_start");
          thinkingStartFound = true;
          expect(data.index).toBe(0);
        }
        if (getAt(data, "content_block.type") === "text") {
          events.push("text_start");
          textStartIndex = data.index as number;
        }
        break;
      case "content_block_delta":
        if (getAt(data, "delta.type") === "thinking_delta") thinkingDeltaFound = true;
        if (getAt(data, "delta.type") === "signature_delta") {
          events.push("signature_delta");
          signatureDeltaFound = true;
          expect(data.index).toBe(0);
          expect(getAt(data, "delta.signature")).toBe("enc_sig_only");
        }
        break;
      case "content_block_stop":
        if (data.index === 0) {
          events.push("thinking_stop");
          thinkingStopFound = true;
        }
        break;
    }
  }
  expect(thinkingStartFound).toBe(true);
  expect(thinkingDeltaFound).toBe(false);
  expect(signatureDeltaFound).toBe(true);
  expect(thinkingStopFound).toBe(true);
  expect(textStartIndex).toBe(1);
  expect(events.join(",")).toBe("thinking_start,signature_delta,thinking_stop,text_start");
});

test("non-stream thinking includes signature", () => {
  const response = `{"type":"response.completed","response":{"id":"resp_123","model":"gpt-5","usage":{"input_tokens":10,"output_tokens":20},"output":[
    {"type":"reasoning","encrypted_content":"enc_sig_nonstream","summary":[{"type":"summary_text","text":"internal reasoning"}]},
    {"type":"message","content":[{"type":"output_text","text":"final answer"}]}
  ]}}`;
  const out = nonStream(`{"messages":[]}`, response);
  expect(get(out, "content.0.type")).toBe("thinking");
  expect(get(out, "content.0.signature")).toBe("enc_sig_nonstream");
  expect(get(out, "content.0.thinking")).toBe("internal reasoning");
});

test("stream text before tool calls does not emit ghost stop", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"grok-composer-2.5-fast"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"message","status":"in_progress"},"output_index":1}`,
      `data: {"type":"response.content_part.added","part":{"type":"output_text"},"content_index":0,"output_index":1}`,
      `data: {"type":"response.output_text.delta","delta":"查看项目的 README 和核心入口，以便准确说明项目用途。\\n","output_index":1}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read","status":"in_progress"},"output_index":2}`,
      `data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"/tmp/README.md\\"}","output_index":2}`,
      `data: {"type":"response.function_call_arguments.done","arguments":"{\\"path\\":\\"/tmp/README.md\\"}","output_index":2}`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"path\\":\\"/tmp/README.md\\"}"},"output_index":2}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_b","name":"Read","status":"in_progress"},"output_index":3}`,
      `data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"/tmp/main.go\\"}","output_index":3}`,
      `data: {"type":"response.content_part.done","part":{"type":"output_text"},"content_index":0,"output_index":1}`,
      `data: {"type":"response.output_item.done","item":{"type":"message","status":"completed"},"output_index":1}`,
      `data: {"type":"response.function_call_arguments.done","arguments":"{\\"path\\":\\"/tmp/main.go\\"}","output_index":3}`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_b","name":"Read","arguments":"{\\"path\\":\\"/tmp/main.go\\"}"},"output_index":3}`,
      `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
    ],
    `{"tools":[{"name":"Read","description":"read"}]}`,
  );
  const startIndices: number[] = [];
  const stopIndices: number[] = [];
  for (const data of dataEvents(outputs)) {
    if (data.type === "content_block_start") startIndices.push(data.index as number);
    if (data.type === "content_block_stop") stopIndices.push(data.index as number);
  }
  expect(startIndices).toEqual([0, 1, 2]);
  expect(stopIndices).toEqual([0, 1, 2]);
});

test("stream function call defers start until done name", () => {
  const originalRequest = `{"tools":[{"name":"web_search","description":"search"}]}`;
  const state = {};
  convertCodexResponseToClaude(emptyContext, "", originalRequest, "", `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`, state);
  const addedOutputs = convertCodexResponseToClaude(emptyContext, "", originalRequest, "", `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1"},"output_index":1}`, state);
  const argumentsOutputs = convertCodexResponseToClaude(emptyContext, "", originalRequest, "", `data: {"type":"response.function_call_arguments.done","arguments":"{\\"query\\":\\"example\\"}","output_index":1}`, state);
  const doneOutputs = convertCodexResponseToClaude(
    emptyContext,
    "",
    originalRequest,
    "",
    `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"web_search","arguments":"{\\"query\\":\\"example\\"}"},"output_index":1}`,
    state,
  );
  expect(addedOutputs.join("")).not.toContain(`"content_block_start"`);
  expect(argumentsOutputs.join("")).not.toContain(`"input_json_delta"`);

  let toolStartCount = 0;
  let toolStopCount = 0;
  const argumentDeltas: string[] = [];
  for (const data of dataEvents(doneOutputs)) {
    switch (data.type) {
      case "content_block_start":
        if (getAt(data, "content_block.type") !== "tool_use") continue;
        toolStartCount++;
        expect(getAt(data, "content_block.name")).toBe("web_search");
        break;
      case "content_block_delta":
        if (getAt(data, "delta.type") === "input_json_delta") argumentDeltas.push(getAt(data, "delta.partial_json") as string);
        break;
      case "content_block_stop":
        toolStopCount++;
        break;
    }
  }
  expect(toolStartCount).toBe(1);
  expect(argumentDeltas).toEqual([`{"query":"example"}`]);
  expect(toolStopCount).toBe(1);
});

test("stream unnamed function call done by call_id keeps pending slots", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_first"},"output_index":1}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_second"},"output_index":2}`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_first","name":"lookup","arguments":"{\\"id\\":1}"}}`,
      `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_second","name":"lookup","arguments":"{\\"id\\":2}"}}`,
    ],
    `{"tools":[{"name":"lookup","description":"lookup"}]}`,
  );
  const toolIDs: string[] = [];
  const startIndices: number[] = [];
  const stopIndices: number[] = [];
  const argumentDeltas: string[] = [];
  for (const data of dataEvents(outputs)) {
    switch (data.type) {
      case "content_block_start":
        if (getAt(data, "content_block.type") === "tool_use") {
          toolIDs.push(getAt(data, "content_block.id") as string);
          startIndices.push(data.index as number);
        }
        break;
      case "content_block_delta":
        if (getAt(data, "delta.type") === "input_json_delta") argumentDeltas.push(getAt(data, "delta.partial_json") as string);
        break;
      case "content_block_stop":
        stopIndices.push(data.index as number);
        break;
    }
  }
  expect(toolIDs).toEqual(["call_first", "call_second"]);
  expect(startIndices).toEqual([0, 1]);
  expect(stopIndices).toEqual([0, 1]);
  expect(argumentDeltas).toEqual([`{"id":1}`, `{"id":2}`]);
});

test("stream deferred unnamed function call does not reserve block index", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_hidden"},"output_index":1}`,
      `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]},"output_index":2}`,
    ],
    `{"tools":[{"name":"lookup","description":"lookup"}]}`,
  );
  const textStart = dataEvents(outputs).find((d) => d.type === "content_block_start" && getAt(d, "content_block.type") === "text");
  expect(textStart).toBeDefined();
  expect(textStart!.index).toBe(0);
});

test("stream terminal output hydrates open function call arguments", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"lookup"},"output_index":1}`,
      `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"query\\":\\"example\\"}"}]}}`,
    ],
    `{"tools":[{"name":"lookup","description":"lookup"}]}`,
  );
  let finalArgumentPosition = -1;
  let stopPosition = -1;
  let messageDeltaPosition = -1;
  let position = 0;
  for (const data of dataEvents(outputs)) {
    position++;
    switch (data.type) {
      case "content_block_delta":
        if (getAt(data, "delta.type") === "input_json_delta" && getAt(data, "delta.partial_json") === `{"query":"example"}`) finalArgumentPosition = position;
        break;
      case "content_block_stop":
        if (data.index === 0) stopPosition = position;
        break;
      case "message_delta":
        messageDeltaPosition = position;
        break;
    }
  }
  expect(finalArgumentPosition).not.toBe(-1);
  expect(stopPosition).not.toBe(-1);
  expect(messageDeltaPosition).not.toBe(-1);
  expect(finalArgumentPosition < stopPosition && stopPosition < messageDeltaPosition).toBe(true);
});

test("stream terminal output emits pending unnamed function call", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1"},"output_index":1}`,
      `data: {"type":"response.function_call_arguments.done","arguments":"{\\"query\\":\\"example\\"}","output_index":1}`,
      `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"query\\":\\"example\\"}"}]}}`,
    ],
    `{"tools":[{"name":"lookup","description":"lookup"}]}`,
  );
  const outputText = outputs.join("");
  expect(outputText.split(`"type":"tool_use"`).length - 1).toBe(1);
  expect(outputText).toContain(`"name":"lookup"`);
  expect(outputText).toContain(`"partial_json":"{\\"query\\":\\"example\\"}"`);
  expect(findClaudeStreamStopReason(outputs)).toBe("tool_use");
  const toolUsePosition = outputText.indexOf(`"type":"tool_use"`);
  const messageDeltaPosition = outputText.indexOf(`"type":"message_delta"`);
  expect(toolUsePosition >= 0 && messageDeltaPosition >= 0 && toolUsePosition < messageDeltaPosition).toBe(true);
});

test("stream unresolved pending function call does not force tool_use stop reason", () => {
  const { outputs, state } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_hidden"},"output_index":1}`,
      `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1},"output":[]}}`,
    ],
    `{"tools":[{"name":"lookup","description":"lookup"}]}`,
  );
  const outputText = outputs.join("");
  expect(outputText).not.toContain(`"type":"tool_use"`);
  expect(findClaudeStreamStopReason(outputs)).toBe("end_turn");
  const params = state.value as ConvertCodexResponseToClaudeParams;
  expect(params).toBeInstanceOf(ConvertCodexResponseToClaudeParams);
  expect(params.functionCalls.size).toBe(0);
  expect(params.functionCallQueue.length).toBe(0);
  expect(params.lastFunctionCall).toBeUndefined();
});

test("stream empty output uses output_item.done message fallback", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]},"output_index":0}`,
      `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
    ],
    `{"tools":[]}`,
  );
  const foundText = dataEvents(outputs).some((d) => d.type === "content_block_delta" && getAt(d, "delta.type") === "text_delta" && getAt(d, "delta.text") === "ok");
  expect(foundText).toBe(true);
});

test("stream web_search_call emits Claude server tool blocks", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}`,
      `data: {"type":"response.output_item.added","item":{"id":"ws_123","type":"web_search_call","status":"in_progress"}}`,
      `data: {"type":"response.web_search_call.searching","item_id":"ws_123"}`,
      `data: {"type":"response.web_search_call.completed","item_id":"ws_123"}`,
      `data: {"type":"response.output_item.done","item":{"id":"ws_123","type":"web_search_call","status":"completed","action":{"type":"search","query":"search weather"}}}`,
      `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":3,"output_tokens":2}}}`,
    ],
    `{"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search weather"}]}`,
  );
  const outputText = outputs.join("");
  for (const needle of [`"type":"server_tool_use"`, `"id":"ws_123"`, `"type":"web_search_tool_result"`, `event: message_stop`]) {
    expect(outputText).toContain(needle);
  }
  const serverToolIndex = outputText.indexOf(`"type":"server_tool_use"`);
  const resultIndex = outputText.indexOf(`"type":"web_search_tool_result"`);
  expect(serverToolIndex >= 0 && resultIndex >= 0 && resultIndex >= serverToolIndex).toBe(true);
  expect(outputText).toContain("partial_json");
  expect(outputText).toContain("search weather");
});

test("stream web_search_call reuses fallback tool_use id", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"web_search_call","status":"in_progress"}}`,
      `data: {"type":"response.web_search_call.completed","item_id":"ws_from_upstream"}`,
      `data: {"type":"response.output_item.done","item":{"id":"ws_from_upstream","type":"web_search_call","status":"completed","action":{"type":"search","query":"search weather"}}}`,
      `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":3,"output_tokens":2}}}`,
    ],
    `{"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search weather"}]}`,
  );
  const outputText = outputs.join("");
  expect(outputText.split(`"type":"server_tool_use"`).length - 1).toBe(1);
  expect(outputText).toContain(`"tool_use_id":"ws_from_upstream"`);
});

test("stream web_search_call action sources", () => {
  const { outputs } = runCodexStream(
    [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"grok-4"}}`,
      `data: {"type":"response.output_item.added","item":{"id":"ws_123","type":"web_search_call","status":"in_progress"}}`,
      `data: {"type":"response.output_item.done","item":{"id":"ws_123","type":"web_search_call","status":"completed","action":{"type":"search","query":"xAI web search docs","sources":[{"type":"url","url":"https://docs.x.ai/developers/tools/web-search","title":"xAI Docs"},{"type":"url","url":"https://example.com/notitle"},{"type":"url","url":""},{"type":"url","url":"   "}]}}}`,
      `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":5,"output_tokens":10}}}`,
    ],
    `{"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search xai docs"}]}`,
  );
  let webSearchResultBlock: unknown;
  for (const data of dataEvents(outputs)) {
    if (data.type === "content_block_start" && getAt(data, "content_block.type") === "web_search_tool_result") webSearchResultBlock = data.content_block;
  }
  expect(webSearchResultBlock).toBeDefined();
  const content = getAt(webSearchResultBlock, "content") as unknown[];
  expect(content.length).toBe(2);
  expect(getAt(content[0], "url")).toBe("https://docs.x.ai/developers/tools/web-search");
  expect(getAt(content[0], "title")).toBe("xAI Docs");
  expect(getAt(content[1], "url")).toBe("https://example.com/notitle");
  expect(getAt(content[1], "title")).toBe("https://example.com/notitle");
});

describe("shortens long tool_use IDs", () => {
  const longCallID = "call_" + "a".repeat(62);
  expect(longCallID.length).toBeGreaterThan(64);

  test("stream", () => {
    const originalRequest = `{"tools":[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]}`;
    const outputs = convertCodexResponseToClaude(emptyContext, "", originalRequest, "", `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"${longCallID}","name":"lookup"}}`, {});
    let toolID = "";
    for (const data of dataEvents(outputs)) {
      if (data.type === "content_block_start" && getAt(data, "content_block.type") === "tool_use") toolID = getAt(data, "content_block.id") as string;
    }
    expect(toolID).not.toBe("");
    expect(toolID.length).toBeLessThanOrEqual(64);
    expect(toolID).not.toBe(longCallID);
  });

  test("nonstream", () => {
    const originalRequest = `{"tools":[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]}`;
    const response = `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"${longCallID}","name":"lookup","arguments":"{}"}]}}`;
    const out = nonStream(originalRequest, response);
    const toolID = get(out, "content.0.id") as string;
    expect(toolID).not.toBe("");
    expect(toolID.length).toBeLessThanOrEqual(64);
    expect(toolID).not.toBe(longCallID);
  });
});

describe("stream stop reason mapping", () => {
  const tests: { name: string; chunks: string[]; wantReason: string }[] = [
    { name: "Stop maps to end_turn", chunks: [`data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1}}}`], wantReason: "end_turn" },
    {
      name: "Incomplete max output maps to max_tokens",
      chunks: [`data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":1,"output_tokens":1}}}`],
      wantReason: "max_tokens",
    },
    {
      name: "Tool call wins over stop",
      chunks: [
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"lookup"}}`,
        `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1}}}`,
      ],
      wantReason: "tool_use",
    },
    {
      name: "Content filter maps to Claude refusal",
      chunks: [`data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"},"usage":{"input_tokens":1,"output_tokens":1}}}`],
      wantReason: "refusal",
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const { outputs } = runCodexStream(tt.chunks, `{"tools":[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]}`);
      expect(findClaudeStreamStopReason(outputs)).toBe(tt.wantReason);
    });
  }
});

test("stream stop sequence mapping", () => {
  const { outputs } = runCodexStream([`data: {"type":"response.completed","response":{"stop_reason":"stop","stop_sequence":"\\nEND","usage":{"input_tokens":1,"output_tokens":1}}}`]);
  const messageDelta = findClaudeStreamMessageDelta(outputs);
  expect(messageDelta).toBeDefined();
  expect(getAt(messageDelta, "delta.stop_reason")).toBe("stop_sequence");
  expect(getAt(messageDelta, "delta.stop_sequence")).toBe("\nEND");
});

const webSearchOriginalRequest = `{"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search weather"}]}`;
const webSearchNonStreamResponse = `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.3-codex-spark","stop_reason":"stop","usage":{"input_tokens":3,"output_tokens":2},"output":[{"type":"web_search_call","id":"ws_123","status":"completed","action":{"type":"search","query":"search weather"}},{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}`;

test("non-stream web_search_call emits server tool blocks", () => {
  const out = nonStream(webSearchOriginalRequest, webSearchNonStreamResponse);
  const types = (get(out, "content") as unknown[]).map((b) => getAt(b, "type"));
  for (const want of ["server_tool_use", "web_search_tool_result", "text"]) expect(types).toContain(want);
  expect(get(out, "content.0.input.query")).toBe("search weather");
});

test("non-stream web search stop reason end_turn", () => {
  const out = nonStream(webSearchOriginalRequest, webSearchNonStreamResponse);
  expect(get(out, "stop_reason")).toBe("end_turn");
});

test("non-stream web search dedupes empty open_page items", () => {
  const response = `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.3-codex-spark","stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"open_page"}},{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"weather"}},{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}`;
  const out = nonStream(`{"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"q"}]}`, response);
  expect(out.split(`"type":"server_tool_use"`).length - 1).toBe(1);
  expect(out).toContain("weather");
});

test("non-stream web_search_call action sources", () => {
  const response = `{"type":"response.completed","response":{"id":"resp_1","model":"grok-4","stop_reason":"stop","usage":{"input_tokens":5,"output_tokens":10},"output":[
    {"type":"web_search_call","id":"ws_123","status":"completed","action":{"type":"search","query":"xAI web search docs","sources":[
      {"type":"url","url":"https://docs.x.ai/developers/tools/web-search","title":"xAI Docs"},
      {"type":"url","url":"https://example.com/notitle"},
      {"type":"url","url":""},
      {"type":"url","url":"   "}
    ]}},
    {"type":"message","content":[{"type":"output_text","text":"here are the docs"}]}
  ]}}`;
  const out = nonStream(`{"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search xai docs"}]}`, response);
  const block = (get(out, "content") as unknown[]).find((b) => getAt(b, "type") === "web_search_tool_result");
  expect(block).toBeDefined();
  const contentArray = getAt(block, "content") as unknown[];
  expect(contentArray.length).toBe(2);
  expect(getAt(contentArray[0], "url")).toBe("https://docs.x.ai/developers/tools/web-search");
  expect(getAt(contentArray[0], "title")).toBe("xAI Docs");
  expect(getAt(contentArray[1], "url")).toBe("https://example.com/notitle");
  expect(getAt(contentArray[1], "title")).toBe("https://example.com/notitle");
});

describe("non-stream stop reason mapping", () => {
  const tests: { name: string; response: string; wantReason: string }[] = [
    { name: "Stop maps to end_turn", response: `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1},"output":[]}}`, wantReason: "end_turn" },
    {
      name: "Incomplete max output maps to max_tokens",
      response: `{"type":"response.incomplete","response":{"id":"resp_1","model":"gpt-5","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":1,"output_tokens":1},"output":[]}}`,
      wantReason: "max_tokens",
    },
    {
      name: "Tool call wins over stop",
      response: `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}"}]}}`,
      wantReason: "tool_use",
    },
    {
      name: "Content filter maps to Claude refusal",
      response: `{"type":"response.incomplete","response":{"id":"resp_1","model":"gpt-5","incomplete_details":{"reason":"content_filter"},"usage":{"input_tokens":1,"output_tokens":1},"output":[]}}`,
      wantReason: "refusal",
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const out = nonStream(`{"tools":[{"name":"lookup","input_schema":{"type":"object","properties":{}}}]}`, tt.response);
      expect(get(out, "stop_reason")).toBe(tt.wantReason);
    });
  }
});

test("non-stream stop sequence mapping", () => {
  const out = nonStream(`{"messages":[]}`, `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","stop_reason":"stop","stop_sequence":"\\nEND","usage":{"input_tokens":1,"output_tokens":1},"output":[]}}`);
  expect(get(out, "stop_reason")).toBe("stop_sequence");
  expect(get(out, "stop_sequence")).toBe("\nEND");
});

const cacheUsageCases: { name: string; usage: string; wantInput: number; wantOutput: number; wantCacheRead: number; wantCacheWrite: number }[] = [
  { name: "cache_write_tokens field", usage: `{"input_tokens":1000,"output_tokens":200,"input_tokens_details":{"cached_tokens":800,"cache_write_tokens":150}}`, wantInput: 50, wantOutput: 200, wantCacheRead: 800, wantCacheWrite: 150 },
  { name: "cache_creation_tokens field alias", usage: `{"input_tokens":1000,"output_tokens":200,"input_tokens_details":{"cached_tokens":800,"cache_creation_tokens":150}}`, wantInput: 50, wantOutput: 200, wantCacheRead: 800, wantCacheWrite: 150 },
  { name: "cached_tokens greater than input_tokens clamps input_tokens to zero", usage: `{"input_tokens":500,"output_tokens":100,"input_tokens_details":{"cached_tokens":800,"cache_write_tokens":50}}`, wantInput: 0, wantOutput: 100, wantCacheRead: 800, wantCacheWrite: 50 },
  { name: "zero cache_write_tokens does not emit cache_creation_input_tokens", usage: `{"input_tokens":1000,"output_tokens":200,"input_tokens_details":{"cached_tokens":800,"cache_write_tokens":0}}`, wantInput: 200, wantOutput: 200, wantCacheRead: 800, wantCacheWrite: 0 },
  { name: "cache_write_tokens only deducts from input_tokens", usage: `{"input_tokens":4022,"output_tokens":462,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":4019}}`, wantInput: 3, wantOutput: 462, wantCacheRead: 0, wantCacheWrite: 4019 },
  { name: "combined cached and cache_write greater than input_tokens clamps to zero", usage: `{"input_tokens":500,"output_tokens":100,"input_tokens_details":{"cached_tokens":300,"cache_write_tokens":300}}`, wantInput: 0, wantOutput: 100, wantCacheRead: 300, wantCacheWrite: 300 },
];

function assertCacheUsage(usage: unknown, tt: (typeof cacheUsageCases)[number]): void {
  expect(getAt(usage, "input_tokens")).toBe(tt.wantInput);
  expect(getAt(usage, "output_tokens")).toBe(tt.wantOutput);
  expect(getAt(usage, "cache_read_input_tokens") ?? 0).toBe(tt.wantCacheRead);
  if (tt.wantCacheWrite === 0) expect(getAt(usage, "cache_creation_input_tokens")).toBeUndefined();
  else expect(getAt(usage, "cache_creation_input_tokens")).toBe(tt.wantCacheWrite);
}

describe("stream preserves cache write usage", () => {
  for (const tt of cacheUsageCases) {
    test(tt.name, () => {
      const { outputs } = runCodexStream([
        `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
        `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}`,
        `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":${tt.usage}}}`,
      ]);
      const delta = findClaudeStreamMessageDelta(outputs);
      expect(delta).toBeDefined();
      assertCacheUsage(delta!.usage, tt);
    });
  }
});

describe("non-stream preserves cache write usage", () => {
  for (const tt of cacheUsageCases) {
    test(tt.name, () => {
      const out = nonStream(`{"messages":[]}`, `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","stop_reason":"stop","usage":${tt.usage},"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}`);
      assertCacheUsage(get(out, "usage"), tt);
    });
  }
});

const reasoningUsageCases: { name: string; usage: string; wantOutput: number; wantExist: boolean; wantTokens?: number }[] = [
  { name: "preserves positive reasoning tokens", usage: `{"input_tokens":420,"output_tokens":518,"output_tokens_details":{"reasoning_tokens":163},"total_tokens":938}`, wantOutput: 518, wantExist: true, wantTokens: 163 },
  { name: "preserves explicit zero reasoning tokens", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":0}}`, wantOutput: 50, wantExist: true, wantTokens: 0 },
  { name: "omits reasoning detail when absent", usage: `{"input_tokens":100,"output_tokens":50}`, wantOutput: 50, wantExist: false },
  { name: "clamps oversized reasoning tokens to output tokens", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":999}}`, wantOutput: 50, wantExist: true, wantTokens: 50 },
  { name: "rejects negative reasoning tokens", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":-5}}`, wantOutput: 50, wantExist: false },
  { name: "rejects negative float reasoning tokens", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":-0.5}}`, wantOutput: 50, wantExist: false },
  { name: "clamps oversized int64 overflow reasoning tokens to output tokens", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":9223372036854775808}}`, wantOutput: 50, wantExist: true, wantTokens: 50 },
  { name: "omits string reasoning detail", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":"163"}}`, wantOutput: 50, wantExist: false },
  { name: "omits boolean reasoning detail", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":true}}`, wantOutput: 50, wantExist: false },
  { name: "omits null reasoning detail", usage: `{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":null}}`, wantOutput: 50, wantExist: false },
];

function assertReasoningUsage(usage: unknown, tt: (typeof reasoningUsageCases)[number]): void {
  expect(getAt(usage, "output_tokens")).toBe(tt.wantOutput);
  const thinking = getAt(usage, "output_tokens_details.thinking_tokens");
  if (tt.wantExist) expect(thinking).toBe(tt.wantTokens);
  else expect(thinking).toBeUndefined();
}

describe("stream preserves reasoning usage", () => {
  for (const tt of reasoningUsageCases) {
    test(tt.name, () => {
      const { outputs } = runCodexStream([
        `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
        `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}`,
        `data: {"type":"response.completed","response":{"stop_reason":"stop","usage":${tt.usage}}}`,
      ]);
      const delta = findClaudeStreamMessageDelta(outputs);
      expect(delta).toBeDefined();
      assertReasoningUsage(delta!.usage, tt);
    });
  }
});

describe("non-stream preserves reasoning usage", () => {
  for (const tt of reasoningUsageCases) {
    test(tt.name, () => {
      const out = nonStream(`{"messages":[]}`, `{"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","stop_reason":"stop","usage":${tt.usage},"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}`);
      assertReasoningUsage(get(out, "usage"), tt);
    });
  }
});

describe("extractResponsesUsage", () => {
  const tests: { name: string; rawUsage: string; want: [number, number, number, number] }[] = [
    { name: "nil / absent usage", rawUsage: "", want: [0, 0, 0, 0] },
    { name: "null usage", rawUsage: "null", want: [0, 0, 0, 0] },
    { name: "only input and output tokens without cache details", rawUsage: `{"input_tokens":100,"output_tokens":50}`, want: [100, 50, 0, 0] },
    { name: "deducts cache_read_tokens only", rawUsage: `{"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cached_tokens":30}}`, want: [70, 50, 30, 0] },
    { name: "deducts cache_write_tokens only (issue 5956)", rawUsage: `{"input_tokens":4022,"output_tokens":462,"input_tokens_details":{"cache_write_tokens":4019}}`, want: [3, 462, 0, 4019] },
    { name: "deducts cache_creation_tokens alias only", rawUsage: `{"input_tokens":4022,"output_tokens":462,"input_tokens_details":{"cache_creation_tokens":4019}}`, want: [3, 462, 0, 4019] },
    { name: "deducts both cached_tokens and cache_write_tokens", rawUsage: `{"input_tokens":1000,"output_tokens":200,"input_tokens_details":{"cached_tokens":800,"cache_write_tokens":150}}`, want: [50, 200, 800, 150] },
    { name: "clamps input_tokens to zero when cache exceeds input", rawUsage: `{"input_tokens":500,"output_tokens":100,"input_tokens_details":{"cached_tokens":300,"cache_write_tokens":300}}`, want: [0, 100, 300, 300] },
    { name: "handles negative cache numbers safely without corrupting input", rawUsage: `{"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cached_tokens":-10,"cache_write_tokens":-5}}`, want: [100, 50, -10, 0] },
    { name: "clamps raw negative input_tokens to zero", rawUsage: `{"input_tokens":-10,"output_tokens":50}`, want: [0, 50, 0, 0] },
    { name: "negative cache_write_tokens falls back to cache_creation_tokens alias", rawUsage: `{"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cache_write_tokens":-1,"cache_creation_tokens":40}}`, want: [60, 50, 0, 40] },
    {
      name: "prevents int64 overflow when cached_tokens and cache_write_tokens are huge",
      rawUsage: `{"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cached_tokens":9223372036854775800,"cache_write_tokens":100}}`,
      want: [0, 50, Number("9223372036854775800"), 100],
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const usage = tt.rawUsage === "" ? undefined : JSON.parse(tt.rawUsage);
      expect(extractResponsesUsage(usage)).toEqual(tt.want);
    });
  }
});

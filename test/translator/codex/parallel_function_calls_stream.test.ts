// Ported from: internal/translator/codex/claude/codex_claude_parallel_function_calls_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { assertCodexClaudeContentBlockLifecycle, type CodexClaudeContentBlock, runCodexStream } from "./helpers.ts";

function translateCodexClaudeChunks(chunks: string[]): string[] {
  return runCodexStream(chunks, `{"stream":true,"tools":[{"name":"Read"}]}`, "gpt-5").outputs;
}

function assertParallelCodexClaudeToolCalls(blocks: CodexClaudeContentBlock[]): void {
  expect(blocks.length).toBe(2);
  const expectedIDs = ["call_a", "call_b"];
  const expectedArguments = [`{"file_path":"a"}`, `{"file_path":"b"}`];
  blocks.forEach((block, index) => {
    expect(block.index).toBe(index);
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("Read");
    expect(block.id).toBe(expectedIDs[index]!);
    expect(block.arguments).toBe(expectedArguments[index]!);
  });
}

describe("stream serializes interleaved named function calls", () => {
  const tests: { name: string; chunks: string[] }[] = [
    {
      name: "first call finishes first",
      chunks: [
        `data: {"type":"response.created","response":{"id":"resp_parallel","model":"gpt-5"}}`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read"},"output_index":1}`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_b","name":"Read"},"output_index":2}`,
        `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":\\"a\\"}","output_index":1}`,
        `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":\\"b\\"}","output_index":2}`,
        `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"a\\"}","output_index":1}`,
        `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},"output_index":1}`,
        `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"b\\"}","output_index":2}`,
        `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_b","name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"},"output_index":2}`,
      ],
    },
    {
      name: "second call finishes first",
      chunks: [
        `data: {"type":"response.created","response":{"id":"resp_parallel","model":"gpt-5"}}`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read"},"output_index":1}`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_b","name":"Read"},"output_index":2}`,
        `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":\\"b\\"}","output_index":2}`,
        `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"b\\"}","output_index":2}`,
        `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_b","name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"},"output_index":2}`,
        `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":\\"a\\"}","output_index":1}`,
        `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"a\\"}","output_index":1}`,
        `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},"output_index":1}`,
      ],
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const blocks = assertCodexClaudeContentBlockLifecycle(translateCodexClaudeChunks(tt.chunks));
      assertParallelCodexClaudeToolCalls(blocks);
    });
  }
});

describe("stream defers other content until function calls close", () => {
  const tests: { name: string; functionCall: string; firstBlock: string; secondBlock: string }[] = [
    {
      name: "named active call",
      functionCall: `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read"},"output_index":0}`,
      firstBlock: "tool_use",
      secondBlock: "text",
    },
    {
      name: "unnamed pending call",
      functionCall: `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a"},"output_index":0}`,
      firstBlock: "text",
      secondBlock: "tool_use",
    },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const chunks = [
        `data: {"type":"response.created","response":{"id":"resp_mixed","model":"gpt-5"}}`,
        tt.functionCall,
        `data: {"type":"response.output_item.added","item":{"type":"message","status":"in_progress"},"output_index":1}`,
        `data: {"type":"response.content_part.added","part":{"type":"output_text"},"content_index":0,"output_index":1}`,
        `data: {"type":"response.output_text.delta","delta":"done","output_index":1}`,
        `data: {"type":"response.content_part.done","part":{"type":"output_text"},"content_index":0,"output_index":1}`,
        `data: {"type":"response.output_item.done","item":{"type":"message","status":"completed"},"output_index":1}`,
        `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"a\\"}","output_index":0}`,
        `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},"output_index":0}`,
        `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
      ];
      const blocks = assertCodexClaudeContentBlockLifecycle(translateCodexClaudeChunks(chunks));
      expect(blocks.length).toBe(2);
      expect(blocks[0]!.index).toBe(0);
      expect(blocks[0]!.type).toBe(tt.firstBlock);
      expect(blocks[1]!.index).toBe(1);
      expect(blocks[1]!.type).toBe(tt.secondBlock);
      for (const block of blocks) {
        if (block.type === "tool_use") expect(block.arguments).toBe(`{"file_path":"a"}`);
        if (block.type === "text") expect(block.text).toBe("done");
      }
    });
  }
});

test("stream deferred text closes before thinking starts", () => {
  const chunks = [
    `data: {"type":"response.created","response":{"id":"resp_mixed","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read"},"output_index":0}`,
    `data: {"type":"response.content_part.added","part":{"type":"output_text"},"content_index":0,"output_index":1}`,
    `data: {"type":"response.output_text.delta","delta":"answer","output_index":1}`,
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_initial"},"output_index":2}`,
    `data: {"type":"response.reasoning_summary_part.added","output_index":2}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"thought","output_index":2}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_final"},"output_index":2}`,
    `data: {"type":"response.function_call_arguments.done","arguments":"{\\"file_path\\":\\"a\\"}","output_index":0}`,
    `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},"output_index":0}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ];
  const blocks = assertCodexClaudeContentBlockLifecycle(translateCodexClaudeChunks(chunks));
  expect(blocks.length).toBe(3);
  expect(blocks[0]!.index).toBe(0);
  expect(blocks[0]!.type).toBe("tool_use");
  expect(blocks[0]!.arguments).toBe(`{"file_path":"a"}`);
  expect(blocks[1]!.index).toBe(1);
  expect(blocks[1]!.type).toBe("text");
  expect(blocks[1]!.text).toBe("answer");
  expect(blocks[2]!.index).toBe(2);
  expect(blocks[2]!.type).toBe("thinking");
});

test("stream terminal matches function calls by output index", () => {
  const chunks = [
    `data: {"type":"response.created","response":{"id":"resp_parallel","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"function_call","name":"Read"},"output_index":0}`,
    `data: {"type":"response.output_item.added","item":{"type":"function_call","name":"Read"},"output_index":1}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},{"type":"function_call","name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"}]}}`,
  ];
  const blocks = assertCodexClaudeContentBlockLifecycle(translateCodexClaudeChunks(chunks));
  expect(blocks.length).toBe(2);
  expect(blocks[0]!.index).toBe(0);
  expect(blocks[0]!.arguments).toBe(`{"file_path":"a"}`);
  expect(blocks[1]!.index).toBe(1);
  expect(blocks[1]!.arguments).toBe(`{"file_path":"b"}`);
});

describe("stream terminal hydrates interleaved function calls", () => {
  for (const terminalType of ["response.completed", "response.incomplete"]) {
    test(terminalType, () => {
      const terminal = `data: {"type":"${terminalType}","response":{"usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"call_a","name":"Read","arguments":"{\\"file_path\\":\\"a\\"}"},{"type":"function_call","call_id":"call_b","name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"}]}}`;
      const chunks = [
        `data: {"type":"response.created","response":{"id":"resp_parallel","model":"gpt-5"}}`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_a","name":"Read"},"output_index":0}`,
        `data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_b","name":"Read"},"output_index":1}`,
        `data: {"type":"response.function_call_arguments.delta","delta":"{\\"file_path\\":","output_index":0}`,
        terminal,
      ];
      const blocks = assertCodexClaudeContentBlockLifecycle(translateCodexClaudeChunks(chunks));
      assertParallelCodexClaudeToolCalls(blocks);
    });
  }
});

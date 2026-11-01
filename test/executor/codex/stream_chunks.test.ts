// Ported from: internal/runtime/executor/codex_executor_stream_alloc_test.go
// Skipped cases: BenchmarkCodexExecuteStreamAllocations (Go benchmark with allocation counts). Adaptation:
//   TestCodexStreamChunksRemainOwnedAfterScannerAdvances guarded against Go chunks aliasing the scanner buffer;
//   JS strings are immutable, so the port checks the part that still applies: every retained chunk keeps its
//   content and the deltas (with interleaved comment and event: lines) reassemble to the full text.
import { describe, expect, test } from "bun:test";
import { CodexExecutor } from "../../../src/executor/codex/index.ts";
import type { ExecOptions } from "../../../src/executor/types.ts";
import { apiKeyAuth, getString, sseResponse, stubFetch } from "./helpers.ts";

/** Go: codexAllocationStream. */
function codexAllocationStream(deltas: number, deltaSize: number): string {
  let stream = `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_alloc","model":"gpt-5.4"}}\n\n`;
  stream += `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_alloc","type":"message","role":"assistant","content":[]}}\n\n`;
  stream += `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`;
  for (let i = 0; i < deltas; i++) {
    const delta = String.fromCharCode(97 + (i % 26)).repeat(deltaSize);
    stream += `: comment-${String(i).padStart(4, "0")}\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":${JSON.stringify(delta)}}\n\n`;
  }
  stream += `data: {"type":"response.completed","response":{"id":"resp_alloc","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":128,"total_tokens":133}}}\n\n`;
  return stream;
}

describe("TestCodexStreamChunksRemainOwnedAfterScannerAdvances", () => {
  const deltas = 48;
  const deltaSize = 512;
  for (const buffered of [false, true]) {
    for (const format of ["claude", "openai-response", "test-codex-raw-ownership"]) {
      test(`buffered=${buffered}/${format}`, async () => {
        const stub = stubFetch(() => sseResponse(codexAllocationStream(deltas, deltaSize)));
        const executor = new CodexExecutor({ fetch: stub.fetch, streamBootstrapBuffering: buffered });
        const result = await executor.executeStream(
          apiKeyAuth(""),
          { model: "gpt-5.4", payload: `{"model":"gpt-5.4","input":"hello"}`, format: "openai-response" },
          { stream: true, sourceFormat: "openai-response", responseFormat: format } as ExecOptions,
        );
        const retained: string[] = [];
        const snapshots: string[] = [];
        for await (const chunk of result.chunks) {
          retained.push(chunk);
          snapshots.push(chunk.slice());
        }
        expect(retained.length).toBeGreaterThan(0);
        let text = "";
        retained.forEach((chunk, index) => {
          expect(chunk).toBe(snapshots[index]!);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            switch (getString(data, "type")) {
              case "response.output_text.delta":
                text += getString(data, "delta");
                break;
              case "content_block_delta":
                text += getString(data, "delta.text");
                break;
            }
          }
        });
        let want = "";
        for (let i = 0; i < deltas; i++) want += String.fromCharCode(97 + (i % 26)).repeat(deltaSize);
        expect(text.length).toBe(want.length);
        expect(text).toBe(want);
      });
    }
  }
});

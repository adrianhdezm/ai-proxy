// Ported from: internal/runtime/executor/claude_executor_stream_terminal_test.go
// Skipped cases: TestClaudeExecutor_ExecuteStream_Translated_ClientDisconnectAfterTerminalEventIsNotFailed (no
// Claude->OpenAI Responses translator in this port); the usage-plugin assertions of the passthrough case are replaced by
// "the stream ends cleanly after message_stop while the upstream body is still open" (usage plugins are not ported).
import { expect, test } from "bun:test";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { parseClaudeStreamUsage } from "../../../src/executor/claude/response.ts";
import { apiKeyAuth, claudeOpts, heldOpenSSE, withUpstream } from "./helpers.ts";

const streamData =
  "event: message_start\n" +
  `data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"usage":{"input_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}` +
  "\n\n" +
  "event: content_block_start\n" +
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` +
  "\n\n" +
  "event: content_block_delta\n" +
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}` +
  "\n\n" +
  "event: content_block_stop\n" +
  `data: {"type":"content_block_stop","index":0}` +
  "\n\n" +
  "event: message_delta\n" +
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}` +
  "\n\n" +
  "event: message_stop\n" +
  `data: {"type":"message_stop"}` +
  "\n\n";

test("ExecuteStream_Passthrough_ClientDisconnectAfterTerminalEventIsNotFailed", async () => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await withUpstream(
    () => heldOpenSSE(streamData, released),
    async (upstream) => {
      const controller = new AbortController();
      const result = await createClaudeExecutor().executeStream(
        apiKeyAuth(upstream.url),
        { model: "claude-opus-5", payload: `{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}],"stream":true}`, format: "claude" },
        claudeOpts({ stream: true, responseFormat: "claude", signal: controller.signal }),
      );
      const chunks: string[] = [];
      let sawTerminal = false;
      let error: unknown;
      try {
        for await (const chunk of result.chunks) {
          chunks.push(chunk);
          if (chunk.includes("message_stop")) {
            sawTerminal = true;
            controller.abort();
          }
        }
      } catch (err) {
        error = err;
      }
      release();
      expect(sawTerminal).toBe(true);
      expect(error).toBeUndefined();
      // Usage stays observable on the forwarded frames: 100 input tokens, 15 output tokens.
      expect(parseClaudeStreamUsage(chunks[0]!.split("\n").find((l) => l.startsWith("data:"))!)?.inputTokens).toBe(100);
      expect(parseClaudeStreamUsage(chunks[4]!.split("\n").find((l) => l.startsWith("data:"))!)?.outputTokens).toBe(15);
    },
  );
});

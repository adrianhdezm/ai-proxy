// Shared stand-in for the Go executeClaudeContextManagementRequest helper (claude_executor_test.go):
// runs the Claude executor against an in-process fetch with a cloaked API-key credential and returns
// the body sent upstream.
import { newAuth } from "../../src/auth/types.ts";
import { ClaudeExecutor } from "../../src/executor/claude/executor.ts";

const messageJSON = `{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`;
const messageSSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

export interface ClaudeCapture {
  url: string;
  body: string;
}

/** A fetch that records every request and answers with a minimal Messages response. */
export function claudeCapturingFetch(stream: boolean, countTokens = false) {
  const requests: ClaudeCapture[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    requests.push({ url: input, body: typeof init?.body === "string" ? init.body : "" });
    if (countTokens) return new Response(`{"input_tokens":12}`, { headers: { "Content-Type": "application/json" } });
    return new Response(stream ? messageSSE : messageJSON, { headers: { "Content-Type": stream ? "text/event-stream" : "application/json" } });
  };
  return { requests, fetch: fetchImpl };
}

/** Go: executeClaudeContextManagementRequest (api_key + cloak_mode "always", model claude-opus-5). */
export async function executeClaudeRequest(payload: string, stream: boolean): Promise<string> {
  const f = claudeCapturingFetch(stream);
  const exec = new ClaudeExecutor({ fetch: f.fetch as never, now: () => Date.UTC(2026, 9, 31, 12) });
  const auth = newAuth({ id: "claude-test", provider: "claude", attributes: { api_key: "key-payload-rule", cloak_mode: "always" } });
  const req = { model: "claude-opus-5", payload, format: "claude" as const };
  if (stream) {
    const result = await exec.executeStream(auth, req, { stream: true, sourceFormat: "claude" });
    for await (const _ of result.chunks) void _;
  } else {
    await exec.execute(auth, req, { stream: false, sourceFormat: "claude" });
  }
  const last = f.requests[f.requests.length - 1];
  if (!last) throw new Error("no upstream request");
  return last.body;
}

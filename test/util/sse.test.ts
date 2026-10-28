// New (no upstream test): SSE parsing helpers shared by executors and the server.
import { expect, test } from "bun:test";
import { SSEParser, formatSSE, iterateSSE, splitSSEFrames } from "../../src/util/sse.ts";

test("parses events split across chunks", () => {
  const p = new SSEParser();
  expect(p.push("event: message_start\ndata: {\"a\":")).toHaveLength(0);
  const evs = p.push("1}\n\ndata: {\"b\":2}\n\n: comment\n\n");
  expect(evs).toEqual([
    { event: "message_start", data: '{"a":1}', raw: 'event: message_start\ndata: {"a":1}' },
    { event: "", data: '{"b":2}', raw: 'data: {"b":2}' },
  ]);
  expect(p.pending()).toBe("");
});

test("handles CRLF and multi-line data", () => {
  const p = new SSEParser();
  const evs = p.push("data: a\r\ndata: b\r\n\r\n");
  expect(evs[0]!.data).toBe("a\nb");
});

test("flush returns an unterminated trailing block", () => {
  const p = new SSEParser();
  p.push("data: tail");
  expect(p.flush()).toEqual([{ event: "", data: "tail", raw: "data: tail" }]);
});

test("iterateSSE reads a fetch body", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: 1\n\nda"));
      c.enqueue(new TextEncoder().encode("ta: 2\n\n"));
      c.close();
    },
  });
  const got: string[] = [];
  for await (const ev of iterateSSE(body)) got.push(ev.data);
  expect(got).toEqual(["1", "2"]);
});

test("formatSSE and splitSSEFrames round-trip", () => {
  const text = formatSSE("ping", "{}") + formatSSE(undefined, "[DONE]");
  expect(splitSSEFrames(text)).toEqual(["event: ping\ndata: {}\n\n", "data: [DONE]\n\n"]);
});

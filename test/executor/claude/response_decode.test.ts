// Ported from: internal/runtime/executor/helps/response_decode_test.go
// Skipped cases: TestDecodeResponseBodyCompositeClose (io.Closer composition has no Web-streams equivalent);
// the "setup error closes original" assertions are reduced to the error itself.
import { describe, expect, test } from "bun:test";
import { decodeResponseBody, readAllText } from "../../../src/executor/claude/response.ts";
import { encodeBody, streamOf, text } from "./helpers.ts";

describe("DecodeResponseBody", () => {
  const plain = text("data: response.completed\n\n");
  const cases: Array<{ name: string; encodings?: string[]; header?: string }> = [
    { name: "plain" },
    { name: "short-plain" },
    { name: "identity", header: "identity" },
    { name: "gzip", encodings: ["gzip"], header: "GZIP" },
    { name: "gzip-sniff", encodings: ["gzip"] },
    { name: "zstd", encodings: ["zstd"], header: "zstd" },
    { name: "zstd-sniff", encodings: ["zstd"] },
    { name: "brotli", encodings: ["br"], header: "br" },
    { name: "deflate-raw", encodings: ["deflate"], header: "deflate" },
    { name: "deflate-zlib", encodings: ["zlib"], header: "deflate" },
    { name: "stacked", encodings: ["gzip", "br", "zstd"], header: "gzip, br, zstd" },
  ];
  for (const tt of cases) {
    test(tt.name, async () => {
      const want = tt.name === "short-plain" ? text("a") : plain;
      let wire = want;
      for (const encoding of tt.encodings ?? []) wire = encodeBody(encoding, wire);
      const decoded = decodeResponseBody(streamOf(wire), tt.header ?? "");
      expect(await readAllText(decoded)).toBe(new TextDecoder().decode(want));
    });
  }
});

test("DecodeResponseBody setup errors", async () => {
  expect(() => decodeResponseBody(streamOf(text("invalid gzip")), "unsupported")).toThrow();
  expect(() => decodeResponseBody(streamOf(text("invalid gzip")), "unsupported, gzip")).toThrow();
  await expect(readAllText(decodeResponseBody(streamOf(text("invalid gzip")), "gzip"))).rejects.toThrow();
  expect(() => decodeResponseBody(null, "")).toThrow();
});

test("DecodeResponseBody unlabeled does not wait for first byte", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const decoded = decodeResponseBody(body, "");
  const reader = decoded.getReader();
  const pending = reader.read();
  controller.enqueue(text("data: {}\n\n"));
  controller.close();
  const first = await pending;
  expect(new TextDecoder().decode(first.value)).toBe("data: {}\n\n");
  reader.releaseLock();
});

test("DecodeResponseBody sniffs split magic bytes", async () => {
  const plain = text("data: response.completed\n\n");
  for (const encoding of ["gzip", "zstd"]) {
    const wire = encodeBody(encoding, plain);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < wire.length; i++) pieces.push(wire.slice(i, i + 1));
    const decoded = decodeResponseBody(streamOf(...pieces), "");
    expect(await readAllText(decoded)).toBe("data: response.completed\n\n");
  }
});

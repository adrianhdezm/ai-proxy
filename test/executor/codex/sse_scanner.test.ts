// Ported from: internal/runtime/executor/helps/codex_sse_scanner_test.go
// Skipped cases: TestCodexSSEScannerHoldsAnEventInMemoryThatFollowsItsBytes (allocation count, no Bun analogue;
//   the 100,000-line event is still assembled below), the 2-second wall-clock bound of
//   TestCodexSSEScannerAssemblesAnEventOfThousandsOfLinesQuickly (correctness kept, timing dropped: deterministic tests),
//   json_error_offset of TestCodexSSEScannerDiagnosticDescribesFraming (the JSON error position is runtime-specific).
//   Warnings are observed through the scanner's onDiagnostic hook instead of a logrus hook.
import { describe, expect, test } from "bun:test";
import { CodexSSEScanner, type CodexSSEDiagnostic, scanCodexSSEText } from "../../../src/executor/codex/index.ts";

function wellFormedCodexSSEStream(): string {
  let stream = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}\n\n';
  for (let i = 0; i < 6; i++) {
    stream += `: comment-${String(i).padStart(4, "0")}\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":${JSON.stringify("x".repeat(64))}}\n\n`;
  }
  stream += 'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n';
  return stream;
}

function scan(stream: string, maxBytes = 1 << 20): { lines: string[]; diags: CodexSSEDiagnostic[] } {
  const diags: CodexSSEDiagnostic[] = [];
  const lines = scanCodexSSEText(stream, { maxBytes, onDiagnostic: (d) => diags.push(d) });
  return { lines, diags };
}

/** Go bufio.Scanner line splitting: "\n" separators, a trailing "\r" dropped, no empty final token. */
function bufioLines(input: string): string[] {
  const parts = input.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

describe("TestCodexSSEScannerAssemblesEventData", () => {
  const marker = "body-bytes-must-not-be-logged";
  const cases: Array<{ name: string; stream: string; want: string[]; warnings?: number }> = [
    {
      name: "one-line events pass through as read",
      stream: 'event: response.created\ndata: {"type":"response.created"}\n\n: keep-alive\n\ndata: {"type":"x","v":"a b"}\n\n',
      want: ["event: response.created", 'data: {"type":"response.created"}', "", ": keep-alive", "", 'data: {"type":"x","v":"a b"}', ""],
    },
    { name: "CRLF line endings", stream: 'event: a\r\ndata: {"type":"a"}\r\n\r\n', want: ["event: a", 'data: {"type":"a"}', ""] },
    {
      name: "data lines of one event are joined and compacted",
      stream: 'event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"id":"r","output":[]}}\n\n',
      want: ["event: response.completed", 'data: {"type":"response.completed","response":{"id":"r","output":[]}}', ""],
    },
    { name: "joined CRLF event", stream: 'data: {"a":\r\ndata: [1,\r\ndata: 2]}\r\n\r\n', want: ['data: {"a":[1,2]}', ""] },
    {
      name: "comment and field lines inside an event come before its data",
      stream: 'event: e\ndata: {"a":\n: keep-alive\nid: 7\nretry: 3000\ndata: 1}\n\n',
      want: ["event: e", ": keep-alive", "id: 7", "retry: 3000", 'data: {"a":1}', ""],
    },
    { name: "unterminated one-line event at end of stream", stream: 'data: {"type":"response.completed"}', want: ['data: {"type":"response.completed"}'] },
    { name: "unterminated multi-line event at end of stream", stream: 'data: {"type":\ndata: "response.completed"}\n', want: ['data: {"type":"response.completed"}'] },
    { name: "complete events without blank separators stay separate", stream: 'data: {"a":1}\ndata: {"b":2}\n', want: ['data: {"a":1}', 'data: {"b":2}'] },
    { name: "split event followed by an event without a blank separator", stream: 'data: {"a":\ndata: 1}\ndata: {"b":2}\n', want: ['data: {"a":1}', 'data: {"b":2}'] },
    {
      name: "an invalid fragment absorbs the following data lines up to the blank line",
      stream: 'data: {"a":"' + marker + '\ndata: {"b":2}\n\n',
      want: ['data: {"a":"' + marker + '\ndata: {"b":2}', ""],
      warnings: 1,
    },
    {
      name: "only the first invalid event in a stream is described",
      stream: 'data: {"a":\n\ndata: {"b":\n\ndata: {"c":3}\n\n',
      want: ['data: {"a":', "", 'data: {"b":', "", 'data: {"c":3}', ""],
      warnings: 1,
    },
    {
      name: "a complete object on its own line inside an open array stays in the event",
      stream: 'data: {"type":"response.completed","response":{"output":[\ndata: {"id":"m","type":"message"}\ndata: ]}}\n\n',
      want: ['data: {"type":"response.completed","response":{"output":[{"id":"m","type":"message"}]}}', ""],
    },
    {
      name: "unterminated incomplete event at end of stream is still delivered",
      stream: 'data: {"type":"response.completed","t":"' + marker + '",',
      want: ['data: {"type":"response.completed","t":"' + marker + '",'],
      warnings: 1,
    },
    { name: "empty and non-JSON data lines take the stock path", stream: "data:\n\ndata: \n\ndata: ping\n\n", want: ["data:", "", "data: ", "", "data: ping", ""] },
    { name: "done sentinel", stream: "data: [DONE]\n\n", want: ["data: [DONE]", ""] },
    {
      name: "invalid one-line event passes through with one warning",
      stream: 'data: {"type":"response.completed","t":"' + marker + '",\n\n',
      want: ['data: {"type":"response.completed","t":"' + marker + '",', ""],
      warnings: 1,
    },
    {
      name: "event split inside a string stays invalid and keeps its data lines",
      stream: 'data: {"t":"' + marker + "\ndata: " + marker + '"}\n\n',
      want: ['data: {"t":"' + marker + "\ndata: " + marker + '"}', ""],
      warnings: 1,
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const { lines, diags } = scan(tc.stream);
      expect(lines).toEqual(tc.want);
      expect(diags.length).toBe(tc.warnings ?? 0);
      for (const diag of diags) {
        expect(JSON.stringify(diag)).not.toContain(marker);
        expect(typeof diag.dataLines).toBe("number");
        expect(typeof diag.jsonErrorOffset).toBe("number");
      }
    });
  }
});

test("TestCodexSSEScannerBoundsAnEventToTheLineLimit", () => {
  const stream = 'data: {"a":"' + "x".repeat(40) + "\ndata: " + "y".repeat(40) + "\ndata: " + "z".repeat(40) + '"}\n\ndata: {"b":2}\n\n';
  const { lines, diags } = scan(stream, 64);
  expect(lines).toEqual(['data: {"a":"' + "x".repeat(40), "data: " + "y".repeat(40), "data: " + "z".repeat(40) + '"}', "", 'data: {"b":2}', ""]);
  expect(diags.length).toBe(1);
});

test("TestCodexSSEScannerAssemblesAnEventOfThousandsOfLinesQuickly", () => {
  const item = (i: number) => `{"type":"message","content":[{"type":"output_text","text":"${String.fromCharCode(97 + (i % 26)).repeat(960)}"}]}`;
  const head = '{"type":"response.completed","response":{"id":"resp_big","output":[';
  let payload = head + item(0);
  let stream = "data: " + head + item(0) + "\n";
  for (let i = 1; i < 2000; i++) {
    payload += "," + item(i);
    stream += "data: ," + item(i) + "\n";
  }
  payload += "]}}";
  stream += "data: ]}}\n\n";
  const { lines } = scan(stream, 52_428_800);
  expect(lines.length).toBe(2);
  expect(lines[0]).toBe("data: " + payload);
});

test("TestCodexSSEScannerHoldsAnEventInMemoryThatFollowsItsBytes (assembly only)", () => {
  const stream = "data: [\n" + "data:\n".repeat(100_000) + "data: ]\n\n";
  expect(scan(stream).lines).toEqual(["data: []", ""]);
});

test("TestCodexSSEScannerReadsLineByLineWhileAssemblyIsOff", () => {
  const scanner = new CodexSSEScanner({ maxBytes: 1 << 20 });
  scanner.setAssembly(false);
  const got: string[] = [];
  // Feed line by line so assembly can be switched on after the first event (Go: SetAssembly mid-scan).
  const input = 'data: {"a":\ndata: 1}\n\ndata: {"b":\ndata: 2}\n\n'.split(/(?<=\n)/);
  for (const piece of input) {
    for (const line of scanner.push(piece)) {
      got.push(line);
      if (got.length === 3) scanner.setAssembly(true);
    }
  }
  got.push(...scanner.flush());
  expect(got).toEqual(['data: {"a":', "data: 1}", "", 'data: {"b":2}', ""]);
});

test("TestCodexSSEScannerDeliversNonDataLinesAsTheyAreRead", () => {
  const scanner = new CodexSSEScanner({ maxBytes: 1 << 20 });
  const got: string[] = [];
  const chunks = ['data: {"a":\n: keep-alive\nid: 7\n', "data: 1}\n\n"];
  chunks.forEach((chunk, i) => {
    for (const line of scanner.push(chunk)) got.push(`${JSON.stringify(line)}@${i + 1}`);
  });
  for (const line of scanner.flush()) got.push(`${JSON.stringify(line)}@${chunks.length}`);
  expect(got).toEqual(['": keep-alive"@1', '"id: 7"@1', '"data: {\\"a\\":1}"@2', '""@2']);
});

test("TestCodexSSEScannerDiagnosticDescribesFraming", () => {
  const { diags } = scan('data: {"type":"response.completed","t":"abc\ndata: def"}\n\n');
  expect(diags.length).toBe(1);
  expect(diags[0]!.dataLines).toBe(2);
  expect(diags[0]!.lineBytes).toBe("37,5");
  expect(diags[0]!.linesValid).toBe("false,false");
  expect(diags[0]!.dataBytes).toBe(43);
});

describe("TestCodexSSEScannerMatchesBufioScannerOnWellFormedStreams", () => {
  const stream = wellFormedCodexSSEStream() + 'data: {"type":"x"}\ndata: {"type":"y"}\n: trailing comment\n\nevent: done\ndata: [DONE]\n\n';
  for (const newline of ["\n", "\r\n"]) {
    test(`newline=${JSON.stringify(newline)}`, () => {
      const input = stream.replaceAll("\n", newline);
      expect(scan(input).lines).toEqual(bufioLines(input));
    });
  }
});

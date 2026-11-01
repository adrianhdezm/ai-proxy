// Ported from: internal/translator/common/apply_patch_input_test.go
// Skipped cases: the raw invalid-UTF-8 byte rows of TestApplyPatchInputDecoderRejectsInvalidArguments
// (invalid utf8 continuation, utf8 truncated by quote, overlong utf8, utf8 encoded surrogate, utf8 beyond
// maximum) and of TestApplyPatchInputDecoderInvalidPendingCharactersDoNotEmitReplacement (invalid utf8,
// truncated utf8): JS strings cannot hold invalid UTF-8, so they are replaced by unpaired-surrogate rows.
// Byte splits become UTF-16 code-unit splits (the only splittable character is a surrogate pair).
import { describe, expect, test } from "bun:test";
import { ApplyPatchInputDecoder } from "../../../src/translator/common/apply_patch_input.ts";
import { wrapApplyPatchInput } from "../../../src/translator/common/apply_patch_tool.ts";

const hasLoneSurrogate = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

test("every split", () => {
  const patch = '*** Begin Patch\n*** Add File: a.txt\n+中文 \\"\n*** End Patch\n';
  const args = wrapApplyPatchInput(patch);
  for (let split = 0; split <= args.length; split++) {
    const decoder = new ApplyPatchInputDecoder();
    let output = "";
    for (const fragment of [args.slice(0, split), args.slice(split)]) {
      const [delta, err] = decoder.push(fragment);
      expect(err).toBeUndefined();
      output += delta;
    }
    const [tail, err] = decoder.finish(args);
    expect(err).toBeUndefined();
    output += tail;
    expect(output).toBe(patch);
    expect(decoder.input()).toBe(patch);
  }
});

function checkFragments(fragments: string[], args: string, want: string): void {
  const decoder = new ApplyPatchInputDecoder();
  let output = "";
  for (const fragment of fragments) {
    const [delta, err] = decoder.push(fragment);
    expect(err).toBeUndefined();
    expect(hasLoneSurrogate(delta)).toBe(false);
    output += delta;
    expect(decoder.input()).toBe(output);
  }
  const [tail, err] = decoder.finish(args);
  expect(err).toBeUndefined();
  output += tail;
  expect(output).toBe(want);
  expect(decoder.input()).toBe(want);
}

describe("string fragments", () => {
  const cases: [string, string, string][] = [
    ["empty", `{"input":""}`, ""],
    ["whitespace", ' \t\r\n{ \n"input" \t: "  line  \\n\\t next\\r\\n" \r}\n\t', "  line  \n\t next\r\n"],
    ["escapes", `{"input":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000\\u0041\\u4e2d\\u6587"}`, '"\\/\b\f\n\r\t\x00A中文'],
    ["escaped key", `{"in\\u0070ut":"patch"}`, "patch"],
    ["surrogate pair", `{"input":"before\\uD83D\\uDE00after"}`, "before😀after"],
    ["surrogate boundaries", `{"input":"\\ud800\\udc00\\uDBFF\\uDFFF\\uD7FF\\uE000"}`, "\u{10000}\u{10ffff}\ud7ff\ue000"],
    ["utf8", `{"input":"¢中文😀�"}`, "¢中文😀�"],
  ];
  for (const [name, args, want] of cases) {
    test(name, () => {
      for (let split = 0; split <= args.length; split++) {
        checkFragments([args.slice(0, split), args.slice(split)], args, want);
        // A final snapshot can complete a pending escape or surrogate pair.
        checkFragments([args.slice(0, split)], args, want);
      }
      checkFragments([...args].flatMap((ch) => (ch.length === 2 ? [ch[0]!, ch[1]!] : [ch])), args, want);
    });
  }
});

test("preview before closing JSON", () => {
  const fragments: [string, string][] = [
    [`{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+  `, "*** Begin Patch\n*** Add File: a.txt\n+  "],
    ["中", "中"],
    ["\ud83d", ""],
    ["\ude00\\", "😀"],
    [`uD8`, ""],
    [`3D`, ""],
    [`\\uDE`, ""],
    [`00\\n*** End Patch\\n`, "😀\n*** End Patch\n"],
  ];
  const decoder = new ApplyPatchInputDecoder();
  for (const [fragment, want] of fragments) expect(decoder.push(fragment)).toEqual([want, undefined]);
  const want = "*** Begin Patch\n*** Add File: a.txt\n+  中😀😀\n*** End Patch\n";
  expect(decoder.input()).toBe(want);
  expect(decoder.finish(wrapApplyPatchInput(want))).toEqual(["", undefined]);
});

describe("rejects invalid arguments", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["array", `[]`],
    ["empty object", `{}`],
    ["wrong key", `{"patch":"x"}`],
    ["unquoted key", `{input:"x"}`],
    ["invalid key escape", `{"in\\qput":"x"}`],
    ["missing colon", `{"input" "x"}`],
    ["number value", `{"input":42}`],
    ["null value", `{"input":null}`],
    ["boolean value", `{"input":true}`],
    ["object value", `{"input":{}}`],
    ["array value", `{"input":[]}`],
    ["duplicate key", `{"input":"x","input":"y"}`],
    ["extra key", `{"input":"x","extra":"y"}`],
    ["trailing comma", `{"input":"x",}`],
    ["trailing json", `{"input":"x"}{}`],
    ["non json whitespace", '\v{"input":"x"}'],
    ["invalid escape", `{"input":"\\q"}`],
    ["invalid hex", `{"input":"\\u12G4"}`],
    ["short unicode", `{"input":"\\u123"}`],
    ["dangling escape", `{"input":"x\\`],
    ["raw newline", '{"input":"x\ny"}'],
    ["raw nul", '{"input":"x\x00y"}'],
    ["low surrogate alone", `{"input":"\\uDE00"}`],
    ["high surrogate alone", `{"input":"\\uD83D"}`],
    ["high followed by text", `{"input":"\\uD83Dx"}`],
    ["high followed by newline escape", `{"input":"\\uD83D\\n"}`],
    ["high followed by bmp", `{"input":"\\uD83D\\u0041"}`],
    ["two high surrogates", `{"input":"\\uD83D\\uD83D"}`],
    ["raw high surrogate then text", '{"input":"\ud83dA"}'],
    ["raw high surrogate closed by quote", '{"input":"\ud83d"}'],
    ["raw low surrogate alone", '{"input":"\ude00"}'],
    ["unclosed value", `{"input":"x`],
    ["unclosed object", `{"input":"x"`],
  ];
  for (const [name, args] of cases) {
    test(name, () => {
      for (let split = 0; split <= args.length; split++) {
        const decoder = new ApplyPatchInputDecoder();
        for (const fragment of [args.slice(0, split), args.slice(split)]) if (decoder.push(fragment)[1]) break;
        expect(decoder.finish(args)[1]).toBeDefined();
        expect(hasLoneSurrogate(decoder.input())).toBe(false);
      }
      const unitDecoder = new ApplyPatchInputDecoder();
      for (let i = 0; i < args.length; i++) if (unitDecoder.push(args.slice(i, i + 1))[1]) break;
      expect(unitDecoder.finish(args)[1]).toBeDefined();
      expect(new ApplyPatchInputDecoder().finish(args)[1]).toBeDefined();
    });
  }
});

test("invalid value fails immediately", () => {
  for (const fragment of [`{"input":4`, `{"input":n`, `{"input":t`, `{"input":[`, `{"input":{`, `{"input":"\\q`, `{"input":"\\u12G`, `{"input":"\\uDE00`, `{"input":"\\uD83Dx`]) {
    expect(new ApplyPatchInputDecoder().push(fragment)[1]).toBeDefined();
  }
});

describe("invalid pending characters do not emit replacement", () => {
  const cases: [string, string, string][] = [
    ["surrogate closed", `\\uD83D`, `"}`],
    ["surrogate text", `\\uD83D`, "x"],
    ["surrogate escape", `\\uD83D\\`, "n"],
    ["invalid low surrogate", `\\uD83D\\u00`, "41"],
    ["invalid escape", `\\`, "q"],
    ["invalid hex", `\\u12`, "G"],
    ["raw surrogate text", "\ud83d", "x"],
    ["raw surrogate closed", "\ud83d", `"}`],
  ];
  for (const [name, pending, continuation] of cases) {
    test(name, () => {
      const decoder = new ApplyPatchInputDecoder();
      expect(decoder.push(`{"input":"safe` + pending)).toEqual(["safe", undefined]);
      const [delta, err] = decoder.push(continuation);
      expect(err).toBeDefined();
      expect(delta).toBe("");
      expect(decoder.input()).toBe("safe");
    });
  }
});

describe("finish and repeated termination", () => {
  const args = wrapApplyPatchInput("  first\nsecond  \n");
  const cases: [string, string, string][] = [
    ["no deltas", "", "  first\nsecond  \n"],
    ["partial deltas", `{"input":"  first\\n`, "second  \n"],
    ["complete deltas", args, ""],
  ];
  for (const [name, push, want] of cases) {
    test(name, () => {
      const decoder = new ApplyPatchInputDecoder();
      expect(decoder.push(push)[1]).toBeUndefined();
      expect(decoder.finish(args)).toEqual([want, undefined]);
      expect(decoder.input()).toBe("  first\nsecond  \n");
      for (let i = 0; i < 3; i++) expect(decoder.finish(args)).toEqual(["", undefined]);
      expect(decoder.finish(wrapApplyPatchInput("  first\nsecond  \nmore"))[1]).toBeDefined();
    });
  }
});

test("rejects final prefix conflict", () => {
  for (const final of ["other", "pre", "prefix changed"]) {
    const decoder = new ApplyPatchInputDecoder();
    expect(decoder.push(`{"input":"prefix original`)).toEqual(["prefix original", undefined]);
    const [tail, err] = decoder.finish(wrapApplyPatchInput(final));
    expect(err).toBeDefined();
    expect(tail).toBe("");
    expect(decoder.input()).toBe("prefix original");
  }
});

test("error is terminal", () => {
  const decoder = new ApplyPatchInputDecoder();
  const [, errInitial] = decoder.push(`{"input":"safe\\uD83D\\u0041`);
  expect(errInitial).toBeDefined();
  expect(decoder.input()).toBe("safe");
  expect(decoder.push(`suffix"}`)).toEqual(["", errInitial]);
  expect(decoder.finish(wrapApplyPatchInput("safe"))).toEqual(["", errInitial]);
});

test("finish error is terminal", () => {
  for (const args of [`{"input":null}`, `{"input":"wrong prefix"}`, `{"input":"safe\\uD83D"}`]) {
    const decoder = new ApplyPatchInputDecoder();
    expect(decoder.push(`{"input":"safe`)).toEqual(["safe", undefined]);
    const [, errInitial] = decoder.finish(args);
    expect(errInitial).toBeDefined();
    const [tail, err] = decoder.finish(`{"input":"safe"}`);
    expect(err).toBe(errInitial);
    expect(tail).toBe("");
    expect(decoder.input()).toBe("safe");
  }
});

test("equivalent final encoding", () => {
  const decoder = new ApplyPatchInputDecoder();
  expect(decoder.push(`{"input":"中\\n`)).toEqual(["中\n", undefined]);
  expect(decoder.finish(`{"in\\u0070ut":"\\u4e2d\\n😀"}`)).toEqual(["😀", undefined]);
  expect(decoder.finish(' \n{"input":"中\\n\\uD83D\\uDE00"}\t')).toEqual(["", undefined]);
});

test("push after finish", () => {
  const decoder = new ApplyPatchInputDecoder();
  expect(decoder.finish(`{"input":"patch"}`)[1]).toBeUndefined();
  const [delta, err] = decoder.push("more");
  expect(err).toBeDefined();
  expect(delta).toBe("");
  expect(decoder.input()).toBe("patch");
});

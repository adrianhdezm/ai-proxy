// Ported from: internal/translator/common/vertex_partial_args_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  VertexPartialArgsAssembler,
  isVertexStreamingFunctionCall,
  newVertexStreamingToolCall,
} from "../../../../src/translator/gemini/common/vertex_partial_args.ts";

const j = (s: string): unknown => JSON.parse(s);

test("VertexPartialArgsAssembler_ComplexTypesAndPaths", () => {
  const chunks = [
    `{"name":"complex_tool","partialArgs":[{"jsonPath":"$.query","stringValue":"line1\\n\\"quoted\\"\\\\slash\\t","willContinue":true}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.query","stringValue":"end","willContinue":true}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.query"},{"jsonPath":"$.count","numberValue":0},{"jsonPath":"$.enabled","boolValue":false},{"jsonPath":"$.optional","nullValue":"NULL_VALUE"}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.nested.items[0].label","stringValue":"first","willContinue":true},{"jsonPath":"$.nested.items[0].score","numberValue":1.5}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.nested.items[0].label"},{"jsonPath":"$.nested.items[1].label","stringValue":"second"},{"jsonPath":"$.nested.items[1].active","boolValue":true}],"willContinue":true}`,
    `{}`,
  ];
  const asm = new VertexPartialArgsAssembler();
  const deltas: string[] = [];
  chunks.forEach((raw, i) => {
    const [delta, done] = asm.pushFunctionCall(j(raw));
    expect(asm.err(), `chunk ${i}`).toBeUndefined();
    deltas.push(delta);
    expect(done, `chunk ${i} delta=${delta}`).toBe(i === chunks.length - 1);
  });
  expect(deltas[0]).toContain(`line1\\n\\"quoted\\"\\\\slash\\t`);
  const wantJSON = `{"query":"line1\\n\\"quoted\\"\\\\slash\\tend","count":0,"enabled":false,"optional":null,"nested":{"items":[{"label":"first","score":1.5},{"label":"second","active":true}]}}`;
  expect(deltas.join("")).toBe(wantJSON);
  expect(asm.fullArguments()).toBe(wantJSON);
});

test("VertexPartialArgsAssembler_InterleavedStringContinuations", () => {
  const chunks = [
    `{"name":"fn","partialArgs":[{"jsonPath":"$.a","stringValue":"A","willContinue":true}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.b","stringValue":"B","willContinue":true}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.b","stringValue":"C","willContinue":false}],"willContinue":true}`,
    `{"partialArgs":[{"jsonPath":"$.a","stringValue":"D","willContinue":false}],"willContinue":true}`,
    `{}`,
  ];
  const asm = new VertexPartialArgsAssembler();
  const deltas: string[] = [];
  chunks.forEach((raw, i) => {
    const [delta, done] = asm.pushFunctionCall(j(raw));
    expect(asm.err(), `chunk ${i}`).toBeUndefined();
    deltas.push(delta);
    expect(done).toBe(i === chunks.length - 1);
  });
  expect(deltas.join("")).toBe(`{"a":"AD","b":"BC"}`);
});

describe("VertexPartialArgsAssembler_NonDepthFirstAndArrayOrdering", () => {
  const run = (chunks: string[]): string => {
    const asm = new VertexPartialArgsAssembler();
    let out = "";
    for (const raw of chunks) {
      const [d] = asm.pushFunctionCall(j(raw));
      expect(asm.err()).toBeUndefined();
      out += d;
    }
    return out;
  };

  test("revisiting ancestor object path", () => {
    const got = run([
      `{"name":"fn","partialArgs":[{"jsonPath":"$.a.x","numberValue":1}],"willContinue":true}`,
      `{"partialArgs":[{"jsonPath":"$.b","numberValue":2}],"willContinue":true}`,
      `{"partialArgs":[{"jsonPath":"$.a.y","numberValue":3}],"willContinue":true}`,
      `{}`,
    ]);
    expect(got).toBe(`{"a":{"x":1,"y":3},"b":2}`);
  });

  test("reverse array indices", () => {
    const got = run([
      `{"name":"fn","partialArgs":[{"jsonPath":"$.items[1]","numberValue":2}],"willContinue":true}`,
      `{"partialArgs":[{"jsonPath":"$.items[0]","numberValue":1}],"willContinue":true}`,
      `{}`,
    ]);
    expect(got).toBe(`{"items":[1,2]}`);
  });

  test("sparse array index filled with null on finish", () => {
    const got = run([`{"name":"fn","partialArgs":[{"jsonPath":"$.items[2]","numberValue":3}],"willContinue":true}`, `{}`]);
    expect(got).toBe(`{"items":[null,null,3]}`);
  });
});

test("VertexPartialArgsAssembler_SingleChunkParameterlessAndEmptyPartialArgsFallback", () => {
  const ping = j(`{"name":"ping","willContinue":false}`);
  expect(isVertexStreamingFunctionCall(ping)).toBe(true);
  const asmPing = new VertexPartialArgsAssembler();
  const [deltaPing, donePing] = asmPing.pushFunctionCall(ping);
  expect(donePing).toBe(true);
  expect(deltaPing).toBe("{}");

  const withArgs = j(`{"name":"get_weather","args":{"city":"Paris"},"partialArgs":[]}`);
  expect(isVertexStreamingFunctionCall(withArgs)).toBe(false);
  const asmArgs = new VertexPartialArgsAssembler();
  const [deltaArgs, doneArgs] = asmArgs.pushFunctionCall(withArgs);
  expect(doneArgs).toBe(true);
  expect(deltaArgs).toBe(`{"city":"Paris"}`);
});

test("VertexStreamingToolCall_CanContinueWith", () => {
  const c1 = j(`{"id":"call_1","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"New ","willContinue":true}],"willContinue":true}`);
  const active = newVertexStreamingToolCall("get_weather", "get_weather", "call_1", "call_1", 0);
  const [, done] = active.assembler.pushFunctionCall(c1);
  expect(done).toBe(false);

  const c2OmittedID = j(`{"name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"York"}],"willContinue":false}`);
  expect(active.canContinueWith(c2OmittedID)).toBe(true);

  const c2DifferentID = j(`{"id":"call_2","name":"get_weather","partialArgs":[{"jsonPath":"$.city","stringValue":"LA"}],"willContinue":false}`);
  expect(active.canContinueWith(c2DifferentID)).toBe(false);
});

describe("VertexPartialArgsAssembler_QuotedJSONPathUnicodeAndLimits", () => {
  test("quoted keys with unicode, surrogate pairs, backslash, and quotes", () => {
    const chunk = `{"name":"fn","partialArgs":[{"jsonPath":"$['\\\\u0061']","numberValue":1},{"jsonPath":"$[\\"\\\\uD83D\\\\uDE00\\"]","stringValue":"smile"},{"jsonPath":"$['k\\\\'ey\\\\\\\\name']","boolValue":true}],"willContinue":false}`;
    const asm = new VertexPartialArgsAssembler();
    const [delta, done] = asm.pushFunctionCall(j(chunk));
    expect(asm.err()).toBeUndefined();
    expect(done).toBe(true);
    expect(delta).toBe(`{"a":1,"😀":"smile","k'ey\\\\name":true}`);
  });

  test("rejects invalid escapes and huge or overflowing array indices", () => {
    const invalidChunks = [
      `{"name":"fn","partialArgs":[{"jsonPath":"$['\\\\x41']","numberValue":1}],"willContinue":false}`,
      `{"name":"fn","partialArgs":[{"jsonPath":"$['\\\\uD800']","numberValue":1}],"willContinue":false}`,
      `{"name":"fn","partialArgs":[{"jsonPath":"$.items[5000]","numberValue":1}],"willContinue":false}`,
      `{"name":"fn","partialArgs":[{"jsonPath":"$.items[999999999999999999999999999]","numberValue":1}],"willContinue":false}`,
    ];
    for (const raw of invalidChunks) {
      const asm = new VertexPartialArgsAssembler();
      const [, done] = asm.pushFunctionCall(j(raw));
      expect(asm.err(), raw).toBeDefined();
      expect(done, raw).toBe(false);
    }
  });
});

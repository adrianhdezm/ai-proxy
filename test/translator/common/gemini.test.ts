// Ported from: internal/translator/common/gemini_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import {
  containsJSONRef,
  contentHasGeminiFunctionResponse,
  mergeAdjacentGeminiContents,
  mergeAdjacentGeminiUserContents,
  reorderGeminiUserParts,
  setGeminiFunctionResponseResult,
  splitGeminiFunctionResponseTurns,
} from "../../../src/translator/common/gemini.ts";
import { garray, getAt, gstr } from "../../../src/util/gpath.ts";

const j = (s: string): unknown => JSON.parse(s);
const parts = (content: unknown): unknown[] => garray(getAt(content, "parts"));

describe("mergeAdjacentGeminiContents", () => {
  test("empty and single item", () => {
    expect(mergeAdjacentGeminiContents([]).length).toBe(0);
    expect(mergeAdjacentGeminiContents([j('{"role":"user","parts":[{"text":"hello"}]}')]).length).toBe(1);
  });

  test("merges consecutive user turns", () => {
    const contents = [
      j('{"role":"user","parts":[{"text":"first prompt"}]}'),
      j('{"role":"user","parts":[{"text":"<system-reminder>rule 1</system-reminder>"}]}'),
      j('{"role":"user","parts":[{"text":"<system-reminder>rule 2</system-reminder>"}]}'),
      j('{"role":"model","parts":[{"text":"assistant answer"}]}'),
      j('{"role":"user","parts":[{"text":"follow-up"}]}'),
    ];
    const merged = mergeAdjacentGeminiContents(contents);
    expect(merged.length).toBe(3);
    expect(getAt(merged[0], "role")).toBe("user");
    const parts0 = parts(merged[0]);
    expect(parts0.length).toBe(3);
    expect(parts0.map((p) => gstr(getAt(p, "text")))).toEqual(["first prompt", "<system-reminder>rule 1</system-reminder>", "<system-reminder>rule 2</system-reminder>"]);
    expect(getAt(merged[1], "role")).toBe("model");
    expect(getAt(merged[2], "role")).toBe("user");
  });

  test("does not merge consecutive model turns to protect signature indices", () => {
    const contents = [
      j('{"role":"user","parts":[{"text":"question"}]}'),
      j('{"role":"model","parts":[{"text":"thought","thought":true}]}'),
      j('{"role":"model","parts":[{"text":"answer"}]}'),
    ];
    expect(mergeAdjacentGeminiContents(contents).length).toBe(3);
  });

  test("skips empty contents or contents with empty parts", () => {
    const contents: unknown[] = ["", j('{"role":"user","parts":[]}'), j('{"role":"user","parts":[{"text":"hello"}]}')];
    expect(mergeAdjacentGeminiContents(contents).length).toBe(1);
  });

  test("merges consecutive user turns and reorders trailing text before functionResponse", () => {
    const contents = [
      j('{"role":"user","parts":[{"functionResponse":{"name":"read","response":{"result":"ok"}}}]}'),
      j('{"role":"user","parts":[{"text":"<system-reminder>reminder</system-reminder>"}]}'),
    ];
    const merged = mergeAdjacentGeminiContents(contents);
    expect(merged.length).toBe(1);
    const p = parts(merged[0]);
    expect(p.length).toBe(2);
    expect(getAt(p[0], "text")).toBe("<system-reminder>reminder</system-reminder>");
    expect(getAt(p[1], "functionResponse.name")).toBe("read");
  });
});

describe("mergeAdjacentGeminiUserContents", () => {
  test("merges consecutive pure text user turns", () => {
    const merged = mergeAdjacentGeminiUserContents([j('{"role":"user","parts":[{"text":"prompt 1"}]}'), j('{"role":"user","parts":[{"text":"prompt 2"}]}')]);
    expect(merged.length).toBe(1);
    expect(parts(merged[0]).length).toBe(2);
  });

  test("does not merge across functionResponse boundaries", () => {
    const merged = mergeAdjacentGeminiUserContents([
      j('{"role":"user","parts":[{"functionResponse":{"name":"test","response":{"result":"ok"}}}]}'),
      j('{"role":"user","parts":[{"text":"user note"}]}'),
      j('{"role":"user","parts":[{"function_response":{"name":"test2","response":{"result":"ok2"}}}]}'),
    ]);
    expect(merged.length).toBe(3);
  });
});

describe("splitGeminiFunctionResponseTurns", () => {
  test("splits mixed user turn with response first", () => {
    const got = splitGeminiFunctionResponseTurns([
      j('{"role":"model","parts":[{"functionCall":{"name":"Bash"}}]}'),
      j('{"role":"user","parts":[{"text":"reminder"},{"functionResponse":{"name":"Bash"}}]}'),
    ]);
    expect(got.length).toBe(3);
    expect(contentHasGeminiFunctionResponse(got[1])).toBe(true);
    expect(contentHasGeminiFunctionResponse(got[2])).toBe(false);
  });

  test("keeps function response only turn intact", () => {
    const input = [j('{"role":"user","parts":[{"functionResponse":{"name":"Bash"}}]}')];
    const got = splitGeminiFunctionResponseTurns(input);
    expect(got.length).toBe(1);
    expect(got[0]).toEqual(input[0]);
  });

  test("handles multiple responses and alternate key", () => {
    const got = splitGeminiFunctionResponseTurns([j('{"role":"user","parts":[{"text":"before"},{"functionResponse":{"name":"one"}},{"function_response":{"name":"two"}},{"text":"after"}]}')]);
    expect(got.length).toBe(2);
    expect(parts(got[0]).length).toBe(2);
    expect(parts(got[1]).length).toBe(2);
    expect(contentHasGeminiFunctionResponse(got[0])).toBe(true);
    expect(contentHasGeminiFunctionResponse(got[1])).toBe(false);
  });

  test("preserves non-user and empty turns", () => {
    const input = [j('{"role":"model","parts":[{"functionResponse":{"name":"model-response"}}]}'), j('{"role":"user","parts":[]}')];
    const got = splitGeminiFunctionResponseTurns(input);
    expect(got).toEqual(input);
  });

  test("splits each mixed turn independently", () => {
    const got = splitGeminiFunctionResponseTurns([
      j('{"role":"user","parts":[{"text":"one"},{"functionResponse":{"name":"one"}}]}'),
      j('{"role":"user","parts":[{"text":"two"},{"functionResponse":{"name":"two"}}]}'),
    ]);
    expect(got.length).toBe(4);
    got.forEach((turn, i) => {
      expect(contentHasGeminiFunctionResponse(turn)).toBe(i % 2 === 0);
    });
  });

  test("hoists function response before intervening text reminder", () => {
    const got = splitGeminiFunctionResponseTurns([
      j('{"role":"model","parts":[{"functionCall":{"name":"Bash"}}]}'),
      j('{"role":"user","parts":[{"text":"system reminder"}]}'),
      j('{"role":"user","parts":[{"functionResponse":{"name":"Bash"}}]}'),
    ]);
    expect(got.length).toBe(3);
    expect(contentHasGeminiFunctionResponse(got[1])).toBe(true);
    expect(getAt(got[2], "parts.0.text")).toBe("system reminder");
  });

  test("merges multiple function response turns into single turn following model", () => {
    const got = splitGeminiFunctionResponseTurns([
      j('{"role":"model","parts":[{"functionCall":{"name":"A"}},{"functionCall":{"name":"B"}}]}'),
      j('{"role":"user","parts":[{"functionResponse":{"name":"A"}}]}'),
      j('{"role":"user","parts":[{"functionResponse":{"name":"B"}}]}'),
    ]);
    expect(got.length).toBe(2);
    expect(parts(got[1]).length).toBe(2);
  });
});

describe("reorderGeminiUserParts", () => {
  test("returns unchanged when no functionResponse", () => {
    const reordered = reorderGeminiUserParts([j('{"text":"hello"}'), j('{"inline_data":{"mime_type":"image/png","data":"abc"}}')]);
    expect(reordered.length).toBe(2);
    expect(getAt(reordered[0], "text")).toBe("hello");
  });

  test("returns unchanged when text already precedes functionResponse", () => {
    const reordered = reorderGeminiUserParts([j('{"text":"context"}'), j('{"functionResponse":{"name":"read","response":{"result":"ok"}}}')]);
    expect(reordered.length).toBe(2);
    expect(getAt(reordered[0], "text")).toBe("context");
  });

  test("reorders trailing text before functionResponse", () => {
    const reordered = reorderGeminiUserParts([j('{"functionResponse":{"name":"read","response":{"result":"ok"}}}'), j('{"text":"<system-reminder>reminder</system-reminder>"}')]);
    expect(reordered.length).toBe(2);
    expect(getAt(reordered[0], "text")).toBe("<system-reminder>reminder</system-reminder>");
    expect(getAt(reordered[1], "functionResponse.name")).toBe("read");
  });

  test("preserves relative order with multiple functionResponses and texts", () => {
    const reordered = reorderGeminiUserParts([
      j('{"text":"leading"}'),
      j('{"functionResponse":{"name":"tool1","response":{"result":"1"}}}'),
      j('{"functionResponse":{"name":"tool2","response":{"result":"2"}}}'),
      j('{"text":"trailing"}'),
    ]);
    expect(reordered.length).toBe(4);
    expect(getAt(reordered[0], "text")).toBe("leading");
    expect(getAt(reordered[1], "text")).toBe("trailing");
    expect(getAt(reordered[2], "functionResponse.name")).toBe("tool1");
    expect(getAt(reordered[3], "functionResponse.name")).toBe("tool2");
  });
});

describe("containsJSONRef", () => {
  const cases: { name: string; json: string; want: boolean }[] = [
    { name: "top-level $ref object", json: '{"$ref": "#/components/schemas/ErrorModel"}', want: true },
    { name: "nested $ref in object", json: '{"responses":{"400":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/ErrorModel"}}}}}}', want: true },
    { name: "nested $ref in array", json: '[{"schema":{"$ref":"#/components/schemas/ErrorModel"}}]', want: true },
    { name: "plain object without $ref", json: '{"temperature": 72, "city": "Seattle"}', want: false },
    { name: "plain array without $ref", json: '[1, 2, {"name": "test"}]', want: false },
    { name: "$ref with non-string value is not a schema ref", json: '{"$ref": 123}', want: false },
    { name: "primitive string containing $ref text is not a schema ref", json: '"this is just a string containing $ref"', want: false },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(containsJSONRef(j(tc.json))).toBe(tc.want);
    });
  }
});

describe("setGeminiFunctionResponseResult", () => {
  test("preserves $ref as string under result", () => {
    const updated = setGeminiFunctionResponseResult(j('{"functionResponse":{"name":"test"}}'), "functionResponse.response.result", j('{"schema":{"$ref":"#/components/schemas/ErrorModel"}}'));
    expect(typeof getAt(updated, "functionResponse.response.result")).toBe("string");
  });

  test("keeps non-$ref object as raw JSON under result", () => {
    const updated = setGeminiFunctionResponseResult(j('{"functionResponse":{"name":"test"}}'), "functionResponse.response.result", j('{"ok":true,"code":200}'));
    const val = getAt(updated, "functionResponse.response.result");
    expect(typeof val).toBe("object");
    expect(getAt(val, "ok")).toBe(true);
  });

  test("places stringified $ref under .result when path ends with response", () => {
    const updated = setGeminiFunctionResponseResult(j('{"functionResponse":{"name":"test"}}'), "functionResponse.response", j('{"schema":{"$ref":"#/components/schemas/ErrorModel"}}'));
    expect(typeof getAt(updated, "functionResponse.response.result")).toBe("string");
  });
});

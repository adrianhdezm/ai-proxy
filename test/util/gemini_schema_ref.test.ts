// Ported from: internal/util/gemini_schema_ref_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { cleanJSONSchemaForGeminiJSONSchema, inlineLocalRefs } from "../../src/util/gemini_schema.ts";
import { getAt } from "../../src/util/gpath.ts";

function compareJSON(expected: string, actual: string): void {
  expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
}

const cleaners: Record<string, (s: string) => string> = { inline: inlineLocalRefs, gemini: cleanJSONSchemaForGeminiJSONSchema };

describe("Issue6897 ref sibling conjunctions", () => {
  const cases: { name: string; target: string; sibling: string; checks: Record<string, string> }[] = [
    { name: "target_minimum", target: `{"type":"string","minLength":5}`, sibling: `"minLength":1`, checks: { "allOf.0.minLength": `5`, minLength: `1` } },
    { name: "sibling_minimum", target: `{"type":"string","minLength":1}`, sibling: `"minLength":5`, checks: { "allOf.0.minLength": `1`, minLength: `5` } },
    { name: "maximum", target: `{"type":"string","maxLength":5}`, sibling: `"maxLength":10`, checks: { "allOf.0.maxLength": `5`, maxLength: `10` } },
    { name: "patterns", target: `{"type":"string","pattern":"^a"}`, sibling: `"pattern":"z$"`, checks: { "allOf.0.pattern": `"^a"`, pattern: `"z$"` } },
    { name: "disjoint_types", target: `{"type":"string"}`, sibling: `"type":"number"`, checks: { "allOf.0.type": `"string"`, type: `"number"` } },
    { name: "overlapping_types", target: `{"type":["string","number"]}`, sibling: `"type":"number"`, checks: { "allOf.0.type": `["string","number"]`, type: `"number"` } },
    { name: "overlapping_nullable_types", target: `{"type":["string","null"]}`, sibling: `"type":"null"`, checks: { "allOf.0.type": `["string","null"]`, type: `"null"` } },
    { name: "overlapping_array_types", target: `{"type":["array","null"],"items":{"type":"integer"}}`, sibling: `"type":"array"`, checks: { "allOf.0.type": `["array","null"]`, "allOf.0.items.type": `"integer"`, type: `"array"` } },
    { name: "overlapping_object_types", target: `{"type":["object","string"],"properties":{"a":{"type":"integer"}}}`, sibling: `"type":"string"`, checks: { "allOf.0.type": `["object","string"]`, "allOf.0.properties.a.type": `"integer"`, type: `"string"` } },
    { name: "enums", target: `{"type":"string","enum":["a","b"]}`, sibling: `"enum":["b","c"]`, checks: { "allOf.0.enum": `["a","b"]`, enum: `["b","c"]` } },
    { name: "required_without_local_properties", target: `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a"]}`, sibling: `"required":["b"]`, checks: { "allOf.0.required": `["a"]`, required: `["b"]`, "allOf.0.properties.b.type": `"string"` } },
    { name: "closed_object_scopes", target: `{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":false}`, sibling: `"properties":{"b":{"type":"string"}},"additionalProperties":false`, checks: { "allOf.0.properties": `{"a":{"type":"string"}}`, properties: `{"b":{"type":"string"}}`, "allOf.0.additionalProperties": `false`, additionalProperties: `false` } },
    { name: "equal_closed_object_constraints", target: `{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":false}`, sibling: `"additionalProperties":false`, checks: { "allOf.0.properties.a.type": `"string"`, "allOf.0.additionalProperties": `false`, additionalProperties: `false` } },
    { name: "sibling_closed_object_scope", target: `{"type":"object","properties":{"a":{"type":"string"}}}`, sibling: `"additionalProperties":false`, checks: { "allOf.0.properties.a.type": `"string"`, additionalProperties: `false` } },
    { name: "target_closed_object_scope", target: `{"type":"object","additionalProperties":false}`, sibling: `"properties":{"a":{"type":"string"}}`, checks: { "allOf.0.additionalProperties": `false`, "properties.a.type": `"string"` } },
    { name: "equal_contains_constraints", target: `{"type":"array","items":{},"contains":{"type":"integer"},"minContains":0}`, sibling: `"contains":{"type":"integer"}`, checks: { "allOf.0.minContains": `0`, "allOf.0.contains.type": `"integer"`, "contains.type": `"integer"` } },
    { name: "contains_count_scope", target: `{"type":"array","items":{},"contains":{"type":"integer"}}`, sibling: `"minContains":0`, checks: { "allOf.0.contains.type": `"integer"`, minContains: `0` } },
    { name: "equal_items_with_different_prefix_scope", target: `{"type":"array","prefixItems":[{"type":"string"}],"items":{"type":"integer"}}`, sibling: `"items":{"type":"integer"}`, checks: { "allOf.0.prefixItems.0.type": `"string"`, "allOf.0.items.type": `"integer"`, "items.type": `"integer"` } },
    { name: "existing_allof", target: `{"type":"string","allOf":[{"minLength":5}]}`, sibling: `"allOf":[{"maxLength":8}]`, checks: { "allOf.0.allOf.0.minLength": `5`, "allOf.1.maxLength": `8` } },
  ];
  for (const tc of cases) {
    for (const rootRef of [false, true]) {
      let name = tc.name + "/nested";
      let input = `{"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":{"A":${tc.target}},"type":"object","properties":{"x":{"$ref":"#/$defs/A",${tc.sibling}}}}`;
      let path = "properties.x";
      if (rootRef) {
        name = tc.name + "/root";
        input = `{"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":{"A":${tc.target}},"$ref":"#/$defs/A",${tc.sibling}}`;
        path = "";
      }
      for (const [cleaner, clean] of Object.entries(cleaners)) {
        test(`${name}/${cleaner}`, () => {
          const got = clean(input);
          const node = getAt(JSON.parse(got), path);
          for (const [key, want] of Object.entries(tc.checks)) {
            const actual = getAt(node, key);
            expect(actual, `lost constraint ${key} = ${want}: ${got}`).toBeDefined();
            expect(actual).toEqual(JSON.parse(want));
          }
          compareJSON(got, clean(got));
        });
      }
    }
  }
});

test("Issue6897 ref sibling annotations and identical types", () => {
  const input = `{"$defs":{"A":{"type":"string","minLength":5,"description":"base","default":"base","examples":["base"]}},"properties":{"x":{"$ref":"#/$defs/A","type":"string","description":"local","default":"local","examples":[{"$ref":"literal"}]}}}`;
  for (const clean of Object.values(cleaners)) {
    const got = clean(input);
    expect(getAt(JSON.parse(got), "properties.x")).toEqual(JSON.parse(`{"type":"string","minLength":5,"description":"local","default":"local","examples":[{"$ref":"literal"}]}`));
  }
});

test("Issue6897 wrapped ref conjunction", () => {
  const got = cleanJSONSchemaForGeminiJSONSchema(`{"schema":{"$defs":{"A":{"type":"string","minLength":5}},"$ref":"#/$defs/A","minLength":1}}`);
  compareJSON(`{"schema":{"minLength":1,"allOf":[{"type":"string","minLength":5}]}}`, got);
});

test("Issue6897 root ref keeps document declarations", () => {
  const got = inlineLocalRefs(`{"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":{"A":{"type":"string","minLength":5}},"$ref":"#/$defs/A","minLength":1}`);
  compareJSON(`{"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":{"A":{"type":"string","minLength":5}},"minLength":1,"allOf":[{"type":"string","minLength":5}]}`, got);
});

test("Issue6897 required outside allOf", () => {
  const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","allOf":[{"properties":{"x":{"type":"string"}}}],"required":["x"]}`);
  expect(getAt(JSON.parse(got), "required.0")).toBe("x");
});

test("Issue6897 array conjunction does not invent items", () => {
  for (const rootRef of [false, true]) {
    const input = rootRef
      ? `{"$defs":{"A":{"type":"array","items":{"type":"integer"},"minItems":2}},"$ref":"#/$defs/A","type":"array","minItems":1}`
      : `{"$defs":{"A":{"type":"array","items":{"type":"integer"},"minItems":2}},"type":"object","properties":{"x":{"$ref":"#/$defs/A","type":"array","minItems":1}}}`;
    const got = cleanJSONSchemaForGeminiJSONSchema(input);
    const node = getAt(JSON.parse(got), rootRef ? "" : "properties.x");
    expect(node).toEqual(JSON.parse(`{"type":"array","minItems":1,"allOf":[{"type":"array","items":{"type":"integer"},"minItems":2}]}`));
    compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
  }
});

test("Issue6897 array target does not invent items before inlining", () => {
  for (const rootRef of [false, true]) {
    const input = rootRef
      ? `{"$defs":{"A":{"type":"array","minItems":2}},"$ref":"#/$defs/A","minItems":1,"items":{"type":"integer"}}`
      : `{"$defs":{"A":{"type":"array","minItems":2}},"type":"object","properties":{"x":{"$ref":"#/$defs/A","minItems":1,"items":{"type":"integer"}}}}`;
    const got = cleanJSONSchemaForGeminiJSONSchema(input);
    const node = getAt(JSON.parse(got), rootRef ? "" : "properties.x");
    expect(node).toEqual(JSON.parse(`{"minItems":1,"items":{"type":"integer"},"allOf":[{"type":"array","minItems":2}]}`));
    compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
  }
});

test("Issue6897 array items inside allOf", () => {
  const got = JSON.parse(cleanJSONSchemaForGeminiJSONSchema(`{"type":"array","allOf":[{"items":{"type":"integer"}}]}`));
  expect(getAt(got, "items")).toBeUndefined();
  expect(getAt(got, "allOf.0.items.type")).toBe("integer");
});

test("Issue6897 union cannot replace conjunction", () => {
  const input = `{"type":"object","allOf":[{"properties":{"x":{"type":"string"}},"required":["x"]}],"anyOf":[{"type":"object"}]}`;
  const got = cleanJSONSchemaForGeminiJSONSchema(input);
  const parsed = JSON.parse(got);
  expect(getAt(parsed, "allOf.0.properties.x.type")).toBe("string");
  expect(getAt(parsed, "allOf.0.required.0")).toBe("x");
  compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
});

test("Issue6897 conjunction preserves required-only union", () => {
  const input = `{"type":"object","allOf":[{"properties":{"a":{"type":"string"},"b":{"type":"string"}}},{"anyOf":[{"required":["a"]},{"required":["b"]}]}]}`;
  const got = cleanJSONSchemaForGeminiJSONSchema(input);
  const parsed = JSON.parse(got);
  expect(getAt(parsed, "allOf.1.anyOf.0.required.0")).toBe("a");
  expect(getAt(parsed, "allOf.1.anyOf.1.required.0")).toBe("b");
  compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
});

test("Issue6897 ref sibling required-only union", () => {
  const input = `{"$defs":{"A":{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"minProperties":1}},"type":"object","properties":{"x":{"$ref":"#/$defs/A","minProperties":0,"anyOf":[{"required":["a"]},{"required":["b"]}]}}}`;
  const got = cleanJSONSchemaForGeminiJSONSchema(input);
  const parsed = JSON.parse(got);
  expect(getAt(parsed, "properties.x.anyOf.0.required.0")).toBe("a");
  expect(getAt(parsed, "properties.x.anyOf.1.required.0")).toBe("b");
  compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
});

test("Issue6897 conjunction does not infer container type", () => {
  for (const sibling of [`"items":{"type":"integer"}`, `"properties":{"ignored":{"type":"integer"}}`]) {
    const input = `{"$defs":{"A":{"type":"number","minimum":5}},"type":"object","properties":{"x":{"$ref":"#/$defs/A","minimum":1,${sibling}}}}`;
    const got = cleanJSONSchemaForGeminiJSONSchema(input);
    const node = getAt(JSON.parse(got), "properties.x");
    expect(getAt(node, "type")).toBeUndefined();
    expect(getAt(node, "allOf.0.type")).toBe("number");
    compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
  }
});

test("Issue6897 outer union preserves conjunction", () => {
  const cases = [
    { input: `{"type":"object","properties":{"x":{"type":"string"}},"anyOf":[{"allOf":[{"properties":{"x":{"minLength":5}}}]}]}`, path: "anyOf.0.allOf.0.properties.x.minLength", want: 5 },
    { input: `{"$defs":{"A":{"type":"object","properties":{"x":{"minLength":5}},"minProperties":1}},"type":"object","properties":{"x":{"type":"string"}},"anyOf":[{"$ref":"#/$defs/A","minProperties":0}]}`, path: "anyOf.0.allOf.0.properties.x.minLength", want: 5 },
    { input: `{"required":["x"],"anyOf":[{"allOf":[{"properties":{"x":{"type":"string"}}}]}]}`, path: "required.0", want: "x" },
  ];
  for (const tc of cases) {
    const got = cleanJSONSchemaForGeminiJSONSchema(tc.input);
    expect(getAt(JSON.parse(got), tc.path)).toBe(tc.want);
    compareJSON(got, cleanJSONSchemaForGeminiJSONSchema(got));
  }
});

test("Issue6897 ref sibling unevaluated scope", () => {
  const cases = [
    { target: `{"type":"object","unevaluatedProperties":false}`, sibling: `"properties":{"x":{"type":"string"}}`, want: `{"properties":{"x":{"type":"string"}},"allOf":[{"type":"object","unevaluatedProperties":false}]}` },
    { target: `{"type":"array","unevaluatedItems":false}`, sibling: `"prefixItems":[{"type":"integer"}]`, want: `{"prefixItems":[{"type":"integer"}],"allOf":[{"type":"array","unevaluatedItems":false}]}` },
    { target: `{"type":"object","properties":{"x":{"type":"string"}},"minProperties":1}`, sibling: `"minProperties":0,"unevaluatedProperties":false`, want: `{"minProperties":0,"unevaluatedProperties":false,"allOf":[{"type":"object","properties":{"x":{"type":"string"}},"minProperties":1}]}` },
    { target: `{"type":"array","prefixItems":[{"type":"integer"}],"minItems":1}`, sibling: `"minItems":0,"unevaluatedItems":false`, want: `{"minItems":0,"unevaluatedItems":false,"allOf":[{"type":"array","prefixItems":[{"type":"integer"}],"minItems":1}]}` },
  ];
  for (const tc of cases) {
    for (const rootRef of [false, true]) {
      const input = rootRef ? `{"$defs":{"A":${tc.target}},"$ref":"#/$defs/A",${tc.sibling}}` : `{"$defs":{"A":${tc.target}},"properties":{"value":{"$ref":"#/$defs/A",${tc.sibling}}}}`;
      const got = JSON.parse(inlineLocalRefs(input));
      let node: unknown;
      if (rootRef) {
        delete (got as Record<string, unknown>).$defs;
        node = got;
      } else {
        node = getAt(got, "properties.value");
      }
      expect(node).toEqual(JSON.parse(tc.want));
    }
  }
});

test("Issue6897 ref sibling minLength", () => {
  const got = cleanJSONSchemaForGeminiJSONSchema(`{"$schema":"https://json-schema.org/draft/2020-12/schema","$defs":{"A":{"type":"string","minLength":5}},"type":"object","properties":{"x":{"$ref":"#/$defs/A","minLength":1}}}`);
  const minLength = (schema: unknown): number => {
    let minimum = Number(getAt(schema, "minLength") ?? 0);
    for (const branch of (getAt(schema, "allOf") as unknown[] | undefined) ?? []) minimum = Math.max(minimum, minLength(branch));
    return minimum;
  };
  expect(minLength(getAt(JSON.parse(got), "properties.x"))).toBe(5);
});

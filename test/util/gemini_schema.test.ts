// Ported from: internal/util/gemini_schema_test.go
// Skipped cases: TestCleanJSONSchema_PreservesLargeNumberPrecision (JSON.parse cannot preserve integers beyond 2^53), large_int sub-check of TestCleanJSONSchema_NestedTrueBooleanSubschemas (same reason)
import { describe, expect, test } from "bun:test";
import {
  cleanJSONSchemaForAntigravity,
  cleanJSONSchemaForAntigravityClaudeTool,
  cleanJSONSchemaForAntigravityResponse,
  cleanJSONSchemaForAntigravityTool,
  cleanJSONSchemaForGemini,
  cleanJSONSchemaForGeminiJSONSchema,
  inlineLocalRefs,
  inlineLocalRefsForCleanString,
  isPropertyDefinition,
  removeExtensionFieldsString,
} from "../../src/util/gemini_schema.ts";
import { getAt, gstr, sortByDepth } from "../../src/util/gpath.ts";

function compareJSON(expected: string, actual: string): void {
  expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
}
function P(s: string): unknown {
  return JSON.parse(s);
}
function g(s: string, path: string): unknown {
  return getAt(JSON.parse(s), path);
}
function gs(s: string, path: string): string {
  return gstr(g(s, path));
}
function has(s: string, path: string): boolean {
  return g(s, path) !== undefined;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => gstr(x)) : [];
}

const antigravityTool = (s: string) => cleanJSONSchemaForAntigravityTool(s, false);
const antigravityClaudeTool = (s: string) => cleanJSONSchemaForAntigravityClaudeTool(s, false);

test("ConstToEnum", () => {
  compareJSON(
    `{"type":"object","properties":{"kind":{"type":"string","description":"Allowed: InsightVizNode"}}}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"kind":{"type":"string","const":"InsightVizNode"}}}`),
  );
});

test("TypeFlattening_Nullable", () => {
  compareJSON(
    `{"type":"object","properties":{"name":{"type":"string","nullable":true,"description":"(nullable)"},"other":{"type":"string"}},"required":["name","other"]}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"name":{"type":["string","null"]},"other":{"type":"string"}},"required":["name","other"]}`),
  );
});

test("ConstraintsToDescription", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"tags":{"type":"array","description":"List of tags","minItems":1},"name":{"type":"string","description":"User name","minLength":3}}}`);
  expect(result.includes(`"minItems"`)).toBe(false);
  expect(result.includes("minItems: 1")).toBe(true);
  expect(result.includes("minLength: 3")).toBe(true);
  expect(result.includes(`"minLength":`)).toBe(false);
});

test("AnyOfFlattening_SmartSelection", () => {
  compareJSON(
    `{"type":"object","properties":{"query":{"type":"object","nullable":true,"description":"Accepts: null | object","properties":{"_":{"type":"boolean"},"kind":{"type":"string"}},"required":["_"]}}}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"query":{"anyOf":[{"type":"null"},{"type":"object","properties":{"kind":{"type":"string"}}}]}}}`),
  );
});

test("OneOfFlattening", () => {
  compareJSON(
    `{"type":"object","properties":{"config":{"anyOf":[{"type":"string"},{"type":"integer"}]}}}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"config":{"oneOf":[{"type":"string"},{"type":"integer"}]}}}`),
  );
});

test("AllOfMerging", () => {
  compareJSON(
    `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"integer"}},"required":["a","b"]}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","allOf":[{"properties":{"a":{"type":"string"}},"required":["a"]},{"properties":{"b":{"type":"integer"}},"required":["b"]}]}`),
  );
});

test("RefHandling", () => {
  compareJSON(
    `{"type":"object","properties":{"customer":{"type":"object","properties":{"name":{"type":"string"},"_":{"type":"boolean"}},"required":["_"]}}}`,
    cleanJSONSchemaForAntigravity(`{"definitions":{"User":{"type":"object","properties":{"name":{"type":"string"}}}},"type":"object","properties":{"customer":{"$ref":"#/definitions/User"}}}`),
  );
});

test("RefHandling_DescriptionEscaping", () => {
  const input = `{"definitions":{"User":{"type":"object","properties":{"name":{"type":"string"}}}},"type":"object","properties":{"customer":{"description":"He said \\"hi\\"\\\\nsecond line","$ref":"#/definitions/User"}}}`;
  compareJSON(
    `{"type":"object","properties":{"customer":{"type":"object","description":"He said \\"hi\\"\\\\nsecond line","properties":{"name":{"type":"string"},"_":{"type":"boolean"}},"required":["_"]}}}`,
    cleanJSONSchemaForAntigravity(input),
  );
});

test("CyclicRefDefaults", () => {
  const result = cleanJSONSchemaForAntigravity(`{"definitions":{"Node":{"type":"object","properties":{"child":{"$ref":"#/definitions/Node"}}}},"$ref":"#/definitions/Node"}`);
  expect(gs(result, "type")).toBe("object");
  expect(gs(result, "properties.child.type")).toBe("object");
  expect(gs(result, "properties.child.description").includes("Node")).toBe(true);
});

test("RequiredCleanup", () => {
  compareJSON(
    `{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a","b"]}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a","b","c"]}`),
  );
});

test("AllOfMerging_DotKeys", () => {
  compareJSON(
    `{"type":"object","properties":{"my.param":{"type":"string"},"b":{"type":"integer"}},"required":["my.param","b"]}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","allOf":[{"properties":{"my.param":{"type":"string"}},"required":["my.param"]},{"properties":{"b":{"type":"integer"}},"required":["b"]}]}`),
  );
});

test("PropertyNameCollision", () => {
  const input = `{"type":"object","properties":{"pattern":{"type":"string","description":"The regex pattern"}},"required":["pattern"]}`;
  const result = cleanJSONSchemaForAntigravity(input);
  compareJSON(input, result);
  expect(has(result, "properties.description")).toBe(false);
});

test("DotKeys", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"my.param":{"type":"string","$ref":"#/definitions/MyType"}},"definitions":{"MyType":{"type":"string"}}}`);
  const props = g(result, "properties") as Record<string, unknown>;
  expect("my.param" in props).toBe(true);
  expect("$ref" in (props["my.param"] as Record<string, unknown>)).toBe(false);
  expect("my" in props).toBe(false);
});

test("AnyOfAlternativeHints", () => {
  compareJSON(
    `{"type":"object","properties":{"value":{"anyOf":[{"type":"string"},{"type":"integer"}],"nullable":true,"description":"(nullable)"}}}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"value":{"anyOf":[{"type":"string"},{"type":"integer"},{"type":"null"}]}}}`),
  );
});

test("NullableHint", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"name":{"type":["string","null"],"description":"User name"}},"required":["name"]}`);
  expect(result.includes("(nullable)")).toBe(true);
  expect(result.includes("User name")).toBe(true);
});

test("TypeFlattening_Nullable_DotKey", () => {
  compareJSON(
    `{"type":"object","properties":{"my.param":{"type":"string","nullable":true,"description":"(nullable)"},"other":{"type":"string"}},"required":["my.param","other"]}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"my.param":{"type":["string","null"]},"other":{"type":"string"}},"required":["my.param","other"]}`),
  );
});

test("EnumHint", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"status":{"type":"string","enum":["active","inactive","pending"],"description":"Current status"}}}`);
  expect(result.includes("Allowed:")).toBe(true);
  expect(result.includes("active") && result.includes("inactive")).toBe(true);
});

test("AdditionalPropertiesHint", () => {
  expect(cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"name":{"type":"string"}},"additionalProperties":false}`).includes("No extra properties allowed")).toBe(true);
});

test("AnyOfFlattening_PreservesDescription", () => {
  compareJSON(
    `{"type":"object","properties":{"config":{"type":"string","nullable":true,"description":"Parent desc (Child desc) (Accepts: string | null)"}}}`,
    cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"config":{"description":"Parent desc","anyOf":[{"type":"string","description":"Child desc"},{"type":"null"}]}}}`),
  );
  const multi = `{"type":"object","properties":{"config":{"description":"Parent desc","anyOf":[{"type":"string","description":"Child desc"},{"type":"integer"}]}}}`;
  compareJSON(multi, cleanJSONSchemaForAntigravity(multi));
});

test("SingleEnumBecomesHint", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"kind":{"type":"string","enum":["fixed"]}}}`);
  expect(result.includes("Allowed: fixed")).toBe(true);
  expect(has(result, "properties.kind.enum")).toBe(false);
});

test("MultipleNonNullTypes", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"value":{"type":["string","integer","boolean"]}}}`);
  expect(result.includes("Accepts:")).toBe(true);
  for (const t of ["string", "integer", "boolean"]) expect(result.includes(t)).toBe(true);
});

describe("empty schema placeholders", () => {
  test("EmptySchemaPlaceholder", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object"}`);
    expect(result.includes(`"reason"`)).toBe(true);
    expect(result.includes(`"required"`)).toBe(true);
  });
  test("EmptyPropertiesPlaceholder", () => {
    expect(cleanJSONSchemaForAntigravity(`{"type":"object","properties":{}}`).includes(`"reason"`)).toBe(true);
  });
  test("NonEmptySchemaUnchanged", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}`);
    expect(result.includes(`"reason"`)).toBe(false);
    expect(result.includes(`"name"`)).toBe(true);
  });
  test("NestedEmptySchema", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"items":{"type":"array","items":{"type":"object"}}}}`);
    expect(has(result, "properties.items.items.properties.reason")).toBe(true);
  });
  test("EmptySchemaWithDescription", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object","description":"An empty object"}`);
    expect(result.includes(`"An empty object"`)).toBe(true);
    expect(result.includes(`"reason"`)).toBe(true);
  });
});

test("AntigravityResponse does not add tool placeholders", () => {
  const bare = cleanJSONSchemaForAntigravityResponse(`{"type":"object"}`);
  expect(has(bare, "properties.reason") || has(bare, "required")).toBe(false);
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","title":"Response","nullable":true,"properties":{"empty":{"type":"object"},"optional":{"type":"object","properties":{"value":{"type":"string"}}}}}`);
  for (const path of ["properties.empty.properties.reason", "properties.empty.required", "properties.optional.properties._", "properties.optional.required"]) {
    expect(has(result, path), path).toBe(false);
  }
  expect(gs(result, "title")).toBe("Response");
  expect(g(result, "nullable")).toBe(true);
});

test("AntigravityResponse projects ignored unions", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"action":{"anyOf":[{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},{"type":"null"}]},"label":{"oneOf":[{"type":"string"},{"type":"null"}]}}}`);
  expect(has(result, "properties.action.anyOf")).toBe(false);
  expect(has(result, "properties.label.oneOf")).toBe(false);
  expect(gs(result, "properties.action.type")).toBe("object");
  expect(g(result, "properties.action.nullable")).toBe(true);
  expect(gs(result, "properties.label.type")).toBe("string");
  expect(g(result, "properties.label.nullable")).toBe(true);
});

test("AntigravityResponse preserves additionalProperties false", () => {
  const input = `{"type":"object","properties":{"name":{"type":"string"},"nested":{"type":"object","properties":{"age":{"type":"integer"}},"additionalProperties":false}},"additionalProperties":false}`;
  const result = cleanJSONSchemaForAntigravityResponse(input);
  expect(g(result, "additionalProperties")).toBe(false);
  expect(g(result, "properties.nested.additionalProperties")).toBe(false);
  expect(result.includes("No extra properties allowed")).toBe(false);
  const toolResult = cleanJSONSchemaForAntigravity(input);
  expect(toolResult.includes(`"additionalProperties"`)).toBe(false);
  expect(toolResult.includes("No extra properties allowed")).toBe(true);
  const nonFalse = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"map":{"type":"object","additionalProperties":{"type":"string"}}},"additionalProperties":true}`);
  expect(nonFalse.includes(`"additionalProperties"`)).toBe(false);
});

test("AntigravityResponse preserves enum type", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"conviction":{"type":"number","enum":[0.25,0.5,1]},"count":{"type":"integer","enum":[1,2]}}}`);
  expect(gs(result, "properties.conviction.type")).toBe("number");
  expect(g(result, "properties.conviction.enum")).toEqual(["0.25", "0.5", "1"]);
  expect(gs(result, "properties.count.type")).toBe("integer");
  expect(g(result, "properties.count.enum")).toEqual(["1", "2"]);
});

describe("format field handling", () => {
  test("FormatFieldRemoval", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"url":{"type":"string","format":"uri","description":"A URL"}}}`);
    expect(result.includes(`"format"`)).toBe(false);
    expect(result.includes("format: uri")).toBe(true);
    expect(result.includes("A URL")).toBe(true);
  });
  test("FormatFieldNoDescription", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"email":{"type":"string","format":"email"}}}`);
    expect(result.includes(`"format"`)).toBe(false);
    expect(result.includes("format: email")).toBe(true);
  });
  test("MultipleFormats", () => {
    const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"url":{"type":"string","format":"uri"},"email":{"type":"string","format":"email"},"date":{"type":"string","format":"date-time"}}}`);
    expect(result.includes(`"format"`)).toBe(false);
    for (const h of ["format: uri", "format: email", "format: date-time"]) expect(result.includes(h)).toBe(true);
  });
});

test("ToolEnumsBecomeHints", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"priority":{"type":"integer","enum":[0,1,2]},"level":{"type":"number","enum":[1.5,2.5,3.5]},"status":{"type":"string","enum":["active","inactive"]}}}`);
  for (const [path, wantType] of Object.entries({ "properties.priority": "integer", "properties.level": "number", "properties.status": "string" })) {
    expect(gs(result, path + ".type")).toBe(wantType);
    expect(has(result, path + ".enum")).toBe(false);
    expect(gs(result, path + ".description").includes("Allowed:")).toBe(true);
  }
});

test("BooleanToolEnumBecomesHint", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"enabled":{"type":"boolean","enum":[true,false]}}}`);
  expect(has(result, "properties.enabled.enum")).toBe(false);
  expect(gs(result, "properties.enabled.type")).toBe("boolean");
  expect(gs(result, "properties.enabled.description").includes("Allowed: true, false")).toBe(true);
});

test("Gemini removes unsupported metadata fields", () => {
  const input = `{"$schema":"http://json-schema.org/draft-07/schema#","$id":"root-schema","$comment":"root comment should be removed","type":"object","properties":{"payload":{"type":"object","$comment":"nested comment should be removed","prefill":"hello","properties":{"mode":{"type":"string","enum":["a","b"],"enumDescriptions":["Alpha","Beta"],"enumTitles":["A","B"]}},"patternProperties":{"^x-":{"type":"string"}}},"$id":{"type":"string","description":"property name should not be removed"},"$comment":{"type":"string","description":"property name should not be removed"},"enumDescriptions":{"type":"array","description":"property name should not be removed"}}}`;
  const expected = `{"type":"object","properties":{"payload":{"type":"object","properties":{"mode":{"type":"string","enum":["a","b"],"description":"Allowed: a, b"}}},"$id":{"type":"string","description":"property name should not be removed"},"$comment":{"type":"string","description":"property name should not be removed"},"enumDescriptions":{"type":"array","items":{"type":"string"},"description":"property name should not be removed"}}}`;
  compareJSON(expected, cleanJSONSchemaForGemini(input));
});

describe("removeExtensionFields", () => {
  const tests: [string, string, string][] = [
    ["removes x- fields at root", `{"type":"object","x-custom-meta":"value","properties":{"foo":{"type":"string"}}}`, `{"type":"object","properties":{"foo":{"type":"string"}}}`],
    ["removes x- fields in nested properties", `{"type":"object","properties":{"foo":{"type":"string","x-internal-id":123}}}`, `{"type":"object","properties":{"foo":{"type":"string"}}}`],
    ["does NOT remove properties named x-", `{"type":"object","properties":{"x-data":{"type":"string"},"normal":{"type":"number","x-meta":"remove"}},"required":["x-data"]}`, `{"type":"object","properties":{"x-data":{"type":"string"},"normal":{"type":"number"}},"required":["x-data"]}`],
    ["does NOT remove $schema and other meta fields", `{"$schema":"http://json-schema.org/draft-07/schema#","$id":"test","type":"object","properties":{"foo":{"type":"string"}}}`, `{"$schema":"http://json-schema.org/draft-07/schema#","$id":"test","type":"object","properties":{"foo":{"type":"string"}}}`],
    ["handles properties named $schema", `{"type":"object","properties":{"$schema":{"type":"string"}}}`, `{"type":"object","properties":{"$schema":{"type":"string"}}}`],
    ["handles escaping in paths", `{"type":"object","properties":{"foo.bar":{"type":"string","x-meta":"remove"}},"x-root.meta":"remove"}`, `{"type":"object","properties":{"foo.bar":{"type":"string"}}}`],
  ];
  for (const [name, input, expected] of tests) {
    test(name, () => compareJSON(expected, removeExtensionFieldsString(input)));
  }
});

test("UniqueItemsStripped", () => {
  const result = cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"ids":{"type":"array","description":"Unique identifiers","items":{"type":"string"},"uniqueItems":true}}}`);
  expect(result.includes(`"uniqueItems"`)).toBe(false);
  expect(result.includes("uniqueItems: true")).toBe(true);
});

test("isPropertyDefinition distinguishes property named properties", () => {
  const cases: Record<string, boolean> = {
    "": false,
    properties: true,
    "properties.properties": false,
    "properties.properties.properties": true,
    "properties.records.items.properties": true,
    "properties.records.items": false,
    "schema.properties": true,
    "request.tools.0.functionDeclarations.0.parameters": false,
    "request.tools.0.functionDeclarations.0.parameters.properties": true,
    "request.tools.0.functionDeclarations.0.parameters.properties.properties": false,
    $defs: true,
    "$defs.properties": false,
    "properties.$defs": false,
    "properties.a.patternProperties": true,
    "properties.patternProperties": false,
  };
  for (const [path, want] of Object.entries(cases)) expect(isPropertyDefinition(path), path).toBe(want);
});

test("strips propertyNames under property named properties", () => {
  const shapes: Record<string, string> = {
    arrayItem: `{"type":"object","properties":{"records":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}},"propertyNames":{"type":"string"}}}}}`,
    propertyNamedProperties: `{"type":"object","properties":{"properties":{"type":"object","propertyNames":{"type":"string"}}}}`,
    combined: `{"type":"object","properties":{"pages":{"type":"array","items":{"type":"object","properties":{"properties":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":true}},"propertyNames":{"type":"string"}}}}}`,
  };
  for (const schema of Object.values(shapes)) {
    for (const clean of [cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini, cleanJSONSchemaForAntigravityResponse]) {
      const got = clean(schema);
      expect(got.includes(`"propertyNames"`)).toBe(false);
      expect(got.includes(`"additionalProperties"`)).toBe(false);
    }
  }
});

test("keeps properties named like keywords", () => {
  const input = `{"type":"object","properties":{"propertyNames":{"type":"string"},"patternProperties":{"type":"string"},"properties":{"type":"object","properties":{"propertyNames":{"type":"string"}}}}}`;
  for (const clean of [cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini]) {
    const got = clean(input);
    for (const path of ["properties.propertyNames", "properties.patternProperties", "properties.properties.properties.propertyNames"]) expect(has(got, path), path).toBe(true);
  }
});

test("ConditionalKeywords", () => {
  const all = [cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini];
  const rootInput = `{"type":"object","properties":{"kind":{"type":"string","enum":["buy","sell"]}},"required":["kind"],"if":{"properties":{"kind":{"const":"sell"}}},"then":{"properties":{"sell_reason":{"type":"string","description":"why the position is being sold"}},"required":["sell_reason"]},"else":{"properties":{"buy_reason":{"type":"string"}}}}`;
  for (const clean of all) {
    const res = clean(rootInput);
    expect(has(res, "if") || has(res, "then") || has(res, "else")).toBe(false);
    expect(has(res, "properties.sell_reason")).toBe(true);
    expect(has(res, "properties.buy_reason")).toBe(true);
    expect(gs(res, "properties.sell_reason.description")).toBe("why the position is being sold");
  }
  const allOfInput = `{"type":"object","properties":{"kind":{"type":"string","enum":["buy","sell"]}},"required":["kind"],"allOf":[{"if":{"properties":{"kind":{"const":"sell"}}},"then":{"properties":{"sell_reason":{"type":"string","description":"why the position is being sold"}},"required":["sell_reason"]}}]}`;
  for (const clean of all) {
    const res = clean(allOfInput);
    expect(has(res, "allOf")).toBe(false);
    expect(res.includes(`"if":`)).toBe(false);
    expect(has(res, "properties.sell_reason")).toBe(true);
    expect(gs(res, "properties.sell_reason.description")).toBe("why the position is being sold");
  }
  const nestedInput = `{"type":"object","properties":{"trade":{"type":"object","properties":{"kind":{"type":"string"}},"if":{"properties":{"kind":{"const":"sell"}}},"then":{"properties":{"sell_reason":{"type":"string"}}}}}}`;
  for (const clean of all) {
    const res = clean(nestedInput);
    expect(has(res, "properties.trade.if") || has(res, "properties.trade.then")).toBe(false);
    expect(has(res, "properties.trade.properties.sell_reason")).toBe(true);
  }
});

test("AntigravityResponse conditional cannot overwrite parent", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"kind":{"type":"string"},"action":{"type":"object","properties":{"full":{"type":"string"}},"required":["full"]}},"required":["kind","action"],"allOf":[{"if":{"properties":{"kind":{"const":"skip"}}},"then":{"properties":{"action":{"type":"null"},"branch_only":{"type":"integer"}}}}]}`);
  expect(gs(result, "properties.action.type")).toBe("object");
  expect(has(result, "properties.action.properties.full")).toBe(true);
  expect(gs(result, "properties.action.required.0")).toBe("full");
  expect(has(result, "properties.branch_only")).toBe(true);
  expect(has(result, "allOf") || result.includes(`"if"`) || result.includes(`"then"`)).toBe(false);
});

test("AntigravityResponse inlines local ref", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"$defs":{"Payload":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}},"type":"object","properties":{"payload":{"$ref":"#/$defs/Payload"}},"required":["payload"]}`);
  expect(has(result, "$defs") || result.includes(`"$ref"`)).toBe(false);
  expect(gs(result, "properties.payload.type")).toBe("object");
  expect(gs(result, "properties.payload.properties.id.type")).toBe("integer");
  expect(gs(result, "properties.payload.required.0")).toBe("id");
});

test("AntigravityResponse type array uses native nullable", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"value":{"type":["number","null"]}},"required":["value"]}`);
  expect(gs(result, "properties.value.type")).toBe("number");
  expect(g(result, "properties.value.nullable")).toBe(true);
  expect(gs(result, "required.0")).toBe("value");
});

test("AntigravityTool keeps numeric enum type", () => {
  const result = antigravityTool(`{"type":"object","properties":{"value":{"type":"number","enum":[1,2]}},"required":["value"]}`);
  expect(gs(result, "properties.value.type")).toBe("number");
  expect(has(result, "properties.value.enum")).toBe(false);
  expect(gs(result, "properties.value.description").includes("Allowed: 1, 2")).toBe(true);
});

test("AntigravityResponse drops ignored boolean enum", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"value":{"type":"boolean","enum":["true"]}},"required":["value"]}`);
  expect(has(result, "properties.value.enum")).toBe(false);
  expect(gs(result, "properties.value.type")).toBe("boolean");
  expect(gs(result, "properties.value.description").includes("Allowed: true")).toBe(true);
});

test("AntigravityResponse hints ignored constraints", () => {
  const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"value":{"type":"number","minimum":1,"maximum":2,"not":{"enum":[1.5]}}}}`);
  for (const keyword of ["minimum", "maximum", "not"]) {
    expect(has(result, "properties.value." + keyword)).toBe(false);
    expect(gs(result, "properties.value.description").includes(keyword + ":")).toBe(true);
  }
});

test("sortByDepth uses segments and is stable", () => {
  const paths = ["root.verylong", "root.x.y", "first.same", "later.same"];
  sortByDepth(paths);
  expect(paths).toEqual(["root.x.y", "root.verylong", "first.same", "later.same"]);
});

test("strips encrypted metadata", () => {
  const input = `{"type":"object","properties":{"api_key":{"type":"string","description":"API credential","encrypted":true},"timeout":{"type":"integer","encrypted":false},"nested":{"type":"object","properties":{"secret":{"type":"string","encrypted":true}}}},"required":["api_key"]}`;
  for (const clean of [cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini, antigravityTool, cleanJSONSchemaForAntigravityResponse]) {
    const got = clean(input);
    expect(got.includes(`"encrypted"`)).toBe(false);
    expect(has(got, "properties.api_key.type")).toBe(true);
    expect(gs(got, "properties.api_key.description")).toBe("API credential");
    expect(has(got, "properties.nested.properties.secret.type")).toBe(true);
  }
});

test("keeps property named encrypted", () => {
  const input = `{"type":"object","properties":{"encrypted":{"type":"boolean","description":"Whether the payload is encrypted","encrypted":true},"data":{"type":"string"}},"required":["encrypted"]}`;
  for (const clean of [cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini]) {
    const got = clean(input);
    expect(has(got, "properties.encrypted")).toBe(true);
    expect(gs(got, "properties.encrypted.type")).toBe("boolean");
    expect(has(got, "properties.encrypted.encrypted")).toBe(false);
  }
});

describe("bare property map normalization", () => {
  const four = [cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini];
  const three = [cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini, cleanJSONSchemaForAntigravityResponse];

  test("BarePropertyMapNormalized", () => {
    const input = `{"type":"object","properties":{"data":{"parent":{"type":"string","required":true},"insert_after":{"type":"string"},"insert_before":{"type":"string"}},"opts":{"opt_fields":{"type":"string"}}}}`;
    for (const clean of four) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.properties.parent.type")).toBe("string");
      expect(gs(got, "properties.data.properties.insert_after.type")).toBe("string");
      expect(gs(got, "properties.data.properties.insert_before.type")).toBe("string");
      expect(strs(g(got, "properties.data.required"))).toContain("parent");
      expect(has(got, "properties.data.properties.parent.required")).toBe(false);
      expect(gs(got, "properties.opts.type")).toBe("object");
      expect(gs(got, "properties.opts.properties.opt_fields.type")).toBe("string");
    }
  });

  test("NestedBarePropertyMap", () => {
    const input = `{"type":"object","properties":{"data":{"workspace":{"type":"string","required":true},"task":{"name":{"type":"string","required":true},"notes":{"type":"string"}}}}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.properties.workspace.type")).toBe("string");
      expect(gs(got, "properties.data.properties.task.type")).toBe("object");
      expect(gs(got, "properties.data.properties.task.properties.name.type")).toBe("string");
      expect(strs(g(got, "properties.data.required"))).toContain("workspace");
      expect(strs(g(got, "properties.data.properties.task.required"))).toContain("name");
    }
  });

  test("BarePropertyMapWithKeywordNames", () => {
    const input = `{"type":"object","properties":{"data":{"title":{"type":"string","required":true},"description":{"type":"string"},"format":{"type":"string"},"type":{"type":"string"}}}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.properties.title.type")).toBe("string");
      expect(gs(got, "properties.data.properties.description.type")).toBe("string");
      expect(gs(got, "properties.data.properties.type.type")).toBe("string");
      expect(strs(g(got, "properties.data.required"))).toContain("title");
    }
  });

  test("ArrayItemsBarePropertyMap", () => {
    const input = `{"type":"object","properties":{"tasks":{"type":"array","items":{"id":{"type":"string","required":true},"label":{"type":"string"}}}}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.tasks.items.type")).toBe("object");
      expect(gs(got, "properties.tasks.items.properties.id.type")).toBe("string");
      expect(strs(g(got, "properties.tasks.items.required"))).toContain("id");
    }
  });

  test("ToolArraysMissingItems", () => {
    const input = `{"type":"object","properties":{"params":{"type":"array"},"values":{"type":["array","null"],"description":"no items"},"existing":{"type":"array","items":{"type":"number"}}}}`;
    for (const clean of [cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForGemini]) {
      const got = clean(input);
      expect(gs(got, "properties.params.items.type")).toBe("string");
      expect(gs(got, "properties.values.items.type")).toBe("string");
      expect(gs(got, "properties.existing.items.type")).toBe("number");
      expect(gs(clean(`{"type":"array"}`), "items.type")).toBe("string");
    }
  });

  test("ResponseArrayMissingItemsUnchanged", () => {
    expect(has(cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"values":{"type":"array"}}}`), "properties.values.items")).toBe(false);
  });

  test("BooleanRequiredPromoted", () => {
    const input = `{"type":"object","properties":{"existing":{"type":"string"},"name":{"type":"string","required":true},"age":{"type":"integer","required":false},"tag":{"type":"string"}},"required":["existing"]}`;
    for (const clean of three) {
      const got = clean(input);
      const req = strs(g(got, "required"));
      expect(req).toContain("existing");
      expect(req).toContain("name");
      expect(req).not.toContain("age");
      expect(req).not.toContain("tag");
      expect(has(got, "properties.name.required")).toBe(false);
      expect(has(got, "properties.age.required")).toBe(false);
    }
  });

  test("BarePropertyMapWithRequestAndToolsNames", () => {
    const input = `{"type":"object","properties":{"data":{"request":{"method":{"type":"string","required":true},"url":{"type":"string"}},"headers":{"authorization":{"type":"string"}},"tools":{"name":{"type":"string"}}}}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.properties.headers.type")).toBe("object");
      expect(gs(got, "properties.data.properties.tools.type")).toBe("object");
      expect(gs(got, "properties.data.properties.request.type")).toBe("object");
      expect(gs(got, "properties.data.properties.request.properties.method.type")).toBe("string");
      expect(strs(g(got, "properties.data.properties.request.required"))).toContain("method");
    }
  });

  test("BarePropertyMapWithSiblingDescription", () => {
    const input = `{"type":"object","properties":{"data":{"description":"Task payload","parent":{"type":"string","required":true},"insert_after":{"type":"string"}}}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.description")).toBe("Task payload");
      expect(gs(got, "properties.data.properties.parent.type")).toBe("string");
      expect(gs(got, "properties.data.properties.insert_after.type")).toBe("string");
      expect(strs(g(got, "properties.data.required"))).toContain("parent");
    }
  });

  test("SingleKeySchemaWrapper", () => {
    const result = cleanJSONSchemaForAntigravityTool(`{"schema": {"type":"object","properties":{"data":{"parent":{"type":"string","required":true}}}}}`, true);
    expect(has(result, "schema")).toBe(true);
    expect(gs(result, "schema.properties.data.type")).toBe("object");
    expect(gs(result, "schema.properties.data.properties.parent.type")).toBe("string");
    expect(strs(g(result, "schema.properties.data.required"))).toContain("parent");
  });

  test("BarePropertyMapWithExplicitTypeObject", () => {
    const input = `{"type":"object","properties":{"data":{"type":"object","parent":{"type":"string","required":true},"insert_after":{"type":"string"}}}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.properties.parent.type")).toBe("string");
      expect(gs(got, "properties.data.properties.insert_after.type")).toBe("string");
      expect(strs(g(got, "properties.data.required"))).toContain("parent");
    }
  });

  test("BarePropertyMapWithNullable", () => {
    const input = `{"type":"object","properties":{"data":{"nullable":true,"description":"Task payload","parent":{"type":"string"}}}}`;
    for (const clean of [cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini]) {
      const got = clean(input);
      expect(gs(got, "properties.data.type")).toBe("object");
      expect(gs(got, "properties.data.properties.parent.type")).toBe("string");
    }
  });

  test("PreservesHTMLCharactersWithoutEscaping", () => {
    const result = cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"data":{"description":"Uses <tag> & symbols > threshold","parent":{"type":"string"}}}}`);
    expect(result.includes(`\\u003c`) || result.includes(`\\u003e`) || result.includes(`\\u0026`)).toBe(false);
    expect(result.includes("<tag>") && result.includes("& symbols >")).toBe(true);
  });

  test("VendorExtensionOnEnumNotWrappedIntoProperties", () => {
    const input = `{"type":"string","enum":["FOO","BAR"],"x-google-enum-descriptions":{"FOO":"Foo option","BAR":"Bar option"}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(has(got, "properties")).toBe(false);
      expect(gs(got, "type")).toBe("string");
    }
  });

  test("ObjectDefaultNotWrappedIntoProperties", () => {
    const input = `{"type":"object","properties":{"settings":{"type":"object","default":{"theme":"dark","lang":"en"}}}}`;
    for (const clean of three) expect(has(clean(input), "properties.settings.properties.default")).toBe(false);
  });

  test("MixedPropertiesAndOrphanBareProperty", () => {
    const input = `{"type":"object","properties":{"foo":{"type":"string"}},"bar":{"type":"integer","required":true}}`;
    for (const clean of three) {
      const got = clean(input);
      expect(gs(got, "properties.foo.type")).toBe("string");
      expect(gs(got, "properties.bar.type")).toBe("integer");
      expect(strs(g(got, "required"))).toContain("bar");
      expect(has(got, "bar")).toBe(false);
    }
  });

  test("PreservesAdditionalPropertiesObjectSchema", () => {
    for (const clean of [cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini]) {
      expect(has(clean(`{"additionalProperties":{"type":"string"}}`), "properties.additionalProperties")).toBe(false);
    }
  });
});

test("AntigravityResponse anyOf required-only branches", () => {
  const got = cleanJSONSchemaForAntigravityResponse(`{"type":"object","anyOf":[{"required":["left"]},{"required":["right"]}],"properties":{"left":{"type":"integer"},"right":{"type":"integer"}},"additionalProperties":false}`);
  expect(gs(got, "type")).toBe("object");
  expect(has(got, "properties.left") && has(got, "properties.right")).toBe(true);
  const branches = g(got, "anyOf") as unknown[];
  expect(branches).toHaveLength(2);
  expect(gstr(getAt(branches[0], "type"))).toBe("object");
  expect(getAt(branches[0], "properties.left")).toBeDefined();
  expect(gstr(getAt(branches[0], "required.0"))).toBe("left");
  expect(gstr(getAt(branches[1], "type"))).toBe("object");
  expect(getAt(branches[1], "properties.right")).toBeDefined();
  expect(gstr(getAt(branches[1], "required.0"))).toBe("right");
});

test("contains keyword stripped", () => {
  const input = `{"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"},"contains":{"enum":["x"]}}},"required":["tags"],"additionalProperties":false}`;
  for (const clean of [cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini]) {
    const got = clean(input);
    expect(has(got, "properties.tags.contains")).toBe(false);
    expect(gs(got, "properties.tags.description").includes("contains")).toBe(true);
  }
});

test("removes draft-04 id and schema identifier keywords (Issue 5888)", () => {
  const input = `{"id":"http://example.com/root.json","$anchor":"rootAnchor","$vocabulary":{"https://json-schema.org/draft/2020-12/vocab/core":true},"type":"object","properties":{"kind":{"type":"string","enum":["short","video"],"id":"ContentType","$anchor":"contentTypeAnchor","$dynamicAnchor":"dynAnchor","$dynamicRef":"#dynAnchor","description":"Kind"},"id":{"type":"string","description":"Property legitimately named id should survive"}},"required":["kind"]}`;
  for (const clean of [cleanJSONSchemaForGemini, cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForAntigravityResponse]) {
    const got = clean(input);
    for (const p of ["id", "$anchor", "$vocabulary", "properties.kind.id", "properties.kind.$anchor", "properties.kind.$dynamicAnchor", "properties.kind.$dynamicRef"]) expect(has(got, p), p).toBe(false);
    expect(has(got, "properties.id")).toBe(true);
    expect(gs(got, "properties.id.type")).toBe("string");
  }
  const refInput = `{"definitions":{"ContentType":{"type":"string","enum":["short","video"],"id":"ContentType","description":"Kind"}},"type":"object","properties":{"kind":{"$ref":"#/definitions/ContentType"}},"required":["kind"]}`;
  for (const clean of [cleanJSONSchemaForAntigravity, cleanJSONSchemaForAntigravityResponse]) {
    const got = clean(refInput);
    expect(gs(got, "properties.kind.type")).toBe("string");
    expect(has(got, "properties.kind.id")).toBe(false);
    expect(has(got, "definitions")).toBe(false);
  }
});

const fourCleaners = [cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini];

test("TrueBooleanSubschemas", () => {
  const input = `{"type":"object","properties":{"screenshot_id":true,"filename":true,"file_size":true,"source_file_checksum":true,"disabled_field":false},"additionalProperties":true}`;
  for (const clean of fourCleaners) {
    const got = clean(input);
    for (const prop of ["screenshot_id", "filename", "file_size", "source_file_checksum"]) expect(g(got, "properties." + prop)).toEqual({});
    expect(g(got, "properties.disabled_field")).toBe(false);
  }
});

test("NestedTrueBooleanSubschemas", () => {
  const input = `{"type":"object","properties":{"tags":{"type":"array","items":true},"tuple":{"type":"array","items":[true,{"type":"string"}],"additionalItems":true},"union":{"anyOf":[true,{"type":"string"}]},"combination":{"allOf":[true,{"type":"object","properties":{"opt":true}}]},"metadata":{"type":"object","properties":{"nested_true":true,"nested_false":false}}},"$defs":{"custom_schema":true}}`;
  for (const clean of fourCleaners) {
    const got = clean(input);
    expect(g(got, "properties.tags.items")).not.toBe(true);
    expect(g(got, "properties.metadata.properties.nested_true")).toEqual({});
    expect(g(got, "properties.metadata.properties.nested_false")).toBe(false);
    expect(g(got, "properties.tuple.items.0")).not.toBe(true);
    expect(g(got, "properties.combination.properties.opt")).not.toBe(true);
  }
});

test("RootAndWrappedTrue", () => {
  for (const clean of fourCleaners) {
    expect(clean("true")).toBe("{}");
    expect(g(clean(`{"schema": true}`), "schema")).not.toBe(true);
  }
});

test("GeminiJSONSchema preserves additionalProperties and pattern (Issue 5959)", () => {
  const input = `{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"SubmitTool","type":"object","additionalProperties":false,"properties":{"recipient":{"type":"string","pattern":"^(alice|bob)$","minLength":3,"maxLength":10},"amount":{"type":"number","minimum":1},"nested":{"type":"object","additionalProperties":false,"properties":{"tag":{"type":"string","pattern":"^[a-z]+$"}}},"items_list":{"type":"array","items":{"type":"string","pattern":"^[0-9]+$"}}},"required":["recipient","amount","non_existent"]}`;
  const cleaned = cleanJSONSchemaForGeminiJSONSchema(input);
  expect(g(cleaned, "additionalProperties")).toBe(false);
  expect(gs(cleaned, "properties.recipient.pattern")).toBe("^(alice|bob)$");
  expect(g(cleaned, "properties.recipient.minLength")).toBe(3);
  expect(g(cleaned, "properties.recipient.maxLength")).toBe(10);
  expect(g(cleaned, "properties.amount.minimum")).toBe(1);
  expect(g(cleaned, "properties.nested.additionalProperties")).toBe(false);
  expect(gs(cleaned, "properties.nested.properties.tag.pattern")).toBe("^[a-z]+$");
  expect(gs(cleaned, "properties.items_list.items.pattern")).toBe("^[0-9]+$");
  expect(has(cleaned, "title")).toBe(false);
  expect(has(cleaned, "$schema")).toBe(false);
  expect(gs(cleaned, "description")).not.toBe("No extra properties allowed");
  expect(gs(cleaned, "properties.recipient.description").includes("pattern:")).toBe(false);
  expect((g(cleaned, "required") as unknown[]).length).toBe(2);
  const legacy = cleanJSONSchemaForGemini(input);
  expect(has(legacy, "additionalProperties")).toBe(false);
  expect(gs(legacy, "description").includes("No extra properties allowed")).toBe(true);
  expect(has(legacy, "properties.recipient.pattern")).toBe(false);
});

test("GeminiJSONSchema preserves schema-valued additionalProperties", () => {
  const input = `{"type":"object","additionalProperties":{"type":"string","pattern":"^[a-z]+$","minLength":2}}`;
  const cleaned = cleanJSONSchemaForGeminiJSONSchema(input);
  expect(gs(cleaned, "additionalProperties.type")).toBe("string");
  expect(gs(cleaned, "additionalProperties.pattern")).toBe("^[a-z]+$");
  expect(g(cleaned, "additionalProperties.minLength")).toBe(2);
  expect(gs(cleaned, "additionalProperties.description").includes("pattern:")).toBe(false);
  expect(has(cleanJSONSchemaForGemini(input), "additionalProperties")).toBe(false);
});

describe("array items require array type (Issue 6011)", () => {
  const cleaners: Record<string, (s: string) => string> = {
    gemini: cleanJSONSchemaForGemini,
    geminiJSONSchema: cleanJSONSchemaForGeminiJSONSchema,
    antigravity: cleanJSONSchemaForAntigravity,
    antigravityLegacy: antigravityTool,
  };
  const inputMissingType = `{"type":"object","properties":{"revision_reasons":{"type":"array","items":{"type":"object","properties":{"evidence_reference":{"description":"references to evidence","items":{"type":"string"}}}}}}}`;
  for (const [name, clean] of Object.entries(cleaners)) {
    test(name + "_missing_type", () => {
      const cleaned = clean(inputMissingType);
      expect(gs(cleaned, "properties.revision_reasons.items.properties.evidence_reference.type")).toBe("array");
      expect(gs(cleaned, "properties.revision_reasons.items.properties.evidence_reference.items.type")).toBe("string");
    });
    test(name + "_union_type_with_items", () => {
      const cleaned = clean(`{"type":"object","properties":{"revision_reasons":{"type":"array","items":{"type":"object","properties":{"evidence_reference":{"type":["string","array"],"items":{"type":"string"}}}}}}}`);
      expect(gs(cleaned, "properties.revision_reasons.items.properties.evidence_reference.type")).toBe("array");
    });
    test(name + "_non_array_strips_items", () => {
      const cleaned = clean(`{"type":"object","properties":{"label":{"type":"string","items":{"type":"string"}},"config":{"type":"object","properties":{"key":{"type":"string"}},"items":{"type":"string"}}}}`);
      expect(has(cleaned, "properties.label.items")).toBe(false);
      expect(has(cleaned, "properties.config.items")).toBe(false);
      expect(gs(cleaned, "properties.label.type")).toBe("string");
    });
    test(name + "_property_named_items_preserved", () => {
      const cleaned = clean(`{"type":"object","properties":{"items":{"type":"string","description":"a field named items"}}}`);
      expect(gs(cleaned, "properties.items.type")).toBe("string");
    });
    test(name + "_root_array_missing_type", () => {
      const cleaned = clean(`{"items":{"type":"string"}}`);
      expect(gs(cleaned, "type")).toBe("array");
      expect(gs(cleaned, "items.type")).toBe("string");
    });
    test(name + "_idempotent", () => {
      const c1 = clean(inputMissingType);
      expect(clean(c1)).toBe(c1);
    });
  }
  test("antigravity_response_schema", () => {
    expect(gs(cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"names":{"items":{"type":"string"}}}}`), "properties.names.type")).toBe("array");
    expect(has(cleanJSONSchemaForAntigravityResponse(`{"type":"object","properties":{"values":{"type":"array"}}}`), "properties.values.items")).toBe(false);
  });
});

test("sanitizeArrayItems preserves items for uppercase ARRAY type", () => {
  const input = `{"type":"OBJECT","properties":{"summary":{"type":"STRING"},"brands":{"type":"ARRAY","items":{"type":"STRING"}},"catalog":{"type":"OBJECT","properties":{"items":{"type":"ARRAY","items":{"type":"OBJECT","properties":{"id":{"type":"STRING"}}}}}}}}`;
  for (const clean of [cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForAntigravity, cleanJSONSchemaForGemini, antigravityTool]) {
    const got = clean(input);
    expect(has(got, "properties.brands.items")).toBe(true);
    expect(gs(got, "properties.brands.type").toLowerCase()).toBe("array");
    expect(has(got, "properties.catalog.properties.items.items")).toBe(true);
  }
});

describe("enforces object type for properties (Issue 6394)", () => {
  const cleaners = [cleanJSONSchemaForGemini, cleanJSONSchemaForGeminiJSONSchema, antigravityTool, cleanJSONSchemaForAntigravityResponse];
  test("TypeArrayWithPropertiesPrefersObject", () => {
    const input = `{"type":"object","properties":{"requestBody":{"type":"object","properties":{"delivery":{"type":"object","properties":{"endpoint":{"type":["string","object"],"properties":{"traces":{"type":"string"}},"required":["traces"]}},"required":["endpoint"]}},"required":["delivery"]}},"required":["requestBody"]}`;
    for (const clean of cleaners) {
      const got = clean(input);
      expect(gs(got, "properties.requestBody.properties.delivery.properties.endpoint.type").toLowerCase()).toBe("object");
      expect(has(got, "properties.requestBody.properties.delivery.properties.endpoint.properties.traces")).toBe(true);
    }
  });
  test("AnyOfUnionMergedIntoNodeWithoutTypeEnsuresObject", () => {
    const input = `{"type":"object","properties":{"endpoint":{"properties":{"traces":{"type":"string"}},"required":["traces"],"anyOf":[{"type":"string"},{"type":"object","properties":{"other":{"type":"string"}}}]}}}`;
    for (const clean of cleaners) {
      const got = clean(input);
      expect(gs(got, "properties.endpoint.type").toLowerCase()).toBe("object");
      expect(has(got, "properties.endpoint.properties.traces")).toBe(true);
    }
  });
  test("PrimitiveTypeWithPropertiesPromotedToObject", () => {
    const input = `{"type":"object","properties":{"endpoint":{"type":"string","properties":{"traces":{"type":"string"}},"required":["traces"]}}}`;
    for (const clean of cleaners) expect(gs(clean(input), "properties.endpoint.type").toLowerCase()).toBe("object");
  });
});

test("removes dependent keywords (Issue 6539)", () => {
  const input = `{"type":"object","properties":{"baseline_url":{"type":"string"},"candidate_url":{"type":"string"},"options":{"type":"object","properties":{"threshold":{"type":"number"},"diff_color":{"type":"string"}},"dependentRequired":{"threshold":["diff_color"]},"dependentSchemas":{"threshold":{"properties":{"diff_color":{"type":"string"}}}},"dependencies":{"threshold":["diff_color"]}},"dependentRequired":{"type":"string","description":"Legitimate property named dependentRequired"},"dependentSchemas":{"type":"object","properties":{"nested":{"type":"string"}},"dependentRequired":{"nested":["other"]}},"dependencies":{"type":"string","description":"Legitimate property named dependencies"}},"dependentRequired":{"baseline_url":["candidate_url"]},"dependentSchemas":{"baseline_url":{"required":["candidate_url"]}},"dependencies":{"baseline_url":["candidate_url"]}}`;
  for (const clean of [cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini, cleanJSONSchemaForGeminiJSONSchema]) {
    const got = clean(input);
    for (const kw of ["dependentRequired", "dependentSchemas", "dependencies"]) {
      expect(has(got, kw), kw).toBe(false);
      expect(has(got, "properties.options." + kw), kw).toBe(false);
      expect(has(got, "properties." + kw), kw).toBe(true);
    }
    expect(has(got, "properties.dependentSchemas.dependentRequired")).toBe(false);
  }
});

describe("preserves multi-branch anyOf/oneOf (Issue 3662)", () => {
  const input = `{"type":"object","properties":{"item":{"anyOf":[{"type":"string"},{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]}]}},"required":["item"]}`;
  const cleaners: Record<string, (s: string) => string> = {
    Antigravity: cleanJSONSchemaForAntigravity,
    AntigravityTool: antigravityTool,
    AntigravityResponse: cleanJSONSchemaForAntigravityResponse,
    Gemini: cleanJSONSchemaForGemini,
    GeminiJSONSchema: cleanJSONSchemaForGeminiJSONSchema,
  };
  for (const [name, clean] of Object.entries(cleaners)) {
    test(name, () => {
      const got = clean(input);
      compareJSON(input, got);
      compareJSON(got, clean(got));
    });
  }

  test("NullableMultiBranchUnionStripsNullBranchAndSetsNullable", () => {
    const nullableUnion = `{"type":"object","properties":{"item":{"anyOf":[{"type":"string"},{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]},{"type":"null"}]}},"required":["item"]}`;
    const ag = cleanJSONSchemaForAntigravity(nullableUnion);
    expect((g(ag, "properties.item.anyOf") as unknown[]).length).toBe(3);
    expect(g(ag, "properties.item.nullable")).toBe(true);
    expect(has(ag, "properties.item.anyOf.2.properties.audio")).toBe(true);
    const gemini = cleanJSONSchemaForGeminiJSONSchema(nullableUnion);
    expect((g(gemini, "properties.item.anyOf") as unknown[]).length).toBe(3);
    expect(has(gemini, "properties.item.nullable")).toBe(false);
    expect(gs(gemini, "properties.item.description").includes("(nullable)")).toBe(true);
    for (const nested of [
      `{"type":"object","properties":{"item":{"anyOf":[{"type":"null"},{"anyOf":[{"type":"string"},{"type":"integer"}]}]}}}`,
      `{"type":"object","properties":{"item":{"anyOf":[{"anyOf":[{"type":"string"},{"type":"integer"}]},{"type":"null"}]}}}`,
    ]) {
      const expectedNested = `{"type":"object","properties":{"item":{"anyOf":[{"type":"string"},{"type":"integer"}],"nullable":true,"description":"(nullable)"}}}`;
      const once = cleanJSONSchemaForAntigravity(nested);
      compareJSON(expectedNested, once);
      compareJSON(expectedNested, cleanJSONSchemaForAntigravity(once));
    }
  });

  test("OneOfNormalizedToAnyOfOnNativeSchemaCarriers", () => {
    const oneOfInput = `{"type":"object","properties":{"item":{"oneOf":[{"type":"string"},{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]}]}},"required":["item"]}`;
    for (const clean of [cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini]) {
      const got = clean(oneOfInput);
      expect(has(got, "properties.item.oneOf")).toBe(false);
      expect((g(got, "properties.item.anyOf") as unknown[]).length).toBe(3);
    }
    expect((g(cleanJSONSchemaForGeminiJSONSchema(oneOfInput), "properties.item.oneOf") as unknown[]).length).toBe(3);
  });

  test("PreservesUnionAndBranchRequiredWhenParentHasProperties", () => {
    const parentPropsUnion = `{"type":"object","properties":{},"anyOf":[{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]}]}`;
    for (const clean of Object.values(cleaners)) compareJSON(parentPropsUnion, clean(parentPropsUnion));
    const mixed = `{"type":"object","properties":{"image":{"type":"string"},"audio":{"type":"string"},"text":{"type":"string"}},"anyOf":[{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]},{"required":["text"]}]}`;
    const expectedMixed = `{"type":"object","properties":{"image":{"type":"string"},"audio":{"type":"string"},"text":{"type":"string"}},"anyOf":[{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]},{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}]}`;
    compareJSON(expectedMixed, cleanJSONSchemaForAntigravity(mixed));
    const pure = `{"type":"object","properties":{"image":{"type":"string"},"audio":{"type":"string"}},"anyOf":[{"required":["image"]},{"required":["audio"]}]}`;
    const expectedPure = `{"type":"object","properties":{"image":{"type":"string"},"audio":{"type":"string"}},"anyOf":[{"type":"object","properties":{"image":{"type":"string"}},"required":["image"]},{"type":"object","properties":{"audio":{"type":"string"}},"required":["audio"]}]}`;
    compareJSON(expectedPure, cleanJSONSchemaForAntigravity(pure));
  });

  test("BooleanUnionBranchesAndSiblingAnyOfOneOf", () => {
    compareJSON(`{"type":"object","properties":{"value":{"type":"string"}}}`, cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"value":{"anyOf":[false,{"type":"string"}]}}}`));
    compareJSON(`{"type":"object","properties":{"value":{"anyOf":[{"type":"string"},{"type":"integer"}]}}}`, cleanJSONSchemaForAntigravity(`{"type":"object","properties":{"value":{"oneOf":[false,{"type":"string"},{"type":"integer"}]}}}`));
    compareJSON(`{"type":"object","properties":{"value":{"anyOf":[{},{"type":"string"},{"type":"integer"}]}}}`, antigravityTool(`{"type":"object","properties":{"value":{"anyOf":[true,{"type":"string"},{"type":"integer"}]}}}`));

    const siblingUnions = `{"type":"object","properties":{"value":{"anyOf":[{"type":"string"},{"type":"integer"}],"oneOf":[{"type":"string"},{"type":"boolean"}]}}}`;
    for (const clean of [cleanJSONSchemaForAntigravity, antigravityTool, cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini]) {
      const got = clean(siblingUnions);
      expect(has(got, "properties.value.oneOf")).toBe(false);
      expect((g(got, "properties.value.anyOf") as unknown[]).length).toBe(2);
      expect(gs(got, "properties.value.description").includes("oneOf:")).toBe(true);
    }
    const js = cleanJSONSchemaForGeminiJSONSchema(siblingUnions);
    expect((g(js, "properties.value.anyOf") as unknown[]).length).toBe(2);
    expect((g(js, "properties.value.oneOf") as unknown[]).length).toBe(2);

    // AntigravityClaudeToolFlattensNestedUnions
    const flattened = antigravityClaudeTool(input);
    expect(has(flattened, "properties.item.anyOf") || has(flattened, "properties.item.oneOf")).toBe(false);
    expect(gs(flattened, "properties.item.type")).toBe("object");
    expect(has(flattened, "properties.item.properties.image")).toBe(true);
    const desc = gs(flattened, "properties.item.description");
    expect(desc.includes("Accepts:") && desc.includes("string")).toBe(true);
    compareJSON(flattened, antigravityClaudeTool(flattened));
    compareJSON(flattened, antigravityClaudeTool(cleanJSONSchemaForAntigravity(input)));
    compareJSON(flattened, cleanJSONSchemaForAntigravity(flattened));

    const nullableUnionInput = `{"type":"object","properties":{"value":{"anyOf":[{"type":"string"},{"type":"integer"},{"type":"null"}]}}}`;
    const direct = antigravityClaudeTool(nullableUnionInput);
    expect(g(direct, "properties.value.nullable")).toBe(true);
    expect(gs(direct, "properties.value.type")).toBe("string");
    const chained = antigravityClaudeTool(cleanJSONSchemaForAntigravity(nullableUnionInput));
    expect(g(chained, "properties.value.nullable")).toBe(true);
    expect(gs(chained, "properties.value.type")).toBe("string");
    expect(has(chained, "properties.value.anyOf")).toBe(false);
    compareJSON(chained, antigravityClaudeTool(chained));

    compareJSON(`{"type":"object","properties":{"value":{"type":"string","description":"Accepts: string | integer"}}}`, antigravityClaudeTool(`{"type":"object","properties":{"value":{"anyOf":[true,{"type":"string"},{"type":"integer"}]}}}`));
    compareJSON(`{"type":"object","properties":{"value":{"type":"string","description":"Accepts: string | integer"}}}`, antigravityClaudeTool(`{"type":"object","properties":{"value":{"oneOf":[false,{"type":"string"},{"type":"integer"}]}}}`));

    const siblingClaude = antigravityClaudeTool(siblingUnions);
    expect(has(siblingClaude, "properties.value.anyOf") || has(siblingClaude, "properties.value.oneOf")).toBe(false);
    expect(g(siblingClaude, "properties.value")).toEqual(P(`{"type":"string","description":"Accepts: string | boolean"}`));
    compareJSON(siblingClaude, antigravityClaudeTool(siblingClaude));

    const nullOnlyCleaners = [cleanJSONSchemaForAntigravity, antigravityTool, antigravityClaudeTool, cleanJSONSchemaForAntigravityResponse, cleanJSONSchemaForGemini, cleanJSONSchemaForGeminiJSONSchema];
    for (const nullOnly of [
      `{"type":"object","properties":{"value":{"anyOf":[{"type":"null"}]}}}`,
      `{"type":"object","properties":{"value":{"oneOf":[{"type":"null"},{"type":"null"}]}}}`,
      `{"type":"object","properties":{"value":{"anyOf":[false,{"type":"null"}],"description":"Null only"}}}`,
    ]) {
      for (const clean of nullOnlyCleaners) {
        const got = clean(nullOnly);
        expect(gs(got, "properties.value.type")).toBe("null");
      }
    }
  });
});

const sixCleaners: Record<string, (s: string) => string> = {
  Antigravity: cleanJSONSchemaForAntigravity,
  AntigravityTool: antigravityTool,
  AntigravityClaudeTool: antigravityClaudeTool,
  AntigravityResponse: cleanJSONSchemaForAntigravityResponse,
  Gemini: cleanJSONSchemaForGemini,
  GeminiJSONSchema: cleanJSONSchemaForGeminiJSONSchema,
};

test("removes discriminator keyword (Issue 6639)", () => {
  const input = `{"type":"object","properties":{"target":{"anyOf":[{"type":"object","properties":{"kind":{"const":"a"},"url":{"type":"string"}}},{"type":"object","properties":{"kind":{"const":"b"},"path":{"type":"string"}}}],"discriminator":{"propertyName":"kind"}},"deliverables":{"type":"array","items":{"anyOf":[{"type":"object","properties":{"kind":{"const":"file"},"path":{"type":"string"}}},{"type":"object","properties":{"kind":{"const":"link"},"url":{"type":"string"}}}],"discriminator":{"propertyName":"kind"}}},"polymorphicObject":{"type":"object","properties":{"kind":{"type":"string"}},"oneOf":[{"properties":{"a":{"type":"string"}}},{"properties":{"b":{"type":"number"}}}],"discriminator":{"propertyName":"kind","mapping":{"a":"#/definitions/A","b":"#/definitions/B"}}},"discriminator":{"type":"string","description":"Legitimate property named discriminator"},"nestedDiscriminatorProp":{"type":"object","properties":{"discriminator":{"type":"object","properties":{"kind":{"type":"string"}},"discriminator":{"propertyName":"kind"}}}}},"discriminator":{"propertyName":"target"}}`;
  for (const [name, clean] of Object.entries(sixCleaners)) {
    const got = clean(input);
    for (const p of ["discriminator", "properties.target.discriminator", "properties.deliverables.items.discriminator", "properties.polymorphicObject.discriminator", "properties.nestedDiscriminatorProp.properties.discriminator.discriminator"]) {
      expect(has(got, p), `${name} ${p}`).toBe(false);
    }
    if (name !== "AntigravityClaudeTool") {
      expect((g(got, "properties.target.anyOf") as unknown[]).length).toBe(2);
      expect((g(got, "properties.deliverables.items.anyOf") as unknown[]).length).toBe(2);
    }
    expect(has(got, "properties.discriminator")).toBe(true);
    expect(has(got, "properties.nestedDiscriminatorProp.properties.discriminator.properties.kind")).toBe(true);
  }
});

test("removes contentMediaType keyword (Issue 6699)", () => {
  const input = `{"type":"object","contentMediaType":"application/json","contentEncoding":"utf-8","properties":{"value":{"anyOf":[{"type":"object","properties":{}},{"type":"string","contentMediaType":"application/json","contentEncoding":"base64"}]},"directPayload":{"type":"string","contentMediaType":"application/json","contentEncoding":"base64"},"contentMediaType":{"type":"string","contentMediaType":"text/plain","description":"Legitimate property named contentMediaType"},"contentEncoding":{"type":"string","contentEncoding":"base64","description":"Legitimate property named contentEncoding"}}}`;
  for (const [name, clean] of Object.entries(sixCleaners)) {
    const got = clean(input);
    for (const p of ["contentMediaType", "contentEncoding", "properties.value.anyOf.1.contentMediaType", "properties.value.anyOf.1.contentEncoding", "properties.directPayload.contentMediaType", "properties.directPayload.contentEncoding", "properties.contentMediaType.contentMediaType", "properties.contentEncoding.contentEncoding"]) {
      expect(has(got, p), `${name} ${p}`).toBe(false);
    }
    if (name !== "AntigravityClaudeTool") {
      expect((g(got, "properties.value.anyOf") as unknown[]).length).toBe(2);
      expect(gs(got, "properties.value.anyOf.1.type")).toBe("string");
    }
    expect(has(got, "properties.contentMediaType")).toBe(true);
    expect(has(got, "properties.contentEncoding")).toBe(true);
  }
});

describe("Issue6732 local ref inlining", () => {
  const geminis: Record<string, (s: string) => string> = { gemini: cleanJSONSchemaForGemini, geminiJSONSchema: cleanJSONSchemaForGeminiJSONSchema };

  test("GeminiCleanersInlineLocalDefs", () => {
    const input = `{"type":"object","properties":{"person":{"$ref":"#/$defs/Person"}},"required":["person"],"$defs":{"Person":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}}`;
    for (const clean of Object.values(geminis)) {
      const got = clean(input);
      expect(gs(got, "properties.person.properties.name.type")).toBe("string");
      expect(has(got, "$defs")).toBe(false);
      expect(got.includes("See: Person")).toBe(false);
    }
  });

  test("GeminiCleanersInlinePropertyReuse", () => {
    const input = `{"type":"object","properties":{"billing":{"type":"object","properties":{"zip":{"type":"string"}}},"shipping":{"$ref":"#/properties/billing"}}}`;
    for (const clean of Object.values(geminis)) expect(gs(clean(input), "properties.shipping.properties.zip.type")).toBe("string");
  });

  test("GeminiCleanersReuseSameDefinitionTwice", () => {
    const input = `{"type":"object","properties":{"billing":{"$ref":"#/$defs/Address"},"shipping":{"$ref":"#/$defs/Address"}},"$defs":{"Address":{"type":"object","properties":{"zip":{"type":"string"}}}}}`;
    for (const clean of Object.values(geminis)) {
      const got = clean(input);
      for (const field of ["billing", "shipping"]) expect(gs(got, `properties.${field}.properties.zip.type`)).toBe("string");
    }
  });

  test("WrappedSchemaResolvesAgainstInnerRoot", () => {
    const inner = `{"type":"object","properties":{"person":{"$ref":"#/$defs/Person"}},"required":["person"],"$defs":{"Person":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}}`;
    const got = antigravityTool(`{"schema":${inner}}`);
    expect(gs(got, "schema.properties.person.properties.name.type")).toBe("string");
    expect(has(got, "schema.$defs")).toBe(false);
    expect(got.includes("See: Person")).toBe(false);
  });

  test("DefaultLiteralPreservedOnJSONSchemaRoute", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"report":{"type":"object","default":{"title":"Report","format":"pdf","id":7,"x-owner":"ops"}}}}`);
    expect(g(got, "properties.report.default")).toEqual({ title: "Report", format: "pdf", id: 7, "x-owner": "ops" });
  });

  test("ExampleLiteralsPreserved", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"a":{"type":"string","example":{"title":"Hi","x-owner":"ops","id":3},"examples":[{"title":"Hi2","x-owner":"ops","id":4}]}}}`);
    expect(g(got, "properties.a.example")).toEqual({ title: "Hi", "x-owner": "ops", id: 3 });
    expect(g(got, "properties.a.examples.0")).toEqual({ title: "Hi2", "x-owner": "ops", id: 4 });
  });

  test("InlineLocalRefsLeavesLiteralRefs", () => {
    const got = inlineLocalRefs(`{"type":"object","properties":{"a":{"type":"object","default":{"$ref":"#/$defs/Person"}}},"$defs":{"Person":{"type":"object","properties":{"name":{"type":"string"}}}}}`);
    expect(gs(got, "properties.a.default.$ref")).toBe("#/$defs/Person");
    expect(has(got, "properties.a.default.properties")).toBe(false);
    expect(has(got, "$defs.Person.properties.name")).toBe(true);
  });

  test("PropertiesNamedDefaultAndTypeRemainSchemas", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"default":{"$ref":"#/$defs/Person"},"type":{"type":"string","title":"Kind"}},"$defs":{"Person":{"type":"object","properties":{"name":{"type":"string"}}}}}`);
    expect(gs(got, "properties.default.properties.name.type")).toBe("string");
    expect(has(got, "properties.type.title")).toBe(false);
  });

  function geminiSchemaDiamondInput(): string {
    let sb = `{"type":"object","properties":{"leaf":{"$ref":"#/$defs/D12"}},"$defs":{"leaf0":{"type":"string","description":"leaf leaf leaf leaf leaf leaf leaf leaf leaf leaf"}`;
    for (let i = 0; i < 13; i++) {
      const target = i === 0 ? "leaf0" : "D" + (i - 1);
      sb += `,"D${i}":{"type":"object","properties":{"a":{"$ref":"#/$defs/${target}"},"b":{"$ref":"#/$defs/${target}"}}}`;
    }
    return sb + "}}";
  }

  test("ExpansionBudgetBoundsSharedDefs", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(geminiSchemaDiamondInput());
    expect(got.length < 512 * 1024).toBe(true);
    expect(has(got, "properties.leaf")).toBe(true);
    expect(has(got, "properties.leaf.properties.a.properties.a")).toBe(true);
    expect(has(got, "$defs")).toBe(false);
  });

  test("UnusedDefinitionsDoNotConsumeExpansionBudget", () => {
    let sb = `{"type":"object","properties":{"person":{"$ref":"#/$defs/Person"}},"required":["person"],"$defs":{"leaf0":{"type":"string","description":"leaf leaf leaf leaf leaf leaf leaf leaf leaf leaf"},"Person":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}`;
    for (let i = 0; i < 13; i++) {
      const target = i === 0 ? "leaf0" : "D" + (i - 1);
      sb += `,"D${i}":{"type":"object","properties":{"a":{"$ref":"#/$defs/${target}"},"b":{"$ref":"#/$defs/${target}"}}}`;
    }
    const input = sb + "}}";
    const first = cleanJSONSchemaForGeminiJSONSchema(input);
    for (let run = 0; run < 5; run++) {
      const got = cleanJSONSchemaForGeminiJSONSchema(input);
      expect(got).toBe(first);
      expect(gs(got, "properties.person.properties.name.type")).toBe("string");
      expect(has(got, "$defs")).toBe(false);
    }
  });

  test("BudgetFallbackDoesNotCopyLargeDescriptions", () => {
    let sb = `{"type":"object","properties":{`;
    for (let i = 0; i < 200; i++) sb += (i > 0 ? "," : "") + `"p${i}":{"$ref":"#/$defs/Big"}`;
    sb += `},"$defs":{"Big":{"type":"object","description":"${"x".repeat(32 * 1024)}","properties":{"name":{"type":"string"}}}}}`;
    const got = cleanJSONSchemaForGeminiJSONSchema(sb);
    expect(got.length < 512 * 1024).toBe(true);
    expect(has(got, "properties.p0") && has(got, "properties.p199")).toBe(true);
    expect(gs(got, "properties.p0.properties.name.type")).toBe("string");
    expect(has(got, "$defs")).toBe(false);
  });

  test("NestedUnusedDefinitionsGraphDoesNotConsumeBudget", () => {
    let sb = `{"type":"object","properties":{"person":{"$ref":"#/$defs/Person"},"a":{"type":"object","$defs":{"Leaf":{"type":"string","description":"${"x".repeat(1024)}"}`;
    for (let i = 0; i < 256; i++) sb += `,"U${i}":{"$ref":"#/properties/a/$defs/Leaf"}`;
    sb += `}}},"required":["person"],"$defs":{"Person":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}}`;
    const got = cleanJSONSchemaForGeminiJSONSchema(sb);
    expect(gs(got, "properties.person.properties.name.type")).toBe("string");
    expect(has(got, "properties.a.$defs") || has(got, "$defs")).toBe(false);
  });

  test("RefSiblingNameMapReferencesStillExpand", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"a":{"$ref":"#/$defs/Base","properties":{"x":{"$ref":"#/$defs/S"}}}},"$defs":{"Base":{"type":"object"},"S":{"type":"string"}}}`);
    expect(gs(got, "properties.a.properties.x.type")).toBe("string");
  });

  test("CleanInliningStripsDefinitionsFromIntermediate", () => {
    const person = `{"type":"object","properties":{"name":{"type":"string"}},"$defs":{"Unused":{"type":"string","description":"${"x".repeat(280 * 1024)}"}}}`;
    const got = inlineLocalRefsForCleanString(`{"type":"object","properties":{"p0":{"$ref":"#/$defs/Person"},"p1":{"$ref":"#/$defs/Person"}},"$defs":{"Person":${person}}}`);
    expect(got.length < 64 * 1024).toBe(true);
    expect(has(got, "$defs")).toBe(false);
    expect(has(got, "properties.p0.$defs")).toBe(false);
    expect(gs(got, "properties.p1.properties.name.type")).toBe("string");
  });

  test("ArrayRefWithExplicitTypeKeepsTargetItems", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"rows":{"type":"array","$ref":"#/$defs/Rows"}},"$defs":{"Rows":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}}}}}}`);
    expect(gs(got, "properties.rows.items.properties.name.type")).toBe("string");
  });

  test("BudgetFallbackStillResolvesSiblings", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"a":{"$ref":"#/$defs/Big","properties":{"x":{"$ref":"#/$defs/S"}}}},"$defs":{"Big":{"type":"object","description":"${"x".repeat(280 * 1024)}"},"S":{"type":"string"}}}`);
    expect(gs(got, "properties.a.properties.x.type")).toBe("string");
    expect(got.includes(`"$ref"`)).toBe(false);
  });

  test("InlineLocalRefsDefinitionNamesKeepSchemaSemantics", () => {
    const got = inlineLocalRefs(`{"$defs":{"S":{"type":"string"},"properties":{"type":"object","default":{"$ref":"#/$defs/S"}},"default":{"type":"object","properties":{"x":{"$ref":"#/$defs/S"}}}}}`);
    expect(gs(got, "$defs.properties.default.$ref")).toBe("#/$defs/S");
    expect(gs(got, "$defs.default.properties.x.type")).toBe("string");
  });

  test("TargetNestedDefinitionsExemptFromBudget", () => {
    const person = `{"type":"object","properties":{"name":{"type":"string"}},"$defs":{"Unused":{"type":"string","description":"${"x".repeat(280 * 1024)}"}}}`;
    const cases: [string, string, string][] = [
      ["propertyRef", `{"type":"object","properties":{"person":{"$ref":"#/$defs/Person"}},"$defs":{"Person":${person}}}`, "properties.person.properties.name.type"],
      ["rootRef", `{"$ref":"#/$defs/Person","$defs":{"Person":${person}}}`, "properties.name.type"],
    ];
    for (const [, input, namePath] of cases) {
      const got = cleanJSONSchemaForGeminiJSONSchema(input);
      expect(gs(got, namePath)).toBe("string");
      expect(has(got, "$defs")).toBe(false);
    }
  });

  test("ArrayRefWithoutTargetItemsGetsPlaceholder", () => {
    const first = antigravityTool(`{"type":"object","properties":{"rows":{"type":"array","$ref":"#/$defs/Common"}},"$defs":{"Common":{"description":"Rows"}}}`);
    expect(gs(first, "properties.rows.items.type")).toBe("string");
    expect(antigravityTool(first)).toBe(first);
  });

  test("SmallTargetFanOutStaysBounded", () => {
    let sb = `{"type":"object","properties":{`;
    for (let i = 0; i < 2000; i++) sb += (i > 0 ? "," : "") + `"p${i}":{"$ref":"#/$defs/S"}`;
    sb += `},"$defs":{"S":{"type":"string","description":"${"x".repeat(512)}"}}}`;
    expect(cleanJSONSchemaForGeminiJSONSchema(sb).length < 512 * 1024).toBe(true);
  });

  test("EscapedDescriptionFanOutStaysBounded", () => {
    const input = `{"type":"object","properties":{"p0":{"$ref":"#/$defs/Big"},"p1":{"$ref":"#/$defs/Big"},"p2":{"$ref":"#/$defs/Big"},"p3":{"$ref":"#/$defs/Big"},"p4":{"$ref":"#/$defs/Big"},"p5":{"$ref":"#/$defs/Big"},"p6":{"$ref":"#/$defs/Big"},"p7":{"$ref":"#/$defs/Big"}},"$defs":{"Big":{"type":"object","description":"${"<".repeat(32 * 1024)}","properties":{"name":{"type":"string"}}}}}`;
    expect(cleanJSONSchemaForGeminiJSONSchema(input).length < 512 * 1024).toBe(true);
  });

  test("DependenciesNameMapKeepsSchemaSemantics", () => {
    const got = inlineLocalRefs(`{"type":"object","dependencies":{"default":{"properties":{"x":{"$ref":"#/definitions/S"}}}},"definitions":{"S":{"type":"string"}}}`);
    expect(gs(got, "dependencies.default.properties.x.type")).toBe("string");
    expect(has(got, "dependencies.default.properties.x.$ref")).toBe(false);
  });

  test("OmittedFallbackDescriptionNotCharged", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"a":{"$ref":"#/$defs/A"},"b":{"$ref":"#/$defs/B"}},"$defs":{"A":{"type":"string","description":"${"x".repeat(262142)}"},"B":{"type":"object","properties":{"name":{"type":"string"}}}}}`);
    expect(gs(got, "properties.b.properties.name.type")).toBe("string");
  });

  test("SynthesizedTypeDoesNotOverrideRefTarget", () => {
    const first = cleanJSONSchemaForGeminiJSONSchema(`{"$ref":"#/$defs/O","items":{"type":"integer"},"$defs":{"O":{"type":"object","properties":{"x":{"type":"string"}}}}}`);
    expect(gs(first, "type")).toBe("object");
    expect(has(first, "items")).toBe(false);
    expect(gs(first, "properties.x.type")).toBe("string");
    expect(cleanJSONSchemaForGeminiJSONSchema(first)).toBe(first);
  });

  test("PropertyNamedRefRemainsProperty", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"$ref":{"type":"string"}}}`);
    expect(gs(got, `properties.\\$ref.type`)).toBe("string");
    expect(got.includes("See:")).toBe(false);
  });

  test("PropertyNamedConstRemainsProperty", () => {
    const got = cleanJSONSchemaForGeminiJSONSchema(`{"type":"object","properties":{"const":{"type":"string"}}}`);
    expect(gs(got, "properties.const.type")).toBe("string");
    expect(has(got, "enum")).toBe(false);
  });
});

test("removes readOnly/writeOnly keywords (Issue 6778)", () => {
  const input = `{"type":"object","$schema":"http://json-schema.org/draft-04/schema#","readOnly":false,"writeOnly":false,"properties":{"parent":{"type":"string","description":"Parent resource name"},"database":{"type":"object","properties":{"name":{"type":"string","description":"Database resource name","readOnly":true},"uid":{"type":"string","readOnly":true},"createTime":{"type":"string","readOnly":true},"etag":{"type":"string","writeOnly":true},"locationId":{"type":"string"}}},"itemsList":{"type":"array","items":{"type":"string","readOnly":true,"writeOnly":false}},"unionField":{"anyOf":[{"type":"string","readOnly":true},{"type":"integer","writeOnly":true}]},"readOnly":{"type":"boolean","readOnly":true,"description":"Legitimate property named readOnly"},"writeOnly":{"type":"boolean","writeOnly":true,"description":"Legitimate property named writeOnly"}},"required":["parent"]}`;
  for (const [name, clean] of Object.entries(sixCleaners)) {
    const got = clean(input);
    for (const p of [
      "readOnly",
      "writeOnly",
      "properties.database.properties.name.readOnly",
      "properties.database.properties.uid.readOnly",
      "properties.database.properties.createTime.readOnly",
      "properties.database.properties.etag.writeOnly",
      "properties.itemsList.items.readOnly",
      "properties.itemsList.items.writeOnly",
      "properties.unionField.readOnly",
      "properties.unionField.writeOnly",
      "properties.unionField.anyOf.0.readOnly",
      "properties.unionField.anyOf.1.writeOnly",
      "properties.readOnly.readOnly",
      "properties.writeOnly.writeOnly",
    ]) {
      expect(has(got, p), `${name} ${p}`).toBe(false);
    }
    for (const kept of ["name", "uid", "createTime", "etag", "locationId"]) expect(gs(got, "properties.database.properties." + kept + ".type")).toBe("string");
    expect(gs(got, "properties.database.properties.name.description")).toBe("Database resource name");
    expect(gs(got, "properties.readOnly.type")).toBe("boolean");
    expect(gs(got, "properties.readOnly.description")).toBe("Legitimate property named readOnly");
    expect(gs(got, "properties.writeOnly.type")).toBe("boolean");
    expect(gs(got, "properties.writeOnly.description")).toBe("Legitimate property named writeOnly");
  }
});

describe("Issue6950 array items from allOf preserved", () => {
  const cleaners: Record<string, { clean: (s: string) => string; preservesNullable: boolean }> = {
    Antigravity: { clean: cleanJSONSchemaForAntigravity, preservesNullable: true },
    AntigravityTool: { clean: antigravityTool, preservesNullable: true },
    AntigravityClaudeTool: { clean: antigravityClaudeTool, preservesNullable: true },
    Gemini: { clean: cleanJSONSchemaForGemini, preservesNullable: false },
  };
  const cases = [
    { name: "direct_allof_items", input: `{"type":"object","properties":{"ids":{"type":"array","allOf":[{"items":{"type":"integer"}}]}}}`, path: "properties.ids", wantItemType: "integer" },
    { name: "ref_in_allof_items", input: `{"type":"object","properties":{"ids":{"type":"array","allOf":[{"$ref":"#/$defs/Ids"}]}},"$defs":{"Ids":{"type":"array","items":{"type":"integer"}}}}`, path: "properties.ids", wantItemType: "integer" },
    { name: "nullable_type_array_with_ref_in_allof", input: `{"type":"object","properties":{"ids":{"type":["array","null"],"allOf":[{"$ref":"#/$defs/Ids"}]}},"$defs":{"Ids":{"type":"array","items":{"type":"integer"}}}}`, path: "properties.ids", wantItemType: "integer", wantDesc: "(nullable)", wantNullable: true },
    { name: "split_allof_branches", input: `{"type":"object","properties":{"ids":{"allOf":[{"type":"array","description":"ID list"},{"items":{"type":"integer"}}]}}}`, path: "properties.ids", wantItemType: "integer", wantDesc: "ID list" },
    { name: "ref_base_array_with_allof_items", input: `{"type":"object","properties":{"ids":{"$ref":"#/$defs/BaseArray","allOf":[{"items":{"type":"integer"}}]}},"$defs":{"BaseArray":{"type":"array","description":"ID list"}}}`, path: "properties.ids", wantItemType: "integer", wantDesc: "ID list" },
    { name: "root_array_with_allof_items", input: `{"type":"array","allOf":[{"items":{"type":"integer"}}]}`, path: "", wantItemType: "integer" },
    { name: "allof_without_items_gets_placeholder", input: `{"type":"object","properties":{"ids":{"type":"array","allOf":[{"description":"x"}]}}}`, path: "properties.ids", wantItemType: "string", wantDesc: "x" },
  ];
  for (const [cleanerName, cleaner] of Object.entries(cleaners)) {
    for (const tc of cases) {
      test(`${cleanerName}/${tc.name}`, () => {
        const got = cleaner.clean(tc.input);
        const node = getAt(JSON.parse(got), tc.path);
        expect(gstr(getAt(node, "type"))).toBe("array");
        expect(gstr(getAt(node, "items.type"))).toBe(tc.wantItemType);
        if (tc.wantDesc) expect(gstr(getAt(node, "description"))).toBe(tc.wantDesc);
        if (tc.wantNullable && cleaner.preservesNullable) expect(getAt(node, "nullable")).toBe(true);
        compareJSON(got, cleaner.clean(got));
      });
    }
  }
});

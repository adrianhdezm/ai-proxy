// Ported from: internal/util/sanitize_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { sanitizeClaudeFunctionName } from "../../src/util/claude_tool_id.ts";
import { sanitizeFunctionName } from "../../src/util/function_name.ts";
import { cleanJSONSchemaForAntigravity, cleanJSONSchemaForGeminiJSONSchema } from "../../src/util/gemini_schema.ts";
import {
  claudeToolIsParameterless,
  cleanClaudeToolArguments,
  cleanClaudeToolArgumentsWithTranslated,
  deduplicateFunctionDeclarations,
  disambiguatedToolNameMap,
  restoreSanitizedToolName,
  sanitizedFunctionNameMap,
  sanitizedToolNameMap,
} from "../../src/util/translator.ts";

describe("sanitizeClaudeFunctionName", () => {
  const tests: [string, string, string][] = [
    ["Normal", "valid_name", "valid_name"],
    ["With Dots", "name.with.dots", "name_with_dots"],
    ["With Colons", "name:with:colons", "name_with_colons"],
    ["With Dashes", "name-with-dashes", "name-with-dashes"],
    ["MCP Tool with Dots and Colons", "mcp.server.special:get_time", "mcp_server_special_get_time"],
    ["With Slashes", "server/action", "server_action"],
    ["Invalid Characters", "name!with@invalid#chars", "name_with_invalid_chars"],
    ["Spaces", "name with spaces", "name_with_spaces"],
    ["Non-ASCII", "name_with_你好_chars", "name_with____chars"],
    ["Empty", "", ""],
    ["Single character valid", "a", "a"],
    ["Single character invalid", "@", "_"],
    ["Starts with digit", "123name", "123name"],
    ["Starts with dash", "-name", "-name"],
    ["Exactly 64 chars", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charact", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charact"],
    ["Too long (65 chars)", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charactX", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charact"],
  ];
  for (const [name, input, expected] of tests) {
    test(name, () => {
      const got = sanitizeClaudeFunctionName(input);
      expect(got).toBe(expected);
      expect(got.length <= 64).toBe(true);
    });
  }
});

describe("sanitizeFunctionName", () => {
  const tests: [string, string, string][] = [
    ["Normal", "valid_name", "valid_name"],
    ["With Dots", "name.with.dots", "name.with.dots"],
    ["With Colons", "name:with:colons", "name:with:colons"],
    ["With Dashes", "name-with-dashes", "name-with-dashes"],
    ["Starts with digit", "123name", "_123name"],
    ["Starts with dot", ".name", "_.name"],
    ["Starts with colon", ":name", "_:name"],
    ["Starts with dash", "-name", "_-name"],
    ["Starts with invalid char", "!name", "_name"],
    ["Exactly 64 chars", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charact", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charact"],
    ["Too long (65 chars)", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charactX", "this_is_a_very_long_name_that_exactly_reaches_sixty_four_charact"],
    ["Very long", "this_is_a_very_long_name_that_exceeds_the_sixty_four_character_limit_for_function_names", "this_is_a_very_long_name_that_exceeds_the_sixty_four_character_l"],
    ["Starts with digit (64 chars total)", "1234567890123456789012345678901234567890123456789012345678901234", "_123456789012345678901234567890123456789012345678901234567890123"],
    ["Starts with invalid char (64 chars total)", "!234567890123456789012345678901234567890123456789012345678901234", "_234567890123456789012345678901234567890123456789012345678901234"],
    ["Empty", "", ""],
    ["Single character invalid", "@", "_"],
    ["Single character valid", "a", "a"],
    ["Single character digit", "1", "_1"],
    ["Single character underscore", "_", "_"],
  ];
  for (const [name, input, expected] of tests) {
    test(name, () => {
      const got = sanitizeFunctionName(input);
      expect(got).toBe(expected);
      expect(got.length <= 64).toBe(true);
      if (got.length > 0) expect(/[a-zA-Z_]/.test(got[0]!)).toBe(true);
    });
  }
});

describe("sanitizedToolNameMap", () => {
  test("returns map for tools needing sanitization", () => {
    const m = sanitizedToolNameMap(`{"tools":[{"name":"valid_tool","input_schema":{}},{"name":"mcp/server/read","input_schema":{}},{"name":"tool@v2","input_schema":{}}]}`);
    expect(m).toBeDefined();
    expect(m!.get("mcp_server_read")).toBe("mcp/server/read");
    expect(m!.get("tool_v2")).toBe("tool@v2");
    expect(m!.has("valid_tool")).toBe(false);
  });
  test("returns nil when no tools need sanitization", () => {
    expect(sanitizedToolNameMap(`{"tools":[{"name":"Read","input_schema":{}},{"name":"Write","input_schema":{}}]}`)).toBeUndefined();
  });
  test("returns nil for empty/missing tools", () => {
    expect(sanitizedToolNameMap(`{}`)).toBeUndefined();
    expect(sanitizedToolNameMap("")).toBeUndefined();
  });
  test("legacy map ignores nested OpenAI tools", () => {
    expect(sanitizedToolNameMap(`{"tools":[{"type":"function","function":{"name":"web/search"}},{"type":"web_search","name":"web_search"}]}`)).toBeUndefined();
  });
  test("collision keeps first legacy mapping", () => {
    const m = sanitizedToolNameMap(`{"tools":[{"name":"read/file","input_schema":{}},{"name":"read@file","input_schema":{}}]}`);
    expect(m!.get("read_file")).toBe("read/file");
  });
});

test("sanitizedFunctionNameMap disambiguates collisions", () => {
  const first = "mcp__plugin_cloudflare_cloudflare-builds__workers_builds_get_build";
  const second = "mcp__plugin_cloudflare_cloudflare-builds__workers_builds_get_build_logs";
  const raw = `{"tools":[{"name":"${first}"},{"name":"${first}"},{"name":"${second}"}]}`;
  const forward = sanitizedFunctionNameMap(raw)!;
  const firstMapped = forward.get(first)!;
  const secondMapped = forward.get(second)!;
  expect(firstMapped).not.toBe("");
  expect(secondMapped).not.toBe("");
  expect(secondMapped).not.toBe(firstMapped);
  expect(firstMapped.length <= 64 && secondMapped.length <= 64).toBe(true);
  const reversedForward = sanitizedFunctionNameMap(`{"tools":[{"name":"${second}"},{"name":"${first}"}]}`)!;
  expect(reversedForward.get(first)).toBe(firstMapped);
  expect(reversedForward.get(second)).toBe(secondMapped);
  const reverse = disambiguatedToolNameMap(raw)!;
  expect(reverse.get(firstMapped)).toBe(first);
  expect(reverse.get(secondMapped)).toBe(second);
});

test("sanitizedFunctionNameMap reads supported tool shapes", () => {
  const forward = sanitizedFunctionNameMap(`{"tools":[{"type":"function","function":{"name":"nested/name"}},{"functionDeclarations":[{"name":"camel@name"}],"function_declarations":[{"name":"snake name"}]}]}`)!;
  expect(forward.get("nested/name")).toBe("nested_name");
  expect(forward.get("camel@name")).toBe("camel_name");
  expect(forward.get("snake name")).toBe("snake_name");
});

test("deduplicateFunctionDeclarations", () => {
  const deduped = JSON.parse(deduplicateFunctionDeclarations(`[{"name":"lookup","description":"first"},{"name":"other"},{"name":"lookup","description":"second"}]`));
  expect(deduped).toHaveLength(2);
  expect(deduped[0].description).toBe("first");
  expect(deduped[1].name).toBe("other");
});

test("restoreSanitizedToolName", () => {
  const m = new Map([
    ["mcp_server_read", "mcp/server/read"],
    ["tool_v2", "tool@v2"],
  ]);
  expect(restoreSanitizedToolName(m, "mcp_server_read")).toBe("mcp/server/read");
  expect(restoreSanitizedToolName(m, "unknown")).toBe("unknown");
  expect(restoreSanitizedToolName(undefined, "name")).toBe("name");
  expect(restoreSanitizedToolName(m, "")).toBe("");
});

describe("cleanClaudeToolArguments", () => {
  const origRequest = `{"tools":[
    {"name":"EnterPlanMode","input_schema":{"type":"object","properties":{}}},
    {"name":"CronList","input_schema":{"type":"object"}},
    {"name":"Bash","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}},
    {"name":"CustomToolWithReason","input_schema":{"type":"object","properties":{"reason":{"type":"string"}}}},
    {"name":"DynamicTool","input_schema":{"type":"object","properties":{"name":{"type":"string"}},"additionalProperties":true}},
    {"name":"UnionTool","input_schema":{"anyOf":[{"type":"object","properties":{"reason":{"type":"string"}}}]}}
  ]}`;
  const dynamicRequest = `{"tools":[
    {"name":"MapTool","input_schema":{"type":"object","additionalProperties":true}},
    {"name":"TypedMapTool","input_schema":{"type":"object","properties":{},"additionalProperties":{"type":"string"}}}
  ]}`;
  const caseCollisionRequest = `{"tools":[
    {"name":"Read","input_schema":{"type":"object","properties":{}}},
    {"name":"read","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}
  ]}`;
  const composedRequest = `{"tools":[
    {"name":"AllOfEmpty","input_schema":{"type":"object","allOf":[{"type":"object","properties":{}}]}},
    {"name":"AllOfArgs","input_schema":{"type":"object","allOf":[{"type":"object","properties":{"path":{"type":"string"}}}]}},
    {"name":"RefEmpty","input_schema":{"$ref":"#/$defs/empty","$defs":{"empty":{"type":"object","properties":{}}}}},
    {"name":"NestedTool","input_schema":{"type":"object","properties":{"opts":{"type":"object","properties":{}},"cfg":{"type":"object","properties":{"mode":{"type":"string"}}}}}}
  ]}`;
  const transferredRequest = `{"model":"gemini-3.8-flash-high","request":{"tools":[{"functionDeclarations":[{"name":"Bash","parametersJsonSchema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]}]}}`;
  const translatedReasonRequired = `{"model":"gemini-3.8-flash-high","request":{"tools":[{"functionDeclarations":[{"name":"Bash","parametersJsonSchema":{"type":"object","properties":{"command":{"type":"string"},"reason":{"type":"string"}},"required":["command","reason"]}}]}]}}`;
  const uniqueItemsRequest = `{"tools":[{"name":"BatchUnique","input_schema":{"type":"object","properties":{"rows":{"type":"array","uniqueItems":true,"items":{"type":"object","properties":{"tag":{"type":"string"}}}}},"required":["rows"],"additionalProperties":false}}]}`;
  const translatedUniqueItems = `{"model":"claude-sonnet-4-6","request":{"tools":[{"functionDeclarations":[{"name":"BatchUnique","parametersJsonSchema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"tag":{"type":"string"},"_":{"type":"boolean"}},"required":["_"]}}},"required":["rows"]}}]}]}}`;
  const minPropsRequest = `{"tools":[{"name":"StoreMetadata","input_schema":{"type":"object","properties":{},"minProperties":1}}]}`;
  const translatedMinProps = `{"model":"claude-sonnet-4-6","request":{"tools":[{"functionDeclarations":[{"name":"StoreMetadata","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"],"minProperties":1}}]}]}}`;
  const siblingAllOfRequest = `{"tools":[{"name":"ConfigureSibling","input_schema":{"type":"object","required":["cfg"],"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{}}},"required":["cfg"],"additionalProperties":false},{"type":"object","properties":{"other":{"type":"string"}},"required":["other"],"additionalProperties":false}],"allOf":[{"properties":{"cfg":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}}]}}]}`;
  const translatedSiblingAllOf = `{"model":"gemini-2.5-pro","tools":[{"functionDeclarations":[{"name":"ConfigureSibling","parametersJsonSchema":{"type":"object","properties":{"cfg":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},"required":["cfg"]}}]}]}`;
  const arrayContainsRequest = `{"tools":[{"name":"BatchContains","input_schema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{}},"contains":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}},"required":["rows"],"additionalProperties":false}}]}`;
  const translatedArrayContains = `{"model":"claude-sonnet-4-6","request":{"tools":[{"functionDeclarations":[{"name":"BatchContains","parametersJsonSchema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}},"required":["rows"]}}]}]}}`;
  const arrayEnumRequest = `{"tools":[{"name":"BatchEnum","input_schema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{}},"enum":[[{"reason":"business"}]]}},"required":["rows"],"additionalProperties":false}}]}`;
  const translatedArrayEnum = `{"model":"claude-sonnet-4-6","request":{"tools":[{"functionDeclarations":[{"name":"BatchEnum","parametersJsonSchema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}},"required":["rows"]}}]}]}}`;
  const enumUnionRequest = `{"tools":[{"name":"ExplainFixed","input_schema":{"type":"object","enum":[{"reason":"business"}],"anyOf":[{"type":"object","properties":{}}]}}]}`;
  const enumRequest = `{"tools":[{"name":"ExplainFixed","input_schema":{"type":"object","enum":[{"reason":"business"}]}},{"name":"ConstTool","input_schema":{"type":"object","const":{"reason":"fixed"}}}]}`;
  const translatedEnum = `{"model":"claude-sonnet-4-6","request":{"tools":[{"functionDeclarations":[{"name":"ExplainFixed","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},{"name":"ConstTool","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}]}]}}`;
  const translatedCollisionDynamic = (() => {
    const sentName = sanitizedFunctionNameMap(`{"tools":[{"name":"1"},{"name":"_1"}]}`)!.get("1")!;
    return `{"model":"claude-sonnet-4-6","request":{"tools":[{"functionDeclarations":[{"name":"${sentName}","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}]}]}}`;
  })();
  const collisionRequest = `{"tools":[{"name":"1","input_schema":{"type":"object","properties":{},"required":["reason"]}},{"name":"_1","input_schema":{"type":"object","properties":{}}}]}`;
  const round15Request = `{"tools":[
    {"name":"Batch","input_schema":{"type":"object","anyOf":[{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{},"additionalProperties":false}}},"required":["rows"],"additionalProperties":false},{"type":"object","properties":{"rows":{}},"required":["rows"],"additionalProperties":false}]}},
    {"name":"BatchStrict","input_schema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{},"additionalProperties":false}}},"required":["rows"]}}
  ]}`;
  const translatedRound15 = `{"model":"gemini-2.5-pro","tools":[{"functionDeclarations":[
    {"name":"Batch","parametersJsonSchema":{"type":"object","anyOf":[{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{}}}},"required":["rows"]},{"type":"object","properties":{"rows":{}},"required":["rows"]}]}},
    {"name":"BatchStrict","parametersJsonSchema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}},"required":["rows"]}}
  ]}]}`;
  const round14Request = `{"tools":[{"name":"ConfigureAltFree","input_schema":{"type":"object","anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{},"additionalProperties":false}},"required":["cfg"],"additionalProperties":false},{"type":"object","properties":{"cfg":{}},"required":["cfg"],"additionalProperties":false}]}}]}`;
  const translatedRound14 = `{"model":"gemini-2.5-pro","tools":[{"functionDeclarations":[{"name":"ConfigureAltFree","parametersJsonSchema":{"type":"object","anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{}}},"required":["cfg"]},{"type":"object","properties":{"cfg":{}},"required":["cfg"]}]}}]}]}`;
  const round13Request = `{"tools":[{"name":"DeepAlt","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{"opts":{"type":"object","properties":{"mode":{"type":"string"}},"additionalProperties":false}},"required":["opts"],"additionalProperties":false}},"required":["cfg"],"additionalProperties":false},{"type":"object","properties":{"cfg":{"type":"object","properties":{"tag":{"type":"string"}},"required":["tag"]}},"required":["cfg"],"additionalProperties":false}]}},"required":["choice"],"additionalProperties":false}}]}`;
  const translatedRound13 = `{"model":"gemini-3-pro-high","request":{"tools":[{"functionDeclarations":[{"name":"DeepAlt","parametersJsonSchema":{"type":"object","properties":{"choice":{"type":"object","properties":{"cfg":{"type":"object","properties":{"opts":{"type":"object","properties":{"mode":{"type":"string"},"_":{"type":"boolean"}},"required":["_"]}},"required":["opts"]}},"required":["cfg"]}},"required":["choice"]}}]}]}}`;
  const round12Request = `{"tools":[{"name":"ConfigureAlt","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{},"additionalProperties":false}},"required":["cfg"],"additionalProperties":false},{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}},"required":["mode"]}},"required":["cfg"],"additionalProperties":false}]}},"required":["choice"],"additionalProperties":false}}]}`;
  const translatedRound12 = `{"model":"gemini-3-pro-high","request":{"tools":[{"functionDeclarations":[{"name":"ConfigureAlt","parametersJsonSchema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},"required":["cfg"]},{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}},"required":["mode"]}},"required":["cfg"]}]}},"required":["choice"]}}]}]}}`;
  const round11Request = `{"tools":[{"name":"ChooseImplicit","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{},"additionalProperties":false},{"type":"object","properties":{"tag":{"type":"string"}},"required":["tag"]}]}},"required":["choice"]}}]}`;
  const translatedRound11 = `{"model":"gemini-3-pro-high","request":{"tools":[{"functionDeclarations":[{"name":"ChooseImplicit","parametersJsonSchema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},{"type":"object","properties":{"tag":{"type":"string"}},"required":["tag"]}]}},"required":["choice"]}}]}]}}`;
  const round10Request = `{"tools":[{"name":"ImplicitBranch","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}},"additionalProperties":false}},"required":["cfg"],"additionalProperties":false},{"type":"object","properties":{"tag":{"type":"string"}},"required":["tag"]}]}},"required":["choice"],"additionalProperties":false}}]}`;
  const translatedRound10 = `{"model":"gemini-3.1-pro","request":{"tools":[{"functionDeclarations":[{"name":"ImplicitBranch","parametersJsonSchema":{"type":"object","properties":{"choice":{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"},"_":{"type":"boolean"}},"required":["_"]}},"required":["cfg"]}},"required":["choice"]}}]}]}}`;
  const round9Request = `{"tools":[{"name":"ConfigureNested","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}},"additionalProperties":false}},"required":["cfg"],"additionalProperties":false},{"type":"object","patternProperties":{"^cfg$":{"type":"object","additionalProperties":true}},"additionalProperties":false}]}},"required":["choice"]}}]}`;
  const translatedRound9 = `{"model":"gemini-3.1-pro","request":{"tools":[{"functionDeclarations":[{"name":"ConfigureNested","parametersJsonSchema":{"type":"object","properties":{"choice":{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"},"_":{"type":"boolean"}},"required":["_"]}},"required":["cfg"]}},"required":["choice"]}}]}]}}`;
  const round8Request = `{"tools":[
    {"name":"ExplainPattern","input_schema":{"type":"object","properties":{},"patternProperties":{"^reason$":{"type":"string"}},"additionalProperties":false}},
    {"name":"PatternData","input_schema":{"type":"object","properties":{},"patternProperties":{"^x-":{"type":"string"}},"additionalProperties":false}}
  ]}`;
  const translatedRound8 = `{"model":"gemini-3.1-pro","request":{"tools":[{"functionDeclarations":[
    {"name":"ExplainPattern","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},
    {"name":"PatternData","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}
  ]}]}}`;
  const round7Request = `{"tools":[{"name":"Configure","input_schema":{"type":"object","properties":{"cfg":{"anyOf":[{"type":"object","properties":{},"additionalProperties":false},{"type":"object","additionalProperties":true}]}},"required":["cfg"]}}]}`;
  const translatedRound7 = `{"model":"gemini-3.1-pro","request":{"tools":[{"functionDeclarations":[{"name":"Configure","parametersJsonSchema":{"type":"object","properties":{"cfg":{"anyOf":[{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}]}},"required":["cfg"]}}]}]}}`;
  const round6Request = `{"tools":[
    {"name":"PlainOptions","input_schema":{"type":"object","properties":{"flag":{"type":"string"}}}},
    {"name":"StrictOptions","input_schema":{"type":"object","properties":{"flag":{"type":"string"}},"additionalProperties":false}},
    {"name":"BranchChoice","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","additionalProperties":true}},"required":["cfg"]},{"type":"object","properties":{"cfg":{"type":"object","properties":{},"additionalProperties":false}},"required":["cfg"]}]}},"required":["choice"]}}
  ]}`;
  const translatedRound6 = `{"model":"gemini-2.5-pro","tools":[{"functionDeclarations":[
    {"name":"PlainOptions","parametersJsonSchema":{"type":"object","properties":{"flag":{"type":"string"}}}},
    {"name":"StrictOptions","parametersJsonSchema":{"type":"object","properties":{"flag":{"type":"string"}}}},
    {"name":"BranchChoice","parametersJsonSchema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"cfg":{"type":"object","additionalProperties":true}},"required":["cfg"]},{"type":"object","properties":{"cfg":{"type":"object","properties":{}}},"required":["cfg"]}]}},"required":["choice"]}}
  ]}]}`;
  const round5Request = `{"tools":[
    {"name":"Explain","input_schema":{"type":"object","required":["reason"],"additionalProperties":true}},
    {"name":"Choose","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"opts":{"type":"object","properties":{},"additionalProperties":false}},"required":["opts"]},{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}]}},"required":["choice"]}},
    {"name":"Options","input_schema":{"type":"object","properties":{"flag":{"type":"string"}},"additionalProperties":true}}
  ]}`;
  const translatedRound5 = `{"model":"gemini-3.8-flash-high","tools":[{"functionDeclarations":[
    {"name":"Explain","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},
    {"name":"Choose","parametersJsonSchema":{"type":"object","properties":{"choice":{"type":"object","properties":{"opts":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},"required":["opts"]}},"required":["choice"]}},
    {"name":"Options","parametersJsonSchema":{"type":"object","properties":{"flag":{"type":"string"}},"additionalProperties":true}}
  ]}]}`;
  const round4Request = `{"tools":[
    {"name":"UnionChoice","input_schema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}]}},"required":["choice"]}},
    {"name":"AllOfChildMerge","input_schema":{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}}}},"allOf":[{"properties":{"cfg":{"type":"object","properties":{}}}}]}},
    {"name":"NestedRefTool","input_schema":{"type":"object","properties":{"opts":{"$ref":"#/$defs/Empty"}},"$defs":{"Empty":{"type":"object","properties":{},"additionalProperties":false}}}},
    {"name":"WrappedPlaceholder","input_schema":{"type":"object","properties":{"flag":{"type":"string"}},"additionalProperties":false}}
  ]}`;
  const translatedRound4 = `{"model":"gemini-3.8-flash-high","request":{"tools":[{"functionDeclarations":[
    {"name":"UnionChoice","parametersJsonSchema":{"type":"object","properties":{"choice":{"anyOf":[{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}]}},"required":["choice"]}},
    {"name":"AllOfChildMerge","parametersJsonSchema":{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}}}}}},
    {"name":"NestedRefTool","parametersJsonSchema":{"type":"object","properties":{"opts":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}}},
    {"name":"WrappedPlaceholder","parametersJsonSchema":{"type":"object","properties":{"flag":{"type":"string"}}}}
  ]}]}}`;
  const extraRequest = `{"tools":[
    {"name":"AllOfDynamicConflict","input_schema":{"type":"object","properties":{},"additionalProperties":false,"allOf":[{"additionalProperties":true}]}},
    {"name":"MultiUnionEmpty","input_schema":{"anyOf":[{"type":"object","properties":{},"additionalProperties":false},{"type":"object","properties":{"x":{"type":"string"}},"required":["x"],"additionalProperties":false}]}},
    {"name":"DupTool","input_schema":{"type":"object","properties":{}}},
    {"name":"DupTool","input_schema":{"type":"object","properties":{}}},
    {"name":"ConflictingDup","input_schema":{"type":"object","properties":{}}},
    {"name":"ConflictingDup","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}},
    {"name":"MatrixTool","input_schema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"array","items":{"type":"object","properties":{}}}}}}}
  ]}`;
  const translatedExtra = `{"model":"gemini-3.8-flash-high","request":{"tools":[{"functionDeclarations":[
    {"name":"AllOfDynamicConflict","parametersJsonSchema":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}},
    {"name":"MultiUnionEmpty","parametersJsonSchema":{"anyOf":[{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]},{"type":"object","properties":{"x":{"type":"string"}},"required":["x"]}]}},
    {"name":"MatrixTool","parametersJsonSchema":{"type":"object","properties":{"rows":{"type":"array","items":{"type":"array","items":{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}}}}}}
  ]}]}}`;
  const deepRequest = `{"tools":[
    {"name":"FreeFormNested","input_schema":{"type":"object","properties":{"payload":{}},"required":["payload"]}},
    {"name":"AllOfMerge","input_schema":{"type":"object","properties":{"cfg":{"type":"object","properties":{"mode":{"type":"string"}}}},"allOf":[{"type":"object","properties":{"cfg":{"type":"object","properties":{"reason":{"type":"string"}}}}}]}},
    {"name":"SingleUnionEmpty","input_schema":{"anyOf":[{"type":"object","properties":{}}]}},
    {"name":"DynamicParent","input_schema":{"type":"object","properties":{"opts":{"type":"object","properties":{}}},"additionalProperties":true}},
    {"name":"RefArray","input_schema":{"type":"object","properties":{"items":{"$ref":"#/$defs/list"}},"$defs":{"list":{"type":"array","items":{"type":"object","properties":{"v":{"type":"string"}}}}}}},
    {"name":"PropRef","input_schema":{"type":"object","properties":{"template":{"type":"object","properties":{}},"copy":{"$ref":"#/properties/template"}}}}
  ]}`;

  const tests: [string, string, string, string | undefined, string, string | undefined][] = [
    ["parameterless empty properties", `{"reason":"Entering plan mode"}`, "EnterPlanMode", origRequest, "{}", undefined],
    ["parameterless missing properties", `{"reason":"List jobs"}`, "CronList", origRequest, "{}", undefined],
    ["declared args preserved", `{"command":"ls -la"}`, "Bash", origRequest, `{"command":"ls -la"}`, undefined],
    ["undeclared reason stripped", `{"command":"ls -la","reason":"why"}`, "Bash", origRequest, `{"command":"ls -la"}`, undefined],
    ["reason kept when translated schema lacks placeholder", `{"command":"ls -la","reason":"why"}`, "Bash", origRequest, `{"command":"ls -la","reason":"why"}`, transferredRequest],
    ["reason stripped when translated schema marks placeholder", `{"command":"ls -la","reason":"why"}`, "Bash", origRequest, `{"command":"ls -la"}`, translatedReasonRequired],
    ["undeclared underscore stripped", `{"command":"ls -la","_":true}`, "Bash", origRequest, `{"command":"ls -la"}`, undefined],
    ["declared reason preserved", `{"reason":"valid"}`, "CustomToolWithReason", origRequest, `{"reason":"valid"}`, undefined],
    ["additional properties preserved", `{"name":"x","reason":"dynamic"}`, "DynamicTool", origRequest, `{"name":"x","reason":"dynamic"}`, undefined],
    ["union schema passthrough", `{"reason":"x"}`, "UnionTool", origRequest, `{"reason":"x"}`, undefined],
    ["unknown tool passthrough", `{"reason":"x"}`, "EnterPlanMode", undefined, `{"reason":"x"}`, undefined],
    ["empty args", "", "EnterPlanMode", origRequest, "{}", undefined],
    ["empty object args", "{}", "EnterPlanMode", origRequest, "{}", undefined],
    ["dynamic map tool preserved", `{"key":"value"}`, "MapTool", dynamicRequest, `{"key":"value"}`, undefined],
    ["typed map tool preserved", `{"key":"value"}`, "TypedMapTool", dynamicRequest, `{"key":"value"}`, undefined],
    ["case collision exact match keeps args", `{"path":"/tmp/a"}`, "read", caseCollisionRequest, `{"path":"/tmp/a"}`, undefined],
    ["case collision exact match parameterless", `{"reason":"x"}`, "Read", caseCollisionRequest, "{}", undefined],
    ["allOf empty normalized", `{"reason":"x"}`, "AllOfEmpty", composedRequest, "{}", undefined],
    ["allOf declared args preserved", `{"path":"/tmp/a"}`, "AllOfArgs", composedRequest, `{"path":"/tmp/a"}`, undefined],
    ["ref to empty normalized", `{"reason":"x"}`, "RefEmpty", composedRequest, "{}", undefined],
    ["nested placeholders stripped", `{"opts":{"reason":"x"},"cfg":{"mode":"fast","_":true}}`, "NestedTool", composedRequest, `{"opts":{},"cfg":{"mode":"fast"}}`, undefined],
    ["free-form nested preserved", `{"payload":{"value":1}}`, "FreeFormNested", deepRequest, `{"payload":{"value":1}}`, undefined],
    ["allOf deep merge keeps declared reason", `{"cfg":{"mode":"a","reason":"b"}}`, "AllOfMerge", deepRequest, `{"cfg":{"mode":"a","reason":"b"}}`, undefined],
    ["single union empty normalized", `{"reason":"x"}`, "SingleUnionEmpty", deepRequest, "{}", undefined],
    ["dynamic parent still cleans declared child", `{"extra":1,"opts":{"reason":"x"}}`, "DynamicParent", deepRequest, `{"extra":1,"opts":{}}`, undefined],
    ["ref array items cleaned", `{"items":[{"v":"a","_":true}]}`, "RefArray", deepRequest, `{"items":[{"v":"a"}]}`, undefined],
    ["property ref cleaned", `{"copy":{"reason":"x"},"template":{}}`, "PropRef", deepRequest, `{"copy":{},"template":{}}`, undefined],
    ["allOf dynamic conflict uses translated schema", `{"reason":"x"}`, "AllOfDynamicConflict", extraRequest, "{}", translatedExtra],
    ["multi-branch union uses translated schema", `{"reason":"x"}`, "MultiUnionEmpty", extraRequest, "{}", translatedExtra],
    ["identical duplicates cleaned", `{"reason":"x"}`, "DupTool", extraRequest, "{}", undefined],
    ["conflicting duplicates passthrough", `{"path":"/tmp/a"}`, "ConflictingDup", extraRequest, `{"path":"/tmp/a"}`, undefined],
    ["conflicting duplicates keep first-declared cleaning", `{"reason":"x"}`, "ConflictingDup", extraRequest, `{"reason":"x"}`, undefined],
    ["matrix nested arrays cleaned", `{"rows":[[{"reason":"x"}]]}`, "MatrixTool", extraRequest, `{"rows":[[{}]]}`, translatedExtra],
    ["union declared required reason preserved", `{"choice":{"reason":"maintenance"}}`, "UnionChoice", round4Request, `{"choice":{"reason":"maintenance"}}`, translatedRound4],
    ["allOf child merge keeps mode", `{"cfg":{"mode":"fast"}}`, "AllOfChildMerge", round4Request, `{"cfg":{"mode":"fast"}}`, translatedRound4],
    ["nested ref placeholder cleaned", `{"opts":{"reason":"initialize"}}`, "NestedRefTool", round4Request, `{"opts":{}}`, translatedRound4],
    ["required-only reason preserved", `{"reason":"maintenance"}`, "Explain", round5Request, `{"reason":"maintenance"}`, translatedRound5],
    ["union branch nested placeholder cleaned", `{"choice":{"opts":{"reason":"initialize"}}}`, "Choose", round5Request, `{"choice":{"opts":{}}}`, translatedRound5],
    ["gemini route keeps dynamic underscore", `{"flag":"x","_":true}`, "Options", round5Request, `{"flag":"x","_":true}`, translatedRound5],
    ["implicit additional properties keeps underscore", `{"flag":"x","_":true}`, "PlainOptions", round6Request, `{"flag":"x","_":true}`, translatedRound6],
    ["closed object still strips executor underscore", `{"flag":"x","_":true}`, "StrictOptions", round6Request, `{"flag":"x"}`, translatedRound6],
    ["alternative branch dynamic data preserved", `{"choice":{"cfg":{"value":1}}}`, "BranchChoice", round6Request, `{"choice":{"cfg":{"value":1}}}`, translatedRound6],
    ["alternative branch dynamic reason preserved", `{"cfg":{"reason":"business"}}`, "Configure", round7Request, `{"cfg":{"reason":"business"}}`, translatedRound7],
    ["pattern property reason preserved", `{"reason":"business"}`, "ExplainPattern", round8Request, `{"reason":"business"}`, translatedRound8],
    ["pattern property non-placeholder data preserved", `{"x-note":"keep"}`, "PatternData", round8Request, `{"x-note":"keep"}`, translatedRound8],
    ["union branch pattern child preserved", `{"choice":{"cfg":{"mode":"fast","_":true}}}`, "ConfigureNested", round9Request, `{"choice":{"cfg":{"mode":"fast","_":true}}}`, translatedRound9],
    ["implicit open branch child preserved", `{"choice":{"tag":"keep","cfg":{"mode":"fast","_":true}}}`, "ImplicitBranch", round10Request, `{"choice":{"tag":"keep","cfg":{"mode":"fast","_":true}}}`, translatedRound10],
    ["implicit open branch field preserved", `{"choice":{"tag":"keep","reason":"business"}}`, "ChooseImplicit", round11Request, `{"choice":{"tag":"keep","reason":"business"}}`, translatedRound11],
    ["implicit open branch non-matching object cleaned", `{"choice":{"reason":"x"}}`, "ChooseImplicit", round11Request, `{"choice":{}}`, translatedRound11],
    ["alternative child candidates keep matched data", `{"choice":{"cfg":{"mode":"fast","reason":"business"}}}`, "ConfigureAlt", round12Request, `{"choice":{"cfg":{"mode":"fast","reason":"business"}}}`, translatedRound12],
    ["alternative child candidates clean unmatched placeholder", `{"choice":{"cfg":{"reason":"x"}}}`, "ConfigureAlt", round12Request, `{"choice":{"cfg":{}}}`, translatedRound12],
    ["deep alternative candidates keep matched subtree", `{"choice":{"cfg":{"tag":"keep","opts":{"mode":"fast","_":true}}}}`, "DeepAlt", round13Request, `{"choice":{"cfg":{"tag":"keep","opts":{"mode":"fast","_":true}}}}`, translatedRound13],
    ["deep alternative candidates clean unmatched subtree", `{"choice":{"cfg":{"opts":{"mode":"fast","_":true}}}}`, "DeepAlt", round13Request, `{"choice":{"cfg":{"opts":{"mode":"fast"}}}}`, translatedRound13],
    ["free-form alternative child preserved", `{"cfg":{"reason":"business","value":1}}`, "ConfigureAltFree", round14Request, `{"cfg":{"reason":"business","value":1}}`, translatedRound14],
    ["free-form array candidate preserved", `{"rows":[{"value":1}]}`, "Batch", round15Request, `{"rows":[{"value":1}]}`, translatedRound15],
    ["strict array placeholder cleaned", `{"rows":[{"reason":"x"}]}`, "BatchStrict", round15Request, `{"rows":[{}]}`, translatedRound15],
    ["fallback keeps required-only reason", `{"reason":"business"}`, "1", collisionRequest, `{"reason":"business"}`, undefined],
    ["object enum value preserved", `{"reason":"business"}`, "ExplainFixed", enumRequest, `{"reason":"business"}`, translatedEnum],
    ["object enum with union preserved", `{"reason":"business"}`, "ExplainFixed", enumUnionRequest, `{"reason":"business"}`, translatedEnum],
    ["array enum elements preserved", `{"rows":[{"reason":"business"}]}`, "BatchEnum", arrayEnumRequest, `{"rows":[{"reason":"business"}]}`, translatedArrayEnum],
    ["array enum elements preserved fallback", `{"rows":[{"reason":"business"}]}`, "BatchEnum", arrayEnumRequest, `{"rows":[{"reason":"business"}]}`, undefined],
    ["array contains elements preserved", `{"rows":[{"reason":"business"}]}`, "BatchContains", arrayContainsRequest, `{"rows":[{"reason":"business"}]}`, translatedArrayContains],
    ["array contains elements preserved fallback", `{"rows":[{"reason":"business"}]}`, "BatchContains", arrayContainsRequest, `{"rows":[{"reason":"business"}]}`, undefined],
    ["sibling allOf declaration preserved", `{"cfg":{"reason":"business"}}`, "ConfigureSibling", siblingAllOfRequest, `{"cfg":{"reason":"business"}}`, translatedSiblingAllOf],
    ["minProperties object preserved", `{"reason":"store","label":"keep"}`, "StoreMetadata", minPropsRequest, `{"reason":"store","label":"keep"}`, translatedMinProps],
    ["minProperties object preserved fallback", `{"reason":"store","label":"keep"}`, "StoreMetadata", minPropsRequest, `{"reason":"store","label":"keep"}`, undefined],
    ["uniqueItems elements preserved", `{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}`, "BatchUnique", uniqueItemsRequest, `{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}`, translatedUniqueItems],
    ["uniqueItems elements preserved fallback", `{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}`, "BatchUnique", uniqueItemsRequest, `{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}`, undefined],
    ["object enum value preserved fallback", `{"reason":"business"}`, "ExplainFixed", enumRequest, `{"reason":"business"}`, undefined],
    ["object const value preserved", `{"reason":"fixed"}`, "ConstTool", enumRequest, `{"reason":"fixed"}`, translatedEnum],
    ["disambiguated name uses translated schema", `{"reason":"business"}`, "1", collisionRequest, `{"reason":"business"}`, translatedCollisionDynamic],
  ];
  for (const [name, rawArgs, toolName, origReq, want, transferred] of tests) {
    test(name, () => {
      expect(cleanClaudeToolArgumentsWithTranslated(rawArgs, toolName, origReq, transferred)).toBe(want);
    });
  }
});

describe("cleanClaudeToolArguments implicit open object preserves arguments", () => {
  const cases: [string, string, string, boolean][] = [
    ["additionalProperties_omitted", `{"type":"object","properties":{}}`, `{"user":"v"}`, false],
    ["additionalProperties_omitted_no_properties", `{"type":"object"}`, `{"user":"v"}`, false],
    ["additionalProperties_true", `{"type":"object","properties":{},"additionalProperties":true}`, `{"user":"v"}`, false],
    ["additionalProperties_false", `{"type":"object","properties":{},"additionalProperties":false}`, `{}`, true],
    ["additionalProperties_false_no_properties", `{"type":"object","additionalProperties":false}`, `{}`, true],
  ];
  for (const [name, schema, want, wantNoArgs] of cases) {
    test(name, () => {
      const original = `{"tools":[{"name":"echo","input_schema":${schema}}]}`;
      const cleanedSchema = cleanJSONSchemaForGeminiJSONSchema(schema);
      const translated = `{"tools":[{"functionDeclarations":[{"name":"echo","parametersJsonSchema":${cleanedSchema}}]}]}`;
      const args = `{"user":"v"}`;
      expect(cleanClaudeToolArguments(args, "echo", original)).toBe(want);
      expect(cleanClaudeToolArgumentsWithTranslated(args, "echo", original, translated)).toBe(want);
      expect(claudeToolIsParameterless("echo", original)).toBe(wantNoArgs);
    });
  }

  test("implicit_open_strips_injected_placeholder_but_keeps_user_arg", () => {
    const schema = `{"type":"object","properties":{}}`;
    const original = `{"tools":[{"name":"echo","input_schema":${schema}}]}`;
    const antigravitySchema = cleanJSONSchemaForAntigravity(schema);
    const translated = `{"tools":[{"functionDeclarations":[{"name":"echo","parametersJsonSchema":${antigravitySchema}}]}]}`;
    const args = `{"user":"v","reason":"Brief explanation"}`;
    expect(cleanClaudeToolArguments(args, "echo", original)).toBe(`{"user":"v"}`);
    expect(cleanClaudeToolArgumentsWithTranslated(args, "echo", original, translated)).toBe(`{"user":"v"}`);
  });

  const nested: [string, string, string, string, boolean][] = [
    ["nested_implicit_open_preserves_user_arg", `{"type":"object","properties":{"opts":{"type":"object","properties":{}}}}`, `{"opts":{"user":"v"}}`, `{"opts":{"user":"v"}}`, false],
    ["nested_explicit_closed_erases_user_arg", `{"type":"object","properties":{"opts":{"type":"object","properties":{},"additionalProperties":false}}}`, `{"opts":{"user":"v"}}`, `{"opts":{}}`, false],
    ["array_item_implicit_open_preserves_user_arg", `{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{}}}}}`, `{"items":[{"user":"v"}]}`, `{"items":[{"user":"v"}]}`, false],
    ["array_item_explicit_closed_erases_user_arg", `{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{},"additionalProperties":false}}}}`, `{"items":[{"user":"v"}]}`, `{"items":[{}]}`, false],
    ["allOf_implicit_open_preserves_user_arg", `{"type":"object","allOf":[{"type":"object","properties":{}}]}`, `{"user":"v"}`, `{"user":"v"}`, false],
    ["allOf_explicit_closed_erases_user_arg", `{"type":"object","allOf":[{"type":"object","properties":{},"additionalProperties":false}]}`, `{"user":"v"}`, `{}`, true],
    ["local_ref_implicit_open_preserves_user_arg", `{"$ref":"#/$defs/open","$defs":{"open":{"type":"object","properties":{}}}}`, `{"user":"v"}`, `{"user":"v"}`, false],
    ["local_ref_explicit_closed_erases_user_arg", `{"$ref":"#/$defs/closed","$defs":{"closed":{"type":"object","properties":{},"additionalProperties":false}}}`, `{"user":"v"}`, `{}`, true],
  ];
  for (const [name, schema, args, want, wantNoArgs] of nested) {
    test(name, () => {
      const original = `{"tools":[{"name":"echo","input_schema":${schema}}]}`;
      const cleanedSchema = cleanJSONSchemaForGeminiJSONSchema(schema);
      const translated = `{"tools":[{"functionDeclarations":[{"name":"echo","parametersJsonSchema":${cleanedSchema}}]}]}`;
      expect(cleanClaudeToolArguments(args, "echo", original)).toBe(want);
      expect(cleanClaudeToolArgumentsWithTranslated(args, "echo", original, translated)).toBe(want);
      expect(claudeToolIsParameterless("echo", original)).toBe(wantNoArgs);
    });
  }
});

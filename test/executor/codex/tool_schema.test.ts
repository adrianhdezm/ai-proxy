// Ported from: internal/runtime/executor/helps/codex_tool_schema_test.go
// Ported from: internal/runtime/executor/codex_executor_tool_schema_test.go
// Skipped cases: TestNormalizeCodexToolIntegerTypes_CodexClientToolFieldTypes (NormalizeCodexToolIntegerTypes is
//   not ported: it rewrites Codex-client tools for non-Codex targets), TestCodexExecutor_DoesNotNormalizeToolIntegerTypesForCodexUserAgent,
//   TestCodexWebsocketsExecutor_* (websockets not ported), TestOpenAICompatExecutor_NormalizesToolIntegerTypesForCodexUserAgent_NonCodexTarget
//   (another executor), TestCodexExecutorExecuteStream_BufferingPartialDeltasIncompleteResponseIsSuccessful (bootstrap
//   buffering not ported). The executor cases send Claude Messages requests (Go used OpenAI chat requests).
import { afterAll, describe, expect, test } from "bun:test";
import { CodexExecutor, normalizeCodexToolSchemas } from "../../../src/executor/codex/index.ts";
import { RawNumber, parseRawJSON } from "../../../src/executor/codex/rawjson.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { apiKeyAuth, drain, getString, getValue, options, request, sseResponse, startUpstream } from "./helpers.ts";

/** Walks parsed raw JSON by literal keys (no gjson escaping needed). */
function at(body: string, ...keys: Array<string | number>): unknown {
  let cur: unknown = parseRawJSON(body);
  for (const key of keys) {
    if (cur === null || typeof cur !== "object" || cur instanceof RawNumber) return undefined;
    cur = (cur as Record<string, unknown>)[key as string];
  }
  return cur;
}

/** gjson .Raw for numbers, the value otherwise. */
function raw(body: string, ...keys: Array<string | number>): unknown {
  const v = at(body, ...keys);
  return v instanceof RawNumber ? v.raw : v;
}

const params = (...keys: Array<string | number>) => ["tools", 0, "parameters", ...keys];

function constUnion(values: string[], key = "oneOf"): string {
  return `"${key}": [${values.map((v) => `{"const": ${v}}`).join(", ")}]`;
}

const eight = ['"1"', '"2"', '"3"', '"4"', '"5"', '"6"', '"7"', '"8"'];

test("TestNormalizeCodexToolSchemas_ComplexOneOfSimplified_PreservesProperties", () => {
  const input = `{
		"model": "gpt-5.5",
		"tools": [{
			"type": "function", "name": "t1", "description": "test tool", "strict": true,
			"parameters": {
				"type": "object",
				"properties": {
					"action": {
						"type": "string",
						"enum": ["p.list","m.list","s.list","s.create","s.send","s.fork","s.status","s.messages","sch.list","sch.create","sch.run","sch.delete","sch.toggle"],
						"oneOf": [
							{"const": "p.list", "description": "List projects"}, {"const": "m.list", "description": "List models"},
							{"const": "s.list", "description": "List sessions"}, {"const": "s.create", "description": "Create session"},
							{"const": "s.send", "description": "Send prompt"}, {"const": "s.fork", "description": "Fork session"},
							{"const": "s.status", "description": "Session status"}, {"const": "s.messages", "description": "Session messages"},
							{"const": "sch.list", "description": "List schedule"}, {"const": "sch.create", "description": "Create schedule"},
							{"const": "sch.run", "description": "Run schedule"}, {"const": "sch.delete", "description": "Delete schedule"},
							{"const": "sch.toggle", "description": "Toggle schedule"}
						],
						"description": "Action to perform"
					},
					"target": {"type": "string", "description": "Target ID"}
				},
				"required": ["action"]
			}
		}]
	}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "action", "oneOf"))).toBeUndefined();
  expect(at(out, ...params("properties", "action", "type"))).toBe("string");
  expect((at(out, ...params("properties", "action", "enum")) as unknown[]).length).toBe(13);
  expect(at(out, ...params("properties", "target", "type"))).toBe("string");
  expect(at(out, ...params("required", 0))).toBe("action");
  expect(at(out, "tools", 0, "name")).toBe("t1");
  expect(at(out, "tools", 0, "strict")).toBe(true);
});

test("TestNormalizeCodexToolSchemas_DottedPropertyName", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"dotted_tool","parameters":{"type":"object","properties":{"my.action":{"type":"string","enum":[${eight.join(",")}],${constUnion(eight)}}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  const prop = at(out, ...params("properties", "my.action")) as Record<string, unknown>;
  expect(prop).toBeDefined();
  expect(prop.oneOf).toBeUndefined();
  expect(prop.type).toBe("string");
  expect(at(out, ...params("properties", "my"))).toBeUndefined();
});

test("TestNormalizeCodexToolSchemas_ColonPropertyName", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"colon_tool","parameters":{"type":"object","properties":{":action":{"type":"string","enum":[${eight.join(",")}],${constUnion(eight)}}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  const prop = at(out, ...params("properties", ":action")) as Record<string, unknown>;
  expect(prop).toBeDefined();
  expect(prop.oneOf).toBeUndefined();
  expect(at(out, ...params("properties", "action"))).toBeUndefined();
});

test("TestNormalizeCodexToolSchemas_NumericDuplicateConstNotTouched", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"num_dup_tool","parameters":{"type":"object","properties":{"val":{"type":"number",${constUnion(["1", "1.0", "2", "3", "4", "5", "6", "7"])}}}}}]}`;
  expect(at(normalizeCodexToolSchemas(input), ...params("properties", "val", "oneOf"))).toBeDefined();
});

test("TestNormalizeCodexToolSchemas_LargeIntegerPrecisionPreserved", () => {
  const largeInt = "9007199254740993";
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"large_int_tool","parameters":{"type":"object","properties":{"id":{"type":"integer",${constUnion([largeInt, "1", "2", "3", "4", "5", "6", "7"])}}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "id", "oneOf"))).toBeUndefined();
  expect(raw(out, ...params("properties", "id", "enum", 0))).toBe(largeInt);
});

test("TestNormalizeCodexToolSchemas_UnicodeDuplicateConstNotTouched", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"dup_tool","parameters":{"type":"object","properties":{"val":{"type":"string",${constUnion(['"a"', '"\\u0061"', '"c"', '"d"', '"e"', '"f"', '"g"', '"h"'])}}}}}]}`;
  expect(at(normalizeCodexToolSchemas(input), ...params("properties", "val", "oneOf"))).toBeDefined();
});

test("TestNormalizeCodexToolSchemas_TypePreservingComparison", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"type_tool","parameters":{"type":"object","properties":{"val":{"enum":[${eight.join(",")}],${constUnion(["1", "2", "3", "4", "5", "6", "7", "8"])}}}}}]}`;
  expect(at(normalizeCodexToolSchemas(input), ...params("properties", "val", "oneOf"))).toBeDefined();
});

test("TestNormalizeCodexToolSchemas_BothOneOfAndAnyOfUntouched", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"compound_tool","parameters":{"type":"object","properties":{"val":{${constUnion(eight)},${constUnion(['"5"', '"6"', '"7"', '"8"', '"9"', '"10"', '"11"', '"12"'], "anyOf")}}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "val", "oneOf"))).toBeDefined();
  expect(at(out, ...params("properties", "val", "anyOf"))).toBeDefined();
});

test("TestNormalizeCodexToolSchemas_MigratesConstBranchesToEnum", () => {
  const values = Array.from({ length: 10 }, (_, i) => `"m${i + 1}"`);
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"t2","parameters":{"type":"object","properties":{"mode":{"type":"string",${constUnion(values)}}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "mode", "oneOf"))).toBeUndefined();
  expect((at(out, ...params("properties", "mode", "enum")) as unknown[]).length).toBe(10);
});

test("TestNormalizeCodexToolSchemas_NonMatchingEnumNotTouched", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"t3","parameters":{"type":"object","properties":{"status":{"type":"string","enum":[${eight.join(",")},"extra"],${constUnion(eight)}}}}}]}`;
  expect(at(normalizeCodexToolSchemas(input), ...params("properties", "status", "oneOf"))).toBeDefined();
});

test("TestNormalizeCodexToolSchemas_NonConstUnionNotTouched", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"t4","parameters":{"type":"object","properties":{"data":{"oneOf":[
		{"type": "string", "pattern": "^[a-z]+$"}, {"type": "number", "minimum": 0}, {"type": "boolean"}, {"type": "null"},
		{"type": "array"}, {"type": "object"}, {"type": "integer"}, {"type": "string", "pattern": "^[0-9]+$"}]}}}}]}`;
  expect(at(normalizeCodexToolSchemas(input), ...params("properties", "data", "oneOf"))).toBeDefined();
});

test("TestNormalizeCodexToolSchemas_SimpleToolPreserved", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"function","name":"lookup","strict":true,"parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(out).toBe(input);
  expect(at(out, ...params("properties", "query", "type"))).toBe("string");
  expect(at(out, "tools", 0, "strict")).toBe(true);
});

test("TestNormalizeCodexToolSchemas_NamespaceToolSimplified", () => {
  const input = `{"model":"gpt-5.5","tools":[{"type":"namespace","name":"mcp","tools":[{"type":"function","name":"complex_tool","parameters":{"type":"object","properties":{"action":{"type":"string",${constUnion(eight)}}}}}]}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, "tools", 0, "tools", 0, "parameters", "properties", "action", "oneOf")).toBeUndefined();
  expect((at(out, "tools", 0, "tools", 0, "parameters", "properties", "action", "enum") as unknown[]).length).toBe(8);
});

test("TestNormalizeCodexToolSchemas_StripsUnsupportedUnicodePropertyEscapePatterns", () => {
  const input = `{
		"model": "gpt-5.6",
		"tools": [{"type": "function", "name": "Artifact", "parameters": {"type": "object", "properties": {
			"field": {"type": "string", "description": "field to edit", "pattern": "^(?!__.*__$)[^\\\\p{Cc}\\\\p{Cf}\\\\p{Zl}\\\\p{Zp}\\"\\\\\\\\./[\\\\]]{1,200}$"},
			"asset_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"}
		}, "required": ["field"]}}]
	}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "field", "pattern"))).toBeUndefined();
  expect(at(out, ...params("properties", "field", "type"))).toBe("string");
  expect(at(out, ...params("properties", "asset_id", "pattern"))).toBe("^[0-9a-f]{32}$");
  expect(normalizeCodexToolSchemas(out)).toBe(out);
});

test("TestNormalizeCodexToolSchemas_StripsOctalNULPatternEscape", () => {
  const input = `{
		"model": "gpt-5.6",
		"tools": [{"type": "function", "name": "Artifact", "parameters": {"type": "object", "properties": {
			"file_paths": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1, "maxLength": 1024, "pattern": "^[^\\\\0]*$"}},
			"asset_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
			"hex_nul": {"type": "string", "pattern": "^[^\\\\x00]*$"}
		}, "required": ["file_paths"]}}]
	}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "file_paths", "items", "pattern"))).toBeUndefined();
  expect(at(out, ...params("properties", "file_paths", "items", "type"))).toBe("string");
  expect(raw(out, ...params("properties", "file_paths", "items", "minLength"))).toBe("1");
  expect(raw(out, ...params("properties", "file_paths", "items", "maxLength"))).toBe("1024");
  expect(raw(out, ...params("properties", "file_paths", "minItems"))).toBe("1");
  expect(at(out, ...params("properties", "asset_id", "pattern"))).toBe("^[0-9a-f]{32}$");
  expect(at(out, ...params("properties", "hex_nul", "pattern"))).toBe("^[^\\x00]*$");
  expect(normalizeCodexToolSchemas(out)).toBe(out);
});

test("TestNormalizeCodexToolSchemas_PreservesNonSchemaPatternKeys", () => {
  const input = `{"model":"gpt-5.6","tools":[{"type":"function","name":"config_tool","parameters":{"type":"object","properties":{
		"regex_config": {"type": "object", "default": {"pattern": "\\\\p{L}+"}, "enum": [{"pattern": "\\\\p{N}+"}]},
		"real_schema": {"type": "string", "pattern": "\\\\p{L}+"}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "real_schema", "pattern"))).toBeUndefined();
  expect(at(out, ...params("properties", "regex_config", "default", "pattern"))).toBe("\\p{L}+");
  expect(at(out, ...params("properties", "regex_config", "enum", 0, "pattern"))).toBe("\\p{N}+");
});

test("TestNormalizeCodexToolSchemas_CoversAllSchemaKeywordLocations", () => {
  const input = `{"model":"gpt-5.6","tools":[{"type":"function","name":"deep_tool","parameters":{
		"type": "object",
		"$defs": {"custom_type": {"type": "string", "pattern": "\\\\p{L}+"}},
		"additionalProperties": {"type": "string", "pattern": "\\\\p{N}+"},
		"patternProperties": {"^s_": {"type": "string", "pattern": "\\\\p{M}+"}},
		"if": {"properties": {"flag": {"type": "string", "pattern": "\\\\p{P}+"}}},
		"then": {"properties": {"val": {"type": "string", "pattern": "\\\\p{S}+"}}},
		"else": {"properties": {"other": {"type": "string", "pattern": "\\\\p{Z}+"}}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("$defs", "custom_type", "pattern"))).toBeUndefined();
  expect(at(out, ...params("additionalProperties", "pattern"))).toBeUndefined();
  expect(at(out, ...params("patternProperties", "^s_", "pattern"))).toBeUndefined();
  expect(at(out, ...params("if", "properties", "flag", "pattern"))).toBeUndefined();
  expect(at(out, ...params("then", "properties", "val", "pattern"))).toBeUndefined();
  expect(at(out, ...params("else", "properties", "other", "pattern"))).toBeUndefined();
  expect(at(out, ...params("$defs", "custom_type", "type"))).toBe("string");
});

test("TestNormalizeCodexToolSchemas_MalformedOrEmptyParametersFallback", () => {
  for (const c of [
    `{"model":"gpt-5.6","tools":[{"type":"function","name":"t","parameters":null}]}`,
    `{"model":"gpt-5.6","tools":[{"type":"function","name":"t","parameters":"not_an_object"}]}`,
    `{"model":"gpt-5.6","tools":[{"type":"function","name":"t","parameters":{"type":"object"}}]}`,
    `{"model":"gpt-5.6","tools":[]}`,
    `{"model":"gpt-5.6"}`,
  ]) {
    expect(normalizeCodexToolSchemas(c).length).toBeGreaterThan(0);
  }
});

test("TestNormalizeCodexToolSchemas_JSONUnicodeEscapeBypassPrevention", () => {
  const input = `{"model":"gpt-5.6","tools":[{"type":"function","name":"escape_bypass_tool","parameters":{"type":"object","properties":{
		"p1": {"type": "string", "pattern": "\\u005c\\u0070{L}+"},
		"p2": {"type": "string", "pattern": "\\u005cp{Cc}"},
		"p3": {"type": "string", "pattern": "\\u005c\\u0050{N}+"},
		"valid": {"type": "string", "pattern": "^[0-9a-f]{32}$"}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  expect(at(out, ...params("properties", "p1", "pattern"))).toBeUndefined();
  expect(at(out, ...params("properties", "p2", "pattern"))).toBeUndefined();
  expect(at(out, ...params("properties", "p3", "pattern"))).toBeUndefined();
  expect(at(out, ...params("properties", "valid", "pattern"))).toBe("^[0-9a-f]{32}$");
});

test("TestNormalizeCodexToolSchemas_PatternPropertiesKeySanitization", () => {
  const input = `{"model":"gpt-5.6","tools":[{"type":"function","name":"pattern_props_tool","parameters":{"type":"object","patternProperties":{
		"^\\\\\\\\p{L}+$": {"type": "string"},
		"^[a-z]+$": {"type": "number"}}}}]}`;
  const out = normalizeCodexToolSchemas(input);
  const patternProps = at(out, ...params("patternProperties")) as Record<string, unknown>;
  expect("^\\p{L}+$" in patternProps).toBe(false);
  expect("^[a-z]+$" in patternProps).toBe(true);
});

test("TestNormalizeCodexToolSchemas_DoesNotNormalizeIntegerTypes", () => {
  const input = `{"tools":[{"type":"function","name":"exec_command","parameters":{"type":"object","properties":{"yield_time_ms":{"type":"number"}}}}]}`;
  expect(at(normalizeCodexToolSchemas(input), ...params("properties", "yield_time_ms", "type"))).toBe("number");
});

test("TestNormalizeCodexToolSchemas_StripsOutOfRangeInt64Bounds", () => {
  const input = `{
		"model": "gpt-6-luna",
		"tools": [{"type": "function", "name": "emulate_process", "description": "Emulate a process.", "parameters": {
			"type": "object",
			"properties": {"options": {"type": "object", "properties": {
				"seed": {"type": "integer", "minimum": 0, "maximum": 18446744073709552000},
				"over_max_int64": {"type": "integer", "minimum": -9223372036854775809, "maximum": 9223372036854775808, "exclusiveMinimum": -9223372036854775809, "exclusiveMaximum": 9223372036854775808},
				"exact_int64_limits": {"type": "integer", "minimum": -9223372036854775808, "maximum": 9223372036854775807, "exclusiveMinimum": -9223372036854775808, "exclusiveMaximum": 9223372036854775807},
				"float_bounds": {"type": "number", "minimum": -0.5, "maximum": 3.14, "exclusiveMinimum": 0.25, "exclusiveMaximum": 99.95},
				"scientific_bounds": {"type": "number", "minimum": 1e5, "maximum": 1e100, "exclusiveMinimum": -1.8446744073709552e+19, "exclusiveMaximum": 18446744073709552000.0},
				"high_precision_fraction": {"type": "number", "maximum": 18446744073709552000.00000000000000000000000000000000000000000000000000000000000000000000000000000001},
				"extreme_exponents": {"type": "number", "minimum": 1.1e-9223372036854775808, "maximum": 10e9223372036854775807},
				"user_data": {"type": "object", "default": {"maximum": 18446744073709552000}, "enum": [{"maximum": 18446744073709552000}]},
				"maximum": {"type": "integer", "minimum": 0}
			}}},
			"$defs": {"uint64_id": {"type": "integer", "maximum": 18446744073709551615}}
		}}]
	}`;
  const out = normalizeCodexToolSchemas(input);
  const opt = (...keys: string[]) => params("properties", "options", "properties", ...keys);
  expect(at(out, ...opt("seed", "maximum"))).toBeUndefined();
  expect(raw(out, ...opt("seed", "minimum"))).toBe("0");
  expect(at(out, ...opt("seed", "type"))).toBe("integer");
  for (const kw of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) expect(at(out, ...opt("over_max_int64", kw))).toBeUndefined();
  expect(raw(out, ...opt("exact_int64_limits", "minimum"))).toBe("-9223372036854775808");
  expect(raw(out, ...opt("exact_int64_limits", "maximum"))).toBe("9223372036854775807");
  expect(raw(out, ...opt("exact_int64_limits", "exclusiveMinimum"))).toBe("-9223372036854775808");
  expect(raw(out, ...opt("exact_int64_limits", "exclusiveMaximum"))).toBe("9223372036854775807");
  expect(raw(out, ...opt("float_bounds", "minimum"))).toBe("-0.5");
  expect(raw(out, ...opt("float_bounds", "maximum"))).toBe("3.14");
  expect(raw(out, ...opt("scientific_bounds", "minimum"))).toBe("1e5");
  for (const kw of ["maximum", "exclusiveMinimum", "exclusiveMaximum"]) expect(at(out, ...opt("scientific_bounds", kw))).toBeUndefined();
  expect(raw(out, ...opt("high_precision_fraction", "maximum"))).toBe(
    "18446744073709552000.00000000000000000000000000000000000000000000000000000000000000000000000000000001",
  );
  expect(raw(out, ...opt("extreme_exponents", "minimum"))).toBe("1.1e-9223372036854775808");
  expect(at(out, ...opt("extreme_exponents", "maximum"))).toBeUndefined();
  expect(raw(out, ...opt("user_data", "default", "maximum"))).toBe("18446744073709552000");
  expect(raw(out, ...opt("user_data", "enum", "0", "maximum"))).toBe("18446744073709552000");
  expect(at(out, ...opt("maximum", "type"))).toBe("integer");
  expect(at(out, ...params("$defs", "uint64_id", "maximum"))).toBeUndefined();
  expect(normalizeCodexToolSchemas(out)).toBe(out);
});

// ---------------------------------------------------------------------------
// Executor-level cases (codex_executor_tool_schema_test.go)
// ---------------------------------------------------------------------------

const incompleteZero = `data: {"type":"response.incomplete","response":{"id":"resp_1","model":"gpt-5.5","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":10,"output_tokens":0,"total_tokens":10}}}\n\n`;

describe("codex executor tool schema and zero-token incomplete handling", () => {
  let respond: () => Response = () => sseResponse("");
  const upstream = startUpstream(() => respond());
  afterAll(() => upstream.close());
  const executor = new CodexExecutor();
  const claudeHello = JSON.stringify({ model: "gpt-5.5", max_tokens: 64, messages: [{ role: "user", content: "hello" }] });

  test("TestCodexExecutorSimplifiesComplexOneOfToolSchema", async () => {
    respond = () =>
      sseResponse(`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n`);
    const actions = ["p.list", "m.list", "s.list", "s.create", "s.send", "s.fork", "s.status", "s.messages", "sch.list", "sch.create", "sch.run", "sch.delete", "sch.toggle"];
    const payload = JSON.stringify({
      model: "gpt-5.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      tools: [
        {
          name: "t1",
          description: "test tool",
          input_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: actions, oneOf: actions.map((a) => ({ const: a, description: a })), description: "Action to perform" },
              target_id: { type: "string", description: "Optional target" },
            },
            required: ["action"],
          },
        },
      ],
    });
    await executor.execute(apiKeyAuth(upstream.url, "test", { plan_type: "pro" }), request("gpt-5.5", payload), options("claude", false));
    const gotBody = upstream.requests[upstream.requests.length - 1]!.body;
    const tools = getValue(gotBody, "tools") as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(0);
    const t1 = JSON.stringify(tools.find((t) => t.name === "t1") ?? tools[0]);
    expect(getValue(t1, "parameters.properties.action.oneOf")).toBeUndefined();
    expect(getString(t1, "parameters.properties.action.type")).toBe("string");
    expect((getValue(t1, "parameters.properties.action.enum") as unknown[]).length).toBe(13);
    expect(getString(t1, "parameters.properties.target_id.type")).toBe("string");
    expect(getString(t1, "parameters.required.0")).toBe("action");
  });

  test("TestCodexExecutorExecuteStream_ZeroTokenIncompleteResponseIsFailure", async () => {
    respond = () => sseResponse(incompleteZero);
    const result = await executor.executeStream(apiKeyAuth(upstream.url), request("gpt-5.5", claudeHello), options("claude", true));
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
    expect((error as StatusError).requestScoped).toBe(true);
  });

  test("TestCodexExecutorExecuteStream_PartialDeltasIncompleteResponseIsSuccessful", async () => {
    respond = () => sseResponse(`data: {"type":"response.output_text.delta","delta":"Hello world"}\n\n` + incompleteZero);
    const result = await executor.executeStream(apiKeyAuth(upstream.url), request("gpt-5.5", claudeHello), options("claude", true));
    const { chunks, error } = await drain(result);
    expect(error).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("TestCodexExecutorExecuteStream_EmptyDeltaDoesNotBypassZeroTokenFailure", async () => {
    respond = () => sseResponse(`data: {"type":"response.output_text.delta","delta":""}\n\n` + incompleteZero);
    const result = await executor.executeStream(apiKeyAuth(upstream.url), request("gpt-5.5", claudeHello), options("claude", true));
    const { error } = await drain(result);
    expect(error).toBeInstanceOf(StatusError);
  });
});

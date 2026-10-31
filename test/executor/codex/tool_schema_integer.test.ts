// Ported from: internal/client/codex/tool-schema/tool_schema_test.go
// Ported from: internal/client/codex/tool-schema/tool_schema_integer_fields_test.go
// Skipped cases: none. Adaptations: Go compared bytes edited in place by sjson; the port re-serialises the
//   literal-preserving raw JSON tree when a field changes, so changed bodies are compared as canonical raw JSON
//   (same keys, order and number literals) and unchanged bodies must come back as the identical string. The
//   function is ported and tested on its own: wiring it into the non-Codex executors (Go applied it for Codex
//   clients whose request targets Claude / Gemini / OpenAI-compatible upstreams) is outside the Codex executor.
//   testdata/history_notes_tools.json is copied from the Go package.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCodexUserAgent, normalizeCodexToolIntegerTypes } from "../../../src/executor/codex/index.ts";
import { RawNumber, parseRawJSON, stringifyRawJSON } from "../../../src/executor/codex/rawjson.ts";
import { getString, getValue } from "./helpers.ts";

/** Canonical form of a raw JSON text (key order and number literals kept, whitespace dropped). */
function canonical(text: string): string {
  return stringifyRawJSON(parseRawJSON(text));
}

/** sjson.SetRawBytes on a gjson path (numeric segments index arrays), returning canonical JSON. */
function setRaw(body: string, path: string, value: string): string {
  const root = parseRawJSON(body);
  const segs = path.split(".");
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const container = cur as Record<string, unknown> | unknown[];
    let next = Array.isArray(container) ? container[Number(seg)] : container[seg];
    if (next === undefined || next === null || typeof next !== "object" || next instanceof RawNumber) {
      next = {};
      if (Array.isArray(container)) container[Number(seg)] = next;
      else container[seg] = next;
    }
    cur = next;
  }
  const last = segs[segs.length - 1]!;
  const parsed = parseRawJSON(value);
  if (Array.isArray(cur)) cur[Number(last)] = parsed;
  else (cur as Record<string, unknown>)[last] = parsed;
  return stringifyRawJSON(root);
}

function ua(value: string | undefined): Headers | undefined {
  if (value === undefined) return undefined;
  return value === "" ? new Headers() : new Headers({ "User-Agent": value });
}

describe("TestNormalizeCodexToolIntegerTypes", () => {
  const input = `{
    "tools": [
      {"type":"function","name":"exec_command","parameters":{"type":"object","properties":{"cmd":{"type":"string"},"yield_time_ms":{"type":"number"},"max_output_tokens":{"type":"number"},"timeout_ms":{"type":"number"}}}},
      {"type":"function","name":"write_stdin","parameters":{"type":"object","properties":{"session_id":{"type":"number"},"yield_time_ms":{"type":"number"},"max_output_tokens":{"type":"number"}}}},
      {"type":"function","name":"sleep","parameters":{"type":"object","properties":{"duration_ms":{"type":"number"}}}},
      {"type":"function","name":"wait_agent","parameters":{"type":"object","properties":{"timeout_ms":{"type":"number"}}}},
      {"type":"function","name":"wait","parameters":{"type":"object","properties":{"yield_time_ms":{"type":"number"},"max_tokens":{"type":"number"}}}},
      {"type":"function","name":"tool_search","parameters":{"type":"object","properties":{"limit":{"type":"number"}}}},
      {"type":"function","name":"test_sync_tool","parameters":{"type":"object","properties":{"sleep_before_ms":{"type":"number"},"sleep_after_ms":{"type":"number"},"participants":{"type":"number"},"timeout_ms":{"type":"number"}}}},
      {"type":"function","name":"unrelated_tool","parameters":{"type":"object","properties":{"timeout_ms":{"type":"number"}}}}
    ],
    "input": [
      {"type":"additional_tools","tools":[{"type":"function","name":"functions__exec_command","parameters":{"type":"object","properties":{"yield_time_ms":{"type":["number","null"]}}}}]}
    ]
  }`;

  test("non-codex user agent preserves numbers", () => {
    const out = normalizeCodexToolIntegerTypes(input, ua("curl/8.7.1"));
    expect(getString(out, "tools.0.parameters.properties.yield_time_ms.type")).toBe("number");
  });

  test("nil or empty headers leaves payload untouched", () => {
    expect(normalizeCodexToolIntegerTypes(input, undefined)).toBe(input);
    expect(normalizeCodexToolIntegerTypes(input, new Headers())).toBe(input);
    expect(isCodexUserAgent(undefined)).toBe(false);
  });

  test("codex user agent normalizes specified fields", () => {
    const out = normalizeCodexToolIntegerTypes(input, ua("codex-tui/0.154.0 (Mac OS 26.5.2; arm64)"));
    const tools = new Map<string, unknown>();
    for (const tool of getValue(out, "tools") as Array<{ name: string }>) tools.set(tool.name, tool);
    const expected: Record<string, string[]> = {
      exec_command: ["yield_time_ms", "max_output_tokens", "timeout_ms"],
      write_stdin: ["session_id", "yield_time_ms", "max_output_tokens"],
      sleep: ["duration_ms"],
      wait_agent: ["timeout_ms"],
      wait: ["yield_time_ms", "max_tokens"],
      tool_search: ["limit"],
      test_sync_tool: ["sleep_before_ms", "sleep_after_ms", "participants", "timeout_ms"],
    };
    for (const [name, fields] of Object.entries(expected)) {
      const tool = tools.get(name);
      expect(tool).toBeDefined();
      for (const field of fields) expect(getString(JSON.stringify(tool), `parameters.properties.${field}.type`)).toBe("integer");
    }
    expect(getString(JSON.stringify(tools.get("exec_command")), "parameters.properties.cmd.type")).toBe("string");
    expect(getString(JSON.stringify(tools.get("unrelated_tool")), "parameters.properties.timeout_ms.type")).toBe("number");
    expect(getValue(out, "input.0.tools.0.parameters.properties.yield_time_ms.type")).toEqual(["integer", "null"]);
  });

  test("third-party mcp tools are not modified", () => {
    const mcpInput = `{"tools":[
      {"type":"function","name":"mcp__server__sleep","parameters":{"type":"object","properties":{"duration_ms":{"type":"number"}}}},
      {"type":"function","name":"mcp__server__exec_command","parameters":{"type":"object","properties":{"yield_time_ms":{"type":"number"}}}},
      {"type":"function","name":"functions__sleep","parameters":{"type":"object","properties":{"duration_ms":{"type":"number"}}}},
      {"type":"function","name":"collab__exec_command","parameters":{"type":"object","properties":{"yield_time_ms":{"type":"number"}}}}
    ]}`;
    const out = normalizeCodexToolIntegerTypes(mcpInput, ua("codex-tui/0.154.0"));
    expect(getString(out, "tools.0.parameters.properties.duration_ms.type")).toBe("number");
    expect(getString(out, "tools.1.parameters.properties.yield_time_ms.type")).toBe("number");
    expect(getString(out, "tools.2.parameters.properties.duration_ms.type")).toBe("integer");
    expect(getString(out, "tools.3.parameters.properties.yield_time_ms.type")).toBe("integer");
  });

  test("array type with number and integer deduplicates to single integer", () => {
    const dupInput = `{"tools":[{"type":"function","name":"sleep","parameters":{"type":"object","properties":{"duration_ms":{"type":["number","integer","null"]}}}}]}`;
    const out = normalizeCodexToolIntegerTypes(dupInput, ua("codex-tui/0.154.0"));
    expect(getValue(out, "tools.0.parameters.properties.duration_ms.type")).toEqual(["integer", "null"]);
  });

  test("claude input_schema format supported", () => {
    const claudeInput = `{"tools":[{"name":"exec_command","input_schema":{"type":"object","properties":{"yield_time_ms":{"type":"number"},"timeout_ms":{"type":"number"}}}}]}`;
    const out = normalizeCodexToolIntegerTypes(claudeInput, ua("codex-tui/0.154.0"));
    expect(getString(out, "tools.0.input_schema.properties.yield_time_ms.type")).toBe("integer");
    expect(getString(out, "tools.0.input_schema.properties.timeout_ms.type")).toBe("integer");
  });

  test("gemini function_declarations format supported", () => {
    const geminiInput = `{"tools":[{"function_declarations":[{"name":"sleep","parameters":{"type":"object","properties":{"duration_ms":{"type":"number"}}}}]}]}`;
    const out = normalizeCodexToolIntegerTypes(geminiInput, ua("codex-desktop/0.159.0"));
    expect(getString(out, "tools.0.function_declarations.0.parameters.properties.duration_ms.type")).toBe("integer");
  });

  test("gemini parametersJsonSchema format supported directly", () => {
    const geminiInput = `{"tools":[{"functionDeclarations":[{"name":"exec_command","parametersJsonSchema":{"type":"object","properties":{"yield_time_ms":{"type":"number"}}}}]}]}`;
    const out = normalizeCodexToolIntegerTypes(geminiInput, ua("codex-desktop/0.159.0"));
    expect(getString(out, "tools.0.functionDeclarations.0.parametersJsonSchema.properties.yield_time_ms.type")).toBe("integer");
  });
});

describe("TestNormalizeCodexToolIntegerTypesSourceFields", () => {
  const cases: Array<[string, string[]]> = [
    ["test_sync_tool", ["barrier.properties.participants", "barrier.properties.timeout_ms"]],
    ["create_goal", ["token_budget"]],
    ["get_channels", ["limit"]],
    ["list_threads", ["limit", "max_chars_per_post"]],
    ["search_posts", ["limit", "max_chars_per_post"]],
    ["read_thread", ["limit", "max_chars_per_post"]],
    ["read_post", ["offset_chars", "limit_chars"]],
    ["memories__list", ["max_results"]],
    ["memories__read", ["line_offset", "max_lines"]],
    ["memories__search", ["context_lines", "max_results"]],
    ["history__list_windows", ["limit"]],
    ["history__list_items", ["limit", "max_chars_per_item"]],
    ["history__read_item", ["offset_chars", "limit_chars"]],
    ["history__search_contents", ["limit"]],
    ["notes__list_files_by_prefix", ["max_results"]],
    ["notes__read_file", ["start_line", "stop_line", "start_line.anyOf.0", "stop_line.anyOf.0"]],
    ["notes__search_contents", ["max_matches_per_file", "max_files"]],
    ["image_gen__imagegen", ["num_last_images_to_include"]],
    [
      "web__run",
      [
        "search_query.items.properties.recency",
        "image_query.items.properties.recency",
        "open.items.properties.lineno",
        "click.items.properties.id",
        "screenshot.items.properties.pageno",
        "weather.items.properties.duration",
        "sports.items.properties.num_games",
      ],
    ],
    ["collaboration__wait_agent", ["timeout_ms"]],
    ["multi_agent_v1__wait_agent", ["timeout_ms"]],
    ["functions__create_goal", ["token_budget"]],
    ["collab__read_post", ["offset_chars", "limit_chars"]],
    ["collaboration__get_channels", ["limit"]],
    ["collaboration__list_threads", ["limit", "max_chars_per_post"]],
    ["collaboration__search_posts", ["limit", "max_chars_per_post"]],
    ["collaboration__read_thread", ["limit", "max_chars_per_post"]],
    ["collaboration__read_post", ["offset_chars", "limit_chars"]],
  ];
  for (const [name, fields] of cases) {
    test(name, () => {
      for (const typeJSON of [`"number"`, `["number","integer","null"]`, `"integer"`, `"string"`]) {
        let input = `{"tools":[{"type":"function","name":${JSON.stringify(name)},"parameters":{"type":"object","properties":{"unrelated":{"type":"number","default":1.5}}},"output_schema":{"properties":{"wall_time_seconds":{"type":"number"}}}}],"input":[{"type":"function_call","arguments":"{\\"limit\\":1.5}"}]}`;
        for (const field of fields) input = setRaw(input, `tools.0.parameters.properties.${field}`, `{"type":${typeJSON},"description":"Keep metadata","minimum":0,"default":1}`);
        for (const agent of ["codex-tui/0.154.0", "curl/8.7.1", undefined]) {
          let want = input;
          if (agent === "codex-tui/0.154.0") {
            const wantType = typeJSON === `"number"` ? `"integer"` : typeJSON === `["number","integer","null"]` ? `["integer","null"]` : typeJSON;
            for (const field of fields) want = setRaw(want, `tools.0.parameters.properties.${field}.type`, wantType);
          }
          const headers = agent === undefined ? undefined : new Headers({ "user-agent": agent });
          const out = normalizeCodexToolIntegerTypes(input, headers);
          if (want === input) expect(out).toBe(input);
          else expect(canonical(out)).toBe(canonical(want));
          // Idempotent.
          expect(normalizeCodexToolIntegerTypes(out, headers)).toBe(out);
        }
      }
    });
  }
});

describe("TestNormalizeCodexToolIntegerTypesNamespaceFormats", () => {
  const schema = `{"type":"object","properties":{"line_offset":{"type":"number"},"max_lines":{"type":["number","null"]},"max_tokens":{"type":"number"}}}`;
  const cases: Array<[string, string, string]> = [
    ["responses", `{"tools":[{"type":"function","name":"memories__read","parameters":%s}]}`, "tools.0.parameters"],
    ["chat", `{"tools":[{"type":"function","function":{"name":"memories__read","parameters":%s}}]}`, "tools.0.function.parameters"],
    ["claude", `{"tools":[{"name":"memories__read","input_schema":%s}]}`, "tools.0.input_schema"],
    ["gemini", `{"tools":[{"function_declarations":[{"name":"memories__read","parameters":%s}]}]}`, "tools.0.function_declarations.0.parameters"],
    ["gemini JSON schema", `{"tools":[{"functionDeclarations":[{"name":"memories__read","parametersJsonSchema":%s}]}]}`, "tools.0.functionDeclarations.0.parametersJsonSchema"],
    ["namespace", `{"tools":[{"type":"namespace","name":"memories","tools":[{"type":"function","name":"read","parameters":%s}]}]}`, "tools.0.tools.0.parameters"],
    ["additional namespace", `{"input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"memories","tools":[{"type":"function","name":"read","parameters":%s}]}]}]}`, "input.0.tools.0.tools.0.parameters"],
  ];
  for (const [name, template, path] of cases) {
    test(name, () => {
      const input = template.replace("%s", schema);
      let want = setRaw(input, `${path}.properties.line_offset.type`, `"integer"`);
      want = setRaw(want, `${path}.properties.max_lines.type`, `["integer","null"]`);
      expect(canonical(normalizeCodexToolIntegerTypes(input, ua("Codex/1.0")))).toBe(canonical(want));
    });
  }
});

describe("TestNormalizeCodexToolIntegerTypesPreservesUnprovenFields", () => {
  const cases: Array<[string, string]> = [
    ["unknown_tool", ""],
    ["mcp__server__read_post", ""],
    ["read", ""],
    ["run", ""],
    ["imagegen", ""],
    ["read_post", "user_tools"],
    ["wait_agent", "mcp__server"],
    ["read", "skills"],
    ["read", "user_tools"],
    ["read_post", "multi_agent_v1"],
    ["read_post", "arbitrary_collaboration"],
  ];
  for (const [name, namespace] of cases) {
    test(`${namespace}/${name}`, () => {
      let tool = `{"type":"function","name":${JSON.stringify(name)},"parameters":{"properties":{"limit":{"type":"number"},"offset_chars":{"type":"number"},"line_offset":{"type":"number"},"timeout_ms":{"type":"number"}}}}`;
      if (namespace !== "") tool = `{"type":"namespace","name":${JSON.stringify(namespace)},"tools":[${tool}]}`;
      const input = `{"tools":[${tool}]}`;
      expect(normalizeCodexToolIntegerTypes(input, ua("codex"))).toBe(input);
    });
  }

  test("nested explicit paths only", () => {
    const input = `{"tools":[{"name":"test_sync_tool","parameters":{"properties":{"barrier.participants":{"type":"number"},"other":{"properties":{"participants":{"type":"number"}}},"barrier":{"properties":{"participants":{"type":"number"},"ratio":{"type":"number"}}}}}}]}`;
    const out = normalizeCodexToolIntegerTypes(input, ua("codex"));
    const want = setRaw(input, "tools.0.parameters.properties.barrier.properties.participants.type", `"integer"`);
    expect(canonical(out)).toBe(canonical(want));
  });
});

describe("TestNormalizeCodexToolIntegerTypesHistoryNotesSchemas", () => {
  // Parameter schemas copied from codex-rs/ext/history-notes/src/tools.rs.
  const fixture = readFileSync(join(import.meta.dir, "testdata", "history_notes_tools.json"), "utf8");
  const namespaces = (JSON.parse(fixture) as { tools: Array<{ name: string; tools: Array<{ name: string; parameters: unknown }> }> }).tools;
  // Raw text of each namespace / parameters object, as gjson's .Raw (re-serialised with the fixture's indentation style).
  const pretty = (v: unknown) => JSON.stringify(v, null, 1).replace(/\n\s*/g, " ");
  for (const namespace of namespaces) {
    const tool = namespace.tools[0]!;
    const name = `${namespace.name}__${tool.name}`;
    test(name, () => {
      const namespaceRaw = pretty(namespace);
      const paramsRaw = pretty(tool.parameters);
      expect(namespaceRaw).toContain(`"type": "integer"`);
      const formats: Array<[string, string]> = [
        ["namespace", `{"tools":[${namespaceRaw}]}`],
        ["flat", `{"tools":[{"name":${JSON.stringify(name)},"parameters":${paramsRaw}}]}`],
        ["additional", `{"input":[{"type":"additional_tools","tools":[${namespaceRaw}]}]}`],
      ];
      for (const [, body] of formats) {
        // Simulate integer declarations degraded to number, keeping the real schema shape.
        const input = body.replaceAll(`"type": "integer"`, `"type": "number"`);
        for (const agent of ["codex", "curl", ""]) {
          const out = normalizeCodexToolIntegerTypes(input, ua(agent));
          if (agent === "codex") expect(canonical(out)).toBe(canonical(body));
          else expect(out).toBe(input);
          expect(normalizeCodexToolIntegerTypes(out, ua(agent))).toBe(out);
        }
      }
      for (const unknownName of [tool.name, `mcp__server__${name}`, `user__${name}`]) {
        const input = `{"tools":[{"name":${JSON.stringify(unknownName)},"parameters":${paramsRaw.replaceAll(`"type": "integer"`, `"type": "number"`)}}]}`;
        expect(normalizeCodexToolIntegerTypes(input, ua("codex"))).toBe(input);
      }
    });
  }
});

test("TestNormalizeCodexToolIntegerTypesNotesExplicitUnionPaths", () => {
  const input = `{"tools":[{"name":"notes__read_file","parameters":{"type":"object","properties":{"start_line":{"anyOf":[{"type":"number"},{"type":"null"}],"default":-3},"stop_line":{"anyOf":[{"type":"number"},{"type":"number"}],"default":-1},"ratio":{"anyOf":[{"type":"number"},{"type":"null"}]},"other":{"properties":{"start_line":{"anyOf":[{"type":"number"}]}}}},"required":["path"]}}],"input":[{"type":"function_call","arguments":"{\\"start_line\\":-3,\\"stop_line\\":-1}"}]}`;
  let want = setRaw(input, "tools.0.parameters.properties.start_line.anyOf.0.type", `"integer"`);
  want = setRaw(want, "tools.0.parameters.properties.stop_line.anyOf.0.type", `"integer"`);
  expect(canonical(normalizeCodexToolIntegerTypes(input, ua("codex")))).toBe(canonical(want));
});

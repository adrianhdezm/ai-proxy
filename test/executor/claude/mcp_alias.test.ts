// Ported from: internal/runtime/executor/helps/claude_mcp_alias_test.go
// Ported from: internal/runtime/executor/helps/claude_builtin_tools_test.go
// Ported from: internal/runtime/executor/claude_executor_request_remap_test.go
// Ported from: internal/runtime/executor/claude_executor_tool_alias_scope_test.go
// Skipped cases: BenchmarkAllocateClaudeMCPToolAlias_Collision (Go benchmark); TestApplyClaudeRawJSONEditsRejectsInvalidRanges,
// TestRemapOAuthToolNamesWithOptionsFallsBackForMalformedJSON and FuzzRemapOAuthToolNamesWithBatchedEditsMatchesLegacy (Go
// keeps a raw-byte batched path and a legacy sjson path and checks one against the other; this port rewrites the parsed
// object once, so there is no second implementation, no raw edit list and no malformed-JSON fallback).
// TestRemapOAuthToolNamesWithBatchedEditsMatchesLegacyBytes is ported as explicit per-fixture assertions on the remapped
// body and reverse map instead of a byte comparison between the two Go paths; the "batched"/"legacy" variants of
// TestRemapOAuthToolNames_MidConversationToolChanges collapse into one. TestClaudeOAuthToolAliasStoreIsSharedAcrossForAPIKeyCopies
// (Go: ForAPIKey copies the executor by value) becomes "one executor serves every credential, so a continuation sees the
// aliases its create request stored", driven through execute(); the Kimi row is dropped (Kimi not ported).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { createClaudeExecutor } from "../../../src/executor/claude/executor.ts";
import { claudeBIP39EnglishWords } from "../../../src/executor/claude/bip39_words.ts";
import {
  allocateClaudeMCPToolAlias,
  augmentClaudeBuiltinToolRegistry,
  claudeMCPAliasWordCount,
  claudeMCPToolAlias,
  defaultClaudeBuiltinToolNames,
  isClaudeMCPToolName,
  isClaudeServerToolType,
} from "../../../src/executor/claude/mcp_alias.ts";
import {
  ClaudeMCPAliasRestoreError,
  ClaudeOAuthToolAliasStore,
  type ClaudeToolAliasMap,
  claudeMCPAliasServer,
  claudeOAuthToolAliasStateLimit,
  parseClaudeMCPAlias,
  prepareClaudeOAuthToolNamesForRequest,
  rememberClaudeOAuthToolAliases,
  remapOAuthToolNames,
  reverseRemapOAuthToolNames,
  reverseRemapOAuthToolNamesFromStreamLine,
  sseJSONPayload,
} from "../../../src/executor/claude/tool_alias.ts";
import { StatusError } from "../../../src/executor/types.ts";
import { claudeOAuthTestMetadata, claudeOpts, drain, fakeFetch } from "./helpers.ts";

const allowed = new Set(claudeBIP39EnglishWords);

function assertClaudeMCPAliasWords(alias: string): void {
  const parts = alias.split("__");
  expect(parts.length).toBe(3);
  const serverWords = parts[1]!.split("_");
  expect(serverWords.length).toBe(2);
  const cut = parts[2]!.indexOf("_");
  expect(cut).toBeGreaterThan(0);
  const toolID = parts[2]!.slice(0, cut);
  for (const word of [...serverWords, toolID]) expect(allowed.has(word)).toBe(true);
}

const parse = (s: string): any => JSON.parse(s);
const remap = (body: string, secret: string) => remapOAuthToolNames(body, secret);
const toolUse = (name: string) => `{"content":[{"type":"tool_use","id":"toolu_1","name":${JSON.stringify(name)},"input":{}}]}`;
const toolUseLine = (name: string) => `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":${JSON.stringify(name)},"input":{}}}`;
const restoredName = (body: string, map: ClaudeToolAliasMap) => parse(reverseRemapOAuthToolNames(body, map)).content[0].name;
const restoredStreamName = (line: string, map: ClaudeToolAliasMap) => parse(sseJSONPayload(reverseRemapOAuthToolNamesFromStreamLine(line, map))).content_block.name;
const keyFor = (map: ClaudeToolAliasMap, original: string) => [...map].find(([k, v]) => v === original && k !== original)?.[0] ?? "";

function expectRestoreError(fn: () => unknown, wantError: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ClaudeMCPAliasRestoreError);
  expect((err as Error).message).toContain(wantError);
  expect((err as StatusError).requestScoped).toBe(true);
}

describe("helps/claude_mcp_alias.go", () => {
  test("IsClaudeMCPToolName", () => {
    for (const name of ["mcp__context7__query-docs", "mcp__amber_cedar__quiet_harbor", "mcp__server__tool__variant"]) expect(isClaudeMCPToolName(name)).toBe(true);
    for (const name of ["context7__query-docs", "mcp____query-docs", "mcp__context7__", "mcp__context7__query.docs", "mcp__context7__" + "x".repeat(64)]) {
      expect(isClaudeMCPToolName(name)).toBe(false);
    }
  });

  test("ClaudeMCPToolAlias", () => {
    const first = claudeMCPToolAlias("credential-secret", "search_web", 0);
    expect(claudeMCPToolAlias("credential-secret", "search_web", 0)).toBe(first);
    const caseDistinct = claudeMCPToolAlias("credential-secret", "Search_Web", 0);
    expect(caseDistinct).not.toBe(first);
    const retry = claudeMCPToolAlias("credential-secret", "search_web", 1);
    expect(retry).not.toBe(first);
    expect(isClaudeMCPToolName(first)).toBe(true);
    expect(first.endsWith("_search_web")).toBe(true);
    expect(first).toMatch(/^mcp__[a-z]+_[a-z]+__[a-z]+_search_web$/);
    assertClaudeMCPAliasWords(first);
    const server = first.split("__")[1];
    expect(caseDistinct.split("__")[1]).toBe(server);
    expect(retry.split("__")[1]).toBe(server);
    expect(claudeMCPToolAlias("other-caller", "search_web", 0).split("__")[1]).not.toBe(server);
  });

  test("ClaudeMCPToolAlias_SemanticSuffixIsSafeAndBounded", () => {
    for (const [original, wantSuffix] of [
      ["browser.open URL", "_browser_open_URL"],
      ["search.网页/tool with spaces", "_search_tool_with_spaces"],
      ["搜索网页", "_tool"],
    ] as const) {
      const alias = claudeMCPToolAlias("credential-secret", original, 0);
      expect(isClaudeMCPToolName(alias)).toBe(true);
      expect(alias.length).toBeLessThanOrEqual(64);
      expect(alias.endsWith(wantSuffix)).toBe(true);
    }
    const original = "a".repeat(68);
    const alias = claudeMCPToolAlias("credential-secret", original, 0);
    const prefixLen = alias.lastIndexOf("_") + 1;
    expect(prefixLen).toBeGreaterThan(0);
    expect(alias.slice(prefixLen)).toBe("a".repeat(Math.max(1, 64 - prefixLen)));
    expect(alias.length).toBe(64);
  });

  test("ClaudeMCPToolAlias_Strict64CharLimitUnderAllWordCombinations", () => {
    for (let i = 0; i < claudeMCPAliasWordCount(); i++) {
      const alias = claudeMCPToolAlias(`test-secret-${i}`, `tool_${i}_long_name_`.repeat(50), i);
      expect(alias.length).toBeLessThanOrEqual(64);
      expect(isClaudeMCPToolName(alias)).toBe(true);
      assertClaudeMCPAliasWords(alias);
    }
  });

  test("AllocateClaudeMCPToolAlias_StopsWhenAttemptsExhausted", () => {
    const reserved = new Set<string>();
    for (let attempt = 0; attempt < claudeMCPAliasWordCount(); attempt++) reserved.add(claudeMCPToolAlias("exhaust-space", "tool.name", attempt));
    expect(allocateClaudeMCPToolAlias("exhaust-space", "tool.name", reserved)).toBeUndefined();
    expect(allocateClaudeMCPToolAlias("exhaust-space", "tool.name")).toBeTruthy();
  });

  test("ClaudeMCPToolAlias_ProbesAllWordsWithoutDuplicates", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < claudeMCPAliasWordCount(); attempt++) {
      const toolPart = claudeMCPToolAlias("test-secret", "tool.name", attempt).split("__")[2]!;
      const toolID = toolPart.slice(0, toolPart.indexOf("_"));
      expect(seen.has(toolID)).toBe(false);
      seen.add(toolID);
    }
    expect(seen.size).toBe(claudeMCPAliasWordCount());
  });

  test("AllocateClaudeMCPToolAlias_AllocatesEveryDistinctWord", () => {
    const reserved = new Set<string>();
    for (let i = 0; i < claudeMCPAliasWordCount(); i++) {
      const alias = allocateClaudeMCPToolAlias("allocate-full-space", "tool.name", reserved);
      expect(alias).toBeDefined();
      expect(reserved.has(alias!)).toBe(false);
      reserved.add(alias!);
    }
    expect(reserved.size).toBe(claudeMCPAliasWordCount());
    expect(allocateClaudeMCPToolAlias("allocate-full-space", "tool.name", reserved)).toBeUndefined();
  });

  test("ClaudeMCPAliasWordlistIntegrity", () => {
    expect(claudeMCPAliasWordCount()).toBe(2048);
    expect(claudeBIP39EnglishWords[0]).toBe("abandon");
    expect(claudeBIP39EnglishWords[2047]).toBe("zoo");
    expect(new Set(claudeBIP39EnglishWords).size).toBe(2048);
    for (const word of claudeBIP39EnglishWords) expect(word).toMatch(/^[a-z]{1,8}$/);
  });

  test("AllocateClaudeMCPToolAliasMatchesSingleShotConstruction", () => {
    for (const original of ["Bash", "read_file", "long_tool_name_".repeat(9)]) {
      const reserved = new Set<string>();
      for (let attempt = 0; attempt < claudeMCPAliasWordCount(); attempt++) {
        const allocated = allocateClaudeMCPToolAlias("shared-construction", original, reserved);
        expect(allocated).toBe(claudeMCPToolAlias("shared-construction", original, attempt));
        reserved.add(allocated!);
      }
    }
  });
});

describe("helps/claude_builtin_tools.go", () => {
  test("ClaudeBuiltinToolRegistry_DefaultSeedFallback", () => {
    const registry = augmentClaudeBuiltinToolRegistry(undefined);
    for (const name of defaultClaudeBuiltinToolNames) expect(registry.has(name)).toBe(true);
  });

  test("ClaudeBuiltinToolRegistry_AugmentsKnownTypedBuiltinsFromBody", () => {
    const registry = augmentClaudeBuiltinToolRegistry(
      `{"tools":[{"type":"web_search_20250305","name":"web_search"},{"type":"custom","name":"client_custom"},{"type":"custom_builtin_20250401","name":"unknown_typed"},{"name":"Read"}]}`,
    );
    expect(registry.has("web_search")).toBe(true);
    for (const name of ["client_custom", "unknown_typed", "Read"]) expect(registry.has(name)).toBe(false);
  });

  test("IsClaudeServerToolType", () => {
    for (const t of [
      "web_search_20250305",
      "code_execution_20250522",
      "tool_search_tool_regex_20251119",
      "advisor_20260301",
      "agent_toolset_20260401",
      "bash_20250124",
      "text_editor_20250728",
      "memory_20250818",
      "computer_20241022",
      "web_fetch_20260209",
    ]) {
      expect(isClaudeServerToolType(t)).toBe(true);
    }
    for (const t of ["", "custom", "custom_builtin_20250401"]) expect(isClaudeServerToolType(t)).toBe(false);
  });
});

describe("thread continuation alias state", () => {
  test("ClaudeOAuthToolAliasRestoresContinuationWithoutDeclarations", () => {
    const secret = "continuation-alias-caller";
    const createBody = `{"thread":{"type":"create"},"tools":[{"name":"Read","input_schema":{"type":"object"}}]}`;
    const store = new ClaudeOAuthToolAliasStore();
    const created = prepareClaudeOAuthToolNamesForRequest(store, createBody, secret);
    const alias = [...created.reverseMap.keys()][0] ?? "";
    expect(alias).not.toBe("");
    const continuationBody = `{"thread":{"type":"continue","previous_message_id":"msg-one"},"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-one","content":"ok"}]}]}`;
    rememberClaudeOAuthToolAliases(store, createBody, created.reverseMap, "msg-one");
    const continued = prepareClaudeOAuthToolNamesForRequest(store, continuationBody, secret);
    const restored = reverseRemapOAuthToolNames(`{"content":[{"type":"tool_use","id":"tool-two","name":${JSON.stringify(alias)},"input":{}}]}`, continued.reverseMap);
    expect(parse(restored).content[0].name).toBe("Read");
  });

  test("ClaudeOAuthToolAliasMissingContinuationStateIsRequestScopedNotFound", () => {
    let err: unknown;
    try {
      prepareClaudeOAuthToolNamesForRequest(new ClaudeOAuthToolAliasStore(), `{"thread":{"type":"continue","previous_message_id":"missing-message"}}`, "missing-state-caller");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StatusError);
    const statusErr = err as StatusError;
    expect(statusErr.statusCode).toBe(404);
    expect(statusErr.requestScoped).toBe(true);
    expect(statusErr.responseBody().length).toBeGreaterThan(0);
    expect(parse(statusErr.responseBody()).error.type).toBe("not_found_error");
  });

  test("ClaudeOAuthToolAliasEvictionReturnsThreadNotFound", () => {
    const store = new ClaudeOAuthToolAliasStore();
    const createBody = `{"thread":{"type":"create"}}`;
    rememberClaudeOAuthToolAliases(store, createBody, new Map([["alias", "Read"]]), "first-message");
    for (let i = 0; i < claudeOAuthToolAliasStateLimit; i++) rememberClaudeOAuthToolAliases(store, createBody, undefined, `message-${i}`);
    let err: unknown;
    try {
      prepareClaudeOAuthToolNamesForRequest(store, `{"thread":{"type":"continue","previous_message_id":"first-message"}}`, "evicted-state-caller");
    } catch (e) {
      err = e;
    }
    expect((err as StatusError).statusCode).toBe(404);
  });
});

describe("remapOAuthToolNames", () => {
  const secret = "differential-caller";

  test("BatchedEditsMatchesLegacyBytes/all reference shapes and undeclared history", () => {
    const body = `{"model":"claude-opus-5","tools":[{"name":"search_web","input_schema":{"type":"object"}},{"name":"Search_Web","input_schema":{"type":"object"}}],"tool_choice":{"type":"tool","name":"search_web"},"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"search_web","input":{}},{"type":"tool_reference","tool_name":"Search_Web"},{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"tool_reference","tool_name":"search_web"}]},{"type":"tool_use","id":"toolu_unknown","name":"not_declared","input":{}}]}]}`;
    const { body: out, reverseMap } = remap(body, secret);
    const got = parse(out);
    const lower = got.tools[0].name;
    const upper = got.tools[1].name;
    expect(isClaudeMCPToolName(lower)).toBe(true);
    expect(isClaudeMCPToolName(upper)).toBe(true);
    expect(lower).not.toBe(upper);
    expect(got.tool_choice.name).toBe(lower);
    const parts = got.messages[0].content;
    expect(parts[0].name).toBe(lower);
    expect(parts[1].tool_name).toBe(upper);
    expect(parts[2].content[0].tool_name).toBe(lower);
    expect(parts[3].name).toBe("not_declared");
    expect(Object.fromEntries(reverseMap)).toEqual({ [lower]: "search_web", [upper]: "Search_Web" });
  });

  test("BatchedEditsMatchesLegacyBytes/typed custom server existing MCP and duplicate declaration", () => {
    const body = `{"tools":[{"type":"custom","name":"client_custom","input_schema":{"type":"object"}},{"type":"web_search_20250305","name":"web_search"},{"name":"mcp__context7__query-docs"},{"name":"client_custom"}],"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"client_custom","id":"toolu_1","input":{}},{"type":"tool_reference","tool_name":"web_search"},{"type":"tool_reference","tool_name":"mcp__context7__query-docs"}]}]}`;
    const { body: out, reverseMap } = remap(body, secret);
    const got = parse(out);
    const alias = got.tools[0].name;
    expect(isClaudeMCPToolName(alias)).toBe(true);
    expect(got.tools[0].type).toBeUndefined();
    expect(got.tools[0].input_schema).toEqual({ type: "object" });
    expect(got.tools[1]).toEqual({ type: "web_search_20250305", name: "web_search" });
    expect(got.tools[2]).toEqual({ name: "mcp__context7__query-docs" });
    expect(got.tools[3]).toEqual({ name: alias });
    const parts = got.messages[0].content;
    expect(parts[0].name).toBe(alias);
    expect(parts[1].tool_name).toBe("web_search");
    expect(parts[2].tool_name).toBe("mcp__context7__query-docs");
    expect(Object.fromEntries(reverseMap)).toEqual({ [alias]: "client_custom", "mcp__context7__query-docs": "mcp__context7__query-docs" });
  });

  test("BatchedEditsMatchesLegacyBytes/alias collision", () => {
    const collision = claudeMCPToolAlias(secret, "fetch_url", 0);
    const { body: out, reverseMap } = remap(`{"tools":[{"name":${JSON.stringify(collision)}},{"name":"fetch_url"}],"tool_choice":{"type":"tool","name":"fetch_url"}}`, secret);
    const got = parse(out);
    expect(got.tools[0].name).toBe(collision);
    const alias = got.tools[1].name;
    expect(isClaudeMCPToolName(alias)).toBe(true);
    expect(alias).not.toBe(collision);
    expect(alias).toBe(claudeMCPToolAlias(secret, "fetch_url", 1));
    expect(got.tool_choice.name).toBe(alias);
    expect(Object.fromEntries(reverseMap)).toEqual({ [alias]: "fetch_url", [collision]: collision });
  });

  test("BatchedEditsMatchesLegacyBytes/unicode long and case distinct names", () => {
    const longName = "读取_" + "very_long_tool_name_".repeat(8);
    const { body: out, reverseMap } = remap(`{"messages":[{"content":[{"name":${JSON.stringify(longName)},"type":"tool_use"},{"tool_name":"read_file","type":"tool_reference"}]}],"tools":[{"name":${JSON.stringify(longName)}},{"name":"read_file"}]}`, secret);
    const got = parse(out);
    const longAlias = got.tools[0].name;
    const readAlias = got.tools[1].name;
    expect(isClaudeMCPToolName(longAlias)).toBe(true);
    expect(longAlias.length).toBeLessThanOrEqual(64);
    expect(got.messages[0].content[0].name).toBe(longAlias);
    expect(got.messages[0].content[1].tool_name).toBe(readAlias);
    expect(reverseMap.get(longAlias)).toBe(longName);
    expect(reverseMap.get(readAlias)).toBe("read_file");
  });

  test("BatchedEditsMatchesLegacyBytes/whitespace key order and escaped original", () => {
    const body =
      '{\n  "messages" : [ { "content" : [ { "name" : "fetch\\u005furl", "input":{}, "type" : "tool_use" } ], "role" : "assistant" } ],\n  "unknown" : {"number":1.2300,"escaped":"a\\/b\\n<>&"},\n  "tool_choice" : { "name" : "fetch\\u005furl", "type" : "tool" },\n  "tools" : [ { "description" : "keep \\"bytes\\"", "name" : "fetch\\u005furl", "input_schema" : { "type" : "object" } } ]\n}';
    const { body: out, reverseMap } = remap(body, secret);
    const got = parse(out);
    const alias = got.tools[0].name;
    expect(alias).toBe(claudeMCPToolAlias(secret, "fetch_url", 0));
    expect(got.messages[0].content[0].name).toBe(alias);
    expect(got.tool_choice.name).toBe(alias);
    expect(got.tools[0].description).toBe('keep "bytes"');
    expect(got.unknown).toEqual({ number: 1.23, escaped: "a/b\n<>&" });
    expect(Object.fromEntries(reverseMap)).toEqual({ [alias]: "fetch_url" });
  });

  test("BatchedEditsMatchesLegacyBytes/non-string names follow legacy coercion", () => {
    const { body: out, reverseMap } = remap(`{"tools":[{"name":42}],"tool_choice":{"type":"tool","name":42},"messages":[{"content":[{"type":"tool_reference","tool_name":42}]}]}`, secret);
    const got = parse(out);
    const alias = got.tools[0].name;
    expect(alias).toBe(claudeMCPToolAlias(secret, "42", 0));
    expect(got.tool_choice.name).toBe(alias);
    expect(got.messages[0].content[0].tool_name).toBe(alias);
    expect(Object.fromEntries(reverseMap)).toEqual({ [alias]: "42" });
  });

  test("BatchedEditsMatchesLegacyBytes/no edits and ReturnsOriginalSliceWithoutEdits", () => {
    for (const body of [
      `{"tools":[{"type":"web_search_20250305","name":"web_search"},{"name":"mcp__server__existing"}],"messages":[{"content":[{"type":"tool_reference","tool_name":"unknown"}]}]}`,
      `{"tools":[{"type":"web_search_20250305","name":"web_search"}]}`,
    ]) {
      const { body: out, reverseMap } = remap(body, "no-edits");
      expect(out).toBe(body);
      expect(reverseMap.size).toBe(0);
    }
  });

  test("ReverseRemapOAuthToolNamesRecoversMangledAliases", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"glob","input_schema":{"type":"object"}},{"name":"read","input_schema":{"type":"object"}}]}`, "mangled-alias-caller");
    const globAlias = parse(remapped).tools[0].name;
    const readAlias = parse(remapped).tools[1].name;
    const globParts = parseClaudeMCPAlias(globAlias)!;
    const readParts = parseClaudeMCPAlias(readAlias)!;
    expect(globParts).toBeDefined();
    expect(readParts).toBeDefined();
    const repeatedAlias = "mcp__" + globParts.server + "__" + globAlias;
    const mixedAlias = "mcp__" + globParts.server + "__" + globParts.toolID + "_" + readParts.semantic;
    const response = `{"content":[
		{"type":"tool_use","id":"toolu_glob","name":${JSON.stringify(repeatedAlias)},"input":{}},
		{"type":"tool_reference","tool_name":${JSON.stringify(mixedAlias)}},
		{"type":"tool_result","tool_use_id":"toolu_read","content":[{"type":"tool_reference","tool_name":${JSON.stringify(mixedAlias)}}]}
	]}`;
    const restored = parse(reverseRemapOAuthToolNames(response, reverseMap));
    expect(restored.content[0].name).toBe("glob");
    expect(restored.content[1].tool_name).toBe("read");
    expect(restored.content[2].content[0].tool_name).toBe("read");

    expect(restoredStreamName(toolUseLine(repeatedAlias), reverseMap)).toBe("glob");
    const refLine = `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_reference","tool_name":${JSON.stringify(mixedAlias)}}}`;
    expect(parse(sseJSONPayload(reverseRemapOAuthToolNamesFromStreamLine(refLine, reverseMap))).content_block.tool_name).toBe("read");
  });

  test("ReverseRemapOAuthToolNamesRecoversRepeatedServerAliases", () => {
    const alias = "mcp__hmzqrngkulqv__xuo7jlxlpzee_Bash";
    const reverseMap: ClaudeToolAliasMap = new Map([
      [alias, "Bash"],
      ["mcp__hmzqrngkulqv__aaaaaaaaaaaa_Bash", "OtherBash"],
    ]);
    for (const responseAlias of ["mcp__hmzqrngkulqv__hmzqrngkulqv__xuo7jlxlpzee_Bash", "mcp__hmzqrngkulqv__hmzqrngkulqv__hmzqrngkulqv__xuo7jlxlpzee_Bash"]) {
      expect(restoredName(toolUse(responseAlias), reverseMap)).toBe("Bash");
      expect(restoredStreamName(toolUseLine(responseAlias), reverseMap)).toBe("Bash");
    }
  });

  test("ReverseRemapOAuthToolNamesRecoversMalformedToolIDBySemanticSuffix", () => {
    const reverseMap: ClaudeToolAliasMap = new Map([["mcp__hmzqrngkulqv__xuo7jlxlpzee_Bash", "Bash"]]);
    for (const responseAlias of [
      "mcp__hmzqrngkulqv__xuo7jlxlpze_Bash",
      "mcp__hmzqrngkulqv__xuo7jlxlpzeea_Bash",
      "mcp__hmzqrngkulqv__xuo7jlxlpze0_Bash",
      "mcp__hmzqrngkulqv__auo7jlxlpzee_Bash",
      "mcp__hmzqrngkulqv__hmzqrngkulqv__xuo7jlxlpze_Bash",
    ]) {
      expect(restoredName(toolUse(responseAlias), reverseMap)).toBe("Bash");
      expect(restoredStreamName(toolUseLine(responseAlias), reverseMap)).toBe("Bash");
    }
  });

  test("ReverseRemapOAuthToolNamesWithBIP39Aliases", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"Bash","input_schema":{"type":"object"}},{"name":"fetch_url","input_schema":{"type":"object"}}]}`, "bip39-caller");
    const bashAlias = parse(remapped).tools[0].name;
    const fetchAlias = parse(remapped).tools[1].name;
    expect(isClaudeMCPToolName(bashAlias)).toBe(true);
    expect(isClaudeMCPToolName(fetchAlias)).toBe(true);
    const p = parseClaudeMCPAlias(bashAlias)!;
    expect(p.semantic).toBe("Bash");
    const names = [
      bashAlias,
      "mcp__" + p.server + "__" + p.server + "__" + p.toolID + "_Bash",
      "mcp__" + p.server + "__corruptedword_Bash",
      "mcp__" + p.server + "__" + p.toolID + "_" + p.toolID + "_Bash",
      "mcp__" + p.server + "__" + p.toolID + "_cabin_Bash",
    ];
    const response = `{"content":[
		{"type":"tool_use","id":"toolu_1","name":${JSON.stringify(names[0])},"input":{}},
		{"type":"tool_use","id":"toolu_2","name":${JSON.stringify(names[1])},"input":{}},
		{"type":"tool_reference","tool_name":${JSON.stringify(names[2])}},
		{"type":"tool_use","id":"toolu_3","name":${JSON.stringify(names[3])},"input":{}},
		{"type":"tool_use","id":"toolu_4","name":${JSON.stringify(names[4])},"input":{}}
	]}`;
    const restored = parse(reverseRemapOAuthToolNames(response, reverseMap));
    expect(restored.content[0].name).toBe("Bash");
    expect(restored.content[1].name).toBe("Bash");
    expect(restored.content[2].tool_name).toBe("Bash");
    expect(restored.content[3].name).toBe("Bash");
    expect(restored.content[4].name).toBe("Bash");
  });

  test("ReverseRemapOAuthToolNamesRejectsUnsafeMangledAliases", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"tool.name"},{"name":"tool/name"}]}`, "ambiguous-alias-caller");
    const first = parseClaudeMCPAlias(parse(remapped).tools[0].name)!;
    const second = parseClaudeMCPAlias(parse(remapped).tools[1].name)!;
    expect(first.semantic).toBe(second.semantic);
    let unknownToolID = "aaaaaaaaaaaa";
    if (unknownToolID === first.toolID || unknownToolID === second.toolID) unknownToolID = "bbbbbbbbbbbb";
    for (const alias of ["mcp__" + first.server + "__" + unknownToolID + "_" + first.semantic, "mcp__" + first.server + "__" + unknownToolID.slice(0, -1) + "_" + first.semantic]) {
      expectRestoreError(() => reverseRemapOAuthToolNames(toolUse(alias), reverseMap), "semantic suffix matches multiple declared tools");
      expectRestoreError(() => reverseRemapOAuthToolNamesFromStreamLine(toolUseLine(alias), reverseMap), "semantic suffix matches multiple declared tools");
    }
    // unrecoverable semantic suffix fails open
    const unrecoverable = "mcp__" + first.server + "__" + unknownToolID + "_missing_tool";
    expect(restoredName(toolUse(unrecoverable), reverseMap)).toBe(unrecoverable);
    expect(reverseRemapOAuthToolNamesFromStreamLine(toolUseLine(unrecoverable), reverseMap)).toBe(toolUseLine(unrecoverable));
  });

  test("ReverseRemapOAuthToolNames_OverlappingSemanticSuffix", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"file"},{"name":"read_file"}]}`, "overlapping-caller");
    const fileAlias = parse(remapped).tools[0].name;
    const readFile = parseClaudeMCPAlias(parse(remapped).tools[1].name)!;
    expect(isClaudeMCPToolName(fileAlias)).toBe(true);
    const drifted = "mcp__" + readFile.server + "__" + readFile.toolID + "_" + readFile.toolID + "_read_file";
    expect(restoredName(toolUse(drifted), reverseMap)).toBe("read_file");
    expect(restoredName(toolUse(fileAlias), reverseMap)).toBe("file");
  });

  test("ReverseRemapOAuthToolNamesPreservesUnrelatedMCPName", () => {
    const { reverseMap } = remap(`{"tools":[{"name":"glob"}]}`, "unrelated-mcp-caller");
    expect(restoredName(toolUse("mcp__external__query"), reverseMap)).toBe("mcp__external__query");
  });

  test("ReverseRemapPassesThroughCallerMCPToolsOnVirtualServerCollision", () => {
    const secret = "virtual-server-collision";
    const server = claudeMCPToolAlias(secret, "probe", 0).split("__")[1]!;
    const native = ["mcp__" + server + "__read_file", "mcp__" + server + "__grep_read_file", "mcp__" + server + "__write_file"];
    const body = `{"tools":[{"name":"read_file","input_schema":{"type":"object"}},{"name":${JSON.stringify(native[0])}},{"name":${JSON.stringify(native[1])}},{"name":${JSON.stringify(native[2])}}]}`;
    const { body: upstream, reverseMap } = remap(body, secret);
    const alias = keyFor(reverseMap, "read_file");
    expect(alias).not.toBe("");
    native.forEach((name, index) => expect(parse(upstream).tools[index + 1].name).toBe(name));
    for (const name of native) {
      expect(restoredName(toolUse(name), reverseMap)).toBe(name);
      expect(restoredStreamName(toolUseLine(name), reverseMap)).toBe(name);
    }
    const toolPart = alias.split("__").slice(2).join("__");
    for (const drifted of [alias, "mcp__" + server + "__" + server + "__" + toolPart, "mcp__" + server + "__abandon_read_file"]) {
      expect(restoredName(toolUse(drifted), reverseMap)).toBe("read_file");
    }
  });

  test("RemapKeepsReverseMapEmptyWhenOnlyCallerMCPToolsArePresent", () => {
    const body = `{"tools":[{"name":"mcp__context7__query-docs"},{"type":"web_search_20250305","name":"web_search"}]}`;
    const { body: out, reverseMap } = remap(body, "no-proxied-tools");
    expect(reverseMap.size).toBe(0);
    expect(out).toBe(body);
  });

  test("ReverseRemapOAuthToolNamesFailsOpenOnTrailingMarkup", () => {
    const alias = "mcp__hmzqrngkulqv__xuo7jlxlpzee_clear_thinking";
    const malformed = alias + '</parameter>\n<parameter name="merge"';
    const reverseMap: ClaudeToolAliasMap = new Map([[alias, "clear_thinking"]]);
    expect(reverseRemapOAuthToolNames(toolUse(malformed), reverseMap)).toBe(toolUse(malformed));
    expect(reverseRemapOAuthToolNamesFromStreamLine(toolUseLine(malformed), reverseMap)).toBe(toolUseLine(malformed));
  });

  test("ClaudeMCPAliasRestoreErrorStaysRequestScoped", () => {
    expect(new ClaudeMCPAliasRestoreError("probe").requestScoped).toBe(true);
  });

  test("ReverseRemapOAuthToolNames_ToolSearchResult_NonStream", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"task_list","input_schema":{"type":"object"}},{"name":"fetch_url","input_schema":{"type":"object"}}]}`, "tool-search-caller");
    const taskAlias = parse(remapped).tools[0].name;
    const fetchAlias = parse(remapped).tools[1].name;
    expect(taskAlias).not.toBe("task_list");
    expect(fetchAlias).not.toBe("fetch_url");
    const resp = `{"id":"msg_01HczuyKgD1KCUuVzvZEH3WN","type":"message","role":"assistant","content":[{"type":"tool_search_tool_result","tool_use_id":"srvtoolu_01HczuyKgD1KCUuVzvZEH3WN","content":{"type":"tool_search_tool_search_result","tool_references":[{"type":"tool_reference","tool_name":${JSON.stringify(taskAlias)}},{"type":"tool_reference","tool_name":${JSON.stringify(fetchAlias)}}]}},{"type":"tool_use","id":"toolu_01","name":${JSON.stringify(taskAlias)},"input":{"action":"list"}}]}`;
    const restored = parse(reverseRemapOAuthToolNames(resp, reverseMap));
    expect(restored.content[0].content.tool_references[0].tool_name).toBe("task_list");
    expect(restored.content[0].content.tool_references[1].tool_name).toBe("fetch_url");
    expect(restored.content[1].name).toBe("task_list");
    const errorResp = `{"id":"msg_02","type":"message","role":"assistant","content":[{"type":"tool_search_tool_result","tool_use_id":"srvtoolu_02","content":{"type":"tool_search_tool_result_error","error_code":"regex_compilation_failed"}}]}`;
    expect(reverseRemapOAuthToolNames(errorResp, reverseMap)).toBe(errorResp);
  });

  test("ReverseRemapOAuthToolNamesFromStreamLine_ToolSearchResult_Stream", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"task_list","input_schema":{"type":"object"}}]}`, "tool-search-stream-caller");
    const taskAlias = parse(remapped).tools[0].name;
    const line = `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_search_tool_result","tool_use_id":"srvtoolu_01","content":{"type":"tool_search_tool_search_result","tool_references":[{"type":"tool_reference","tool_name":${JSON.stringify(taskAlias)}}]}}}`;
    const restored = reverseRemapOAuthToolNamesFromStreamLine(line, reverseMap);
    expect(restored.startsWith("data: ")).toBe(true);
    expect(parse(sseJSONPayload(restored)).content_block.content.tool_references[0].tool_name).toBe("task_list");
  });

  test("RemapOAuthToolNames_ToolSearchResultInMessageHistory", () => {
    const body = `{"tools":[{"name":"task_list","input_schema":{"type":"object"}},{"type":"advisor_20260301","name":"advisor","model":"claude-haiku-4-5-20251001"},{"type":"agent_toolset_20260401"}],"messages":[{"role":"assistant","content":[{"type":"tool_search_tool_result","tool_use_id":"srvtoolu_01","content":{"type":"tool_search_tool_search_result","tool_references":[{"type":"tool_reference","tool_name":"task_list"}]}}]}]}`;
    const { body: remapped, reverseMap } = remap(body, "history-caller");
    const taskAlias = keyFor(reverseMap, "task_list");
    expect(taskAlias).not.toBe("");
    const got = parse(remapped);
    expect(got.tools[1].type).toBe("advisor_20260301");
    expect(got.tools[1].name).toBe("advisor");
    expect(got.tools[2].type).toBe("agent_toolset_20260401");
    expect(got.messages[0].content[0].content.tool_references[0].tool_name).toBe(taskAlias);
  });

  describe("RemapOAuthToolNames_MidConversationToolChanges", () => {
    const tools =
      `[{"name":"read_file","description":"Read a file","input_schema":{"type":"object","properties":{}}},` +
      `{"name":"lookup_notes","description":"Look up notes","input_schema":{"type":"object","properties":{}},"defer_loading":true},` +
      `{"type":"web_search_20250305","name":"web_search"},` +
      `{"name":"mcp__context7__query-docs","input_schema":{"type":"object"}}]`;
    interface Check {
      path: string;
      original: string;
      aliased?: boolean;
    }
    const cases: Array<{ name: string; messages: string; checks: Check[] }> = [
      {
        name: "tool_addition reference to declared tool",
        messages: `[{"role":"user","content":"Reply with exactly: ok"},{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_reference","name":"lookup_notes"}}]}]`,
        checks: [{ path: "messages.1.content.0.tool.name", original: "lookup_notes", aliased: true }],
      },
      {
        name: "tool_removal reference to declared tool",
        messages: `[{"role":"user","content":"hi"},{"role":"system","content":[{"type":"tool_removal","tool":{"type":"tool_reference","name":"read_file"}}]}]`,
        checks: [{ path: "messages.1.content.0.tool.name", original: "read_file", aliased: true }],
      },
      {
        name: "mixed with text and tool_use history",
        messages: `[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]},{"role":"system","content":[{"type":"text","text":"Tools changed."},{"type":"tool_removal","tool":{"type":"tool_reference","name":"read_file"}},{"type":"tool_addition","tool":{"type":"tool_reference","name":"lookup_notes"}}]}]`,
        checks: [
          { path: "messages.1.content.0.name", original: "read_file", aliased: true },
          { path: "messages.3.content.0.text", original: "Tools changed." },
          { path: "messages.3.content.1.tool.name", original: "read_file", aliased: true },
          { path: "messages.3.content.2.tool.name", original: "lookup_notes", aliased: true },
        ],
      },
      {
        name: "undeclared server and caller MCP names unchanged",
        messages: `[{"role":"user","content":"hi"},{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_reference","name":"Bash"}},{"type":"tool_addition","tool":{"type":"tool_reference","name":"web_search"}},{"type":"tool_removal","tool":{"type":"tool_reference","name":"mcp__context7__query-docs"}}]}]`,
        checks: [
          { path: "messages.1.content.0.tool.name", original: "Bash" },
          { path: "messages.1.content.1.tool.name", original: "web_search" },
          { path: "messages.1.content.2.tool.name", original: "mcp__context7__query-docs" },
        ],
      },
      {
        name: "MCP connector references unchanged",
        messages: `[{"role":"user","content":"hi"},{"role":"system","content":[{"type":"tool_addition","tool":{"type":"mcp_tool_reference","server_name":"docs","name":"read_file"}},{"type":"tool_removal","tool":{"type":"mcp_toolset_reference","server_name":"read_file"}}]}]`,
        checks: [
          { path: "messages.1.content.0.tool.name", original: "read_file" },
          { path: "messages.1.content.1.tool.server_name", original: "read_file" },
        ],
      },
      {
        name: "inline definition redefining declared tool",
        messages: `[{"role":"user","content":"hi"},{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"lookup_notes","description":"v2","input_schema":{"type":"object"}}}}]}]`,
        checks: [{ path: "messages.1.content.0.tool.definition.name", original: "lookup_notes", aliased: true }],
      },
      {
        name: "inline definitions of undeclared or server tools unchanged",
        messages: `[{"role":"user","content":"hi"},{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"db_query","input_schema":{"type":"object"}}}},{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"type":"web_search_20260209","name":"read_file"}}},{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"type":"mcp_toolset","mcp_server_name":"calendar"}}}]}]`,
        checks: [
          { path: "messages.1.content.0.tool.definition.name", original: "db_query" },
          { path: "messages.1.content.1.tool.definition.name", original: "read_file" },
          { path: "messages.1.content.2.tool.definition.mcp_server_name", original: "calendar" },
        ],
      },
      {
        name: "malformed tool changes ignored",
        messages: `[{"role":"user","content":"hi"},{"role":"system","content":[{"type":"tool_addition"},{"type":"tool_addition","tool":"lookup_notes"},{"type":"tool_addition","tool":{"name":"lookup_notes"}},{"type":"tool_addition","tool":{"type":"tool_reference","tool_name":"lookup_notes"}},{"type":"tool_removal","tool":{"type":"tool_definition","definition":{"name":"lookup_notes"}}},{"type":"tool_addition","tool":{"type":"tool_reference","name":""}}]}]`,
        checks: [
          { path: "messages.1.content.1.tool", original: "lookup_notes" },
          { path: "messages.1.content.2.tool.name", original: "lookup_notes" },
          { path: "messages.1.content.3.tool.tool_name", original: "lookup_notes" },
          { path: "messages.1.content.4.tool.definition.name", original: "lookup_notes" },
          { path: "messages.1.content.5.tool.name", original: "" },
        ],
      },
    ];
    const at = (root: unknown, path: string): unknown => path.split(".").reduce<any>((cur, key) => (cur == null ? undefined : cur[key]), root);
    for (const c of cases) {
      test(c.name, () => {
        const body = `{"model":"claude-opus-5-5","max_tokens":64,"tools":${tools},"messages":${c.messages}}`;
        const { body: out, reverseMap } = remap(body, "tool-change-caller");
        const got = parse(out);
        const declared = new Map<string, string>();
        (parse(tools) as Array<{ name: string }>).forEach((tool, index) => declared.set(tool.name, got.tools[index].name));
        for (const check of c.checks) {
          let want = check.original;
          if (check.aliased) {
            want = declared.get(check.original)!;
            expect(want).not.toBe(check.original);
            expect(isClaudeMCPToolName(want)).toBe(true);
            expect(reverseMap.get(want)).toBe(check.original);
          }
          expect(String(at(got, check.path) ?? "")).toBe(want);
        }
        expect(got.tools[2].name).toBe("web_search");
        expect(got.tools[3].name).toBe("mcp__context7__query-docs");
      });
    }
  });

  test("ReverseRemapOAuthToolNamesRestoresHybridPassthroughMCPTools", () => {
    const virtual = "mcp__ripple_middle__";
    const reverseMap: ClaudeToolAliasMap = new Map([
      [virtual + "blanket_Bash", "Bash"],
      [virtual + "brand_Read", "Read"],
      ["mcp__acme__link_pull_request", "mcp__acme__link_pull_request"],
      ["mcp__acme__list_threads", "mcp__acme__list_threads"],
    ]);
    for (const hybrid of ["mcp__ripple_middle__link_pull_request", "mcp__ripple_middle__acme__link_pull_request"]) {
      expect(restoredName(toolUse(hybrid), reverseMap)).toBe("mcp__acme__link_pull_request");
      expect(restoredStreamName(toolUseLine(hybrid), reverseMap)).toBe("mcp__acme__link_pull_request");
    }
  });

  test("ReverseRemapOAuthToolNamesHybridPassthroughPrecedenceAndAmbiguity", () => {
    const virtual = "mcp__ripple_middle__";
    const precedence: ClaudeToolAliasMap = new Map([
      [virtual + "blanket_Bash", "Bash"],
      ["mcp__shell__Bash", "mcp__shell__Bash"],
    ]);
    expect(restoredName(toolUse(virtual + "Bash"), precedence)).toBe("Bash");
    const ambiguous: ClaudeToolAliasMap = new Map([
      [virtual + "blanket_other", "other"],
      ["mcp__srv1__query", "mcp__srv1__query"],
      ["mcp__srv2__query", "mcp__srv2__query"],
    ]);
    expect(() => reverseRemapOAuthToolNames(toolUse(virtual + "query"), ambiguous)).toThrow();
  });

  test("ReverseRemapOAuthToolNames_UndeclaredToolFailsOpen", () => {
    const { body: remapped, reverseMap } = remap(`{"tools":[{"name":"terminal","input_schema":{"type":"object"}}]}`, "undeclared-tool-caller");
    const parts = parseClaudeMCPAlias(parse(remapped).tools[0].name)!;
    expect(parts).toBeDefined();
    const undeclared = "mcp__" + parts.server + "__tiny_terminap";
    expect(restoredName(toolUse(undeclared), reverseMap)).toBe(undeclared);
    expect(reverseRemapOAuthToolNamesFromStreamLine(toolUseLine(undeclared), reverseMap)).toBe(toolUseLine(undeclared));
  });

  test("ReverseRemapRestoresCallerMCPToolWrappedInVirtualServer", () => {
    const recall = "mcp__docs-search__search-pages";
    const { reverseMap } = remap(`{"tools":[{"name":"Bash"},{"name":"${recall}"},{"name":"mcp__docs-search__search-issues"}]}`, "wrapped-passthrough-caller");
    const server = claudeMCPAliasServer(keyFor(reverseMap, "Bash"));
    expect(server).not.toBe("");
    for (const wrapped of ["mcp__" + server + "__search-pages", "mcp__" + server + "__" + recall]) {
      expect(restoredName(toolUse(wrapped), reverseMap)).toBe(recall);
      expect(restoredStreamName(toolUseLine(wrapped), reverseMap)).toBe(recall);
    }
  });

  test("ReverseRemapWrappedCallerMCPToolStaysAnErrorWhenAmbiguous", () => {
    const { reverseMap } = remap(`{"tools":[{"name":"Bash"},{"name":"mcp__a__query"},{"name":"mcp__b__query"}]}`, "wrapped-ambiguous-caller");
    const server = claudeMCPAliasServer(keyFor(reverseMap, "Bash"));
    expectRestoreError(() => reverseRemapOAuthToolNames(toolUse("mcp__" + server + "__query"), reverseMap), "matches multiple declared tools");
  });
});

describe("executor integration (cloaked OAuth)", () => {
  const oauth = () =>
    newAuth({ id: "mcp-alias-oauth", provider: "claude", attributes: { api_key: "sk-ant-oat-mcp-alias", cloak_mode: "always" }, metadata: claudeOAuthTestMetadata() });

  test("client tools go upstream as MCP aliases and come back with their names (execute and stream)", async () => {
    const { fetch, requests } = fakeFetch((req) => {
      const sent = JSON.parse(req.body);
      const alias = sent.tools[0].name as string;
      if (sent.stream) {
        const sse =
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_alias","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n` +
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"${alias}","input":{}}}\n\n` +
          `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n` +
          `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(`{"id":"msg_alias","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"toolu_1","name":"${alias}","input":{}}],"usage":{"input_tokens":1,"output_tokens":1}}`, {
        headers: { "Content-Type": "application/json" },
      });
    });
    const exec = createClaudeExecutor({ fetch });
    const payload = `{"model":"claude-opus-5","max_tokens":16,"tools":[{"name":"read_file","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"read it"}]}`;
    const req = { model: "claude-opus-5", payload, format: "claude" as const };

    const resp = await exec.execute(oauth(), req, claudeOpts());
    const sent = JSON.parse(requests[0]!.body);
    expect(isClaudeMCPToolName(sent.tools[0].name)).toBe(true);
    expect(sent.tools[0].name.endsWith("_read_file")).toBe(true);
    expect(JSON.parse(resp.payload).content[0].name).toBe("read_file");

    const stream = await exec.executeStream(oauth(), req, claudeOpts({ stream: true }));
    const chunks = (await drain(stream)).join("");
    expect(chunks).toContain(`"name":"read_file"`);
    expect(chunks).not.toContain("mcp__");
  });

  test("API key credentials without the CLI profile keep their tool names", async () => {
    const { fetch, requests } = fakeFetch(() => new Response(`{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":1,"output_tokens":1}}`, { headers: { "Content-Type": "application/json" } }));
    const exec = createClaudeExecutor({ fetch });
    const auth = newAuth({ id: "api-key", provider: "claude", attributes: { api_key: "sk-ant-api03-key", cloak_mode: "always" } });
    await exec.execute(auth, { model: "claude-opus-5", payload: `{"model":"claude-opus-5","max_tokens":16,"tools":[{"name":"read_file","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"x"}]}`, format: "claude" }, claudeOpts());
    expect(JSON.parse(requests[0]!.body).tools[0].name).toBe("read_file");
  });

  // Go: TestClaudeOAuthToolAliasStoreIsSharedAcrossForAPIKeyCopies.
  test("a thread continuation reuses the aliases its create request stored", async () => {
    let createAlias = "";
    const { fetch, requests } = fakeFetch((req) => {
      const sent = JSON.parse(req.body);
      if (Array.isArray(sent.tools)) createAlias = sent.tools[0].name;
      const id = sent.thread?.type === "create" ? "msg-shared" : "msg-next";
      return new Response(`{"id":"${id}","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"toolu_1","name":"${createAlias}","input":{}}],"usage":{"input_tokens":1,"output_tokens":1}}`, {
        headers: { "Content-Type": "application/json" },
      });
    });
    const exec = createClaudeExecutor({ fetch });
    const create = `{"model":"claude-opus-5","max_tokens":16,"thread":{"type":"create"},"tools":[{"name":"Read","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"go"}]}`;
    await exec.execute(oauth(), { model: "claude-opus-5", payload: create, format: "claude" }, claudeOpts());
    const continuation = `{"model":"claude-opus-5","max_tokens":16,"thread":{"type":"continue","previous_message_id":"msg-shared"},"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`;
    const resp = await exec.execute(oauth(), { model: "claude-opus-5", payload: continuation, format: "claude" }, claudeOpts());
    expect(requests.length).toBe(2);
    expect(JSON.parse(resp.payload).content[0].name).toBe("Read");

    const missing = `{"model":"claude-opus-5","max_tokens":16,"thread":{"type":"continue","previous_message_id":"msg-unknown"},"messages":[{"role":"user","content":"x"}]}`;
    let err: unknown;
    try {
      await exec.execute(oauth(), { model: "claude-opus-5", payload: missing, format: "claude" }, claudeOpts());
    } catch (e) {
      err = e;
    }
    expect((err as StatusError).statusCode).toBe(404);
    expect(requests.length).toBe(2);
  });
});

// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_tool_search_disabled_test.go
// Skipped cases: none. Golden comparisons are semantic (parsed JSON deep equality) rather than
// byte-for-byte: Go re-encoded echoed request values with sorted map keys and HTML escaping.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  convertClaudeResponseToOpenAIResponses,
  convertClaudeResponseToOpenAIResponsesNonStream,
  convertOpenAIResponsesRequestToClaudeResult,
  convertOpenAIResponsesRequestToClaudeWithToolSearch,
  clientToolSearchEnabled,
  clientToolSearchEnabledFor,
  withClientToolSearch,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext, type TranslateContext, type TranslatorState } from "../../../../../src/translator/types.ts";
import { get, withToolSearch } from "./helpers.ts";
import { codexSearchCall1, codexSearchOutput1, codexToolSearchRequest, codexUserTurn } from "./tool_search_fixtures.ts";

interface GoldenCase {
  name: string;
  request: unknown;
}
interface GoldenOutput {
  request: string;
  request_error?: string;
  stream: string[] | null;
  non_stream: string;
}

const dir = join(import.meta.dir, "../../../../fixtures/translator/claude/openai/responses/tool_search_disabled");
const fixtures = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { stream: string[]; cases: GoldenCase[] };
const golden = JSON.parse(readFileSync(join(dir, "dev_golden.json"), "utf8")) as Record<string, GoldenOutput>;
const createdAt = /"created_at":\d+/g;
const normalize = (raw: string): string => raw.replace(createdAt, `"created_at":0`);

function render(c: GoldenCase): GoldenOutput {
  const request = JSON.stringify(c.request);
  const { body, err } = convertOpenAIResponsesRequestToClaudeResult("claude-sonnet-4-5", request, true, false, clientToolSearchEnabled());
  const result: GoldenOutput = { request: body, stream: [], non_stream: "" };
  if (err) result.request_error = err.message;
  const state: TranslatorState = {};
  for (const chunk of fixtures.stream) {
    for (const output of convertClaudeResponseToOpenAIResponses(emptyContext, "claude-test", request, body, chunk, state)) result.stream!.push(normalize(output));
  }
  result.non_stream = normalize(convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "claude-test", request, body, fixtures.stream.join("\n"), undefined));
  return result;
}

const sseJSON = (frame: string): unknown => {
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  return { event: frame.split("\n")[0], data: data ? JSON.parse(data.slice(6)) : undefined };
};

test("golden has an entry per case", () => {
  expect(fixtures.cases.length).toBeGreaterThan(0);
  expect(Object.keys(golden).length).toBe(fixtures.cases.length);
});

describe("tool search disabled matches dev golden", () => {
  for (const c of fixtures.cases) {
    test(c.name, () => {
      const want = golden[c.name]!;
      const got = withToolSearch(false, () => render(c));
      expect(JSON.parse(got.request)).toEqual(JSON.parse(want.request));
      expect(got.request_error).toBe(want.request_error);
      expect(got.stream!.map(sseJSON)).toEqual((want.stream ?? []).map(sseJSON));
      expect(JSON.parse(got.non_stream)).toEqual(JSON.parse(want.non_stream));
    });
  }
});

test("tool search enabled differs from dev golden", () => {
  const c = fixtures.cases.find((x) => x.name === "codex_session")!;
  expect(c).toBeDefined();
  const got = withToolSearch(true, () => render(c));
  expect(JSON.parse(got.request)).not.toEqual(JSON.parse(golden[c.name]!.request));
});

test("pinned context wins over switch", () => {
  const session = fixtures.cases.find((x) => x.name === "codex_session")!;
  const request = JSON.stringify(session.request);
  const translate = (ctx: TranslateContext): string =>
    convertOpenAIResponsesRequestToClaudeWithToolSearch("claude-sonnet-4-5", request, true, clientToolSearchEnabledFor(ctx));
  const streamItemTypes = (ctx: TranslateContext, translated: string): string => {
    const state: TranslatorState = {};
    const types: string[] = [];
    for (const chunk of fixtures.stream) {
      for (const output of convertClaudeResponseToOpenAIResponses(ctx, "claude-test", request, translated, chunk, state)) {
        const data = (sseJSON(output) as { data: any }).data;
        if (data?.type === "response.output_item.done") types.push(data.item.type);
      }
    }
    return types.join(",");
  };
  const nonStreamFirstType = (ctx: TranslateContext, translated: string): string =>
    get(convertClaudeResponseToOpenAIResponsesNonStream(ctx, "claude-test", request, translated, fixtures.stream.join("\n"), undefined), "output.0.type");

  withToolSearch(false, () => {
    const pinnedOn = withClientToolSearch(emptyContext, true);
    expect((get(translate(pinnedOn), "tools") as any[]).some((t) => t.name === "tool_search")).toBe(true);
    expect(streamItemTypes(pinnedOn, translate(pinnedOn)).startsWith("tool_search_call,")).toBe(true);
    expect(nonStreamFirstType(pinnedOn, translate(pinnedOn))).toBe("tool_search_call");
  });
  withToolSearch(true, () => {
    const pinnedOff = withClientToolSearch(emptyContext, false);
    expect(JSON.parse(translate(pinnedOff))).toEqual(JSON.parse(golden[session.name]!.request));
    expect(streamItemTypes(pinnedOff, translate(pinnedOff))).not.toContain("tool_search_call");
    expect(nonStreamFirstType(pinnedOff, translate(pinnedOff))).toBe("function_call");
  });
});

test("compat context follows pin", () => {
  const request = codexToolSearchRequest(codexUserTurn, codexSearchCall1, codexSearchOutput1);
  for (const tc of [
    { global: false, pinned: true },
    { global: true, pinned: false },
  ]) {
    withToolSearch(tc.global, () => {
      const ctx = withClientToolSearch(emptyContext, tc.pinned);
      const out = convertOpenAIResponsesRequestToClaudeWithToolSearch("claude-sonnet-4-5", request, true, clientToolSearchEnabledFor(ctx), true);
      expect((get(out, "tools") as any[]).some((t) => t.name === "tool_search")).toBe(tc.pinned);
    });
  }
});

// Ported from: internal/translator/gemini/openai/responses/issue6258_terminal_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import type { TranslatorState } from "../../../../../src/translator/types.ts";
import { J, nonStream, parseSSEEvent, streamChunk } from "./helpers.ts";

const issue6258Usage = `{"promptTokenCount":100,"candidatesTokenCount":10,"thoughtsTokenCount":50,"totalTokenCount":160,"cachedContentTokenCount":7}`;

function translate(state: TranslatorState, frame: string): J[] {
  return streamChunk("gemini-3.7-flash", "", "", frame, state).map((c) => parseSSEEvent(c).data);
}

function terminalOf(events: J[]): J {
  let terminal = new J(undefined);
  let terminals = 0;
  let created = 0;
  let inProgress = 0;
  let previous = -1;
  const added = new Map<string, J>();
  const done = new Map<string, number>();
  let responseID = "";
  for (const event of events) {
    const seq = event.int("sequence_number");
    expect(seq).toBeGreaterThan(previous);
    previous = seq;
    const id = event.str("response.id");
    if (id !== "") {
      if (responseID !== "") expect(id).toBe(responseID);
      responseID = id;
    }
    switch (event.str("type")) {
      case "response.created":
        created++;
        break;
      case "response.in_progress":
        inProgress++;
        break;
      case "response.output_item.added":
        added.set(event.str("item.id"), event);
        break;
      case "response.output_item.done": {
        const itemID = event.str("item.id");
        done.set(itemID, (done.get(itemID) ?? 0) + 1);
        const start = added.get(itemID);
        expect(start?.int("output_index")).toBe(event.int("output_index"));
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        terminals++;
        terminal = event;
    }
  }
  expect(terminals).toBe(1);
  expect([created, inProgress]).toEqual([1, 1]);
  for (const itemID of added.keys()) expect([itemID, done.get(itemID)]).toEqual([itemID, 1]);
  terminal.arr("response.output").forEach((item, index) => {
    expect(added.get(item.str("id"))?.int("output_index")).toBe(index);
  });
  return terminal.get("response");
}

function assertUsage(response: J, input: number, output: number, reasoning: number, total: number, cached: number): void {
  const want: Record<string, number> = {
    input_tokens: input,
    output_tokens: output,
    "output_tokens_details.reasoning_tokens": reasoning,
    total_tokens: total,
    "input_tokens_details.cached_tokens": cached,
  };
  for (const [path, value] of Object.entries(want)) {
    expect(response.exists("usage." + path)).toBe(true);
    expect([path, response.int("usage." + path)]).toEqual([path, value]);
  }
}

function assertIncomplete(response: J): void {
  expect(response.str("status")).toBe("incomplete");
  expect(response.str("incomplete_details.reason")).toBe("max_output_tokens");
  expect(response.str("output.0.status")).toBe("incomplete");
  expect(response.str("output.0.content.0.text")).toBe("partial");
}

describe("TestIssue6258GeminiResponsesSplitStopUsage", () => {
  for (const wrapped of [false, true]) {
    for (const usageKey of ["usageMetadata", "cpaUsageMetadata"]) {
      test(`wrapped=${wrapped}/${usageKey}`, () => {
        const frame = (body: string): string => (wrapped ? `data: {"response":${body}}` : "data: " + body);
        const state: TranslatorState = {};
        const events = translate(state, frame(`{"responseId":"split-stop","candidates":[{"content":{"parts":[{"text":"answer"}]}}]}`));
        const finish = frame(`{"candidates":[{"content":{"parts":[{"text":" tail"}]},"finishReason":"STOP"}]}`);
        const beforeUsage = translate(state, finish);
        expect(beforeUsage.some((e) => e.str("type") === "response.completed")).toBe(false);
        events.push(...beforeUsage);
        const repeatedFinish = translate(state, frame(`{"candidates":[{"finishReason":"STOP"}]}`));
        expect(repeatedFinish.some((e) => e.str("type") === "response.completed")).toBe(false);
        events.push(...repeatedFinish);
        const afterUsage = translate(state, frame(`{"${usageKey}":${issue6258Usage}}`));
        expect(afterUsage.filter((e) => e.str("type") === "response.completed").length).toBe(1);
        events.push(...afterUsage);
        for (const repeated of [finish, "data: [DONE]", "data: [DONE]"]) events.push(...translate(state, repeated));
        const response = terminalOf(events);
        expect(response.str("status")).toBe("completed");
        expect(response.str("output.0.content.0.text")).toBe("answer tail");
        assertUsage(response, 100, 60, 50, 160, 7);
      });
    }
  }
});

describe("TestIssue6258GeminiResponsesMaxTokens", () => {
  for (const mode of ["same_frame", "split_usage", "no_usage_clean_done"]) {
    test("stream/" + mode, () => {
      const state: TranslatorState = {};
      const events = translate(state, `{"responseId":"max","candidates":[{"content":{"parts":[{"text":"partial"}]}}]}`);
      let finish = `{"candidates":[{"finishReason":"MAX_TOKENS"}]`;
      if (mode === "same_frame") finish += `,"usageMetadata":` + issue6258Usage;
      events.push(...translate(state, finish + "}"));
      if (mode === "split_usage") events.push(...translate(state, `{"usageMetadata":${issue6258Usage}}`));
      for (const frame of ["[DONE]", "[DONE]", finish + "}"]) events.push(...translate(state, frame));
      const response = terminalOf(events);
      for (const event of events) expect(["response.completed", "response.failed"]).not.toContain(event.str("type"));
      assertIncomplete(response);
      if (mode !== "no_usage_clean_done") assertUsage(response, 100, 60, 50, 160, 7);
    });
  }
  test("nonstream", () => {
    const raw = `{"responseId":"max","candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":${issue6258Usage}}`;
    const response = J.parse(nonStream("gemini-3.7-flash", "", "", raw));
    assertIncomplete(response);
    assertUsage(response, 100, 60, 50, 160, 7);
  });
});

describe("TestIssue6258GeminiResponsesUsageSnapshots", () => {
  for (const c of [
    { name: "absent_preserves", finishUsage: `{"candidatesTokenCount":12,"totalTokenCount":182}`, output: 62, reasoning: 50, total: 182 },
    { name: "explicit_zero_replaces", finishUsage: `{"candidatesTokenCount":12,"thoughtsTokenCount":0,"totalTokenCount":0}`, output: 12, reasoning: 0, total: 0 },
  ]) {
    test(c.name, () => {
      const state: TranslatorState = {};
      const events: J[] = [];
      for (const frame of [
        `{"responseId":"snapshots","candidates":[{"content":{"parts":[{"text":"answer"}]}}],"usageMetadata":${issue6258Usage}}`,
        `{"usageMetadata":${issue6258Usage}}`,
        `{"usageMetadata":{"promptTokenCount":120,"cachedContentTokenCount":0},"cpaUsageMetadata":{"promptTokenCount":999}}`,
        `{"candidates":[{"finishReason":"STOP"}],"usageMetadata":${c.finishUsage}}`,
        `[DONE]`,
      ])
        events.push(...translate(state, frame));
      assertUsage(terminalOf(events), 120, c.output, c.reasoning, c.total, 0);
    });
  }
});

test("TestIssue6258GeminiResponsesMaxTokensOnlyActiveMessageIncomplete", () => {
  const state: TranslatorState = {};
  const events: J[] = [];
  for (const frame of [
    `{"responseId":"mixed","candidates":[{"content":{"parts":[{"text":"preface"}]}}]}`,
    `{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-1","name":"lookup","args":{"key":"value"}}}]}}]}`,
    `{"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":${issue6258Usage}}`,
    `[DONE]`,
  ])
    events.push(...translate(state, frame));
  const response = terminalOf(events);
  const items = response.arr("output");
  expect(items.length).toBe(3);
  ["completed", "completed", "incomplete"].forEach((want, index) => {
    expect(items[index]!.str("status")).toBe(want);
    for (const event of events) {
      if (event.str("type") === "response.output_item.done" && event.int("output_index") === index) expect(event.str("item.status")).toBe(want);
    }
  });
});

describe("TestIssue6258GeminiResponsesDoneUsesUsageSnapshot", () => {
  for (const usageKey of ["usageMetadata", "cpaUsageMetadata"]) {
    test(usageKey, () => {
      const state: TranslatorState = {};
      const events: J[] = [];
      for (const frame of [
        `{"responseId":"snapshot-done","candidates":[{"content":{"parts":[{"text":"answer"}]}}],"${usageKey}":${issue6258Usage}}`,
        `{"${usageKey}":${issue6258Usage}}`,
        `{"candidates":[{"finishReason":"STOP"}]}`,
        `[DONE]`,
        `[DONE]`,
      ])
        events.push(...translate(state, frame));
      assertUsage(terminalOf(events), 100, 60, 50, 160, 7);
    });
  }
});

test("TestIssue6258GeminiResponsesSameFrameControl", () => {
  const state: TranslatorState = {};
  const events = translate(state, `{"responseId":"control","candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":${issue6258Usage}}`);
  events.push(...translate(state, "[DONE]"));
  assertUsage(terminalOf(events), 100, 60, 50, 160, 7);
});

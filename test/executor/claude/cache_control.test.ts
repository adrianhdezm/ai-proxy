// Ported from: internal/runtime/executor/claude_executor_test.go
// Skipped cases: this file holds the cache_control cases (TestNormalizeCacheControlTTL_*, TestEnforceCacheControlLimit_*,
// TestClaudeExecutor_NullCacheControlIgnored) and TestClaudeUsesLegacySystemReminder; byte identity is checked on the
// JSON string the helpers return.
import { describe, expect, test } from "bun:test";
import {
  countCacheControls,
  enforceCacheControlLimit,
  injectMessagesCacheControl,
  injectSystemCacheControl,
  injectToolsCacheControl,
  normalizeCacheControlTTL,
} from "../../../src/executor/claude/cache_control.ts";
import { claudeUsesLegacySystemReminder } from "../../../src/executor/claude/request_shape.ts";

const j = (s: string) => JSON.parse(s);

function expectKeyOrder(out: string): void {
  const idx = ["\"model\"", "\"messages\"", "\"tools\"", "\"system\""].map((k) => out.indexOf(k));
  for (const i of idx) expect(i).not.toBe(-1);
  expect(idx[0]! < idx[1]! && idx[1]! < idx[2]! && idx[2]! < idx[3]!).toBe(true);
}

describe("normalizeCacheControlTTL", () => {
  test("DowngradesLaterOneHourBlocks", () => {
    const out = j(
      normalizeCacheControlTTL(`{"tools":[{"name":"t1","cache_control":{"type":"ephemeral","ttl":"1h"}}],"system":[{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`),
    );
    expect(out.tools[0].cache_control.ttl).toBe("1h");
    expect(out.messages[0].content[0].cache_control.ttl).toBeUndefined();
  });

  test("PreservesOriginalBytesWhenNoChange", () => {
    const payload = `{"tools":[{"name":"t1","cache_control":{"type":"ephemeral","ttl":"1h"}}],"system":[{"type":"text","text":"<system-reminder>foo & bar</system-reminder>","cache_control":{"type":"ephemeral","ttl":"1h"}}],"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}`;
    expect(normalizeCacheControlTTL(payload)).toBe(payload);
  });

  test("PreservesKeyOrderWhenModified", () => {
    const out = normalizeCacheControlTTL(
      `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral","ttl":"1h"}}]}],"tools":[{"name":"t1","cache_control":{"type":"ephemeral"}}],"system":[{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}}]}`,
    );
    expect(j(out).messages[0].content[0].cache_control.ttl).toBeUndefined();
    expectKeyOrder(out);
  });
});

describe("enforceCacheControlLimit", () => {
  test("StripsNonLastToolBeforeMessages", () => {
    const out = enforceCacheControlLimit(
      `{"tools":[{"name":"t1","cache_control":{"type":"ephemeral"}},{"name":"t2","cache_control":{"type":"ephemeral"}}],"system":[{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":[{"type":"text","text":"u2","cache_control":{"type":"ephemeral"}}]}]}`,
      4,
    );
    expect(countCacheControls(out)).toBe(4);
    const o = j(out);
    expect(o.tools[0].cache_control).toBeUndefined();
    expect(o.tools[1].cache_control).toBeDefined();
    expect(o.messages[0].content[0].cache_control).toBeDefined();
    expect(o.messages[1].content[0].cache_control).toBeDefined();
  });

  test("PreservesKeyOrderWhenModified", () => {
    const out = enforceCacheControlLimit(
      `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral"}},{"type":"text","text":"u2","cache_control":{"type":"ephemeral"}}]}],"tools":[{"name":"t1","cache_control":{"type":"ephemeral"}},{"name":"t2","cache_control":{"type":"ephemeral"}}],"system":[{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}}]}`,
      4,
    );
    expect(countCacheControls(out)).toBe(4);
    expect(j(out).tools[0].cache_control).toBeUndefined();
    expectKeyOrder(out);
  });

  test("ReservesThreadMarker", () => {
    const out = enforceCacheControlLimit(
      `{"thread":{"type":"create"},"tools":[{"name":"t1","cache_control":{"type":"ephemeral"}}],"system":[{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}},{"type":"text","text":"s2","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral"}},{"type":"text","text":"u2","cache_control":{"type":"ephemeral"}}]}]}`,
      4,
    );
    expect(countCacheControls(out)).toBe(3);
  });

  test("ToolOnlyPayloadStillRespectsLimit", () => {
    const tools = [1, 2, 3, 4, 5].map((i) => `{"name":"t${i}","cache_control":{"type":"ephemeral"}}`).join(",");
    const out = enforceCacheControlLimit(`{"tools":[${tools}]}`, 4);
    expect(countCacheControls(out)).toBe(4);
    expect(j(out).tools[0].cache_control).toBeUndefined();
    expect(j(out).tools[4].cache_control).toBeDefined();
  });
});

test("ClaudeExecutor_NullCacheControlIgnored", () => {
  const nulls = [1, 2, 3, 4, 5].map((i) => `{"type":"text","text":"block ${i}","cache_control":null}`).join(",");
  const payload = `{"messages":[{"role":"user","content":[{"type":"text","text":"block 0","cache_control":{"type":"ephemeral"}},${nulls}]}]}`;
  expect(countCacheControls(payload)).toBe(1);
  const out = enforceCacheControlLimit(payload, 4);
  expect(countCacheControls(out)).toBe(1);
  expect(j(out).messages[0].content[0].cache_control.type).toBe("ephemeral");

  expect(j(injectToolsCacheControl(`{"tools":[{"name":"tool1","description":"desc","cache_control":null}]}`)).tools[0].cache_control.type).toBe("ephemeral");
  expect(j(injectSystemCacheControl(`{"system":[{"type":"text","text":"sys","cache_control":null}]}`)).system[0].cache_control.type).toBe("ephemeral");
  expect(j(injectMessagesCacheControl(`{"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":null}]}]}`)).messages[0].content[0].cache_control.type).toBe("ephemeral");

  const excess = enforceCacheControlLimit(
    `{"tools":[{"name":"t1","cache_control":{"type":"ephemeral"}},{"name":"t2","cache_control":null},{"name":"t3","cache_control":{"type":"ephemeral"}}],"system":[{"type":"text","text":"s1","cache_control":{"type":"ephemeral"}},{"type":"text","text":"s2","cache_control":null}],"messages":[{"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral"}},{"type":"text","text":"u2","cache_control":null},{"type":"text","text":"u3","cache_control":{"type":"ephemeral"}}]}]}`,
    4,
  );
  expect(countCacheControls(excess)).toBe(4);
  expect(j(excess).tools[0].cache_control).toBeUndefined();
  expect(j(excess).tools[2].cache_control).toBeDefined();

  const normalized = normalizeCacheControlTTL(`{"system":[{"type":"text","text":"sys0","cache_control":null},{"type":"text","text":"sys1","cache_control":{"type":"ephemeral","ttl":"1h"}}]}`);
  expect(j(normalized).system[1].cache_control.ttl).toBe("1h");
});

test("ClaudeUsesLegacySystemReminder", () => {
  const cases: Record<string, boolean> = {
    "claude-opus-4-6": true,
    "claude-opus-4-7": true,
    "claude-sonnet-5": false,
    "prefix/claude-sonnet-4-6": true,
    "claude-3-5-haiku-latest": true,
    "claude-opus-5": false,
    "prefix/claude-opus-4-8": false,
    "claude-fable-5": false,
    "claude-future-6": false,
    "": false,
  };
  for (const [model, want] of Object.entries(cases)) expect(claudeUsesLegacySystemReminder(`{"model":${JSON.stringify(model)}}`), model).toBe(want);
});

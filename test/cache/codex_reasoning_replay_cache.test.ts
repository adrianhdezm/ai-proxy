// Ported from: internal/cache/codex_reasoning_replay_cache_test.go
// Skipped cases: TestCodexReasoningReplayRequiredHomeReadAndSlidingExpire, TestCodexReasoningReplayRequiredHomeFailures,
//   TestCodexReasoningReplayBestEffortHomeWriteFailureDoesNotUseLocalCache, TestCodexReasoningReplayAppendPreservesCumulativeTurnsInHome,
//   TestCodexReasoningReplayAppendHomeCASPreservesConcurrentTurns, TestCodexReasoningReplayHomeRejectsEmptyScopeWithoutKV
//   (Home KV backend not ported). Added: TTL expiry with an injected clock, sliding refresh on read, append dedupe of a turn id.
import { describe, expect, test } from "bun:test";
import {
  CodexReasoningReplayCache,
  CodexReasoningReplayCacheMaxEntries,
  CodexReasoningReplayCacheMaxTurnsPerEntry,
  CodexReasoningReplayCacheTTLMs,
  CodexReasoningReplayTurnType,
  trimCodexReasoningReplayItems,
} from "../../src/cache/codex_reasoning_replay_cache.ts";

/** Go: validCodexReasoningReplayEncryptedContentForTest (a Fernet-shaped GPT signature). */
export function validEncryptedContent(seed: number): string {
  const payload = new Uint8Array(1 + 8 + 16 + 16 + 32);
  payload[0] = 0x80;
  for (let i = 9; i < payload.length; i++) payload[i] = (seed + i) & 0xff;
  return Buffer.from(payload).toString("base64url");
}

function reasoningItem(seed: number): string {
  return `{"type":"reasoning","summary":[],"content":null,"encrypted_content":"${validEncryptedContent(seed)}"}`;
}

test("TestCodexReasoningReplayCacheRejectsInvalidItems", () => {
  const cache = new CodexReasoningReplayCache();
  expect(cache.cacheItem("gpt-5.4", "session", `{"type":"reasoning","encrypted_content":"bad","summary":[]}`)).toBe(false);
  expect(cache.getItem("gpt-5.4", "session")).toBeUndefined();
});

test("TestCodexReasoningReplayAppendBoundsTurnsPerEntry", () => {
  const items: string[] = [];
  for (let turn = 0; turn <= CodexReasoningReplayCacheMaxTurnsPerEntry; turn++) {
    items.push(`{"type":"${CodexReasoningReplayTurnType}","id":"turn-${turn}"}`, reasoningItem(50 + turn));
  }
  const trimmed = trimCodexReasoningReplayItems(items);
  expect(trimmed.length).toBe(CodexReasoningReplayCacheMaxTurnsPerEntry * 2);
  expect(JSON.parse(trimmed[0]!).id).toBe("turn-1");
});

test("TestCodexReasoningReplayCacheScopesByModelAndSession", () => {
  const cache = new CodexReasoningReplayCache();
  const encrypted = validEncryptedContent(7);
  const item = `{"type":"reasoning","summary":[],"content":null,"encrypted_content":"${encrypted}"}`;
  expect(cache.cacheItem("gpt-5.4", "session-a", item)).toBe(true);
  expect(cache.getItem("gpt-5.5", "session-a")).toBeUndefined();
  expect(cache.getItem("gpt-5.4", "session-b")).toBeUndefined();
  expect(cache.getItem("gpt-5.4", "session-a")).toBe(item);
});

test("TestCodexReasoningReplayCacheBatchEvictsWhenFull", () => {
  const cache = new CodexReasoningReplayCache();
  const item = reasoningItem(9);
  for (let i = 0; i <= CodexReasoningReplayCacheMaxEntries; i++) expect(cache.cacheItem("gpt-5.4", `session-${i}`, item)).toBe(true);
  expect(cache.size).toBeLessThan(CodexReasoningReplayCacheMaxEntries);
  // The least recently used sessions went first.
  expect(cache.getItem("gpt-5.4", "session-0")).toBeUndefined();
  expect(cache.getItem("gpt-5.4", `session-${CodexReasoningReplayCacheMaxEntries}`)).toBe(item);
});

describe("TTL (injected clock)", () => {
  test("an entry expires after the TTL and reads slide it", () => {
    let now = 1_000_000;
    const cache = new CodexReasoningReplayCache({ now: () => now });
    const item = reasoningItem(3);
    cache.cacheItem("gpt-5.4", "s", item);
    now += CodexReasoningReplayCacheTTLMs - 1;
    expect(cache.getItem("gpt-5.4", "s")).toBe(item);
    now += CodexReasoningReplayCacheTTLMs; // within the TTL of the read above
    expect(cache.getItem("gpt-5.4", "s")).toBe(item);
    now += CodexReasoningReplayCacheTTLMs + 1;
    expect(cache.getItem("gpt-5.4", "s")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("an append to an expired entry starts over; purgeExpired drops stale sessions only", () => {
    let now = 0;
    const cache = new CodexReasoningReplayCache({ now: () => now });
    const marker = (id: string) => `{"type":"${CodexReasoningReplayTurnType}","id":"${id}"}`;
    cache.appendItems("m", "old", [marker("t1"), reasoningItem(1)]);
    now += CodexReasoningReplayCacheTTLMs + 1;
    cache.appendItems("m", "old", [marker("t2"), reasoningItem(2)]);
    expect(cache.getItems("m", "old")!.map((i) => JSON.parse(i).id ?? "item")).toEqual(["t2", "item"]);
    cache.appendItems("m", "fresh", [marker("t3"), reasoningItem(3)]);
    now += CodexReasoningReplayCacheTTLMs; // "old" was read at the previous tick, "fresh" written then too
    cache.getItems("m", "fresh");
    now += 2;
    cache.purgeExpired();
    expect(cache.getItems("m", "old")).toBeUndefined();
    expect(cache.getItems("m", "fresh")).toBeDefined();
  });

  test("appending the same turn id twice keeps one copy", () => {
    const cache = new CodexReasoningReplayCache();
    const turn = [`{"type":"${CodexReasoningReplayTurnType}","id":"same"}`, reasoningItem(4)];
    cache.appendItems("m", "s", turn);
    cache.appendItems("m", "s", turn);
    expect(cache.getItems("m", "s")!.length).toBe(2);
  });
});

// Ported from: internal/cache/claude_web_search_result_cache_test.go
// Skipped cases: TestClaudeWebSearchResultCacheHomeModeDoesNotUseLocalCache,
//   TestClaudeWebSearchResultCacheHomeWriteReadAndSlidingExpire,
//   TestClaudeWebSearchResultCacheHomeRejectsEmptyScopeAndPropagatesErrors (Home KV backend not ported; the
//   empty-scope rejection of the last one is covered locally below).
import { expect, test } from "bun:test";
import { ClaudeWebSearchResultCache } from "../../src/cache/claude_web_search_result_cache.ts";

const minute = 60_000;

function newCache() {
  let now = 1_800_000_000_000;
  const cache = new ClaudeWebSearchResultCache({ now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

test("TestClaudeWebSearchResultCacheScopesBySessionAndToolUse", () => {
  const { cache } = newCache();
  cache.set("session-a", "srvtoolu_1", `[{"url":"a"}]`, 30 * minute, 16);
  expect(cache.get("session-a", "srvtoolu_1")).toBe(`[{"url":"a"}]`);
  expect(cache.get("session-b", "srvtoolu_1")).toBeUndefined();
  expect(cache.get("session-a", "srvtoolu_2")).toBeUndefined();
  expect(cache.get("", "srvtoolu_1")).toBeUndefined();
});

test("TestClaudeWebSearchResultCacheExpiresAndSlides", () => {
  const { cache, advance } = newCache();
  const ttl = 30 * minute;
  cache.set("s", "srvtoolu_1", "[1]", ttl, 16);
  advance(ttl - minute);
  expect(cache.get("s", "srvtoolu_1", ttl)).toBe("[1]");
  // The read above extended the lifetime.
  advance(ttl - minute);
  expect(cache.get("s", "srvtoolu_1", ttl)).toBe("[1]");
  advance(ttl);
  expect(cache.get("s", "srvtoolu_1", ttl)).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("TestClaudeWebSearchResultCacheEnforcesEntryLimitWithoutByteCap", () => {
  const { cache } = newCache();
  const limit = 4;
  const longSession = "s".repeat(4096);
  // Large payloads are not rejected by a byte limit; only the entry limit applies.
  const large = "a".repeat(5 << 20);
  cache.set("s", "large", large, 60 * minute, limit);
  expect(cache.get("s", "large")?.length).toBe(large.length);

  for (let i = 0; i < limit + 10; i++) cache.set(longSession + i, "srvtoolu_" + i, "[1]", 60 * minute, limit);
  expect(cache.size).toBe(limit);
  for (const key of cache.keys()) expect(key).toHaveLength(64);
  const last = limit + 9;
  expect(cache.get(longSession + last, "srvtoolu_" + last)).toBe("[1]");
  expect(cache.get(longSession + "0", "srvtoolu_0")).toBeUndefined();

  cache.set(longSession + last, "srvtoolu_" + last, "[2]", 60 * minute, limit);
  expect(cache.get(longSession + last, "srvtoolu_" + last)).toBe("[2]");
});

test("TestClaudeWebSearchResultCachePurgesExpiredBeforeEvictingLiveEntries", () => {
  const { cache, advance } = newCache();
  cache.set("s", "short", "[1]", 5 * minute, 2);
  cache.set("s", "long", "[2]", 30 * minute, 2);
  // Touch "short" so "long" is the LRU tail, then advance past "short"'s TTL.
  cache.get("s", "short", 5 * minute);
  advance(10 * minute);
  cache.set("s", "new", "[3]", 30 * minute, 2);
  expect(cache.get("s", "long")).toBe("[2]");
  expect(cache.get("s", "new")).toBe("[3]");
});

test("TestClaudeWebSearchResultCacheHomeRejectsEmptyScopeAndPropagatesErrors (local part)", () => {
  const { cache } = newCache();
  expect(cache.set("", "srvtoolu_1", "[1]", minute, 16)).toBe(false);
  expect(cache.set("s", "", "[1]", minute, 16)).toBe(false);
  expect(cache.set("s", "srvtoolu_1", "", minute, 16)).toBe(false);
  expect(cache.size).toBe(0);
  // A zero TTL and limit fall back to the defaults (24h, 1024 entries).
  expect(cache.set("s", "srvtoolu_1", "[1]", 0, 0)).toBe(true);
  expect(cache.get("s", "srvtoolu_1")).toBe("[1]");
});

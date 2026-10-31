// Ported from: internal/cache/bounded_lru_test.go
// Skipped cases: TestBoundedLRUCreatesOneValuePerKeyConcurrently is reduced to the
//   single-threaded guarantee (one create per key); JS has no concurrent callers.
import { expect, test } from "bun:test";
import { BoundedLRU } from "../../src/cache/bounded_lru.ts";

test("evicts the least recently used entry", () => {
  const evicted: string[] = [];
  const cache = new BoundedLRU<string, string>(2, (k, v) => evicted.push(`${k}=${v}`));
  expect(cache.getOrAdd("a", () => "A")).toBe("A");
  cache.getOrAdd("b", () => "B");
  expect(cache.get("a")).toBe("A");
  cache.getOrAdd("c", () => "C");
  expect(cache.get("b")).toBeUndefined();
  expect(cache.size).toBe(2);
  expect(evicted).toEqual(["b=B"]);
});

test("creates one value per key", () => {
  const cache = new BoundedLRU<string, number>(2);
  let creates = 0;
  expect(cache.getOrAdd("key", () => (creates++, 42))).toBe(42);
  expect(cache.getOrAdd("key", () => (creates++, 7))).toBe(42);
  expect(creates).toBe(1);
});

test("delete runs the eviction callback; capacity below 1 is clamped", () => {
  const evicted: string[] = [];
  const cache = new BoundedLRU<string, number>(0, (k) => evicted.push(k));
  cache.getOrAdd("a", () => 1);
  cache.getOrAdd("b", () => 2);
  expect(evicted).toEqual(["a"]);
  expect(cache.delete("b")).toBe(true);
  expect(cache.delete("b")).toBe(false);
  expect(evicted).toEqual(["a", "b"]);
});

// Ported from: internal/cache/claude_thinking_replay_cache_test.go
// Skipped cases: the Home KV fake client of TestClaudeThinkingReplayAppendsAssistantTurns is replaced by the local
// cache (Home KV is not ported); TestClaudeThinkingReplayClearDoesNotClearKimiState keeps only the Claude half (the
// Kimi replay cache is not ported), checking that clear() isolates per cache instance. TTL, snapshot and byte-budget
// cases below are additional coverage of the local mode with an injected clock.
import { expect, test } from "bun:test";
import { ClaudeThinkingReplayCache, ClaudeThinkingReplayCacheTTLMs } from "../../src/cache/claude_thinking_replay_cache.ts";

const modelFamily = "claude:auth:model";
const sessionKey = "execution:multi-turn";
const first = `[{"type":"thinking","thinking":"first","signature":"sig-1"},{"type":"tool_use","id":"toolu-1","name":"Read","input":{"path":"one"}}]`;
const second = `[{"type":"thinking","thinking":"second","signature":"sig-2"},{"type":"tool_use","id":"toolu-2","name":"Read","input":{"path":"two"}}]`;

test("ClaudeThinkingReplayAppendsAssistantTurns", () => {
  const cache = new ClaudeThinkingReplayCache();
  expect(cache.cacheBestEffort(modelFamily, sessionKey, first)).toBe(true);
  const read = cache.getWithSnapshot(modelFamily, sessionKey);
  expect(read.found).toBe(true);
  expect(cache.replaceIfUnchanged(modelFamily, sessionKey, read.snapshot, second)).toBe(true);
  const { contents, found } = cache.get(modelFamily, sessionKey);
  expect(found).toBe(true);
  expect(contents).toEqual([first, second]);
});

test("ClaudeThinkingReplayClearIsScopedToItsCache", () => {
  const other = new ClaudeThinkingReplayCache();
  const cache = new ClaudeThinkingReplayCache();
  const otherContent = `[{"type":"thinking","signature":"kimi"}]`;
  const content = `[{"type":"thinking","signature":"claude"}]`;
  expect(other.cacheBestEffort("shared-model", "execution:shared-session", otherContent)).toBe(true);
  expect(cache.cacheBestEffort("shared-model", "execution:shared-session", content)).toBe(true);
  cache.clear();
  expect(other.get("shared-model", "execution:shared-session")).toEqual({ contents: [otherContent], found: true });
  expect(cache.get("shared-model", "execution:shared-session")).toEqual({ contents: [], found: false });
});

test("stale snapshot cannot replace or delete newer state", () => {
  const cache = new ClaudeThinkingReplayCache();
  const a = cache.getWithSnapshot(modelFamily, sessionKey);
  const b = cache.getWithSnapshot(modelFamily, sessionKey);
  expect(cache.replaceIfUnchanged(modelFamily, sessionKey, b.snapshot, first)).toBe(true);
  expect(cache.replaceIfUnchanged(modelFamily, sessionKey, a.snapshot, second)).toBe(false);
  expect(cache.deleteIfUnchanged(modelFamily, sessionKey, a.snapshot)).toBe(false);
  expect(cache.get(modelFamily, sessionKey).contents).toEqual([first]);
  const c = cache.getWithSnapshot(modelFamily, sessionKey);
  expect(cache.deleteIfUnchanged(modelFamily, sessionKey, c.snapshot)).toBe(true);
  expect(cache.get(modelFamily, sessionKey).found).toBe(false);
});

test("entries expire after the TTL on the injected clock and duplicates are not appended", () => {
  let t = 0;
  const cache = new ClaudeThinkingReplayCache({ now: () => t });
  cache.cacheBestEffort(modelFamily, sessionKey, first);
  const read = cache.getWithSnapshot(modelFamily, sessionKey);
  expect(cache.replaceIfUnchanged(modelFamily, sessionKey, read.snapshot, first.replace(`"thinking":"first"`, ` "thinking" : "first"`))).toBe(true);
  expect(cache.get(modelFamily, sessionKey).contents).toHaveLength(1);
  t += ClaudeThinkingReplayCacheTTLMs + 1;
  expect(cache.get(modelFamily, sessionKey).found).toBe(false);
});

test("invalid content and empty keys are rejected; byte budget evicts least recent sessions", () => {
  const cache = new ClaudeThinkingReplayCache({ maxTotalBytes: first.length * 2 + 10 });
  expect(cache.cacheBestEffort("", sessionKey, first)).toBe(false);
  expect(cache.cacheBestEffort(modelFamily, "", first)).toBe(false);
  expect(cache.cacheBestEffort(modelFamily, sessionKey, "[]")).toBe(false);
  expect(cache.cacheBestEffort(modelFamily, sessionKey, "{}")).toBe(false);
  cache.cacheBestEffort(modelFamily, "s1", first);
  cache.cacheBestEffort(modelFamily, "s2", first);
  cache.cacheBestEffort(modelFamily, "s3", first);
  expect(cache.get(modelFamily, "s1").found).toBe(false);
  expect(cache.get(modelFamily, "s3").found).toBe(true);
  expect(cache.bytes).toBeLessThanOrEqual(first.length * 2 + 10);
});

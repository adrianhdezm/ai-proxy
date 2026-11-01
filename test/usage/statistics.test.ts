// New (no upstream test): the in-memory aggregator behind GET /v0/usage (port of the v6
// RequestStatistics snapshot shape) with the port's breakdowns, bounded history and `since`.
import { expect, test } from "bun:test";
import { parseClaudeUsage } from "../../src/usage/claude.ts";
import { parseSince } from "../../src/usage/http.ts";
import { UsageStatistics } from "../../src/usage/statistics.ts";

const t0 = Date.parse("2026-10-28T10:15:00Z");

function seeded(historyLimit?: number) {
  let now = t0;
  const stats = new UsageStatistics({ enabled: true, historyLimit, now: () => now });
  const at = (ms: number) => (now = ms);
  return { stats, at };
}

test("snapshot aggregates totals and per-day/hour/model/credential/client-key buckets", () => {
  const { stats } = seeded();
  stats.record({
    timestamp: t0,
    provider: "claude",
    model: "claude-opus-5",
    authId: "auth-a",
    authIndex: "team",
    clientKey: "sk-client-aaaaaaaa1111",
    detail: parseClaudeUsage(`{"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}`),
  });
  stats.record({
    timestamp: t0 + 3600_000,
    provider: "codex",
    model: "gpt-5.4",
    authId: "auth-b",
    clientKey: "sk-client-aaaaaaaa1111",
    detail: parseClaudeUsage(`{"usage":{"input_tokens":1,"output_tokens":1}}`),
  });
  stats.record({ timestamp: t0 + 86_400_000, provider: "claude", model: "claude-opus-5", authId: "auth-a", failed: true, fail: { statusCode: 429 }, endpoint: "POST /v1/messages" });

  const snap = stats.snapshot();
  const u = snap.usage;
  expect(u.total_requests).toBe(3);
  expect(u.success_count).toBe(2);
  expect(u.failure_count).toBe(1);
  expect(snap.failed_requests).toBe(1);
  expect(u.total_tokens).toBe(22);
  expect(u.tokens).toEqual({ input_tokens: 11, output_tokens: 6, reasoning_tokens: 0, cached_tokens: 3, cache_read_tokens: 3, cache_creation_tokens: 2, total_tokens: 22 });
  expect(u.requests_by_day).toEqual({ "2026-10-28": 2, "2026-10-29": 1 });
  expect(u.requests_by_hour).toEqual({ "10": 2, "11": 1 });
  expect(u.tokens_by_day).toEqual({ "2026-10-28": 22, "2026-10-29": 0 });
  expect(u.tokens_by_hour).toEqual({ "10": 20, "11": 2 });
  expect(u.models["claude-opus-5"]).toMatchObject({ total_requests: 2, success_count: 1, failure_count: 1, total_tokens: 20 });
  expect(u.providers.codex).toMatchObject({ total_requests: 1, total_tokens: 2 });
  expect(u.credentials["auth-a"]).toMatchObject({ provider: "claude", label: "team", total_requests: 2, failure_count: 1 });
  // client-key map: masked key, or "METHOD path" when the request had none (Go: resolveAPIIdentifier)
  expect(Object.keys(u.apis).sort()).toEqual(["POST /v1/messages", "sk-c...1111"]);
  const api = u.apis["sk-c...1111"]!;
  expect(api.total_requests).toBe(2);
  expect(api.models["claude-opus-5"]!.details).toHaveLength(1);
  expect(api.models["claude-opus-5"]!.details[0]).toMatchObject({ auth_id: "auth-a", auth_index: "team", failed: false, fail: { status_code: 200 }, tokens: { total_tokens: 20 } });
  expect(snap.recent_requests.map((r) => r.model)).toEqual(["claude-opus-5", "gpt-5.4", "claude-opus-5"]);
  expect(snap.recent_requests[2]!.fail).toEqual({ status_code: 429 });
  expect(JSON.stringify(snap)).not.toContain("sk-client-aaaaaaaa1111");
});

test("history is bounded while cumulative counters keep counting", () => {
  const { stats } = seeded(2);
  for (let i = 0; i < 5; i++) stats.record({ timestamp: t0 + i * 1000, model: `m${i}` });
  const snap = stats.snapshot();
  expect(snap.usage.total_requests).toBe(5);
  expect(snap.history_limit).toBe(2);
  expect(snap.recent_requests.map((r) => r.model)).toEqual(["m3", "m4"]);
  expect(snap.usage.apis.unknown!.models.m0!.details).toEqual([]);
});

test("since computes every aggregate from the history and reports completeness", () => {
  const { stats } = seeded(3);
  for (let i = 0; i < 5; i++) stats.record({ timestamp: t0 + i * 1000, model: "m", failed: i === 4 });
  const recent = stats.snapshot({ since: t0 + 3000 });
  expect(recent.usage.total_requests).toBe(2);
  expect(recent.failed_requests).toBe(1);
  expect(recent.since).toBe(new Date(t0 + 3000).toISOString());
  expect(recent.history_complete).toBe(true);
  const old = stats.snapshot({ since: t0 });
  expect(old.usage.total_requests).toBe(3);
  expect(old.history_complete).toBe(false);
});

test("reset clears aggregates and history", () => {
  const { stats } = seeded();
  stats.record({ model: "m" });
  stats.reset();
  expect(stats.snapshot().usage.total_requests).toBe(0);
  expect(stats.recent()).toEqual([]);
});

test("parseSince accepts RFC 3339 and epoch seconds/milliseconds", () => {
  expect(parseSince(null)).toBeUndefined();
  expect(parseSince("")).toBeUndefined();
  expect(parseSince("2026-10-28T10:15:00Z")).toBe(t0);
  expect(parseSince(String(t0 / 1000))).toBe(t0);
  expect(parseSince(String(t0))).toBe(t0);
  expect(Number.isNaN(parseSince("yesterday"))).toBe(true);
});

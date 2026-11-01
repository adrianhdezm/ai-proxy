// Ported from: sdk/cliproxy/usage/manager_test.go
// Skipped cases: TestStreamFromContextDefaultsMissingToFalse, TestStreamFromContextHonorsExplicitTrue,
//   TestGenerateFromContextDefaultsMissingToTrue, TestGenerateFromContextHonorsExplicitFalse,
//   TestAccessProviderAndIsNativeKeyFromContext (Go context plumbing; the port passes values explicitly),
//   TestRecordBaseURLField (no base URL on records), TestGenerateEnabledDefaultsNilToTrue,
//   TestGenerateEnabledHonorsExplicitFalse, TestGenerateEnabledHonorsExplicitTrue,
//   TestRecordOmittedGenerateIsEnabled (no generate flag: Claude Messages always generates),
//   TestIsNativeAccessProvider (no pluggable access providers in the port)
import { expect, test } from "bun:test";
import { maskClientKey } from "../../src/usage/record.ts";
import { UsageStatistics } from "../../src/usage/statistics.ts";

const fixedNow = Date.parse("2026-10-28T12:34:56Z");

test("RecordStreamField", () => {
  const stats = new UsageStatistics({ enabled: true, now: () => fixedNow });
  const record = stats.record({ provider: "codex", model: "gpt-5.4", stream: true });
  expect(record!.stream).toBe(true);
});

test("RecordNativeKeyFields (adapted): the inbound client key is stored masked", () => {
  const stats = new UsageStatistics({ enabled: true, now: () => fixedNow });
  const record = stats.record({ provider: "codex", model: "gpt-5.4", clientKey: "sk-test-123456789" });
  expect(record!.apiKey).toBe("sk-t...6789");
  expect(JSON.stringify(stats.snapshot())).not.toContain("sk-test-123456789");
  expect(maskClientKey("short")).toBe("****");
  expect(maskClientKey("")).toBe("");
});

test("ManagerPublishBackfillsContextAuthFields (adapted): record() back-fills request id, timestamp and defaults", () => {
  let ids = 0;
  const stats = new UsageStatistics({ enabled: true, now: () => fixedNow, newId: () => `req-${++ids}` });
  const record = stats.record({ model: "claude-opus-5", clientKey: "sk-ctx-key-abcdef" });
  expect(record!.requestId).toBe("req-1");
  expect(record!.timestamp).toBe(fixedNow);
  expect(record!.provider).toBe("unknown");
  expect(record!.alias).toBe("claude-opus-5");
  expect(record!.apiKey).toBe("sk-c...cdef");
  expect(record!.fail.statusCode).toBe(200);
  const explicit = stats.record({ requestId: "given", model: "m", timestamp: fixedNow - 1000, failed: true });
  expect(explicit!.requestId).toBe("given");
  expect(explicit!.timestamp).toBe(fixedNow - 1000);
  expect(explicit!.fail.statusCode).toBe(500);
});

test("disabled statistics discard records (Go: statisticsEnabled=false)", () => {
  const stats = new UsageStatistics({ enabled: false, now: () => fixedNow });
  expect(stats.record({ model: "m" })).toBeUndefined();
  expect(stats.snapshot().usage.total_requests).toBe(0);
  stats.setEnabled(true);
  expect(stats.record({ model: "m" })).toBeDefined();
  stats.setEnabled(false);
  expect(stats.record({ model: "m" })).toBeUndefined();
  expect(stats.snapshot().usage.total_requests).toBe(1);
});

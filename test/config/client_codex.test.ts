// Ported from: internal/config/client_test.go
// Skipped cases: TestClientCodexEnableApplyPatch, TestClientCodexEnableApplyPatchSave (the apply_patch bridge is not
//   carried), TestClientCodexWebSearchResultCacheSave and the SDKConfig/JSON round-trip/NormalizeConfigLayout halves
//   of TestClientCodexWebSearchResultCache (config writing, JSON config and v8 migration not carried), the
//   "{unknown: true}" invalid row (this port warns about unknown keys instead of rejecting them).
import { describe, expect, test } from "bun:test";
import { DefaultWebSearchResultCacheLimit, DefaultWebSearchResultCacheTTLMs, parseConfig } from "../../src/config/load.ts";

const opts = { env: {}, home: "/home/tester", warn: () => {} };
const minute = 60_000;

describe("TestClientCodexWebSearchResultCache", () => {
  for (const tc of [
    { name: "omitted", raw: "config-version: 8\n", enabled: false, ttl: DefaultWebSearchResultCacheTTLMs, limit: DefaultWebSearchResultCacheLimit },
    { name: "enabled with integer seconds ttl", raw: "client: {codex: {web-search-result-cache: {enabled: true, ttl: 1800, limit: 64}}}\n", enabled: true, ttl: 30 * minute, limit: 64 },
    { name: "enabled with 30m ttl", raw: "client: {codex: {web-search-result-cache: {enabled: true, ttl: 30m, limit: 128}}}\n", enabled: true, ttl: 30 * minute, limit: 128 },
    { name: "disabled with 24h ttl", raw: "client: {codex: {web-search-result-cache: {enabled: false, ttl: 24h, limit: 1024}}}\n", enabled: false, ttl: 24 * 60 * minute, limit: 1024 },
    { name: "null fields fall back to defaults", raw: "client: {codex: {web-search-result-cache: {enabled: null, ttl: null, limit: null}}}\n", enabled: false, ttl: DefaultWebSearchResultCacheTTLMs, limit: DefaultWebSearchResultCacheLimit },
  ]) {
    test(tc.name, () => {
      const got = parseConfig(tc.raw, opts).client.codex.webSearchResultCache;
      expect(got).toEqual({ enabled: tc.enabled, ttlMs: tc.ttl, limit: tc.limit });
    });
  }

  test("invalid values are rejected", () => {
    for (const raw of [
      "client: {codex: {web-search-result-cache: false}}\n",
      "client: {codex: {web-search-result-cache: {enabled: invalid}}}\n",
      "client: {codex: {web-search-result-cache: {ttl: invalid}}}\n",
      "client: {codex: {web-search-result-cache: {ttl: -30m}}}\n",
      "client: {codex: {web-search-result-cache: {ttl: -10}}}\n",
      "client: {codex: {web-search-result-cache: {ttl: true}}}\n",
      "client: {codex: {web-search-result-cache: {limit: -1}}}\n",
      "client: {codex: {web-search-result-cache: {limit: invalid}}}\n",
    ]) {
      expect(() => parseConfig(raw, opts), raw).toThrow();
    }
  });
});

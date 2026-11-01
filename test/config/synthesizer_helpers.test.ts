// Ported from: internal/watcher/synthesizer/helpers_test.go
// Skipped cases: TestNewStableIDGenerator (no counters field exposed), TestStableIDGenerator_NilReceiver (no nil
//   receivers in TS), the `diff.ComputeExcludedModelsHash` equality assertions inside TestApplyAuthExcludedModelsMeta
//   (hash function differs; presence/absence is asserted instead).
import { describe, expect, test } from "bun:test";
import { newAuth } from "../../src/auth/types.ts";
import { StableIDGenerator, addConfigHeadersToAttrs, addRequestRetryToMetadata, applyAuthExcludedModelsMeta, computeExcludedModelsHash } from "../../src/config/auths.ts";

describe("StableIDGenerator.next", () => {
  const cases = [
    { name: "basic gemini apikey", kind: "gemini:apikey", parts: ["test-key", ""], wantPrefix: "gemini:apikey:" },
    { name: "claude with base url", kind: "claude:apikey", parts: ["sk-ant-xxx", "https://api.anthropic.com"], wantPrefix: "claude:apikey:" },
    { name: "empty parts", kind: "codex:apikey", parts: [] as string[], wantPrefix: "codex:apikey:" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const [id, short] = new StableIDGenerator().next(tt.kind, ...tt.parts);
      expect(id.startsWith(tt.wantPrefix)).toBe(true);
      expect(short).not.toBe("");
      expect(short.length).toBe(12);
      expect(id).toBe(`${tt.kind}:${short}`);
    });
  }
});

test("StableIDGenerator stability", () => {
  const [id1] = new StableIDGenerator().next("gemini:apikey", "test-key", "https://api.example.com");
  const [id2] = new StableIDGenerator().next("gemini:apikey", "test-key", "https://api.example.com");
  expect(id1).toBe(id2);
  // Parts are trimmed before hashing.
  const [id3] = new StableIDGenerator().next("gemini:apikey", " test-key ", "https://api.example.com ");
  expect(id3).toBe(id1);
  // Known digest: sha256("gemini:apikey" + NUL + "test-key" + NUL + "https://api.example.com") prefix.
  expect(id1).toBe("gemini:apikey:" + sha256Prefix(["gemini:apikey", "test-key", "https://api.example.com"]));
});

test("StableIDGenerator collision handling", () => {
  const gen = new StableIDGenerator();
  const [id1, short1] = gen.next("gemini:apikey", "same-key");
  const [id2, short2] = gen.next("gemini:apikey", "same-key");
  expect(id1).not.toBe(id2);
  expect(short1).not.toBe(short2);
  expect(short2.endsWith("-1")).toBe(true);
  const [, short3] = gen.next("gemini:apikey", "same-key");
  expect(short3.endsWith("-2")).toBe(true);
});

describe("applyAuthExcludedModelsMeta", () => {
  test("apikey with excluded models", () => {
    const auth = newAuth({ id: "a", provider: "gemini" });
    applyAuthExcludedModelsMeta(auth, ["Model-A", " model-b ", "model-a", ""], "apikey");
    expect(auth.attributes.excluded_models).toBe("model-a,model-b");
    expect(auth.attributes.excluded_models_hash).toBe(computeExcludedModelsHash(["model-a", "model-b"]));
    expect(auth.attributes.auth_kind).toBe("apikey");
  });

  test("empty rules keep existing attributes and set only the kind", () => {
    const auth = newAuth({ id: "a", provider: "gemini", attributes: { excluded_models: "stale", excluded_models_hash: "stale-hash" } });
    applyAuthExcludedModelsMeta(auth, [], "oauth");
    expect(auth.attributes.excluded_models).toBe("stale");
    expect(auth.attributes.excluded_models_hash).toBe("stale-hash");
    expect(auth.attributes.auth_kind).toBe("oauth");
  });

  test("empty auth kind leaves auth_kind untouched", () => {
    const auth = newAuth({ id: "a", provider: "gemini" });
    applyAuthExcludedModelsMeta(auth, ["x"], "");
    expect("auth_kind" in auth.attributes).toBe(false);
    expect(auth.attributes.excluded_models).toBe("x");
  });
});

describe("addConfigHeadersToAttrs", () => {
  const cases: { name: string; headers: Record<string, string> | null; attrs: Record<string, string> | null; want: Record<string, string> | null }[] = [
    {
      name: "basic headers",
      headers: { Authorization: "Bearer token", "X-Custom": "value" },
      attrs: { existing: "key" },
      want: { existing: "key", "header:Authorization": "Bearer token", "header:X-Custom": "value" },
    },
    { name: "empty headers", headers: {}, attrs: { existing: "key" }, want: { existing: "key" } },
    { name: "nil headers", headers: null, attrs: { existing: "key" }, want: { existing: "key" } },
    { name: "nil attrs", headers: { key: "value" }, attrs: null, want: null },
    { name: "skip empty keys and values", headers: { "": "value", key: "", "  ": "value", valid: "valid-value" }, attrs: {}, want: { "header:valid": "valid-value" } },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      addConfigHeadersToAttrs(tt.headers, tt.attrs);
      expect(tt.attrs).toEqual(tt.want);
    });
  }
});

test("addRequestRetryToMetadata", () => {
  let metadata: Record<string, unknown> = {};
  addRequestRetryToMetadata(0, metadata);
  expect(metadata.request_retry).toBe(0);

  metadata = {};
  addRequestRetryToMetadata(2, metadata);
  expect(metadata.request_retry).toBe(2);

  metadata = {};
  addRequestRetryToMetadata(-1, metadata);
  expect("request_retry" in metadata).toBe(false);

  metadata = {};
  addRequestRetryToMetadata(undefined, metadata);
  expect("request_retry" in metadata).toBe(false);

  expect(() => addRequestRetryToMetadata(2, null)).not.toThrow();
});

function sha256Prefix(parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  parts.forEach((part, i) => {
    if (i > 0) hasher.update(new Uint8Array([0]));
    hasher.update(part);
  });
  return hasher.digest("hex").slice(0, 12);
}

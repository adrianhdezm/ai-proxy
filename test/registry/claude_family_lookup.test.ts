// Ported from: internal/registry/claude_family_lookup_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { lookupStaticModelInfo, lookupStaticModelInfoByChannel } from "../../src/registry/index.ts";

describe("LookupStaticModelInfo Claude variants use catalog entry", () => {
  const cases = [
    { id: "claude-opus-5-5[1m]", family: "claude-opus-5-5" },
    { id: "claude-opus-5-5-20261001", family: "claude-opus-5-5" },
    { id: "claude-opus-5-5-20261001[1m]", family: "claude-opus-5-5" },
    { id: "claude-sonnet-5-5[1m]", family: "claude-sonnet-5-5" },
    { id: "claude-sonnet-5-5-20261001", family: "claude-sonnet-5-5" },
    { id: "claude-fable-5[1m]", family: "claude-fable-5" },
    { id: "claude-fable-5-1[1m]", family: "claude-fable-5-1" },
    { id: "claude-haiku-4-5-20251001[1m]", family: "claude-haiku-4-5-20251001" },
  ];
  for (const tt of cases) {
    test(tt.id, () => {
      expect(lookupStaticModelInfo(tt.id)?.id).toBe(tt.family);
      expect(lookupStaticModelInfoByChannel(tt.id, "claude")?.id).toBe(tt.family);
    });
  }

  test("exact catalog IDs keep winning, and only Claude variants are normalized", () => {
    expect(lookupStaticModelInfo("claude-haiku-4-5-20251001")?.id).toBe("claude-haiku-4-5-20251001");
    for (const id of ["claude-unknown-20261001", "claude-opus-5-5-2026", "claude-opus-5-5[1m", "gpt-5[1m]"]) {
      expect(lookupStaticModelInfo(id)).toBeUndefined();
    }
  });
});

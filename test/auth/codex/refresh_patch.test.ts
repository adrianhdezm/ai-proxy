// Ported from: internal/auth/codex/refresh_patch_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { CredentialRefreshPatch, isCodexCredentialKey } from "../../../src/auth/codex/refresh_patch.ts";
import { cloneStringAnyMap } from "../../../src/auth/codex/token.ts";

type AnyMap = Record<string, unknown>;

describe("CredentialRefreshPatch", () => {
  for (const rotated of ["outer", "siwc"] as const) {
    test(`checks partitions independently (${rotated} rotated on disk)`, () => {
      const before: AnyMap = {
        access_token: "outer-old",
        refresh_token: "outer-ref-old",
        last_refresh: "2026-10-12T12:00:00Z",
        siwc: { access_token: "siwc-old", refresh_token: "siwc-ref-old", last_refresh: "2026-10-12T12:00:00Z" },
      };
      const after = cloneStringAnyMap(before);
      after.access_token = "outer-new";
      after.refresh_token = "outer-ref-new";
      (after.siwc as AnyMap).access_token = "siwc-new";
      (after.siwc as AnyMap).refresh_token = "siwc-ref-new";
      const patch = CredentialRefreshPatch.create(before, after, true, true);
      const disk = cloneStringAnyMap(before);
      let wantOuter = "outer-ref-new";
      let wantSIWC = "siwc-ref-new";
      if (rotated === "outer") {
        disk.access_token = "outer-bound";
        disk.refresh_token = "outer-ref-bound";
        wantOuter = "outer-ref-bound";
      } else {
        (disk.siwc as AnyMap).access_token = "siwc-bound";
        (disk.siwc as AnyMap).refresh_token = "siwc-ref-bound";
        wantSIWC = "siwc-ref-bound";
      }
      // Changing source/result maps later must not mutate the immutable patch.
      before.refresh_token = "mutated-before";
      after.refresh_token = "mutated-after";
      const saved = patch.apply(disk);
      expect(saved.refresh_token).toBe(wantOuter);
      expect((saved.siwc as AnyMap).refresh_token).toBe(wantSIWC);
      expect(patch.canApplyTo(disk)).toBe(true);
      expect(patch.refreshedOuter).toBe(true);
      expect(patch.refreshedSIWC).toBe(true);
    });
  }

  test("a disk baseline recorded under the lock also matches", () => {
    const mem = { access_token: "mem-at", refresh_token: "mem-rt" };
    const disk = { access_token: "disk-at", refresh_token: "disk-rt", prefix: "keep" };
    const after = { access_token: "new-at", refresh_token: "new-rt", last_refresh: "t" };
    const patch = CredentialRefreshPatch.createWithDiskBaseline(mem, disk, after, true, false);
    expect(patch.canApplyTo(disk)).toBe(true);
    expect(patch.apply(disk)).toEqual({ access_token: "new-at", refresh_token: "new-rt", last_refresh: "t", prefix: "keep" });
    expect(patch.canApplyTo({ access_token: "other" })).toBe(false);
    expect(patch.refreshedSIWC).toBe(false);
  });

  test("isCodexCredentialKey", () => {
    expect(isCodexCredentialKey("siwc")).toBe(true);
    expect(isCodexCredentialKey("use_siwc")).toBe(true);
    expect(isCodexCredentialKey("access_token")).toBe(true);
    expect(isCodexCredentialKey("prefix")).toBe(false);
  });
});

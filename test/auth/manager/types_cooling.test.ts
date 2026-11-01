// Ported from: sdk/cliproxy/auth/types_cooling_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { disableCoolingOverride } from "../../../src/auth/manager/index.ts";
import { auth } from "./helpers.ts";

test("DisableCoolingOverrideSupportsExplicitFalse", () => {
  const cases: Array<{ name: string; metadata?: Record<string, unknown>; want: boolean; wantPresent: boolean }> = [
    { name: "unset", want: false, wantPresent: false },
    { name: "canonical true", metadata: { disable_cooling: true }, want: true, wantPresent: true },
    { name: "canonical false", metadata: { disable_cooling: false }, want: false, wantPresent: true },
    { name: "legacy false", metadata: { "disable-cooling": false }, want: false, wantPresent: true },
    { name: "string false", metadata: { disable_cooling: "false" }, want: false, wantPresent: true },
    { name: "invalid", metadata: { disable_cooling: "invalid" }, want: false, wantPresent: false },
  ];
  for (const tc of cases) {
    expect(disableCoolingOverride(auth({ id: tc.name, metadata: tc.metadata ?? {} }))).toEqual([tc.want, tc.wantPresent]);
  }
});

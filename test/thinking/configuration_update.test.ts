// Ported from: internal/thinking/configuration_update_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { collapseConfigurationUpdates, hasThinkingSuffix, stripConfigurationUpdates } from "../../src/thinking/index.ts";
import { getString, getValue, raw } from "./helpers.ts";

describe("CollapseConfigurationUpdates boundaries", () => {
  for (const tc of [
    { name: "empty input", body: `{"input":[]}` },
    { name: "invalid JSON", body: `{"input":[` },
  ]) {
    test(tc.name, () => {
      expect(collapseConfigurationUpdates(tc.body)).toBe(tc.body);
    });
  }

  test("only configuration updates", () => {
    const body = `{"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":"high"}}]}`;
    const got = collapseConfigurationUpdates(body);
    expect(getValue(got, "input")).toEqual([]);
    expect(getString(got, "reasoning.effort")).toBe("high");
  });
});

describe("StripConfigurationUpdates exported", () => {
  test("items removed without changing top level effort", () => {
    const body = `{"reasoning":{"effort":"medium"},"input":[{"type":"configuration_update","reasoning":{"effort":"high"}},{"role":"user","content":"hi"}]}`;
    const got = stripConfigurationUpdates(body);
    expect(raw(got, "input")).toBe(`[{"role":"user","content":"hi"}]`);
    expect(getString(got, "reasoning.effort")).toBe("medium");
  });

  for (const tc of [
    { name: "empty input", body: `{"input":[]}` },
    { name: "invalid JSON", body: `{"input":[` },
  ]) {
    test(tc.name, () => {
      expect(stripConfigurationUpdates(tc.body)).toBe(tc.body);
    });
  }
});

describe("HasThinkingSuffix", () => {
  for (const tc of [
    { model: "model", want: false },
    { model: "model()", want: false },
    { model: "model(invalid)", want: false },
    { model: "model(high)", want: true },
    { model: "model(xhigh)", want: true },
    { model: "model(none)", want: true },
    { model: "model(auto)", want: true },
    { model: "model(16384)", want: true },
  ]) {
    test(tc.model, () => {
      expect(hasThinkingSuffix(tc.model)).toBe(tc.want);
    });
  }
});

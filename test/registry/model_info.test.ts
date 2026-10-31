// Ported from: internal/modelconfig/model_info_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { normalizeThinkingSupport, resolveModelInfo, type ThinkingSupport } from "../../src/registry/index.ts";
import { applyThinkingWithModelInfo } from "../../src/thinking/apply.ts";

test("TestResolveModelInfoUsesSuffixFreeStaticCapabilities", () => {
  const info = resolveModelInfo("claude-opus-4-6(high)", "claude");
  expect(info.thinking).toBeDefined();
  expect(info.id).toBe("claude-opus-4-6(high)");
  expect(info.userDefined).toBe(false);
});

test("TestResolveModelInfoExplicitThinkingOverridesAndClones", () => {
  const support: ThinkingSupport = { levels: [" XHIGH ", "xhigh", " High "] };
  const info = resolveModelInfo("custom-model", "codex", support);
  expect(info.thinking?.levels).toEqual(["xhigh", "high"]);
  support.levels![0] = "low";
  expect(info.thinking!.levels![0]).toBe("xhigh");
});

test("TestNormalizeThinkingSupportDerivesSpecialLevelFlags", () => {
  const support = normalizeThinkingSupport({ levels: ["low", "none", "auto"] });
  expect(support).toBeDefined();
  expect(support!.zeroAllowed).toBe(true);
  expect(support!.dynamicAllowed).toBe(true);
});

// A claude-api-key model entry with its own thinking levels must keep the catalog
// way of turning thinking off: claude-sonnet-5-5 rejects "disabled".
test("TestResolveModelInfoConfiguredThinkingKeepsCatalogDisableType", () => {
  const configured: ThinkingSupport = { levels: ["low", "medium", "high", "none"] };
  const info = resolveModelInfo("claude-sonnet-5-5", "claude", configured);
  expect(info.thinking?.disableType).toBe("between_tools");
  expect(info.thinking?.levels).toEqual(["low", "medium", "high", "none"]);

  const body = `{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"disabled"}}`;
  const out = applyThinkingWithModelInfo(body, "", "claude-sonnet-5-5", "claude", "claude", "claude", info);
  expect(JSON.parse(out).thinking).toEqual({ type: "between_tools" });

  const explicit = resolveModelInfo("claude-sonnet-5-5", "claude", { levels: ["low"], disableType: "disabled" });
  expect(explicit.thinking?.disableType).toBe("disabled");
  expect(resolveModelInfo("claude-opus-5", "claude", configured).thinking?.disableType ?? "").toBe("");
  expect(resolveModelInfo("claude-sonnet-5-5[1m]", "claude", configured).thinking?.disableType).toBe("between_tools");
});

test("TestResolveModelInfoUnknownModelKeepsMissingCapability", () => {
  const info = resolveModelInfo("unknown-configured-model", "claude");
  expect(info.thinking).toBeUndefined();
  expect(info.userDefined).toBe(false);
});

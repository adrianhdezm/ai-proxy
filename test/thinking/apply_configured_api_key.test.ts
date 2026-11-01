// Ported from: internal/thinking/apply_configured_api_key_test.go
// Skipped cases: TestApplyThinkingWithModelInfoUsesOpenRouterVisibility (openrouter dropped)
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../src/registry/types.ts";
import {
  type SummaryConfig,
  SummaryEnabled,
  SummaryUnspecified,
  ThinkingError,
  applyThinkingWithModelInfo,
  applyThinkingWithModelInfoAndSummary,
  applyThinkingWithSourceAndSummary,
  applyThinkingWithSummary,
  extractSummaryConfig,
} from "../../src/thinking/index.ts";
import { exists, getString, getValue, raw } from "./helpers.ts";

const noSummary: SummaryConfig = { mode: SummaryUnspecified };

describe("ApplyThinkingWithModelInfo maps cross-family high intent", () => {
  const cases = [
    { name: "xhigh stays xhigh", source: "xhigh", supported: ["high", "max", "xhigh"], want: "xhigh" },
    { name: "xhigh prefers max", source: "xhigh", supported: ["high", "max"], want: "max" },
    { name: "xhigh falls back to high", source: "xhigh", supported: ["high"], want: "high" },
    { name: "max stays max", source: "max", supported: ["high", "xhigh", "max"], want: "max" },
    { name: "max prefers xhigh", source: "max", supported: ["high", "xhigh"], want: "xhigh" },
    { name: "max falls back to high", source: "max", supported: ["high"], want: "high" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const modelInfo: ModelInfo = { id: "claude-upstream", type: "claude", thinking: { levels: tc.supported } };
      const body = `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`;
      const source = `{"reasoning_effort":"${tc.source}"}`;
      const out = applyThinkingWithModelInfo(body, source, "claude-upstream", "openai", "claude", "claude", modelInfo);
      expect(getString(out, "output_config.effort")).toBe(tc.want);
    });
  }
});

test("ApplyThinkingWithModelInfo maps OpenAI-compatibility high intent", () => {
  const modelInfo: ModelInfo = { id: "compat-upstream", type: "openai-compatibility", thinking: { levels: ["high", "max"] } };
  const out = applyThinkingWithModelInfo(`{"reasoning_effort":"high"}`, `{"reasoning_effort":"xhigh"}`, "compat-upstream", "openai", "openai", "compat-provider", modelInfo);
  expect(getString(out, "reasoning_effort")).toBe("max");
});

test("ApplyThinkingWithModelInfo maps Responses to Codex high intent", () => {
  const modelInfo: ModelInfo = { id: "codex-upstream", type: "codex", thinking: { levels: ["high", "xhigh"] } };
  const out = applyThinkingWithModelInfo(`{"reasoning":{"effort":"high"}}`, `{"reasoning":{"effort":"max"}}`, "codex-upstream", "openai-response", "codex", "codex", modelInfo);
  expect(getString(out, "reasoning.effort")).toBe("xhigh");
});

test("ApplyThinkingWithModelInfo keeps same-family validation strict", () => {
  const modelInfo: ModelInfo = { id: "openai-upstream", type: "openai", thinking: { levels: ["low", "medium", "high"] } };
  const body = `{"reasoning_effort":"xhigh"}`;
  expect(() => applyThinkingWithModelInfo(body, body, "openai-upstream", "openai", "openai", "openai", modelInfo)).toThrow(ThinkingError);
});

test("ApplyThinkingWithModelInfo applies enabled summary-only Claude visibility", () => {
  const modelInfo: ModelInfo = { id: "private-claude", type: "claude", thinking: { levels: ["high"] } };
  const out = applyThinkingWithModelInfo(`{"model":"private-claude","max_tokens":32000}`, `{"reasoning":{"summary":"auto"}}`, "private-claude", "openai-response", "claude", "claude", modelInfo);
  expect(getString(out, "thinking.type")).toBe("adaptive");
  expect(getString(out, "thinking.display")).toBe("summarized");
});

test("ApplyThinkingWithModelInfoAndSummary drops inferred Claude mode when summary removed", () => {
  const modelInfo: ModelInfo = { id: "private-manual-claude", type: "claude", thinking: { min: 1024, max: 16000 } };
  const out = applyThinkingWithModelInfoAndSummary(
    `{"model":"private-manual-claude","max_tokens":32000,"thinking":{"type":"adaptive"}}`,
    `{"reasoning":{"summary":"auto"}}`,
    "private-manual-claude",
    "openai-response",
    "claude",
    "claude",
    modelInfo,
    noSummary,
  );
  expect(exists(out, "thinking")).toBe(false);
});

test("ApplyThinkingWithModelInfo does not activate Claude for disabled summary", () => {
  const modelInfo: ModelInfo = { id: "private-claude", type: "claude", thinking: { levels: ["high"] } };
  const out = applyThinkingWithModelInfo(`{"model":"private-claude","max_tokens":32000}`, `{"reasoning":{"summary":null}}`, "private-claude", "openai-response", "claude", "claude", modelInfo);
  expect(exists(out, "thinking")).toBe(false);
});

test("ApplyThinkingWithModelInfo summary-only does not invent OpenAI effort", () => {
  const modelInfo: ModelInfo = { id: "private-openai", type: "openai", thinking: { levels: ["high", "max"] } };
  const out = applyThinkingWithModelInfo(
    `{"model":"private-openai","messages":[{"role":"user","content":"hi"}]}`,
    `{"model":"private-openai","reasoning":{"summary":"auto"},"input":"hi"}`,
    "private-openai",
    "openai-response",
    "openai",
    "openai",
    modelInfo,
  );
  expect(exists(out, "reasoning_effort")).toBe(false);
});

test("ApplyThinkingWithSummary keeps OpenAI chat suffix none", () => {
  const out = applyThinkingWithSummary(`{"model":"private-openai","messages":[{"role":"user","content":"hi"}]}`, "private-openai(none)", "openai-response", "openai", "openai", { mode: SummaryEnabled, detail: "auto" });
  expect(getString(out, "reasoning_effort")).toBe("none");
});

describe("ApplyConfigurationUpdate cross protocol", () => {
  const source = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"},{"type":"configuration_update","reasoning":{"effort":"high"}}]}`;
  const cases = [
    { name: "unsupported Responses source becomes OpenAI Chat effort", body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`, model: "private-chat", format: "openai", typeName: "openai", supported: false, wantPath: "reasoning_effort", want: "high" },
    { name: "supported updates cannot be sent to OpenAI Chat", body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`, model: "private-chat", format: "openai", typeName: "openai", supported: true, wantPath: "reasoning_effort", want: "high" },
    { name: "Responses source becomes Claude effort", body: `{"max_tokens":4096,"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"},"other":true}`, model: "private-claude", format: "claude", typeName: "claude", supported: false, wantPath: "output_config.effort", want: "high" },
    { name: "model suffix overrides source updates", body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`, model: "private-chat(low)", format: "openai", typeName: "openai", supported: false, wantPath: "reasoning_effort", want: "low" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const info: ModelInfo = { id: "private", type: tc.typeName, supportConfigurationUpdate: tc.supported, thinking: { levels: ["low", "medium", "high", "xhigh"] } };
      const out = applyThinkingWithModelInfo(tc.body, source, tc.model, "openai-response", tc.format, tc.format, info);
      expect(getString(out, tc.wantPath)).toBe(tc.want);
      expect(getValue(out, "other")).toBe(true);
    });
  }
});

describe("ApplyConfigurationUpdate source entry", () => {
  const source = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`;
  const target = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"medium"}},{"role":"user","content":"ok"}]}`;
  const cases: Array<{ name: string; model: string; body: string; source: string; format?: string; want: string; wantInput?: string; wantSame?: boolean }> = [
    { name: "registry capability preserves native Responses without suffix", model: "gpt-6-astra", body: source, source, want: "xhigh", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]`, wantSame: true },
    { name: "unknown gpt-6 model defaults to unsupported", model: "gpt-6-unknown-routed", body: source, source, want: "low", wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "source effort controls translated target", model: "gpt-6-unknown-routed", body: target, source, want: "low", wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unknown model source update applies to OpenAI Chat", model: "gpt-6-unknown-routed", body: `{"reasoning_effort":"xhigh","messages":[{"role":"user","content":"ok"}]}`, source, format: "openai", want: "low" },
    { name: "nonarray input remains unchanged", model: "gpt-6-unknown-routed", body: `{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update"}}`, source, want: "low", wantInput: `{"type":"configuration_update"}` },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const format = tc.format ?? "codex";
      const out = applyThinkingWithSourceAndSummary(tc.body, tc.source, tc.model, "openai-response", format, format, extractSummaryConfig(tc.source, "openai-response"));
      const path = format === "openai" ? "reasoning_effort" : "reasoning.effort";
      expect(getString(out, path)).toBe(tc.want);
      if (tc.wantInput) expect(raw(out, "input")).toBe(tc.wantInput);
      if (tc.wantSame) expect(out).toBe(tc.body);
    });
  }
});

describe("ApplyConfigurationUpdate invalid target", () => {
  const invalidTarget = `{"reasoning":{"effort":"xhigh"},"input":[`;
  const updateSource = `{"reasoning":{"effort":"medium"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`;
  const info: ModelInfo = { id: "private-codex", type: "codex", thinking: { levels: ["low", "medium", "high", "xhigh"] } };
  const cases = [
    { name: "bound model does not rebuild invalid target from source update", model: "private-codex", source: updateSource, bound: true, normalized: false, want: invalidTarget },
    { name: "unbound model does not rebuild invalid target from source update", model: "gpt-6-unknown-routed", source: updateSource, bound: false, normalized: false, want: invalidTarget },
    { name: "normalized updates cannot rebuild invalid target", model: "private-codex", source: updateSource, bound: true, normalized: true, want: invalidTarget },
    { name: "suffix alone still rebuilds invalid target", model: "private-codex(high)", source: "", bound: true, normalized: false, want: `{"reasoning":{"effort":"high"}}` },
    { name: "suffix takes priority over source update for invalid target", model: "private-codex(high)", source: updateSource, bound: true, normalized: true, want: `{"reasoning":{"effort":"high"}}` },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const out = tc.bound
        ? applyThinkingWithModelInfoAndSummary(invalidTarget, tc.source, tc.model, "codex", "codex", "codex", info, noSummary, tc.normalized)
        : applyThinkingWithSourceAndSummary(invalidTarget, tc.source, tc.model, "codex", "codex", "codex", noSummary, tc.normalized);
      expect(out).toBe(tc.want);
    });
  }
});

test("ApplyConfigurationUpdate bound model without thinking", () => {
  const body = `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`;
  let out = applyThinkingWithModelInfoAndSummary(body, body, "gpt-6-astra", "codex", "codex", "codex", undefined, extractSummaryConfig(body, "codex"));
  expect(getString(out, "reasoning.effort")).toBe("low");
  expect((getValue(out, "input") as unknown[]).length).toBe(1);

  const info: ModelInfo = { id: "custom", type: "codex", userDefined: true };
  out = applyThinkingWithModelInfoAndSummary(body, body, "custom", "codex", "codex", "codex", info, extractSummaryConfig(body, "codex"));
  expect(getString(out, "reasoning.effort")).toBe("low");
  expect((getValue(out, "input") as unknown[]).length).toBe(1);

  info.supportConfigurationUpdate = true;
  for (const tc of [
    { name: "native no suffix", model: "custom", want: "xhigh" },
    { name: "native suffix", model: "custom(high)", want: "high" },
  ]) {
    const applied = applyThinkingWithModelInfoAndSummary(body, body, tc.model, "codex", "codex", "codex", info, extractSummaryConfig(body, "codex"));
    expect(getString(applied, "reasoning.effort"), tc.name).toBe(tc.want);
    expect(getString(applied, "input.0.reasoning.effort"), tc.name).toBe("low");
    expect(getString(applied, "reasoning.summary"), tc.name).toBe("auto");
  }
});

test("ApplyThinkingWithModelInfo uses original Responses effort", () => {
  const modelInfo: ModelInfo = { id: "claude-upstream", type: "claude", thinking: { levels: ["high", "max"] } };
  const out = applyThinkingWithModelInfo(`{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`, `{"reasoning":{"effort":"xhigh"}}`, "claude-upstream", "openai-response", "claude", "claude", modelInfo);
  expect(getString(out, "output_config.effort")).toBe("max");
});

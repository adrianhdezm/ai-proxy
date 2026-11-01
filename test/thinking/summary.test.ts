// Ported from: internal/thinking/summary_test.go
// Skipped cases: antigravity and interactions rows in TestExtractSummaryConfig, TestApplySummaryConfig and
//   TestApplySummaryConfigNormalizesTargetAliases (dropped providers); the OpenRouter/DeepSeek/Kimi/Moonshot
//   rows of TestApplySummaryConfig_OpenAIChatProviderDialects (dropped providers; the generic
//   "update existing field" behaviour is kept)
import { describe, expect, test } from "bun:test";
import {
  SummaryDisabled,
  SummaryEnabled,
  SummaryUnspecified,
  type SummaryConfig,
  type SummaryMode,
  applySummaryConfig,
  applySummaryConfigForModel,
  applySummaryConfigForProvider,
  extractExplicitSummaryConfig,
  extractSummaryConfig,
} from "../../src/thinking/index.ts";
import { exists, getString, getValue } from "./helpers.ts";

describe("ExtractSummaryConfig", () => {
  const cases: Array<{ name: string; format: string; body: string; wantMode: SummaryMode; wantDetail?: string }> = [
    { name: "chat effort enables", format: "openai", body: `{"reasoning_effort":"high"}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "chat none disables", format: "openai", body: `{"reasoning_effort":"none"}`, wantMode: SummaryDisabled },
    { name: "chat missing unspecified", format: "openai", body: `{}`, wantMode: SummaryUnspecified },
    { name: "chat null effort unspecified", format: "openai", body: `{"reasoning_effort":null}`, wantMode: SummaryUnspecified },
    { name: "chat non-string effort unspecified", format: "openai", body: `{"reasoning_effort":17}`, wantMode: SummaryUnspecified },
    { name: "chat google extension false overrides effort", format: "openai", body: `{"reasoning_effort":"high","extra_body":{"google":{"thinking_config":{"include_thoughts":false}}}}`, wantMode: SummaryDisabled },
    { name: "chat google extension true", format: "openai", body: `{"extra_body":{"google":{"thinking_config":{"include_thoughts":true}}}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "chat exclude disables", format: "openai", body: `{"reasoning_effort":"high","reasoning":{"exclude":true}}`, wantMode: SummaryDisabled },
    { name: "chat exclude false enables", format: "openai", body: `{"reasoning":{"effort":"high","exclude":false}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "chat legacy include_reasoning false disables", format: "openai", body: `{"reasoning_effort":"high","include_reasoning":false}`, wantMode: SummaryDisabled },
    { name: "chat legacy include_reasoning true enables", format: "openai", body: `{"include_reasoning":true}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "chat reasoning enabled false disables", format: "openai", body: `{"reasoning":{"enabled":false}}`, wantMode: SummaryDisabled },
    { name: "chat reasoning enabled true enables", format: "openai", body: `{"reasoning":{"enabled":true}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "chat exclude wins over include_reasoning", format: "openai", body: `{"reasoning":{"exclude":true},"include_reasoning":true}`, wantMode: SummaryDisabled },
    { name: "chat non-boolean include_reasoning unspecified", format: "openai", body: `{"include_reasoning":"false"}`, wantMode: SummaryUnspecified },
    { name: "responses effort alone unspecified", format: "openai-response", body: `{"reasoning":{"effort":"high"}}`, wantMode: SummaryUnspecified },
    { name: "responses summary auto", format: "openai-response", body: `{"reasoning":{"effort":"high","summary":"auto"}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "responses summary concise", format: "openai-response", body: `{"reasoning":{"summary":"concise"}}`, wantMode: SummaryEnabled, wantDetail: "concise" },
    { name: "responses summary null", format: "openai-response", body: `{"reasoning":{"summary":null}}`, wantMode: SummaryDisabled },
    { name: "responses boolean summary invalid", format: "openai-response", body: `{"reasoning":{"summary":true}}`, wantMode: SummaryUnspecified },
    { name: "responses deprecated generate summary", format: "openai-response", body: `{"reasoning":{"generate_summary":"detailed"}}`, wantMode: SummaryEnabled, wantDetail: "detailed" },
    { name: "claude summarized", format: "claude", body: `{"thinking":{"type":"adaptive","display":"summarized"}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "claude omitted", format: "claude", body: `{"thinking":{"type":"enabled","budget_tokens":2048,"display":"omitted"}}`, wantMode: SummaryDisabled },
    { name: "claude display without type is invalid", format: "claude", body: `{"thinking":{"display":"summarized"}}`, wantMode: SummaryUnspecified },
    { name: "claude display with auto type is invalid", format: "claude", body: `{"thinking":{"type":"auto","display":"summarized"}}`, wantMode: SummaryUnspecified },
    // applySummaryConfig runs before applyThinking fills budget_tokens, so an absent budget must not be read as inactive thinking.
    { name: "claude enabled display without budget is valid", format: "claude", body: `{"thinking":{"type":"enabled","display":"summarized"}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "claude enabled display with zero budget is invalid", format: "claude", body: `{"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized"}}`, wantMode: SummaryUnspecified },
    { name: "claude auto compatibility budget summarized", format: "claude", body: `{"thinking":{"type":"enabled","budget_tokens":-1,"display":"summarized"}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "claude auto compatibility budget omitted", format: "claude", body: `{"thinking":{"type":"enabled","budget_tokens":-1,"display":"omitted"}}`, wantMode: SummaryDisabled },
    { name: "gemini include true", format: "gemini", body: `{"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`, wantMode: SummaryEnabled, wantDetail: "auto" },
    { name: "gemini include false", format: "gemini", body: `{"generationConfig":{"thinkingConfig":{"includeThoughts":false}}}`, wantMode: SummaryDisabled },
    { name: "gemini string bool is invalid", format: "gemini", body: `{"generationConfig":{"thinkingConfig":{"includeThoughts":"true"}}}`, wantMode: SummaryUnspecified },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const got = extractSummaryConfig(tt.body, tt.format);
      expect(got.mode).toBe(tt.wantMode);
      expect(got.detail ?? "").toBe(tt.wantDetail ?? "");
    });
  }
});

test("ExtractExplicitSummaryConfig does not use chat effort", () => {
  expect(extractExplicitSummaryConfig(`{"reasoning_effort":"high"}`, "openai").mode).toBe(SummaryUnspecified);
  expect(extractExplicitSummaryConfig(`{"reasoning_effort":"high","reasoning":{"exclude":true}}`, "openai").mode).toBe(SummaryDisabled);
});

describe("ApplySummaryConfig", () => {
  const cases: Array<{ name: string; format: string; body?: string; config: SummaryConfig; path: string; want: string }> = [
    { name: "chat enabled invents no effort", format: "openai", config: { mode: SummaryEnabled }, path: "reasoning_effort", want: "" },
    { name: "chat enabled preserves active effort", format: "openai", body: `{"reasoning_effort":"high"}`, config: { mode: SummaryEnabled }, path: "reasoning_effort", want: "high" },
    { name: "chat enabled preserves disabled effort", format: "openai", body: `{"reasoning_effort":"none"}`, config: { mode: SummaryEnabled }, path: "reasoning_effort", want: "none" },
    // Chat cannot express "reason but hide", so disabling must not fall back to reasoning_effort:"none".
    { name: "chat disabled preserves requested effort", format: "openai", body: `{"reasoning_effort":"high"}`, config: { mode: SummaryDisabled }, path: "reasoning_effort", want: "high" },
    { name: "chat disabled sets exclude when present", format: "openai", body: `{"reasoning":{"effort":"high","exclude":false}}`, config: { mode: SummaryDisabled }, path: "reasoning.exclude", want: "true" },
    { name: "chat enabled clears exclude when present", format: "openai", body: `{"reasoning":{"effort":"high","exclude":true}}`, config: { mode: SummaryEnabled }, path: "reasoning.exclude", want: "false" },
    { name: "chat disabled updates legacy include_reasoning when present", format: "openai", body: `{"reasoning_effort":"high","include_reasoning":true}`, config: { mode: SummaryDisabled }, path: "include_reasoning", want: "false" },
    { name: "chat disabled invents no visibility field", format: "openai", body: `{"reasoning_effort":"high"}`, config: { mode: SummaryDisabled }, path: "reasoning", want: "" },
    { name: "claude enabled", format: "claude", body: `{"thinking":{"type":"adaptive"}}`, config: { mode: SummaryEnabled }, path: "thinking.display", want: "summarized" },
    { name: "claude disabled", format: "claude", body: `{"thinking":{"type":"enabled","budget_tokens":2048}}`, config: { mode: SummaryDisabled }, path: "thinking.display", want: "omitted" },
    { name: "gemini enabled", format: "gemini", config: { mode: SummaryEnabled }, path: "generationConfig.thinkingConfig.includeThoughts", want: "true" },
    { name: "gemini disabled", format: "gemini", config: { mode: SummaryDisabled }, path: "generationConfig.thinkingConfig.includeThoughts", want: "false" },
    { name: "responses concise", format: "openai-response", config: { mode: SummaryEnabled, detail: "concise" }, path: "reasoning.summary", want: "concise" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applySummaryConfig(tt.body ?? `{}`, tt.format, tt.config);
      expect(getString(out, tt.path)).toBe(tt.want);
    });
  }
});

describe("ApplySummaryConfig OpenAI chat provider dialects", () => {
  const cases = [
    { name: "OpenAI does not invent visibility", provider: "openai", body: `{}`, mode: SummaryEnabled, wantExisting: false, wantExclude: "", wantEffort: "" },
    { name: "generic provider updates existing exclude field", provider: "openai-compatibility", body: `{"reasoning":{"exclude":false}}`, mode: SummaryDisabled, wantExisting: true, wantExclude: "true", wantEffort: "" },
    { name: "disabled summary preserves documented effort", provider: "openai", body: `{"reasoning_effort":"high"}`, mode: SummaryDisabled, wantExisting: false, wantExclude: "", wantEffort: "high" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applySummaryConfigForProvider(tt.body, "openai", "model", tt.provider, undefined, { mode: tt.mode });
      expect(exists(out, "reasoning.exclude")).toBe(tt.wantExisting);
      if (tt.wantExisting) expect(getString(out, "reasoning.exclude")).toBe(tt.wantExclude);
      if (tt.wantEffort === "") expect(exists(out, "reasoning_effort")).toBe(false);
      else expect(getString(out, "reasoning_effort")).toBe(tt.wantEffort);
    });
  }
});

test("ApplySummaryConfig normalizes gemini target aliases", () => {
  const out = applySummaryConfig(`{"generationConfig":{"thinkingConfig":{"include_thoughts":true}}}`, "gemini", { mode: SummaryEnabled });
  expect(exists(out, "generationConfig.thinkingConfig.includeThoughts")).toBe(true);
  expect(exists(out, "generationConfig.thinkingConfig.include_thoughts")).toBe(false);
});

// Anthropic requires thinking.type and rejects display on a disabled block, so display must never
// be written unless thinking is already active.
test("ApplySummaryConfig Claude display requires active thinking", () => {
  const bodies = [`{}`, `{"messages":[{"role":"user","content":"hi"}]}`, `{"thinking":{"type":"disabled"}}`];
  for (const mode of [SummaryEnabled, SummaryDisabled]) {
    for (const body of bodies) {
      const out = applySummaryConfig(body, "claude", { mode });
      expect(exists(out, "thinking.display")).toBe(false);
      expect(out).toBe(body);
    }
  }
});

describe("ApplySummaryConfigForModel Claude enabled summary uses valid thinking mode", () => {
  const cases = [
    { name: "adaptive model", model: "claude-opus-5", body: `{"model":"claude-opus-5","max_tokens":32000}`, wantType: "adaptive", wantBudget: 0 },
    { name: "manual model", model: "claude-haiku-4-5-20251001", body: `{"model":"claude-haiku-4-5-20251001","max_tokens":32000}`, wantType: "enabled", wantBudget: 1024 },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applySummaryConfigForModel(tt.body, "claude", tt.model, { mode: SummaryEnabled });
      expect(getString(out, "thinking.type")).toBe(tt.wantType);
      expect(getString(out, "thinking.display")).toBe("summarized");
      if (tt.wantBudget > 0) expect(getValue(out, "thinking.budget_tokens")).toBe(tt.wantBudget);
    });
  }
});

// Disabling summaries must not add a Claude thinking block: absence preserves the per-model default.
test("ApplySummaryConfigForModel Claude disabled summary does not enable thinking", () => {
  for (const model of ["claude-opus-5", "claude-haiku-4-5-20251001"]) {
    const out = applySummaryConfigForModel(`{"model":"${model}","max_tokens":32000}`, "claude", model, { mode: SummaryDisabled });
    expect(exists(out, "thinking")).toBe(false);
  }
});

test("ApplySummaryConfig responses normalizes deprecated generate_summary", () => {
  const out = applySummaryConfig(`{"reasoning":{"generate_summary":"detailed"}}`, "openai-response", { mode: SummaryEnabled, detail: "detailed" });
  expect(getString(out, "reasoning.summary")).toBe("detailed");
  expect(exists(out, "reasoning.generate_summary")).toBe(false);
});

test("ApplySummaryConfig responses disabled omits summary", () => {
  const out = applySummaryConfig(`{"reasoning":{"effort":"high","summary":"auto"}}`, "openai-response", { mode: SummaryDisabled });
  expect(exists(out, "reasoning.summary")).toBe(false);
  expect(getString(out, "reasoning.effort")).toBe("high");
});

test("ApplySummaryConfig responses disabled drops empty reasoning", () => {
  const out = applySummaryConfig(`{"model":"gpt-5.4","reasoning":{"summary":"auto"}}`, "openai-response", { mode: SummaryDisabled });
  expect(exists(out, "reasoning")).toBe(false);
});

test("ApplySummaryConfig unspecified leaves body unchanged", () => {
  const body = `{"thinking":{"type":"adaptive"}}`;
  expect(applySummaryConfig(body, "claude", { mode: SummaryUnspecified })).toBe(body);
});

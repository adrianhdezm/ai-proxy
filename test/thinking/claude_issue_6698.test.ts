// Ported from: internal/thinking/claude_issue_6698_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../src/registry/types.ts";
import { lookupModelInfo } from "../../src/registry/index.ts";
import { applyThinking, applyThinkingWithModelInfo, extractTranslatedReasoningEffort } from "../../src/thinking/index.ts";
import { exists, getString, getValue, raw } from "./helpers.ts";

const msgs = `"messages":[{"role":"user","content":"hi"}]`;

// claude-sonnet-5-5 rejects thinking.type="disabled" and requires "between_tools" instead. That type
// accepts no extra thinking fields and only effort high or below, so turning thinking off must emit
// {"type":"between_tools"} and remove output_config.effort.
describe("ApplyThinking claude-sonnet-5-5 disabled uses between_tools", () => {
  const cases = [
    { name: "disabled", body: `{"model":"claude-sonnet-5-5",${msgs},"thinking":{"type":"disabled"}}`, model: "claude-sonnet-5-5" },
    { name: "disabled with stale budget display block_binding and effort", body: `{"model":"claude-sonnet-5-5",${msgs},"thinking":{"type":"disabled","budget_tokens":8000,"display":"omitted","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"xhigh"}}`, model: "claude-sonnet-5-5" },
    { name: "suffix none overrides active thinking with display and block_binding", body: `{"model":"claude-sonnet-5-5",${msgs},"thinking":{"type":"adaptive","display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"output_config":{"effort":"max"}}`, model: "claude-sonnet-5-5(none)" },
    { name: "suffix zero", body: `{"model":"claude-sonnet-5-5",${msgs},"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`, model: "claude-sonnet-5-5(0)" },
    { name: "zero budget with display and block_binding", body: `{"model":"claude-sonnet-5-5",${msgs},"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`, model: "claude-sonnet-5-5" },
    { name: "context variant", body: `{"model":"claude-sonnet-5-5[1m]",${msgs},"thinking":{"type":"disabled"}}`, model: "claude-sonnet-5-5[1m]" },
    { name: "dated variant", body: `{"model":"claude-sonnet-5-5-20261001",${msgs},"thinking":{"type":"disabled"}}`, model: "claude-sonnet-5-5-20261001" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applyThinking(tt.body, tt.model, "claude", "claude", "claude");
      expect(raw(out, "thinking")).toBe(`{"type":"between_tools"}`);
      expect(exists(out, "output_config.effort")).toBe(false);
      expect(extractTranslatedReasoningEffort(out, "claude")).toBe("none");
    });
  }
});

// Anthropic rejects thinking.type="disabled" on claude-opus-5-5, claude-fable-5 and claude-fable-5-1.
// Turning thinking off must fall back to adaptive thinking at the lowest supported effort ("low")
// with display="omitted", and keep an explicit {"type":"disabled"} block on models that accept it.
describe("ApplyThinking Claude disabled falls back on adaptive-only models", () => {
  const cases = [
    { model: "claude-opus-5-5", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-opus-5-5[1m]", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-opus-5-5-20261001", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-fable-5", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-fable-5[1m]", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-fable-5-1", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-fable-5-1[1m]", wantThinking: "adaptive", wantEffort: "low" },
    { model: "claude-opus-5", wantThinking: "disabled", wantEffort: "" },
    { model: "claude-sonnet-5", wantThinking: "disabled", wantEffort: "" },
    { model: "claude-haiku-5-5", wantThinking: "disabled", wantEffort: "" },
    { model: "claude-opus-4-8", wantThinking: "disabled", wantEffort: "" },
    { model: "claude-opus-4-7", wantThinking: "disabled", wantEffort: "" },
    { model: "claude-haiku-4-5-20251001", wantThinking: "disabled", wantEffort: "" },
  ];
  for (const tt of cases) {
    test(tt.model, () => {
      const body = `{"model":"${tt.model}","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"disabled","budget_tokens":8000,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`;
      const out = applyThinking(body, tt.model, "claude", "claude", "claude");
      expect(getString(out, "thinking.type")).toBe(tt.wantThinking);
      expect(getString(out, "output_config.effort")).toBe(tt.wantEffort);
      expect(exists(out, "thinking.budget_tokens")).toBe(false);
      expect(exists(out, "thinking.block_binding")).toBe(false);
      if (tt.wantThinking === "adaptive") expect(getString(out, "thinking.display")).toBe("omitted");
      else expect(exists(out, "thinking.display")).toBe(false);
    });
  }
});

describe("ApplyThinking Claude disabled fallback inputs", () => {
  const activeWithExtras = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":8000,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`;
  const cases = [
    { name: "suffix none", body: activeWithExtras, model: "claude-opus-5-5(none)" },
    { name: "suffix zero", body: activeWithExtras, model: "claude-opus-5-5(0)" },
    { name: "zero budget", body: `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`, model: "claude-opus-5-5" },
    { name: "zero budget on opus5", body: `{"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}`, model: "claude-opus-5" },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const out = applyThinking(tt.body, tt.model, "claude", "claude", "claude");
      expect(exists(out, "thinking.budget_tokens")).toBe(false);
      expect(exists(out, "thinking.block_binding")).toBe(false);
      if (tt.model === "claude-opus-5") {
        expect(raw(out, "thinking")).toBe(`{"type":"disabled"}`);
        return;
      }
      expect(getString(out, "thinking.type")).toBe("adaptive");
      expect(getString(out, "output_config.effort")).toBe("low");
      expect(getString(out, "thinking.display")).toBe("omitted");
    });
  }
});

// Opus 4.7, Opus 4.8, Fable 5 and Fable 5.1 reject thinking.budget_tokens and accept only adaptive
// thinking with output_config.effort. Numeric budgets map to the nearest effort level and auto stays
// plain adaptive without a synthesized mid-range budget. Opus 4.6 and Sonnet 4.6 still accept budgets.
describe("ApplyThinking Claude adaptive-only models convert budget and auto", () => {
  const adaptiveOnlyModels = ["claude-opus-4-7", "claude-opus-4-8", "claude-fable-5", "claude-fable-5-1"];
  for (const model of adaptiveOnlyModels) {
    test(`${model}/native_budget_tokens`, () => {
      const body = `{"model":"${model}","max_tokens":32000,"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":16384}}`;
      const out = applyThinking(body, model, "claude", "claude", "claude");
      expect(getString(out, "thinking.type")).toBe("adaptive");
      expect(exists(out, "thinking.budget_tokens")).toBe(false);
      expect(getString(out, "output_config.effort")).toBe("high");
    });

    test(`${model}/numeric_suffix`, () => {
      const body = `{"model":"${model}","max_tokens":32000,"messages":[{"role":"user","content":"hi"}]}`;
      const out = applyThinking(body, `${model}(64000)`, "claude", "claude", "claude");
      expect(getString(out, "thinking.type")).toBe("adaptive");
      expect(exists(out, "thinking.budget_tokens")).toBe(false);
      expect(getString(out, "output_config.effort")).toBe("xhigh");
    });

    test(`${model}/translated_budget`, () => {
      const info = lookupModelInfo(model, "claude");
      const body = `{"model":"${model}","max_tokens":32000,"messages":[{"role":"user","content":"hi"}]}`;
      const source = `{"generationConfig":{"thinkingConfig":{"thinkingBudget":4096}}}`;
      const out = applyThinkingWithModelInfo(body, source, model, "gemini", "claude", "claude", info);
      expect(getString(out, "thinking.type")).toBe("adaptive");
      expect(exists(out, "thinking.budget_tokens")).toBe(false);
      expect(getString(out, "output_config.effort")).toBe("medium");
    });

    test(`${model}/auto_suffix`, () => {
      const body = `{"model":"${model}","max_tokens":32000,"messages":[{"role":"user","content":"hi"}]}`;
      const out = applyThinking(body, `${model}(auto)`, "claude", "claude", "claude");
      expect(getString(out, "thinking.type")).toBe("adaptive");
      expect(exists(out, "thinking.budget_tokens")).toBe(false);
      expect(exists(out, "output_config.effort")).toBe(false);
    });
  }

  // Configured routes with unordered levels or a special "auto" token must still select the lowest
  // canonical effort level ("low") when falling back from off.
  test("configured unordered or auto levels select lowest canonical", () => {
    for (const levels of [
      ["high", "medium", "low"],
      ["auto", "high", "low"],
    ]) {
      const info: ModelInfo = { id: "claude-opus-5-5", type: "claude", thinking: { zeroAllowed: false, dynamicAllowed: true, levels } };
      const body = `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"disabled"}}`;
      const out = applyThinkingWithModelInfo(body, "", "claude-opus-5-5", "claude", "claude", "claude", info);
      expect(getString(out, "thinking.type")).toBe("adaptive");
      expect(getString(out, "output_config.effort")).toBe("low");
    }
  });

  for (const hybridModel of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
    test(`${hybridModel}/retains_budget_tokens`, () => {
      const body = `{"model":"${hybridModel}","max_tokens":32000,"messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":16384}}`;
      const out = applyThinking(body, hybridModel, "claude", "claude", "claude");
      expect(getString(out, "thinking.type")).toBe("enabled");
      expect(getValue(out, "thinking.budget_tokens")).toBe(16384);
    });
  }
});

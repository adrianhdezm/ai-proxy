// Ported from: internal/thinking/apply_codex_usage_test.go
// Skipped cases: the logrus hook assertions of TestApplyThinkingLogsNativeResponsesEffectiveEffort
//   (log entry inspection; the body-unchanged and effective-effort checks are kept)
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../src/registry/types.ts";
import { lookupModelInfo } from "../../src/registry/index.ts";
import {
  type SummaryConfig,
  SummaryUnspecified,
  applyThinking,
  applyThinkingWithModelInfo,
  applyThinkingWithModelInfoAndSummary,
  extractReasoningEffort,
  extractTranslatedReasoningEffort,
} from "../../src/thinking/index.ts";
import { getString, getValue, raw } from "./helpers.ts";

const noSummary: SummaryConfig = { mode: SummaryUnspecified };

describe("ExtractCodexReasoningEffort with configuration_update", () => {
  const cases = [
    { name: "codex extracts configuration_update effort over top-level", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`, wantRequestEffort: "low", wantTranslatedEffort: "low" },
    { name: "openai-response extracts configuration_update effort over top-level", provider: "openai-response", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`, wantRequestEffort: "low", wantTranslatedEffort: "low" },
    { name: "codex picks latest configuration_update when multiple are present", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"second turn"},{"type":"configuration_update","reasoning":{"effort":"medium"}}]}`, wantRequestEffort: "medium", wantTranslatedEffort: "medium" },
    { name: "codex falls back to top-level when configuration_update has no reasoning effort", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","tools":[]}]}`, wantRequestEffort: "xhigh", wantTranslatedEffort: "xhigh" },
    { name: "codex handles configuration_update effort none", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`, wantRequestEffort: "none", wantTranslatedEffort: "none" },
    { name: "codex handles configuration_update effort auto", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"auto"}}]}`, wantRequestEffort: "auto", wantTranslatedEffort: "auto" },
    { name: "trailing configuration_update without reasoning effort preserves earlier effort", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","tools":[]}]}`, wantRequestEffort: "low", wantTranslatedEffort: "low" },
    { name: "invalid json returns empty effort", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":`, wantRequestEffort: "", wantTranslatedEffort: "" },
    { name: "codex falls back to top-level when input has no configuration_update", provider: "codex", model: "gpt-6-astra", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"role":"user","content":"hello"}]}`, wantRequestEffort: "xhigh", wantTranslatedEffort: "xhigh" },
    { name: "source configuration_update takes precedence over suffix for request effort", provider: "codex", model: "gpt-6-astra(high)", body: `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`, wantRequestEffort: "low", wantTranslatedEffort: "low" },
    { name: "suffix takes precedence over top-level without updates", provider: "openai-response", model: "gpt-6-astra(high)", body: `{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","tools":[]}]}`, wantRequestEffort: "high", wantTranslatedEffort: "xhigh" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(extractReasoningEffort(tc.body, tc.provider, tc.model)).toBe(tc.wantRequestEffort);
      expect(extractTranslatedReasoningEffort(tc.body, tc.provider)).toBe(tc.wantTranslatedEffort);
    });
  }
});

describe("ExtractCodexReasoningEffort with configuration_update target routing", () => {
  const source = `{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"medium"}},{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":null}},{"role":"user","content":"ok"}]}`;
  for (const supported of [true, false]) {
    test(supported ? "supported" : "unsupported", () => {
      const info: ModelInfo = { id: "opaque-route", type: "codex", supportConfigurationUpdate: supported, thinking: { levels: ["low", "high", "xhigh"] } };
      const body = applyThinkingWithModelInfoAndSummary(source, source, "opaque-route(high)", "openai-response", "codex", "codex", info, noSummary);
      expect(extractReasoningEffort(source, "openai-response", "opaque-route(high)")).toBe("low");
      expect(extractTranslatedReasoningEffort(body, "codex")).toBe(supported ? "low" : "high");
      expect(getString(body, "reasoning.effort")).toBe("high");
      expect(getString(body, "input.0.type") === "configuration_update").toBe(supported);
    });
  }
});

describe("ApplyConfigurationUpdate routing", () => {
  const model = "configured-responses";
  const suffixForTest = (suffix: string) => (suffix === "" ? "" : `(${suffix})`);
  const cases: Array<{ name: string; body: string; format?: string; suffix?: string; supported?: boolean; noThinking?: boolean; skipEffort?: boolean; wantEffort?: string; wantInput?: string; wantSame?: boolean }> = [
    { name: "supported native request preserves baseline and updates byte for byte", body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, supported: true, wantEffort: "xhigh", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]`, wantSame: true },
    { name: "supported no-effort request remains unchanged", body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},{"role":"user","content":"ok"}]}`, supported: true, wantInput: `[{"type":"configuration_update","tools":[]},{"role":"user","content":"ok"}]`, wantSame: true },
    { name: "supported native request without thinking metadata preserves baseline summary and updates", body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, supported: true, noThinking: true, wantEffort: "xhigh", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]`, wantSame: true },
    { name: "supported native suffix still strips effort without thinking metadata", body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, supported: true, noThinking: true, suffix: "high", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]` },
    { name: "supported suffix only rewrites the top-level effort", body: `{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, supported: true, suffix: "high", wantEffort: "high", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]` },
    { name: "supported suffix keeps effective input effort for current turn", body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, supported: true, suffix: "high", wantEffort: "high", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]` },
    { name: "supported invalid suffix leaves native payload untouched", body: `{"reasoning":{"generate_summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, supported: true, suffix: "invalid", wantInput: `[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]`, wantSame: true },
    { name: "unsupported latest nonempty update wins and other input order stays unchanged", body: `{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[{"role":"user","content":"first"},{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":"  "}},{"role":"assistant","content":"reply"},{"type":"configuration_update","reasoning":{"effort":"medium"}},{"type":"configuration_update","tools":[]},{"role":"user","content":"last"}]}`, wantEffort: "medium", wantInput: `[{"role":"user","content":"first"},{"role":"assistant","content":"reply"},{"role":"user","content":"last"}]` },
    { name: "unsupported ignores empty and nonstring efforts", body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":42}},{"type":"configuration_update","reasoning":{"effort":null}},{"type":"configuration_update","reasoning":{"effort":"  "}},{"role":"user","content":"ok"}]}`, wantEffort: "low", wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unsupported suffix takes precedence and still removes updates", body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, suffix: "high", wantEffort: "high", wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unsupported without top-level reasoning promotes the last update", body: `{"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, wantEffort: "low", wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unsupported removes updates with no effort without inventing one", body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},{"role":"user","content":"ok"}]}`, wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unsupported without thinking support still removes updates", body: `{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},{"role":"user","content":"ok"}]}`, noThinking: true, wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unsupported without thinking support strips effort but keeps summary", body: `{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, noThinking: true, wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "unsupported openai-response alias removes updates", body: `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`, format: "openai-response", wantEffort: "low", wantInput: `[{"role":"user","content":"ok"}]` },
    { name: "invalid JSON is untouched", body: `{"reasoning":{"effort":"xhigh"},"input":[`, wantSame: true, skipEffort: true },
    { name: "nonarray input is untouched", body: `{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update","reasoning":{"effort":"low"}}}`, wantInput: `{"type":"configuration_update","reasoning":{"effort":"low"}}`, wantSame: true },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const format = tc.format ?? "codex";
      const info: ModelInfo = { id: model, type: "codex", supportConfigurationUpdate: tc.supported === true, thinking: tc.noThinking ? undefined : { levels: ["low", "medium", "high", "xhigh"] } };
      const body = tc.body;
      const applied = applyThinkingWithModelInfo(body, body, model + suffixForTest(tc.suffix ?? ""), format, format, "codex", info);
      if (tc.wantSame) expect(applied).toBe(body);
      if (!tc.skipEffort) expect(getString(applied, "reasoning.effort")).toBe(tc.wantEffort ?? "");
      if (tc.wantInput) expect(raw(applied, "input")).toBe(tc.wantInput);
      if (getValue(body, "reasoning.summary") !== undefined) expect(getString(applied, "reasoning.summary")).toBe("auto");
      if (getValue(body, "reasoning.other") !== undefined) expect(getValue(applied, "reasoning.other")).toBe(7);
      if (tc.supported && tc.suffix) expect(extractTranslatedReasoningEffort(applied, format)).toBe("low");
    });
  }
});

describe("ApplyThinking native Responses effective effort", () => {
  const cases = [
    { name: "update overrides top-level baseline", body: `{"model":"gpt-6-sol","reasoning":{"effort":"high","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"role":"user","content":"ok"}]}`, wantEffort: "xhigh" },
    { name: "latest update wins", body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"type":"configuration_update","reasoning":{"effort":"max"}}]}`, wantEffort: "max" },
    { name: "trailing empty and nonstring updates keep last effective effort", body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"type":"configuration_update","reasoning":{"effort":null}},{"type":"configuration_update","reasoning":{"effort":42}},{"type":"configuration_update","reasoning":{"effort":"  "}}]}`, wantEffort: "xhigh" },
    { name: "top-level fallback without update", body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"role":"user","content":"ok"}]}`, wantEffort: "high" },
    { name: "update without top-level effort", body: `{"model":"gpt-6-sol","input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}}]}`, wantEffort: "xhigh" },
    { name: "update disables thinking", body: `{"model":"gpt-6-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`, wantEffort: "none" },
  ];
  for (const tc of cases) {
    for (const bound of [false, true]) {
      test(`${tc.name} (${bound ? "resolved model" : "registry lookup"})`, () => {
        let applied: string;
        if (bound) {
          const modelInfo = lookupModelInfo("gpt-6-sol", "codex");
          expect(modelInfo?.supportConfigurationUpdate).toBe(true);
          applied = applyThinkingWithModelInfo(tc.body, tc.body, "gpt-6-sol", "codex", "codex", "codex", modelInfo);
        } else {
          applied = applyThinking(tc.body, "gpt-6-sol", "codex", "codex", "codex");
        }
        expect(applied).toBe(tc.body);
        expect(extractTranslatedReasoningEffort(applied, "codex")).toBe(tc.wantEffort);
      });
    }
  }
});

test("ApplyThinking preserves Codex top-level reasoning effort baseline", () => {
  // Preserving the request-level baseline sent upstream keeps the prompt prefix cache intact.
  const body = `{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`;
  const applied = applyThinking(body, "gpt-6-astra", "codex", "codex", "codex");
  expect(getString(applied, "reasoning.effort")).toBe("xhigh");
  expect(getString(applied, "reasoning.summary")).toBe("auto");
  expect(getString(applied, "input.0.reasoning.effort")).toBe("low");
  expect(extractTranslatedReasoningEffort(applied, "codex")).toBe("low");
});

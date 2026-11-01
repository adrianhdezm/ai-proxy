// Ported from: test/thinking_conversion_test.go
// Skipped cases:
//   - every case whose fromFormat is openai, openai-response or gemini (inbound is Claude-only in this
//     port, so no request translator exists for them): suffix matrix 1-10, 16, 18-22, 28-32, 38-47,
//     58-61, 66-70, 76-85, 88-89; body matrix 1-10, 16, 18-22, 28-32, 31A-31D, 38-47, 58-61, 66-70,
//     76-85, 88-89; the whole A and B subgroups of the Claude adaptive matrix; R1-R4.
//   - every case targeting a dropped provider: antigravity (48-57, 88-89, 31B, 31D, C19), kimi (K1-K16,
//     R3, OUT6, OUT10), xai (X1-X10, OUT7), interactions (I1-I2, IN1-IN11, OUT1-OUT12).
//   - suffix/body case 71 and body case C12: their expectation ("injected default" medium / adaptive
//     without effort -> high) comes from the Claude->Codex / Claude->Gemini request translators, which
//     are not in this slice and not yet in the repo.
//
// Data flow (as upstream): input JSON -> translateRequest(from, to) -> applyThinking -> assertions.
// Translation goes through src/translator/registry.ts's default registry. Until the Claude-inbound
// request translators register themselves there, the registry falls back to passthrough and
// applyThinking reads the Claude-format thinking fields directly (its fromFormat fallback); every
// kept case holds in both situations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getGlobalRegistry, type ModelInfo } from "../../src/registry/index.ts";
import { defaultRegistry } from "../../src/translator/registry.ts";
import { ThinkingError, applyThinking, parseSuffix } from "../../src/thinking/index.ts";
import { getValue } from "./helpers.ts";

interface ThinkingTestCase {
  name: string;
  from: string;
  to: string;
  model: string;
  inputJSON: string;
  expectField?: string;
  expectValue?: string;
  expectField2?: string;
  expectValue2?: string;
  expectAbsent?: string[];
  includeThoughts?: string;
  expectErr?: boolean;
}

const user = `"messages":[{"role":"user","content":"hi"}]`;

/** Shared model definitions for the E2E cases (Go: getTestModels), dropped providers removed. */
function getTestModels(): ModelInfo[] {
  return [
    { id: "level-model", object: "model", created: 1700000000, ownedBy: "test", type: "openai", displayName: "Level Model", thinking: { levels: ["minimal", "low", "medium", "high"], zeroAllowed: false, dynamicAllowed: false } },
    { id: "level-subset-model", object: "model", created: 1700000000, ownedBy: "test", type: "gemini", displayName: "Level Subset Model", thinking: { levels: ["low", "high"], zeroAllowed: false, dynamicAllowed: false } },
    { id: "gemini-budget-model", object: "model", created: 1700000000, ownedBy: "test", type: "gemini", displayName: "Gemini Budget Model", thinking: { min: 128, max: 20000, zeroAllowed: false, dynamicAllowed: true } },
    { id: "gemini-mixed-model", object: "model", created: 1700000000, ownedBy: "test", type: "gemini", displayName: "Gemini Mixed Model", thinking: { min: 128, max: 32768, levels: ["low", "high"], zeroAllowed: false, dynamicAllowed: true } },
    { id: "claude-budget-model", object: "model", created: 1700000000, ownedBy: "test", type: "claude", displayName: "Claude Budget Model", thinking: { min: 1024, max: 128000, zeroAllowed: true, dynamicAllowed: false } },
    { id: "claude-opus-4-6-model", object: "model", created: 1770318000, ownedBy: "anthropic", type: "claude", displayName: "Claude 4.6 Opus", description: "Premium model combining maximum intelligence with practical performance", contextLength: 1000000, maxCompletionTokens: 128000, thinking: { min: 1024, max: 128000, zeroAllowed: true, dynamicAllowed: false, levels: ["low", "medium", "high", "max"] } },
    { id: "claude-sonnet-4-6-model", object: "model", created: 1771372800, ownedBy: "anthropic", type: "claude", displayName: "Claude 4.6 Sonnet", contextLength: 200000, maxCompletionTokens: 64000, thinking: { min: 1024, max: 128000, zeroAllowed: true, dynamicAllowed: false, levels: ["low", "medium", "high"] } },
    { id: "no-thinking-model", object: "model", created: 1700000000, ownedBy: "test", type: "openai", displayName: "No Thinking Model" },
    { id: "user-defined-model", object: "model", created: 1700000000, ownedBy: "test", type: "openai", displayName: "User Defined Model", userDefined: true },
  ];
}

/** Runs the cases through the real data flow path (Go: runThinkingTests). */
function runThinkingTests(cases: ThinkingTestCase[]): void {
  for (const tc of cases) {
    test(`Case${tc.name}_${tc.from}->${tc.to}_${tc.model}`, () => {
      const baseModel = parseSuffix(tc.model).modelName;
      let body = defaultRegistry.translateRequest(tc.from, tc.to, baseModel, tc.inputJSON, true);
      if (tc.to === "claude") {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        parsed.max_tokens = 200000;
        body = JSON.stringify(parsed);
      }

      if (tc.expectErr) {
        expect(() => applyThinking(body, tc.model, tc.from, tc.to, tc.to)).toThrow(ThinkingError);
        return;
      }
      body = applyThinking(body, tc.model, tc.from, tc.to, tc.to);

      for (const fieldPath of tc.expectAbsent ?? []) {
        expect(getValue(body, fieldPath), `expected ${fieldPath} absent, body=${body}`).toBeUndefined();
      }

      if (!tc.expectField) {
        let hasThinking = false;
        switch (tc.to) {
          case "gemini":
            hasThinking = getValue(body, "generationConfig.thinkingConfig") !== undefined;
            break;
          case "claude":
            hasThinking = getValue(body, "thinking") !== undefined;
            break;
          case "openai":
            hasThinking = getValue(body, "reasoning_effort") !== undefined;
            break;
          case "codex":
            hasThinking = getValue(body, "reasoning.effort") !== undefined || getValue(body, "reasoning") !== undefined;
            break;
        }
        expect(hasThinking, `expected no thinking field, body=${body}`).toBe(false);
        return;
      }

      const assertField = (fieldPath: string, expected: string) => {
        const val = getValue(body, fieldPath);
        expect(val, `expected field ${fieldPath} not found, body=${body}`).toBeDefined();
        const actual = typeof val === "number" ? String(Math.trunc(val)) : String(val);
        expect(actual, `field ${fieldPath}, body=${body}`).toBe(expected);
      };

      assertField(tc.expectField, tc.expectValue ?? "");
      if (tc.expectField2) assertField(tc.expectField2, tc.expectValue2 ?? "");

      // Claude adaptive effort is only valid as a pair: native Claude Code always sends
      // thinking.type="adaptive" alongside output_config.effort.
      if (tc.to === "claude" && getValue(body, "output_config.effort") !== undefined) assertField("thinking.type", "adaptive");

      if (tc.to === "gemini") {
        const itVal = getValue(body, "generationConfig.thinkingConfig.includeThoughts");
        if (!tc.includeThoughts) {
          expect(itVal, `includeThoughts should be absent without summary intent, body=${body}`).toBeUndefined();
        } else {
          expect(itVal, `expected includeThoughts, body=${body}`).toBeDefined();
          expect(String(itVal)).toBe(tc.includeThoughts);
        }
      }
    });
  }
}

let registeredClient = "";
beforeAll(() => {
  registeredClient = `thinking-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  getGlobalRegistry().registerClient(registeredClient, "test", getTestModels());
});
afterAll(() => {
  getGlobalRegistry().unregisterClient(registeredClient);
});

// TestThinkingE2EMatrix_Suffix: thinking configuration via model name suffix.
describe("ThinkingE2EMatrix_Suffix", () => {
  runThinkingTests([
    // level-model (Levels=minimal/low/medium/high, ZeroAllowed=false, DynamicAllowed=false)
    { name: "11", from: "claude", to: "openai", model: "level-model", inputJSON: `{"model":"level-model",${user}}` },
    { name: "12", from: "claude", to: "openai", model: "level-model(8192)", inputJSON: `{"model":"level-model(8192)",${user}}`, expectField: "reasoning_effort", expectValue: "medium" },
    { name: "13", from: "claude", to: "openai", model: "level-model(64000)", inputJSON: `{"model":"level-model(64000)",${user}}`, expectField: "reasoning_effort", expectValue: "high" },
    { name: "14", from: "claude", to: "openai", model: "level-model(0)", inputJSON: `{"model":"level-model(0)",${user}}`, expectField: "reasoning_effort", expectValue: "minimal" },
    { name: "15", from: "claude", to: "openai", model: "level-model(-1)", inputJSON: `{"model":"level-model(-1)",${user}}`, expectField: "reasoning_effort", expectValue: "medium" },
    // level-subset-model (Levels=low/high)
    { name: "17", from: "claude", to: "gemini", model: "level-subset-model(1)", inputJSON: `{"model":"level-subset-model(1)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingLevel", expectValue: "low" },
    // gemini-budget-model (Min=128, Max=20000, ZeroAllowed=false, DynamicAllowed=true)
    { name: "23", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: `{"model":"gemini-budget-model",${user}}` },
    { name: "24", from: "claude", to: "gemini", model: "gemini-budget-model(8192)", inputJSON: `{"model":"gemini-budget-model(8192)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "8192" },
    { name: "25", from: "claude", to: "gemini", model: "gemini-budget-model(64000)", inputJSON: `{"model":"gemini-budget-model(64000)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "20000" },
    { name: "26", from: "claude", to: "gemini", model: "gemini-budget-model(0)", inputJSON: `{"model":"gemini-budget-model(0)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "128" },
    { name: "27", from: "claude", to: "gemini", model: "gemini-budget-model(-1)", inputJSON: `{"model":"gemini-budget-model(-1)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "-1" },
    // gemini-mixed-model (Min=128, Max=32768, Levels=low/high, ZeroAllowed=false, DynamicAllowed=true)
    { name: "33", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: `{"model":"gemini-mixed-model",${user}}` },
    { name: "34", from: "claude", to: "gemini", model: "gemini-mixed-model(8192)", inputJSON: `{"model":"gemini-mixed-model(8192)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "8192" },
    { name: "35", from: "claude", to: "gemini", model: "gemini-mixed-model(64000)", inputJSON: `{"model":"gemini-mixed-model(64000)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "32768" },
    { name: "36", from: "claude", to: "gemini", model: "gemini-mixed-model(0)", inputJSON: `{"model":"gemini-mixed-model(0)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingLevel", expectValue: "low" },
    { name: "37", from: "claude", to: "gemini", model: "gemini-mixed-model(-1)", inputJSON: `{"model":"gemini-mixed-model(-1)",${user}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "-1" },
    // no-thinking-model (Thinking=nil)
    { name: "62", from: "claude", to: "openai", model: "no-thinking-model", inputJSON: `{"model":"no-thinking-model",${user}}` },
    { name: "63", from: "claude", to: "openai", model: "no-thinking-model(8192)", inputJSON: `{"model":"no-thinking-model(8192)",${user}}` },
    { name: "64", from: "claude", to: "openai", model: "no-thinking-model(0)", inputJSON: `{"model":"no-thinking-model(0)",${user}}` },
    { name: "65", from: "claude", to: "openai", model: "no-thinking-model(-1)", inputJSON: `{"model":"no-thinking-model(-1)",${user}}` },
    // user-defined-model (UserDefined=true, Thinking=nil)
    { name: "72", from: "claude", to: "codex", model: "user-defined-model(8192)", inputJSON: `{"model":"user-defined-model(8192)",${user}}`, expectField: "reasoning.effort", expectValue: "medium" },
    { name: "73", from: "claude", to: "codex", model: "user-defined-model(64000)", inputJSON: `{"model":"user-defined-model(64000)",${user}}`, expectField: "reasoning.effort", expectValue: "xhigh" },
    { name: "74", from: "claude", to: "codex", model: "user-defined-model(0)", inputJSON: `{"model":"user-defined-model(0)",${user}}`, expectField: "reasoning.effort", expectValue: "none" },
    { name: "75", from: "claude", to: "codex", model: "user-defined-model(-1)", inputJSON: `{"model":"user-defined-model(-1)",${user}}`, expectField: "reasoning.effort", expectValue: "auto" },
    // Same-protocol passthrough
    { name: "86", from: "claude", to: "claude", model: "claude-budget-model(8192)", inputJSON: `{"model":"claude-budget-model(8192)",${user}}`, expectField: "thinking.budget_tokens", expectValue: "8192" },
    { name: "87", from: "claude", to: "claude", model: "claude-budget-model(200000)", inputJSON: `{"model":"claude-budget-model(200000)",${user}}`, expectField: "thinking.budget_tokens", expectValue: "128000" },
  ]);
});

// TestThinkingE2EMatrix_Body: thinking configuration via request body parameters.
describe("ThinkingE2EMatrix_Body", () => {
  runThinkingTests([
    // level-model
    { name: "11", from: "claude", to: "openai", model: "level-model", inputJSON: `{"model":"level-model",${user}}` },
    { name: "12", from: "claude", to: "openai", model: "level-model", inputJSON: `{"model":"level-model",${user},"thinking":{"type":"enabled","budget_tokens":8192}}`, expectField: "reasoning_effort", expectValue: "medium" },
    { name: "13", from: "claude", to: "openai", model: "level-model", inputJSON: `{"model":"level-model",${user},"thinking":{"type":"enabled","budget_tokens":64000}}`, expectField: "reasoning_effort", expectValue: "high" },
    { name: "14", from: "claude", to: "openai", model: "level-model", inputJSON: `{"model":"level-model",${user},"thinking":{"type":"enabled","budget_tokens":0}}`, expectField: "reasoning_effort", expectValue: "minimal" },
    { name: "15", from: "claude", to: "openai", model: "level-model", inputJSON: `{"model":"level-model",${user},"thinking":{"type":"enabled","budget_tokens":-1}}`, expectField: "reasoning_effort", expectValue: "medium" },
    // level-subset-model
    { name: "17", from: "claude", to: "gemini", model: "level-subset-model", inputJSON: `{"model":"level-subset-model",${user},"thinking":{"type":"enabled","budget_tokens":1}}`, expectField: "generationConfig.thinkingConfig.thinkingLevel", expectValue: "low" },
    // gemini-budget-model
    { name: "23", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: `{"model":"gemini-budget-model",${user}}` },
    { name: "24", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: `{"model":"gemini-budget-model",${user},"thinking":{"type":"enabled","budget_tokens":8192}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "8192" },
    { name: "25", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: `{"model":"gemini-budget-model",${user},"thinking":{"type":"enabled","budget_tokens":64000}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "20000" },
    { name: "26", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: `{"model":"gemini-budget-model",${user},"thinking":{"type":"enabled","budget_tokens":0}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "128" },
    { name: "27", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: `{"model":"gemini-budget-model",${user},"thinking":{"type":"enabled","budget_tokens":-1}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "-1" },
    // gemini-mixed-model
    { name: "33", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: `{"model":"gemini-mixed-model",${user}}` },
    { name: "34", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: `{"model":"gemini-mixed-model",${user},"thinking":{"type":"enabled","budget_tokens":8192}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "8192" },
    { name: "35", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: `{"model":"gemini-mixed-model",${user},"thinking":{"type":"enabled","budget_tokens":64000}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "32768" },
    { name: "36", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: `{"model":"gemini-mixed-model",${user},"thinking":{"type":"enabled","budget_tokens":0}}`, expectField: "generationConfig.thinkingConfig.thinkingLevel", expectValue: "low" },
    { name: "37", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: `{"model":"gemini-mixed-model",${user},"thinking":{"type":"enabled","budget_tokens":-1}}`, expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "-1" },
    // no-thinking-model
    { name: "62", from: "claude", to: "openai", model: "no-thinking-model", inputJSON: `{"model":"no-thinking-model",${user}}` },
    { name: "63", from: "claude", to: "openai", model: "no-thinking-model", inputJSON: `{"model":"no-thinking-model",${user},"thinking":{"type":"enabled","budget_tokens":8192}}` },
    { name: "64", from: "claude", to: "openai", model: "no-thinking-model", inputJSON: `{"model":"no-thinking-model",${user},"thinking":{"type":"enabled","budget_tokens":0}}` },
    { name: "65", from: "claude", to: "openai", model: "no-thinking-model", inputJSON: `{"model":"no-thinking-model",${user},"thinking":{"type":"enabled","budget_tokens":-1}}` },
    // user-defined-model
    { name: "72", from: "claude", to: "codex", model: "user-defined-model", inputJSON: `{"model":"user-defined-model",${user},"thinking":{"type":"enabled","budget_tokens":8192}}`, expectField: "reasoning.effort", expectValue: "medium" },
    { name: "73", from: "claude", to: "codex", model: "user-defined-model", inputJSON: `{"model":"user-defined-model",${user},"thinking":{"type":"enabled","budget_tokens":64000}}`, expectField: "reasoning.effort", expectValue: "xhigh" },
    { name: "74", from: "claude", to: "codex", model: "user-defined-model", inputJSON: `{"model":"user-defined-model",${user},"thinking":{"type":"enabled","budget_tokens":0}}`, expectField: "reasoning.effort", expectValue: "none" },
    { name: "75", from: "claude", to: "codex", model: "user-defined-model", inputJSON: `{"model":"user-defined-model",${user},"thinking":{"type":"enabled","budget_tokens":-1}}`, expectField: "reasoning.effort", expectValue: "auto" },
    // Same-protocol: body configs are validated strictly against the model range
    { name: "86", from: "claude", to: "claude", model: "claude-budget-model", inputJSON: `{"model":"claude-budget-model",${user},"thinking":{"type":"enabled","budget_tokens":8192}}`, expectField: "thinking.budget_tokens", expectValue: "8192" },
    { name: "87", from: "claude", to: "claude", model: "claude-budget-model", inputJSON: `{"model":"claude-budget-model",${user},"thinking":{"type":"enabled","budget_tokens":200000}}`, expectErr: true },
  ]);
});

// TestThinkingE2EClaudeAdaptive_Body, C subgroup: Claude adaptive + effort cross-protocol conversion.
describe("ThinkingE2EClaudeAdaptive_Body", () => {
  const adaptive = (model: string, effort: string) => `{"model":"${model}",${user},"thinking":{"type":"adaptive"},"output_config":{"effort":"${effort}"}}`;
  runThinkingTests([
    { name: "C1", from: "claude", to: "openai", model: "level-model", inputJSON: adaptive("level-model", "minimal"), expectField: "reasoning_effort", expectValue: "minimal" },
    { name: "C2", from: "claude", to: "openai", model: "level-model", inputJSON: adaptive("level-model", "low"), expectField: "reasoning_effort", expectValue: "low" },
    { name: "C3", from: "claude", to: "openai", model: "level-model", inputJSON: adaptive("level-model", "medium"), expectField: "reasoning_effort", expectValue: "medium" },
    { name: "C4", from: "claude", to: "openai", model: "level-model", inputJSON: adaptive("level-model", "high"), expectField: "reasoning_effort", expectValue: "high" },
    { name: "C5", from: "claude", to: "openai", model: "level-model", inputJSON: adaptive("level-model", "xhigh"), expectField: "reasoning_effort", expectValue: "high" },
    { name: "C6", from: "claude", to: "openai", model: "level-model", inputJSON: adaptive("level-model", "max"), expectField: "reasoning_effort", expectValue: "high" },
    { name: "C7", from: "claude", to: "openai", model: "no-thinking-model", inputJSON: adaptive("no-thinking-model", "high") },
    { name: "C8", from: "claude", to: "gemini", model: "level-subset-model", inputJSON: adaptive("level-subset-model", "high"), expectField: "generationConfig.thinkingConfig.thinkingLevel", expectValue: "high" },
    { name: "C9", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: adaptive("gemini-budget-model", "low"), expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "1024" },
    { name: "C10", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: adaptive("gemini-budget-model", "medium"), expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "8192" },
    { name: "C11", from: "claude", to: "gemini", model: "gemini-budget-model", inputJSON: adaptive("gemini-budget-model", "high"), expectField: "generationConfig.thinkingConfig.thinkingBudget", expectValue: "20000" },
    { name: "C13", from: "claude", to: "gemini", model: "gemini-mixed-model", inputJSON: adaptive("gemini-mixed-model", "high"), expectField: "generationConfig.thinkingConfig.thinkingLevel", expectValue: "high" },
    { name: "C14", from: "claude", to: "codex", model: "level-model", inputJSON: adaptive("level-model", "minimal"), expectField: "reasoning.effort", expectValue: "minimal" },
    { name: "C15", from: "claude", to: "codex", model: "level-model", inputJSON: adaptive("level-model", "low"), expectField: "reasoning.effort", expectValue: "low" },
    { name: "C16", from: "claude", to: "codex", model: "level-model", inputJSON: adaptive("level-model", "high"), expectField: "reasoning.effort", expectValue: "high" },
    { name: "C17", from: "claude", to: "codex", model: "level-model", inputJSON: adaptive("level-model", "xhigh"), expectField: "reasoning.effort", expectValue: "high" },
    { name: "C18", from: "claude", to: "codex", model: "level-model", inputJSON: adaptive("level-model", "max"), expectField: "reasoning.effort", expectValue: "high" },
    { name: "C20", from: "claude", to: "claude", model: "claude-sonnet-4-6-model", inputJSON: adaptive("claude-sonnet-4-6-model", "medium"), expectField: "thinking.type", expectValue: "adaptive", expectField2: "output_config.effort", expectValue2: "medium" },
    { name: "C21", from: "claude", to: "claude", model: "claude-opus-4-6-model", inputJSON: adaptive("claude-opus-4-6-model", "max"), expectField: "thinking.type", expectValue: "adaptive", expectField2: "output_config.effort", expectValue2: "max" },
    { name: "C22", from: "claude", to: "claude", model: "claude-opus-4-6-model", inputJSON: adaptive("claude-opus-4-6-model", "xhigh"), expectErr: true },
    { name: "C23", from: "claude", to: "claude", model: "claude-sonnet-4-6-model", inputJSON: adaptive("claude-sonnet-4-6-model", "high"), expectField: "thinking.type", expectValue: "adaptive", expectField2: "output_config.effort", expectValue2: "high" },
    { name: "C24", from: "claude", to: "claude", model: "claude-sonnet-4-6-model", inputJSON: adaptive("claude-sonnet-4-6-model", "max"), expectErr: true },
    { name: "C25", from: "claude", to: "claude", model: "claude-sonnet-4-6-model", inputJSON: adaptive("claude-sonnet-4-6-model", "xhigh"), expectErr: true },
  ]);
});

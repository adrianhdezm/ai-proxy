// Ported from: internal/config/gemini_keys_normalization_test.go
// Skipped cases: interactions-api-key assertions (family not carried).
import { expect, test } from "bun:test";
import { parseConfig, sanitizeGeminiKeys } from "../../src/config/load.ts";
import type { ApiKeyCredential } from "../../src/config/types.ts";

function entry(partial: Partial<ApiKeyCredential>): ApiKeyCredential {
  return { apiKey: "", baseUrl: "", models: [], proxyUrl: "", prefix: "", label: "", headers: {}, priority: 0, excludedModels: [], ...partial };
}

test("SanitizeGeminiKeys allows empty API key with base URL", () => {
  const out = sanitizeGeminiKeys([
    entry({ apiKey: "" }), // empty key without base URL, should be dropped
    entry({ apiKey: "  " }), // whitespace key without base URL, should be dropped
    entry({ apiKey: "", baseUrl: "https://custom-gemini.example.com", headers: { "Header-A": "1" } }),
    entry({ apiKey: "", baseUrl: "https://custom-gemini.example.com", headers: { "Header-B": "2" } }),
    entry({ apiKey: "key-1", baseUrl: "https://custom-gemini.example.com" }),
  ]);
  expect(out.length).toBe(3);
  expect(out[0]!.baseUrl).toBe("https://custom-gemini.example.com");
});

test("duplicate gemini keys collapse and both list spellings are accepted", () => {
  const cfg = parseConfig(`
gemini-api-key:
  - "AIza-plain"
  - api-key: "AIza-plain"
  - api-key: " AIza-object "
    prefix: "/team/"
    base-url: " https://gl.example.com "
  - api-key: "AIza-object"
    prefix: "team"
    base-url: "https://gl.example.com"
generative-language-api-key:
  - "AIza-legacy"
  - "AIza-plain"
`);
  expect(cfg.geminiApiKeys.map((k) => [k.apiKey, k.prefix, k.baseUrl])).toEqual([
    ["AIza-plain", "", ""],
    ["AIza-object", "team", "https://gl.example.com"],
    ["AIza-legacy", "", ""],
  ]);
});

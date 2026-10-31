// Ported from: internal/config/oauth_model_alias_test.go
// Skipped cases: the oauth-request-scoped-errors half of TestParseConfigOAuthMetaChannel (request-scoped error
//   rules are not carried).
// Adapted: TestParseConfigOAuthMetaChannel runs on the codex channel (the meta provider is not carried);
//   TestSanitizeOAuthModelAlias_AllowsMultipleAliasesForSameName keeps its antigravity fixture as an opaque
//   channel name.
import { expect, test } from "bun:test";
import { parseConfig, sanitizeOAuthModelAlias } from "../../src/config/load.ts";

test("TestSanitizeOAuthModelAlias_PreservesOptionalFields", () => {
  const out = sanitizeOAuthModelAlias({
    " CoDeX ": [
      { name: " gpt-5 ", alias: " g5 ", fork: true, displayName: " GPT Five ", forceMapping: true },
      { name: "gpt-6", alias: "g6" },
    ],
  });
  const aliases = out.codex!;
  expect(aliases).toHaveLength(2);
  expect(aliases[0]).toEqual({ name: "gpt-5", alias: "g5", fork: true, displayName: "GPT Five", forceMapping: true });
  expect(aliases[1]).toEqual({ name: "gpt-6", alias: "g6", fork: false, displayName: "", forceMapping: false });
});

test("TestSanitizeOAuthModelAlias_AllowsMultipleAliasesForSameName", () => {
  const out = sanitizeOAuthModelAlias({
    antigravity: [
      { name: "gemini-claude-opus-4-5-thinking", alias: "claude-opus-4-5-20251101", fork: true },
      { name: "gemini-claude-opus-4-5-thinking", alias: "claude-opus-4-5-20251101-thinking", fork: true },
      { name: "gemini-claude-opus-4-5-thinking", alias: "claude-opus-4-5", fork: true },
    ],
  });
  const expected = [
    { name: "gemini-claude-opus-4-5-thinking", alias: "claude-opus-4-5-20251101", fork: true },
    { name: "gemini-claude-opus-4-5-thinking", alias: "claude-opus-4-5-20251101-thinking", fork: true },
    { name: "gemini-claude-opus-4-5-thinking", alias: "claude-opus-4-5", fork: true },
  ];
  const aliases = out.antigravity!;
  expect(aliases).toHaveLength(expected.length);
  expected.forEach((exp, i) => {
    expect(aliases[i]!.name).toBe(exp.name);
    expect(aliases[i]!.alias).toBe(exp.alias);
    expect(aliases[i]!.fork).toBe(exp.fork);
  });
});

test("TestParseConfigOAuthMetaChannel (codex channel)", () => {
  const cfg = parseConfig(
    `
oauth-model-alias:
  codex:
    - name: "gpt-5.4"
      alias: "codex-latest"
      fork: true
      force-mapping: true
oauth-excluded-models:
  codex:
    - "gpt-5.1"
`,
    { env: {}, home: "/home/tester", warn: () => {} },
  );
  const aliases = cfg.oauthModelAlias!.codex!;
  expect(aliases).toHaveLength(1);
  expect(aliases[0]).toMatchObject({ name: "gpt-5.4", alias: "codex-latest", fork: true, forceMapping: true });
  expect(cfg.oauthExcludedModels!.codex).toEqual(["gpt-5.1"]);
});

test("v8 oauth.model-alias / oauth.excluded-models layout and normalisation", () => {
  const cfg = parseConfig(
    `
oauth:
  model-alias:
    " Claude ":
      - {name: claude-opus-4-6, alias: opus, display-name: " Opus "}
      - {name: claude-opus-4-6, alias: OPUS}
      - {name: same, alias: Same}
  excluded-models:
    " CODEX ": [" GPT-5.1* ", "gpt-5.1*", ""]
`,
    { env: {}, home: "/home/tester", warn: () => {} },
  );
  expect(cfg.oauthModelAlias).toEqual({ claude: [{ name: "claude-opus-4-6", alias: "opus", fork: false, displayName: "Opus", forceMapping: false }] });
  expect(cfg.oauthExcludedModels).toEqual({ codex: ["gpt-5.1*"] });
});

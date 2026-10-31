// Ported from: internal/config/is_compat_test.go
// Skipped cases: TestCodexModelSupportConfigurationUpdate (flag not carried), JSON decode variants (YAML only in this port).
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

test("Codex model is-compat config decoding", () => {
  const yamlConfig = `codex-api-key:
  - api-key: key
    models:
      - name: deepseek-upstream
        alias: deepseek-alias
        is-compat: true
      - name: native-upstream
        alias: native-alias
`;
  const cfg = parseConfig(yamlConfig);
  expect(cfg.codexApiKeys.length).toBe(1);
  expect(cfg.codexApiKeys[0]!.models.length).toBe(2);
  expect(cfg.codexApiKeys[0]!.models[0]!.isCompat).toBe(true);
  expect(cfg.codexApiKeys[0]!.models[1]!.isCompat).toBe(false);
});

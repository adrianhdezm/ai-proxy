// Ported from: internal/translator/common/codex_replay_signature_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { codexReplaySignatureForTarget } from "../../../src/translator/common/codex_replay_signature.ts";
import { encodeBase64, rawURLEncoding } from "../../../src/util/base64.ts";

// Shape-valid synthetic Meta envelope: "Q-PaDgE" pins the observed five-byte header,
// and 1426 unpadded base64url chars decode to 45 + 1024 bytes.
function testCodexReplayMetaSignature(): string {
  return "Q-PaDgE" + "A".repeat(1419);
}

function testCodexReplayGPTSignature(): string {
  const decoded = new Uint8Array(89);
  decoded[0] = 0x80;
  for (let i = 9; i < decoded.length; i++) decoded[i] = i;
  return encodeBase64(decoded, rawURLEncoding);
}

describe("codexReplaySignatureForTarget", () => {
  const metaSig = testCodexReplayMetaSignature();
  const routedSig = metaSig + "." + "Ab3".repeat(23).slice(0, 67);
  const gptSig = testCodexReplayGPTSignature();
  const routedGPT = gptSig + "." + "Ab3".repeat(27).slice(0, 79);

  const cases: { name: string; model: string; sig: string; want: string | undefined }[] = [
    { name: "native meta on muse target", model: "muse-spark-1.3", sig: metaSig, want: metaSig },
    { name: "routed meta on muse target", model: "meta/muse-wonder", sig: routedSig, want: routedSig },
    { name: "gpt on gpt target", model: "gpt-5.4", sig: gptSig, want: gptSig },
    { name: "routed gpt on openrouter gpt target", model: "openrouter/openai/gpt-5.6-luna-pro", sig: routedGPT, want: routedGPT },
    { name: "gpt cache prefix normalized", model: "gpt-5.4", sig: "gpt#" + gptSig, want: gptSig },
    { name: "meta sig on gpt target rejected", model: "gpt-5.4", sig: metaSig, want: undefined },
    { name: "routed meta on gpt target rejected", model: "gpt-5.4", sig: routedSig, want: undefined },
    { name: "gpt sig on meta target rejected", model: "muse-spark-1.3", sig: gptSig, want: undefined },
    // An unmapped target defaults to the Codex GPT family.
    { name: "gpt on unmapped target", model: "deepseek-v4", sig: gptSig, want: gptSig },
    { name: "meta on unmapped target rejected", model: "deepseek-v4", sig: metaSig, want: undefined },
    { name: "empty signature", model: "gpt-5.4", sig: "", want: undefined },
    { name: "unknown format", model: "gpt-5.4", sig: "opaque-blob-xyz", want: undefined },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(codexReplaySignatureForTarget(tc.model, tc.sig)).toBe(tc.want);
    });
  }
});

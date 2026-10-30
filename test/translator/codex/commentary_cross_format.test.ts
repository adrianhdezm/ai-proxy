// Ported from: internal/translator/codex/claude/codex_claude_commentary_cross_format_test.go
// Skipped cases: TestCommentaryMarkerRestoredByOpenAIChatTranslator, TestCommentaryMarkerRestoredByGeminiTranslator,
//   TestCommentaryMarkerRestoredByInteractionsTranslator, TestCommentaryMarkerRestoredByAntigravityTranslator
//   (they exercise other translators; the shared payload and assertion are kept and applied to the
//   Codex translator, which owns the marker in this slice)
import { expect, test } from "bun:test";
import { convertClaudeRequestToCodex, convertClaudeRequestToCodexWithCompat } from "../../../src/translator/codex/claude/index.ts";

// A client may replay CPA-relayed commentary history to a non-Codex upstream.
// Every Claude request translator must restore the internal marker as plain
// assistant text before its own thinking handling, and the marker literal must
// never appear in the translated request.
const crossFormatCommentaryPayload = `{"model":"test-model","messages":[{"role":"user","content":"First turn"},{"role":"assistant","content":[{"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"cpa:commentary:v1"},{"type":"text","text":"FINAL_SENTINEL"}]},{"role":"user","content":"Next turn"}]}`;

function assertCommentaryRestoredAsText(out: string): void {
  expect(out).not.toContain("cpa:commentary:v1");
  expect(out).toContain("COMMENTARY_SENTINEL");
  expect(out).toContain("FINAL_SENTINEL");
}

test("commentary marker restored by Codex translator", () => {
  assertCommentaryRestoredAsText(convertClaudeRequestToCodex("test-model", crossFormatCommentaryPayload, false));
  assertCommentaryRestoredAsText(convertClaudeRequestToCodexWithCompat("test-model", crossFormatCommentaryPayload, false));
});

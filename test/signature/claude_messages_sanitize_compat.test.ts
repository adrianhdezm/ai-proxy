// Ported from: internal/signature/claude_messages_sanitize_compat_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import {
  codexCommentarySignatureMarker,
  restoreCodexCommentaryMarkers,
  sanitizeClaudeMessagesForClaudeUpstream,
  sanitizeClaudeMessagesSignaturesForModel,
} from "../../src/signature/index.ts";
import { garray, getAt } from "../../src/util/gpath.ts";

const at = (payload: string, path: string): unknown => getAt(JSON.parse(payload), path);

test("SanitizeClaudeMessagesForClaudeUpstream preserves empty thinking in compat mode", () => {
  const input = '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":""}]}]}';

  const withoutCompat = sanitizeClaudeMessagesForClaudeUpstream(input, "deepseek-v4").payload;
  expect(garray(at(withoutCompat, "messages.0.content")).length).toBe(0);

  const withCompat = sanitizeClaudeMessagesForClaudeUpstream(input, "deepseek-v4", true).payload;
  expect(at(withCompat, "messages.0.content.0.type")).toBe("thinking");
  expect(at(withCompat, "messages.0.content.0.signature")).toBe("");
});

test("SanitizeClaudeMessagesForClaudeUpstream restores commentary marker as text", () => {
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"${codexCommentarySignatureMarker}"},{"type":"text","text":"FINAL_SENTINEL"}]}]}`;

  for (const compat of [false, true]) {
    const out = sanitizeClaudeMessagesForClaudeUpstream(input, "deepseek-v4", compat).payload;
    expect(garray(at(out, "messages.0.content")).length).toBe(2);
    expect(at(out, "messages.0.content.0.type")).toBe("text");
    expect(at(out, "messages.0.content.0.text")).toBe("COMMENTARY_SENTINEL");
    expect(at(out, "messages.0.content.0.signature")).toBeUndefined();
    expect(at(out, "messages.0.content.1.text")).toBe("FINAL_SENTINEL");
  }
});

test("SanitizeClaudeMessagesSignaturesForModel restores commentary marker as text", () => {
  const input = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"${codexCommentarySignatureMarker}"}]}]}`;

  for (const model of ["claude-sonnet-5", "gpt-5.4", "gemini-3.5-flash", "unknown-model"]) {
    const out = sanitizeClaudeMessagesSignaturesForModel(input, model).payload;
    expect(at(out, "messages.0.content.0.type"), model).toBe("text");
    expect(at(out, "messages.0.content.0.text"), model).toBe("COMMENTARY_SENTINEL");
    expect(at(out, "messages.0.content.0.signature"), model).toBeUndefined();
  }
});

test("RestoreCodexCommentaryMarkers restores text on any target", () => {
  const input = `{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"${codexCommentarySignatureMarker}"},{"type":"text","text":"FINAL_SENTINEL"}]}]}`;

  const { payload: out, restored } = restoreCodexCommentaryMarkers(input);
  expect(restored).toBe(1);
  expect(at(out, "messages.1.content.0.type")).toBe("text");
  expect(at(out, "messages.1.content.0.text")).toBe("COMMENTARY_SENTINEL");
  expect(at(out, "messages.1.content.0.signature")).toBeUndefined();
  expect(at(out, "messages.1.content.1.text")).toBe("FINAL_SENTINEL");

  const untouched = '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"opaque-deepseek-id"}]}]}';
  const again = restoreCodexCommentaryMarkers(untouched);
  expect(again.restored).toBe(0);
  expect(again.payload).toBe(untouched);
});

test("SanitizeClaudeMessagesForClaudeUpstream preserves opaque thinking signature in compat mode", () => {
  const input = '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"opaque-deepseek-id"}]}]}';

  const withoutCompat = sanitizeClaudeMessagesForClaudeUpstream(input, "deepseek-v4").payload;
  expect(at(withoutCompat, "messages.0.content.0.signature") ?? "").toBe("");

  const withCompat = sanitizeClaudeMessagesForClaudeUpstream(input, "deepseek-v4", true).payload;
  expect(at(withCompat, "messages.0.content.0.type")).toBe("thinking");
  expect(at(withCompat, "messages.0.content.0.signature")).toBe("opaque-deepseek-id");
});

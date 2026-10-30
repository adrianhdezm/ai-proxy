// Ported from: internal/translator/codex/claude/codex_claude_commentary_phase_test.go
// Skipped cases: none
//
// GPT-5.x models answer with two message output items: a "commentary" preamble
// and the "final_answer". Only the final answer is a Claude text block; the
// preamble travels as thinking so a text consumer (or a TTS client) gets the
// answer once. The commentary thinking block carries the internal commentary
// marker as its signature so the request translator can restore it on replay.
import { expect, test } from "bun:test";
import { emptyContext } from "../../../src/translator/types.ts";
import { codexCommentarySignatureMarker, convertCodexResponseToClaudeNonStream } from "../../../src/translator/codex/claude/index.ts";
import { collectCodexClaudeBlocks, get } from "./helpers.ts";

test("stream commentary phase is thinking", () => {
  const got = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"commentary"}}`,
    `data: {"type":"response.content_part.added","part":{"type":"output_text"}}`,
    `data: {"type":"response.output_text.delta","delta":"Checking the "}`,
    `data: {"type":"response.output_text.delta","delta":"gate first."}`,
    `data: {"type":"response.content_part.done","part":{"type":"output_text","text":"Checking the gate first."}}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking the gate first."}]}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"final_answer"}}`,
    `data: {"type":"response.content_part.added","part":{"type":"output_text"}}`,
    `data: {"type":"response.output_text.delta","delta":"The merge was refused."}`,
    `data: {"type":"response.content_part.done","part":{"type":"output_text","text":"The merge was refused."}}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"The merge was refused."}]}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(got.thinking).toEqual(["Checking the gate first."]);
  expect(got.text).toEqual(["The merge was refused."]);
  expect(got.signatures).toEqual([codexCommentarySignatureMarker]);
});

test("stream commentary done fallback is thinking", () => {
  // No deltas at all: both items arrive whole on output_item.done.
  const got = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"On it."}]}}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Done: two PRs merged."}]}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(got.thinking).toEqual(["On it."]);
  expect(got.text).toEqual(["Done: two PRs merged."]);
});

test("stream second message done fallback after streamed first message", () => {
  // First message streams deltas; second message arrives whole on output_item.done
  // (both with and without a preceding output_item.added).
  for (const includeSecondAdded of [true, false]) {
    const chunks = [
      `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
      `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"commentary"}}`,
      `data: {"type":"response.output_text.delta","delta":"Checking."}`,
      `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking."}]}}`,
    ];
    if (includeSecondAdded) chunks.push(`data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"final_answer"}}`);
    chunks.push(
      `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"All checks passed."}]}}`,
      `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
    );
    const got = collectCodexClaudeBlocks(chunks);
    expect(got.thinking, `includeSecondAdded=${includeSecondAdded}`).toEqual(["Checking."]);
    expect(got.text, `includeSecondAdded=${includeSecondAdded}`).toEqual(["All checks passed."]);
  }
});

test("stream commentary does not take reasoning signature", () => {
  // reasoning item (with encrypted_content) -> commentary message -> final_answer:
  // the reasoning signature belongs to the reasoning block; the commentary block
  // carries only the internal commentary marker.
  const got = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"pre"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think"}`,
    `data: {"type":"response.reasoning_summary_part.done"}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"enc_sig"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"commentary"}}`,
    `data: {"type":"response.output_text.delta","delta":"Looking."}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Looking."}]}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"final_answer"}}`,
    `data: {"type":"response.output_text.delta","delta":"All green."}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"All green."}]}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(got.thinking).toEqual(["Let me think", "Looking."]);
  expect(got.signatures).toEqual(["enc_sig", codexCommentarySignatureMarker]);
  expect(got.text).toEqual(["All green."]);

  // Also verify when a reasoning item's output_item.added parked encrypted_content
  // before any summary delta opened a block, a commentary block does not consume it.
  const parkedGot = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"parked_sig"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"commentary"}}`,
    `data: {"type":"response.output_text.delta","delta":"Checking."}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking."}]}}`,
    `data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"Thought."}],"encrypted_content":""}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(parkedGot.thinking).toEqual(["Checking.", "Thought."]);
  expect(parkedGot.signatures).toEqual([codexCommentarySignatureMarker, "parked_sig"]);
});

test("stream unclosed reasoning closes before commentary starts", () => {
  // If a reasoning item never emitted output_item.done before a commentary message
  // starts, its thinking block must still close (with its fallback signature)
  // before the commentary thinking block opens.
  const got = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_fallback"}}`,
    `data: {"type":"response.reasoning_summary_part.added"}`,
    `data: {"type":"response.reasoning_summary_text.delta","delta":"Reasoning step"}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"commentary"}}`,
    `data: {"type":"response.content_part.added","part":{"type":"output_text"}}`,
    `data: {"type":"response.output_text.delta","delta":"Commentary step"}`,
    `data: {"type":"response.content_part.done","part":{"type":"output_text","text":"Commentary step"}}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Commentary step"}]}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(got.thinking).toEqual(["Reasoning step", "Commentary step"]);
  expect(got.signatures).toEqual(["enc_fallback", codexCommentarySignatureMarker]);
});

test("stream final_answer only unchanged", () => {
  const got = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"final_answer"}}`,
    `data: {"type":"response.output_text.delta","delta":"Hi."}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Hi."}]}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(got.thinking).toEqual([]);
  expect(got.text).toEqual(["Hi."]);
});

test("non-stream commentary phase is thinking", () => {
  const raw = `{"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[
    {"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Checking the gate first."}]},
    {"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"The merge was refused."}]}
  ],"usage":{"input_tokens":1,"output_tokens":1}}}`;
  const out = convertCodexResponseToClaudeNonStream(emptyContext, "", `{"messages":[]}`, "", raw, {});
  const content = get(out, "content") as unknown[];
  expect(content.length).toBe(2);
  expect(get(out, "content.0.type")).toBe("thinking");
  expect(get(out, "content.0.thinking")).toBe("Checking the gate first.");
  expect(get(out, "content.0.signature")).toBe(codexCommentarySignatureMarker);
  expect(get(out, "content.1.type")).toBe("text");
  expect(get(out, "content.1.text")).toBe("The merge was refused.");
});

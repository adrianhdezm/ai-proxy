// Ported from: internal/translator/codex/claude/codex_claude_commentary_replay_test.go
// Skipped cases: none
//
// The internal commentary marker is an implementation contract between the
// Codex-to-Claude response translator and the Claude-to-Codex request
// translator. It must never be forwarded to an upstream as a signature.
import { expect, test } from "bun:test";
import { emptyContext } from "../../../src/translator/types.ts";
import {
  codexCommentarySignatureMarker,
  convertClaudeRequestToCodex,
  convertClaudeRequestToCodexWithCompat,
  convertCodexResponseToClaudeNonStream,
} from "../../../src/translator/codex/claude/index.ts";
import { getAt } from "../../../src/util/gpath.ts";
import { collectCodexClaudeBlocks, get } from "./helpers.ts";

const testCommentaryMarkerSignature = codexCommentarySignatureMarker;

test("non-stream commentary carries internal marker", () => {
  const raw = `{"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[
    {"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"COMMENTARY_SENTINEL"}]},
    {"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"FINAL_SENTINEL"}]}
  ],"usage":{"input_tokens":1,"output_tokens":1}}}`;
  const out = convertCodexResponseToClaudeNonStream(emptyContext, "", `{"messages":[]}`, "", raw, {});
  expect((get(out, "content") as unknown[]).length).toBe(2);
  expect(get(out, "content.0.type")).toBe("thinking");
  expect(get(out, "content.0.thinking")).toBe("COMMENTARY_SENTINEL");
  expect(get(out, "content.0.signature")).toBe(testCommentaryMarkerSignature);
  expect(get(out, "content.1.type")).toBe("text");
  expect(get(out, "content.1.text")).toBe("FINAL_SENTINEL");
});

test("stream commentary carries internal marker", () => {
  const got = collectCodexClaudeBlocks([
    `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"commentary"}}`,
    `data: {"type":"response.content_part.added","part":{"type":"output_text"}}`,
    `data: {"type":"response.output_text.delta","delta":"COMMENTARY_SENTINEL"}`,
    `data: {"type":"response.content_part.done","part":{"type":"output_text","text":"COMMENTARY_SENTINEL"}}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"COMMENTARY_SENTINEL"}]}}`,
    `data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"final_answer"}}`,
    `data: {"type":"response.output_text.delta","delta":"FINAL_SENTINEL"}`,
    `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"FINAL_SENTINEL"}]}}`,
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
  ]);
  expect(got.thinking).toEqual(["COMMENTARY_SENTINEL"]);
  expect(got.signatures).toEqual([testCommentaryMarkerSignature]);
  expect(got.text).toEqual(["FINAL_SENTINEL"]);
});

test("ConvertClaudeRequestToCodex commentary marker restores commentary message", () => {
  const payload = `{"model":"gpt-6.1-sol","max_tokens":128,"messages":[
    {"role":"user","content":"First turn"},
    {"role":"assistant","content":[
      {"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"${testCommentaryMarkerSignature}"},
      {"type":"text","text":"FINAL_SENTINEL"}
    ]},
    {"role":"user","content":"Next turn"}
  ]}`;
  for (const stream of [false, true]) {
    const result = convertClaudeRequestToCodex("gpt-6.1-sol", payload, stream);
    expect(result).not.toContain(testCommentaryMarkerSignature);
    const inputs = get(result, "input") as unknown[];
    expect(inputs.length).toBe(4);
    const commentary = inputs[1];
    expect(getAt(commentary, "type")).toBe("message");
    expect(getAt(commentary, "role")).toBe("assistant");
    expect(getAt(commentary, "phase")).toBe("commentary");
    expect(getAt(commentary, "content.0.type")).toBe("output_text");
    expect(getAt(commentary, "content.0.text")).toBe("COMMENTARY_SENTINEL");
    const final = inputs[2];
    expect(getAt(final, "type")).toBe("message");
    expect(getAt(final, "role")).toBe("assistant");
    expect(getAt(final, "phase")).toBeUndefined();
    expect(getAt(final, "content.0.text")).toBe("FINAL_SENTINEL");
    for (const item of inputs) expect(getAt(item, "type")).not.toBe("reasoning");
  }
});

test("ConvertClaudeRequestToCodex commentary marker before tool_use survives tool round trip", () => {
  const payload = `{"model":"gpt-6.1-sol","messages":[
    {"role":"user","content":"First turn"},
    {"role":"assistant","content":[
      {"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"${testCommentaryMarkerSignature}"},
      {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}
    ]},
    {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}
  ]}`;
  const result = convertClaudeRequestToCodex("gpt-6.1-sol", payload, false);
  expect(result).not.toContain(testCommentaryMarkerSignature);
  const inputs = get(result, "input") as unknown[];
  expect(inputs.length).toBe(4);
  expect(getAt(inputs[1], "phase")).toBe("commentary");
  expect(getAt(inputs[1], "content.0.text")).toBe("COMMENTARY_SENTINEL");
  expect(getAt(inputs[2], "type")).toBe("function_call");
  expect(getAt(inputs[3], "type")).toBe("function_call_output");
});

test("ConvertClaudeRequestToCodex commentary marker round trip from response", () => {
  const raw = `{"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[
    {"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"COMMENTARY_SENTINEL"}]},
    {"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"FINAL_SENTINEL"}]}
  ],"usage":{"input_tokens":1,"output_tokens":1}}}`;
  const claudeResponse = convertCodexResponseToClaudeNonStream(emptyContext, "", `{"messages":[]}`, "", raw, {});
  const content = JSON.stringify(get(claudeResponse, "content"));

  const replay = `{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"First turn"},{"role":"assistant","content":${content}},{"role":"user","content":"Next turn"}]}`;
  const result = convertClaudeRequestToCodex("gpt-6.1-sol", replay, false);
  expect(result).toContain("COMMENTARY_SENTINEL");
  expect(result).toContain("FINAL_SENTINEL");
  expect(result).not.toContain(testCommentaryMarkerSignature);
});

test("ConvertClaudeRequestToCodexWithCompat commentary marker restores text not reasoning", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"COMMENTARY_SENTINEL","signature":"${testCommentaryMarkerSignature}"}]}]}`;
  const result = convertClaudeRequestToCodexWithCompat("deepseek-v4", payload, false);
  expect(result).not.toContain(testCommentaryMarkerSignature);
  const inputs = get(result, "input") as unknown[];
  expect(inputs.length).toBe(1);
  expect(getAt(inputs[0], "type")).toBe("message");
  expect(getAt(inputs[0], "phase")).toBe("commentary");
  expect(getAt(inputs[0], "content.0.text")).toBe("COMMENTARY_SENTINEL");
});

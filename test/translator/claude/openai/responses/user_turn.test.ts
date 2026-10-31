// Ported from: internal/translator/claude/openai/responses/claude_openai-responses_user_turn_test.go
// Skipped cases: none (the registry envelope check becomes a defaultRegistry.translateRequest throw)
import { describe, expect, test } from "bun:test";
import {
  convertOpenAIResponsesRequestToClaudeResult,
} from "../../../../../src/translator/claude/openai/responses/index.ts";
import { UnsupportedPartError } from "../../../../../src/translator/common/parts.ts";
import { defaultRegistry } from "../../../../../src/translator/registry.ts";
import { FormatClaude, FormatOpenAIResponse } from "../../../../../src/translator/types.ts";
import { get, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

const responsesUserHello = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}`;
const responsesAssistantHi = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}`;
const responsesUserNext = `{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}`;
const responsesFileIDPart = `{"type":"input_file","file_id":"file-1"}`;
const responsesAudioPart = `{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}`;
const responsesTextPart = `{"type":"input_text","text":"keep me"}`;
const responsesInlineFile = `{"type":"input_file","filename":"a.pdf","file_data":"data:application/pdf;base64,JVBERi0xLjQK"}`;
const responsesDeveloperMsg = `{"type":"message","role":"developer","content":[{"type":"input_text","text":"dev"}]}`;

const userTurn = (...parts: string[]): string => `{"type":"message","role":"user","content":[${parts.join(",")}]}`;
function payload(instructions: string, ...items: string[]): string {
  let prefix = `{"model":"claude-sonnet-4",`;
  if (instructions !== "") prefix += `"instructions":"${instructions}",`;
  return `${prefix}"input":[${items.join(",")}]}`;
}
const compat = (input: string) => convertOpenAIResponsesRequestToClaudeResult("claude-sonnet-4", input, false, true, true);
const plain = (input: string) => convertOpenAIResponsesRequestToClaudeResult("claude-sonnet-4", input, false, false, true);

describe("refuses any emptied user turn", () => {
  const cases: [string, string, string][] = [
    ["history then file id only", payload("", responsesUserHello, responsesAssistantHi, userTurn(responsesFileIDPart)), "input_file"],
    ["audio only after history", payload("", responsesUserHello, responsesAssistantHi, userTurn(responsesAudioPart)), "input_audio"],
    ["instructions and developer prompt do not hide the empty turn", payload("sys", responsesDeveloperMsg, userTurn(responsesFileIDPart)), "input_file"],
    ["emptied turn before a later text turn", payload("", userTurn(responsesFileIDPart), responsesAssistantHi, responsesUserNext), "input_file"],
    ["file url carries no bytes", payload("", userTurn(`{"type":"input_file","file_url":"https://example.test/a.pdf"}`)), "input_file"],
  ];
  for (const [name, input, wantType] of cases) {
    test(name, () => {
      const { body, err } = compat(input);
      expect(err).toBeInstanceOf(UnsupportedPartError);
      expect((err as UnsupportedPartError).type).toBe(wantType);
      expect((err as UnsupportedPartError).statusCode).toBe(400);
      expect(err!.message).toBe("unsupported content part: " + wantType);
      expect(() => JSON.parse(body)).not.toThrow();
      let thrown: unknown;
      try {
        defaultRegistry.translateRequest(FormatOpenAIResponse, FormatClaude, "claude-sonnet-4", input, false);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UnsupportedPartError);
      expect((thrown as UnsupportedPartError).type).toBe(wantType);
    });
  }
});

describe("keeps turn with text beside attachment", () => {
  for (const [name, attachment] of Object.entries({ "file id": responsesFileIDPart, audio: responsesAudioPart })) {
    test(name, () => {
      const { body, err } = compat(payload("", responsesUserHello, responsesAssistantHi, userTurn(responsesTextPart, attachment)));
      expect(err).toBeUndefined();
      expect(get(body, "messages.2.content")).toBe("keep me");
    });
  }
});

test("inline file stays a document", () => {
  const { body, err } = compat(payload("", responsesUserHello, responsesAssistantHi, userTurn(responsesInlineFile)));
  expect(err).toBeUndefined();
  const part = get(body, "messages.2.content.0");
  expect(part.type).toBe("document");
  expect(part.source.data).toBe("JVBERi0xLjQK");
});

test("exported wrappers keep a JSON body", () => {
  const input = payload("", userTurn(responsesFileIDPart));
  const p = plain(input);
  const c = compat(input);
  for (const r of [p, c]) expect(() => JSON.parse(r.body)).not.toThrow();
  expect(p.err).toBeDefined();
  expect(c.err).toBeDefined();
});

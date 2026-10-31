// Ported from: internal/translator/gemini/openai/responses/gemini_openai-responses_user_turn_test.go
// Skipped cases: TestConvertOpenAIResponsesRequestToGemini_ExportedWrapperKeepsAJSONBody (TS request transforms throw
// instead of returning a body alongside the error); the TranslateRequestEnvelope check uses the registry's translateRequest
import { describe, expect, test } from "bun:test";
import { UnsupportedPartError } from "../../../../../src/translator/common/parts.ts";
import "../../../../../src/translator/gemini/openai/responses/index.ts";
import { translateRequest } from "../../../../../src/translator/registry.ts";
import { FormatGemini, FormatOpenAIResponse } from "../../../../../src/translator/types.ts";
import { g, toGeminiErr } from "./helpers.ts";

const hello = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}`;
const assistant = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}`;
const next = `{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}`;
const developer = `{"type":"message","role":"developer","content":[{"type":"input_text","text":"dev"}]}`;
const fileID = `{"type":"input_file","file_id":"file-1"}`;
const fileData = `{"type":"input_file","filename":"a.pdf","file_data":"data:application/pdf;base64,JVBERi0xLjQK"}`;
const fileURL = `{"type":"input_file","file_url":"https://example.test/a.pdf","filename":"a.pdf"}`;
const text = `{"type":"input_text","text":"keep me"}`;
const emptyText = `{"type":"input_text","text":""}`;

const userTurn = (...parts: string[]): string => `{"type":"message","role":"user","content":[${parts.join(",")}]}`;
const payload = (instructions: string, ...items: string[]): string =>
  `{"model":"gemini-3-pro",${instructions !== "" ? `"instructions":"${instructions}",` : ""}"input":[${items.join(",")}]}`;

describe("TestConvertOpenAIResponsesRequestToGemini_RefusesAnyEmptiedUserTurn", () => {
  const cases = [
    { name: "file id only", input: payload("", userTurn(fileID)) },
    { name: "history then file id only", input: payload("", hello, assistant, userTurn(fileID)) },
    { name: "instructions and developer prompt do not hide the empty turn", input: payload("sys", developer, userTurn(fileID)) },
    { name: "emptied turn before a later text turn", input: payload("", userTurn(fileID), assistant, next) },
    { name: "empty text beside the file id does not count as sendable", input: payload("", hello, assistant, userTurn(emptyText, fileID)) },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const [, err] = toGeminiErr("gemini-3-pro", c.input);
      expect(err).toBeInstanceOf(UnsupportedPartError);
      expect((err as UnsupportedPartError).type).toBe("input_file");
      expect((err as UnsupportedPartError).statusCode).toBe(400);
      expect(err!.message).toBe("unsupported content part: input_file");
      let registryErr: unknown;
      try {
        translateRequest(FormatOpenAIResponse, FormatGemini, "gemini-3-pro", c.input, false);
      } catch (e) {
        registryErr = e;
      }
      expect(registryErr).toBeInstanceOf(UnsupportedPartError);
      expect((registryErr as UnsupportedPartError).type).toBe("input_file");
    });
  }
});

test("TestConvertOpenAIResponsesRequestToGemini_KeepsTurnWithTextBesideFileID", () => {
  const [body, err] = toGeminiErr("gemini-3-pro", payload("", hello, assistant, userTurn(text, fileID)));
  expect(err).toBeUndefined();
  expect(g(body, "contents.2.parts.0.text").str()).toBe("keep me");
});

describe("TestConvertOpenAIResponsesRequestToGemini_InlineAndRemoteFilesStayParts", () => {
  for (const [name, c] of Object.entries({
    "inline bytes": { part: fileData, path: "contents.2.parts.0.inline_data.mime_type", want: "application/pdf" },
    "remote url": { part: fileURL, path: "contents.2.parts.0.file_data.file_uri", want: "https://example.test/a.pdf" },
  })) {
    test(name, () => {
      const [body, err] = toGeminiErr("gemini-3-pro", payload("", hello, assistant, userTurn(c.part)));
      expect(err).toBeUndefined();
      expect(g(body, c.path).str()).toBe(c.want);
    });
  }
});

// Skipped: TestConvertOpenAIResponsesRequestToGemini_ExportedWrapperKeepsAJSONBody — Go returned a
// JSON body alongside the error; the TS request contract throws instead of returning a body.

// Ported from: internal/translator/openai/openai/responses/openai_openai-responses_user_turn_test.go, internal/translator/openai/openai/responses/openai_openai-responses_video_test.go
// Skipped cases: none (the registry half of RefusesAnyEmptiedUserTurn calls defaultRegistry.translateRequest, where the
//   refusal surfaces as a thrown UnsupportedPartError instead of sdktranslator.TranslateRequestEnvelope's Err)
import { describe, expect, test } from "bun:test";
import { FormatOpenAI, FormatOpenAIResponse } from "../../../../../src/translator/types.ts";
import { defaultRegistry } from "../../../../../src/translator/registry.ts";
import { UnsupportedPartError } from "../../../../../src/translator/common/parts.ts";
import {
  convertOpenAIResponsesRequestToOpenAIChatCompletions,
  convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError,
} from "../../../../../src/translator/openai/openai/responses/index.ts";
import { arr, convertReq, get, str } from "./helpers.ts";

const chatTurnHello = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}`;
const chatTurnAssistant = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}`;
const chatTurnNext = `{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}`;
const chatTurnDeveloper = `{"type":"message","role":"developer","content":[{"type":"input_text","text":"dev"}]}`;
const chatTurnFileID = `{"type":"input_file","file_id":"file-1"}`;
const chatTurnFileData = `{"type":"input_file","filename":"a.pdf","file_data":"data:application/pdf;base64,JVBERi0xLjQK"}`;
const chatTurnFileURL = `{"type":"input_file","file_url":"https://example.test/a.pdf"}`;
const chatTurnAudio = `{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}`;
const chatTurnNoAudio = `{"type":"input_audio","input_audio":{"format":"wav"}}`;
const chatTurnText = `{"type":"input_text","text":"keep me"}`;
const chatTurnEmptyText = `{"type":"input_text","text":""}`;

const chatUserTurn = (...parts: string[]) => `{"type":"message","role":"user","content":[${parts.join(",")}]}`;
function chatPayload(instructions: string, ...items: string[]): string {
  let prefix = `{"model":"gpt-5",`;
  if (instructions !== "") prefix += `"instructions":"${instructions}",`;
  return prefix + `"input":[${items.join(",")}]}`;
}

describe("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_RefusesAnyEmptiedUserTurn", () => {
  const cases = [
    { name: "history then file url only", input: chatPayload("", chatTurnHello, chatTurnAssistant, chatUserTurn(chatTurnFileURL)), wantType: "input_file" },
    { name: "audio without bytes", input: chatPayload("", chatTurnHello, chatTurnAssistant, chatUserTurn(chatTurnNoAudio)), wantType: "input_audio" },
    { name: "instructions and developer prompt do not hide the empty turn", input: chatPayload("sys", chatTurnDeveloper, chatUserTurn(chatTurnFileURL)), wantType: "input_file" },
    { name: "emptied turn before a later text turn", input: chatPayload("", chatUserTurn(chatTurnFileURL), chatTurnAssistant, chatTurnNext), wantType: "input_file" },
    { name: "empty text beside the unsendable file does not count as sendable", input: chatPayload("", chatUserTurn(chatTurnEmptyText, chatTurnFileURL)), wantType: "input_file" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const [body, err] = convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError("gpt-5", tc.input, false);
      expect(err).toBeInstanceOf(UnsupportedPartError);
      expect((err as UnsupportedPartError).type).toBe(tc.wantType);
      expect((err as UnsupportedPartError).statusCode).toBe(400);
      expect(err!.message).toBe("unsupported content part: " + tc.wantType);
      expect(() => JSON.parse(body)).not.toThrow();

      let thrown: unknown;
      try {
        defaultRegistry.translateRequest(FormatOpenAIResponse, FormatOpenAI, "gpt-5", tc.input, false);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UnsupportedPartError);
      expect((thrown as UnsupportedPartError).type).toBe(tc.wantType);
    });
  }
});

describe("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_MapsFilesAndAudio", () => {
  const cases: Record<string, { part: string; want: Record<string, string> }> = {
    "file id": { part: chatTurnFileID, want: { type: "file", "file.file_id": "file-1" } },
    "file data": { part: chatTurnFileData, want: { type: "file", "file.file_data": "data:application/pdf;base64,JVBERi0xLjQK", "file.filename": "a.pdf" } },
    audio: { part: chatTurnAudio, want: { type: "input_audio", "input_audio.data": "UklGRg==", "input_audio.format": "wav" } },
  };
  for (const [name, tc] of Object.entries(cases)) {
    test(name, () => {
      const body = convertOpenAIResponsesRequestToOpenAIChatCompletions("gpt-5", chatPayload("", chatTurnHello, chatTurnAssistant, chatUserTurn(tc.part)), false);
      const part = get(body, "messages.2.content.0");
      for (const [path, want] of Object.entries(tc.want)) expect(str(part, path)).toBe(want);
    });
  }
});

test("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_KeepsTurnWithTextBesideAttachment", () => {
  for (const attachment of [chatTurnFileURL, chatTurnNoAudio]) {
    const body = convertOpenAIResponsesRequestToOpenAIChatCompletions("gpt-5", chatPayload("", chatTurnHello, chatTurnAssistant, chatUserTurn(chatTurnText, attachment)), false);
    expect(str(body, "messages.2.content.0.text")).toBe("keep me");
  }
});

test("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_MappedAttachmentBesideTextKeepsBoth", () => {
  const body = convertOpenAIResponsesRequestToOpenAIChatCompletions("gpt-5", chatPayload("", chatUserTurn(chatTurnText, chatTurnFileID, chatTurnAudio)), false);
  expect(arr(body, "messages.0.content").length).toBe(3);
});

test("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_ExportedWrapperKeepsAJSONBody", () => {
  const [body] = convertOpenAIResponsesRequestToOpenAIChatCompletionsWithError("gpt-5", chatPayload("", chatUserTurn(chatTurnFileURL)), false);
  expect(() => JSON.parse(body)).not.toThrow();
});

describe("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_VideoInput", () => {
  const tests = [
    { name: "remote URL", part: `{"type":"input_video","video_url":"https://example.com/clip.mp4?part=1&name=a%20b"}`, want: `{"type":"video_url","video_url":{"url":"https://example.com/clip.mp4?part=1&name=a%20b"}}` },
    { name: "base64 data URL", part: `{"type":"input_video","video_url":"data:video/mp4;base64,AAECAwQ="}`, want: `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,AAECAwQ="}}` },
    {
      name: "processing mode",
      part: `{"type":"input_video","video_url":"https://example.com/clip.webm","processing":"agentic"}`,
      want: `{"type":"video_url","video_url":{"url":"https://example.com/clip.webm","processing":"agentic"}}`,
    },
    {
      name: "object video URL",
      part: `{"type":"input_video","video_url":{"url":"https://example.com/clip.mp4","processing":"static"}}`,
      want: `{"type":"video_url","video_url":{"url":"https://example.com/clip.mp4","processing":"static"}}`,
    },
    {
      name: "chat video part in Responses content",
      part: `{"type":"video_url","video_url":{"url":"data:video/webm;base64,AAECAwQ=","processing":"static"}}`,
      want: `{"type":"video_url","video_url":{"url":"data:video/webm;base64,AAECAwQ=","processing":"static"}}`,
    },
    {
      name: "top-level processing overrides object processing",
      part: `{"type":"input_video","video_url":{"url":"https://example.com/clip.mp4","processing":"static"},"processing":"agentic"}`,
      want: `{"type":"video_url","video_url":{"url":"https://example.com/clip.mp4","processing":"agentic"}}`,
    },
    { name: "missing URL remains a video for upstream validation", part: `{"type":"input_video"}`, want: `{"type":"video_url","video_url":{}}` },
    { name: "invalid URL is not coerced to a string", part: `{"type":"input_video","video_url":123}`, want: `{"type":"video_url","video_url":{"url":123}}` },
  ];
  for (const tt of tests) {
    for (const stream of [false, true]) {
      test(`${tt.name}/stream=${stream}`, () => {
        const out = convertReq(`{"input":[{"role":"user","content":[${tt.part}]}]}`, "video-model", stream);
        const content = arr(out, "messages.0.content");
        expect(content.length).toBe(1);
        expect(content[0]).toEqual(JSON.parse(tt.want));
      });
    }
  }
});

test("ConvertOpenAIResponsesRequestToOpenAIChatCompletions_MixedVideoInputOrder", () => {
  const raw = `{"input":[{"type":"message","role":"user","content":[
    {"type":"input_text","text":"Compare these clips and this image."},
    {"type":"input_video","video_url":"https://example.com/first.mp4"},
    {"type":"input_image","image_url":"https://example.com/frame.png","detail":"low"},
    {"type":"input_video","video_url":"data:video/mp4;base64,AAECAwQ=","processing":"static"},
    {"type":"input_text","text":"Describe the differences."}
  ]}]}`;
  const want = [
    { type: "text", text: "Compare these clips and this image." },
    { type: "video_url", video_url: { url: "https://example.com/first.mp4" } },
    { type: "image_url", image_url: { url: "https://example.com/frame.png", detail: "low" } },
    { type: "video_url", video_url: { url: "data:video/mp4;base64,AAECAwQ=", processing: "static" } },
    { type: "text", text: "Describe the differences." },
  ];
  expect(get(convertReq(raw, "video-model"), "messages.0.content")).toEqual(want);
});

// Ported from: internal/translator/gemini/claude/gemini_claude_user_turn_test.go
// Skipped cases: none (the Go envelope cases use sdktranslator.TranslateRequestEnvelope; here they go through
//   the default registry's translateRequest, whose refusal is a thrown UnsupportedPartError)
import { describe, expect, test } from "bun:test";
import "../../../../src/translator/gemini/claude/index.ts";
import { UnsupportedPartError } from "../../../../src/translator/common/parts.ts";
import { convertClaudeRequestToGeminiWithCompat } from "../../../../src/translator/gemini/claude/request.ts";
import { defaultRegistry } from "../../../../src/translator/registry.ts";
import { FormatClaude, FormatGemini } from "../../../../src/translator/types.ts";
import { getAt, gstr } from "../../../../src/util/gpath.ts";
import { getArr, getStr } from "../helpers.ts";

const userTurnUpload = `{"type":"container_upload","file_id":"file-1"}`;

function refusal(fn: () => string): UnsupportedPartError | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof UnsupportedPartError) return err;
    throw err;
  }
}

describe("ConvertClaudeRequestToGemini_RefusesAnyEmptiedUserTurn", () => {
  const cases = [
    {
      name: "history then attachment only",
      input: `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"text","text":"hi"}]},{"role":"user","content":[${userTurnUpload}]}]}`,
      wantType: "container_upload",
    },
    {
      name: "system prompt and system reminder",
      input: `{"model":"m","system":"sys","messages":[{"role":"system","content":"reminder"},{"role":"user","content":[${userTurnUpload}]}]}`,
      wantType: "container_upload",
    },
    {
      name: "emptied turn before a later text turn",
      input: `{"model":"m","messages":[{"role":"user","content":[${userTurnUpload}]},{"role":"assistant","content":[{"type":"text","text":"ok"}]},{"role":"user","content":"next"}]}`,
      wantType: "container_upload",
    },
    {
      name: "document without bytes",
      input: `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"document","source":{"type":"file","file_id":"file-1"}}]}]}`,
      wantType: "document",
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const err = refusal(() => convertClaudeRequestToGeminiWithCompat("m", tc.input, false));
      expect(err).toBeInstanceOf(UnsupportedPartError);
      expect(err!.type).toBe(tc.wantType);
      expect(err!.statusCode).toBe(400);
      expect(err!.message).toBe("unsupported content part: " + tc.wantType);
    });
  }
});

test("ConvertClaudeRequestToGemini_KeepsTurnWithTextBesideAttachment", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"text","text":"keep me"},${userTurnUpload}]}]}`;
  const body = convertClaudeRequestToGeminiWithCompat("m", input, false);
  expect(getStr(body, "contents.2.parts.0.text")).toBe("keep me");
});

test("ConvertClaudeRequestToGemini_Base64DocumentAfterHistoryStaysInlineData", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQK"}}]}]}`;
  const body = convertClaudeRequestToGeminiWithCompat("m", input, false);
  expect(getStr(body, "contents.2.parts.0.inline_data.mime_type")).toBe("application/pdf");
  expect(getStr(body, "contents.2.parts.0.inline_data.data")).toBe("JVBERi0xLjQK");
});

/** Translates two history turns followed by a final user turn holding the given content parts through the registry. */
function claudeImageTurnToGemini(finalContent: string): { body: string; err: UnsupportedPartError | undefined } {
  const input = `{"model":"m","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":[${finalContent}]}]}`;
  let body = "";
  const err = refusal(() => {
    body = defaultRegistry.translateRequest(FormatClaude, FormatGemini, "m", input, false);
    return body;
  });
  return { body, err };
}

function requireImageRefusal(envelope: { body: string; err: UnsupportedPartError | undefined }): void {
  expect(envelope.err).toBeInstanceOf(UnsupportedPartError);
  expect(envelope.err!.type).toBe("image");
  expect(envelope.err!.statusCode).toBe(400);
  expect(envelope.err!.message).toBe("unsupported content part: image");
}

describe("ClaudeToGeminiUnrepresentableImageOnlyTurnIsRefused", () => {
  const cases: Record<string, string> = {
    "url source": `{"type":"url","url":"https://example.test/a.png"}`,
    "file source": `{"type":"file","file_id":"file-1"}`,
  };
  for (const [name, source] of Object.entries(cases)) {
    test(name, () => {
      requireImageRefusal(claudeImageTurnToGemini(`{"type":"image","source":${source}}`));
    });
  }
});

test("ClaudeToGeminiUnrepresentableImageBesideTextStillSucceeds", () => {
  for (const source of [`{"type":"url","url":"https://example.test/a.png"}`, `{"type":"file","file_id":"file-1"}`]) {
    const envelope = claudeImageTurnToGemini(`{"type":"text","text":"keep me"},{"type":"image","source":${source}}`);
    expect(envelope.err).toBeUndefined();
    const parts = getArr(envelope.body, "contents.2.parts");
    expect(parts.length).toBe(1);
    expect(gstr(getAt(parts[0], "text"))).toBe("keep me");
  }
});

test("ClaudeToGeminiEmptyTextDoesNotHideAnUnrepresentableImage", () => {
  requireImageRefusal(claudeImageTurnToGemini(`{"type":"text","text":""},{"type":"image","source":{"type":"url","url":"https://example.test/a.png"}}`));
});

test("ClaudeToGeminiBase64ImageOnlyTurnStaysInlineData", () => {
  const envelope = claudeImageTurnToGemini(`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}`);
  expect(envelope.err).toBeUndefined();
  expect(getStr(envelope.body, "contents.2.parts.0.inline_data.mime_type")).toBe("image/png");
  expect(getStr(envelope.body, "contents.2.parts.0.inline_data.data")).toBe("aGVsbG8=");
});

test("ClaudeToGeminiWhitespaceTextDoesNotHideAnUnrepresentableImage", () => {
  for (const text of ["  ", " \\n\\t", "\\u00a0"]) {
    requireImageRefusal(claudeImageTurnToGemini(`{"type":"text","text":"${text}"},{"type":"image","source":{"type":"file","file_id":"file-1"}}`));
  }
  requireImageRefusal(claudeImageTurnToGemini(`{"type":"image","source":{"type":"url","url":"https://example.test/a.png"}},{"type":"text","text":"  "}`));
});

test("ClaudeToGeminiRealTextBesideWhitespaceAndAnImageStillSucceeds", () => {
  const envelope = claudeImageTurnToGemini(`{"type":"text","text":"  "},{"type":"text","text":"keep me"},{"type":"image","source":{"type":"file","file_id":"file-1"}}`);
  expect(envelope.err).toBeUndefined();
  const found = getArr(envelope.body, "contents.2.parts").some((p) => gstr(getAt(p, "text")) === "keep me");
  expect(found).toBe(true);
});

// Ported from: internal/translator/openai/claude/openai_claude_user_turn_test.go
// Skipped cases: none (the Go translator returned body+error; here the refusal is a thrown
//   UnsupportedPartError, so the "body is still valid JSON" sub-assertion has no equivalent)
import { describe, expect, test } from "bun:test";
import { FormatClaude, FormatOpenAI } from "../../../src/translator/types.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { UnsupportedPartError } from "../../../src/translator/common/index.ts";
import { convertClaudeRequestToOpenAIWithCompat } from "../../../src/translator/openai/claude/index.ts";
import { getString, getValue } from "./helpers.ts";

const userTurnUpload = `{"type":"container_upload","file_id":"file-1"}`;

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function requireUnsupported(err: unknown, wantType: string): void {
  expect(err).toBeInstanceOf(UnsupportedPartError);
  const unsupported = err as UnsupportedPartError;
  expect(unsupported.type).toBe(wantType);
  expect(unsupported.statusCode).toBe(400);
  expect(unsupported.message).toBe("unsupported content part: " + wantType);
}

describe("ConvertClaudeRequestToOpenAI_RefusesAnyEmptiedUserTurn", () => {
  const cases = [
    { name: "history then attachment only", input: `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"text","text":"hi"}]},{"role":"user","content":[${userTurnUpload}]}]}`, wantType: "container_upload" },
    { name: "system prompt and system reminder", input: `{"model":"m","system":"sys","messages":[{"role":"system","content":"reminder"},{"role":"user","content":[${userTurnUpload}]}]}`, wantType: "container_upload" },
    { name: "emptied turn before a later text turn", input: `{"model":"m","messages":[{"role":"user","content":[${userTurnUpload}]},{"role":"assistant","content":[{"type":"text","text":"ok"}]},{"role":"user","content":"next"}]}`, wantType: "container_upload" },
    { name: "document without bytes", input: `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"document","source":{"type":"file","file_id":"file-1"}}]}]}`, wantType: "document" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      requireUnsupported(
        catchError(() => convertClaudeRequestToOpenAIWithCompat("m", tc.input, false)),
        tc.wantType,
      );
    });
  }
});

test("ConvertClaudeRequestToOpenAI_KeepsTurnWithTextBesideAttachment", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"text","text":"keep me"},${userTurnUpload}]}]}`;
  const body = convertClaudeRequestToOpenAIWithCompat("m", input, false);
  expect(getString(body, "messages.2.content.0.text")).toBe("keep me");
});

test("ConvertClaudeRequestToOpenAI_Base64DocumentAfterHistoryStaysAFilePart", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQK"}}]}]}`;
  const body = convertClaudeRequestToOpenAIWithCompat("m", input, false);
  expect(getString(body, "messages.2.content.0.type")).toBe("file");
  expect(getString(body, "messages.2.content.0.file.file_data")).toBe("data:application/pdf;base64,JVBERi0xLjQK");
});

test("ConvertClaudeRequestToOpenAI_ToolResultKeepsTurnBesideUnsendableFile", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"run"},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"t","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"done"},${userTurnUpload}]}]}`;
  expect(() => convertClaudeRequestToOpenAIWithCompat("m", input, false)).not.toThrow();
});

/**
 * Go: claudeImageTurnToOpenAI — translates two history turns followed by a final user turn
 * holding the given content parts, through the registered Claude -> OpenAI transform.
 */
function claudeImageTurnToOpenAI(finalContent: string): { body?: string; err?: unknown } {
  const input = `{"model":"m","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":[${finalContent}]}]}`;
  try {
    return { body: defaultRegistry.translateRequest(FormatClaude, FormatOpenAI, "m", input, false) };
  } catch (err) {
    return { err };
  }
}

describe("ClaudeToOpenAIImageOnlyTurnKeepsTheImage", () => {
  const cases = [
    { name: "base64", source: `{"type":"base64","media_type":"image/png","data":"aGVsbG8="}`, want: "data:image/png;base64,aGVsbG8=" },
    { name: "http url", source: `{"type":"url","url":"https://example.test/a.png"}`, want: "https://example.test/a.png" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const envelope = claudeImageTurnToOpenAI(`{"type":"image","source":${tc.source}}`);
      expect(envelope.err).toBeUndefined();
      expect(getString(envelope.body!, "messages.2.content.0.type")).toBe("image_url");
      expect(getString(envelope.body!, "messages.2.content.0.image_url.url")).toBe(tc.want);
    });
  }
});

test("ClaudeToOpenAIFileImageOnlyTurnIsRefused", () => {
  requireUnsupported(claudeImageTurnToOpenAI(`{"type":"image","source":{"type":"file","file_id":"file-1"}}`).err, "image");
});

test("ClaudeToOpenAIFileImageBesideTextStillSucceeds", () => {
  const envelope = claudeImageTurnToOpenAI(`{"type":"text","text":"keep me"},{"type":"image","source":{"type":"file","file_id":"file-1"}}`);
  expect(envelope.err).toBeUndefined();
  const parts = getValue(envelope.body!, "messages.2.content") as unknown[];
  expect(parts.length).toBe(1);
  expect(getString(JSON.stringify(parts[0]), "text")).toBe("keep me");
});

test("ClaudeToOpenAIEmptyTextDoesNotHideAFileImage", () => {
  requireUnsupported(claudeImageTurnToOpenAI(`{"type":"text","text":""},{"type":"image","source":{"type":"file","file_id":"file-1"}}`).err, "image");
});

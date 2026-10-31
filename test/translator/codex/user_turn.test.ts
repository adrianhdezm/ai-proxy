// Ported from: internal/translator/codex/claude/codex_claude_user_turn_test.go
// Skipped cases: none (Go returned body+error together; the TS transform throws the
// UnsupportedPartError instead, so the "body is valid JSON" side-assertions are dropped)
import { describe, expect, test } from "bun:test";
import { convertClaudeRequestToCodexWithCompat } from "../../../src/translator/codex/claude/index.ts";
import { UnsupportedPartError } from "../../../src/translator/common/index.ts";
import { defaultRegistry } from "../../../src/translator/registry.ts";
import { FormatClaude, FormatCodex } from "../../../src/translator/types.ts";
import { get } from "./helpers.ts";

const userTurnUpload = `{"type":"container_upload","file_id":"file-1"}`;

function expectUnsupported(fn: () => unknown, wantType: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnsupportedPartError);
  const unsupported = caught as UnsupportedPartError;
  expect(unsupported.type).toBe(wantType);
  expect(unsupported.statusCode).toBe(400);
  expect(unsupported.message).toBe("unsupported content part: " + wantType);
}

describe("ConvertClaudeRequestToCodex refuses any emptied user turn", () => {
  const cases: { name: string; input: string; wantType: string }[] = [
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
      expectUnsupported(() => convertClaudeRequestToCodexWithCompat("m", tc.input, false), tc.wantType);
    });
  }
});

test("ConvertClaudeRequestToCodex keeps turn with text beside attachment", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"text","text":"keep me"},${userTurnUpload}]}]}`;
  const body = convertClaudeRequestToCodexWithCompat("m", input, false);
  expect(get(body, "input.2.content.0.text")).toBe("keep me");
});

test("ConvertClaudeRequestToCodex base64 document after history stays a file", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBERi0xLjQK"}}]}]}`;
  const body = convertClaudeRequestToCodexWithCompat("m", input, false);
  expect(get(body, "input.2.content.0.type")).toBe("input_file");
  expect(get(body, "input.2.content.0.file_data")).toBe("data:application/pdf;base64,JVBERi0xLjQK");
});

describe("ConvertClaudeRequestToCodex empty text does not hide an emptied user turn", () => {
  const cases: Record<string, string> = {
    "array content": `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":""},${userTurnUpload}]}]}`,
    "after history": `{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":[${userTurnUpload},{"type":"text","text":""}]}]}`,
  };
  for (const [name, input] of Object.entries(cases)) {
    test(name, () => {
      expectUnsupported(() => convertClaudeRequestToCodexWithCompat("m", input, false), "container_upload");
    });
  }
});

test("ConvertClaudeRequestToCodex non-empty text beside attachment still succeeds", () => {
  const input = `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":""},{"type":"text","text":"keep me"},${userTurnUpload}]}]}`;
  const body = convertClaudeRequestToCodexWithCompat("m", input, false);
  expect(get(body, "input.0.content.1.text")).toBe("keep me");
});

/** Translates two history turns plus a final user turn holding the given parts through the default registry (Go: TranslateRequestEnvelope). */
function claudeImageTurnToCodex(finalContent: string): { body?: string; err?: unknown } {
  const input = `{"model":"m","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":[${finalContent}]}]}`;
  try {
    return { body: defaultRegistry.translateRequest(FormatClaude, FormatCodex, "m", input, false) };
  } catch (err) {
    return { err };
  }
}

describe("Claude to Codex image-only turn keeps the image", () => {
  const cases: { name: string; source: string; field: string; want: string }[] = [
    { name: "base64", source: `{"type":"base64","media_type":"image/png","data":"aGVsbG8="}`, field: "image_url", want: "data:image/png;base64,aGVsbG8=" },
    { name: "http url", source: `{"type":"url","url":"https://example.test/a.png"}`, field: "image_url", want: "https://example.test/a.png" },
    { name: "file id", source: `{"type":"file","file_id":"file-1"}`, field: "file_id", want: "file-1" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const envelope = claudeImageTurnToCodex(`{"type":"image","source":${tc.source}}`);
      expect(envelope.err).toBeUndefined();
      expect(get(envelope.body!, "input.2.content.0.type")).toBe("input_image");
      expect(get(envelope.body!, `input.2.content.0.${tc.field}`)).toBe(tc.want);
    });
  }
});

describe("Claude to Codex unrepresentable image-only turn is refused", () => {
  const cases: Record<string, string> = {
    "non http url": `{"type":"url","url":"ftp://example.test/a.png"}`,
    "empty url": `{"type":"url","url":""}`,
    "file no id": `{"type":"file"}`,
    "unknown kind": `{"type":"unknown"}`,
    "base64 no data": `{"type":"base64","media_type":"image/png","data":""}`,
  };
  for (const [name, source] of Object.entries(cases)) {
    test(name, () => {
      const envelope = claudeImageTurnToCodex(`{"type":"image","source":${source}}`);
      expect(envelope.err).toBeInstanceOf(UnsupportedPartError);
      const unsupported = envelope.err as UnsupportedPartError;
      expect(unsupported.type).toBe("image");
      expect(unsupported.statusCode).toBe(400);
      expect(unsupported.message).toBe("unsupported content part: image");
    });
  }
});

test("Claude to Codex unrepresentable image beside text still succeeds", () => {
  const envelope = claudeImageTurnToCodex(`{"type":"text","text":"keep me"},{"type":"image","source":{"type":"file"}}`);
  expect(envelope.err).toBeUndefined();
  expect(get(envelope.body!, "input.2.content.0.text")).toBe("keep me");
});

test("Claude to Codex empty text does not hide an unrepresentable image", () => {
  const envelope = claudeImageTurnToCodex(`{"type":"text","text":""},{"type":"image","source":{"type":"file"}}`);
  expect(envelope.err).toBeInstanceOf(UnsupportedPartError);
  expect((envelope.err as UnsupportedPartError).type).toBe("image");
});

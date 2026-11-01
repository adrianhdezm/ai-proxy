// Ported from: internal/translator/common/parts_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import {
  UnsupportedPartError,
  UserRun,
  UserTurnDrops,
  countSendableGeminiParts,
  interactionsAttachmentType,
  isHTTPURL,
  isInteractionsInstructionStep,
  userRun,
} from "../../../src/translator/common/parts.ts";

const j = (s: string): unknown => JSON.parse(s);

test("UserTurnDrops refuses an emptied turn even when other turns remain", () => {
  const drops = new UserTurnDrops();
  drops.endTurn(1); // an earlier normal turn
  drops.drop("container_upload");
  drops.endTurn(0); // the turn the attachment emptied
  drops.endTurn(3); // a later normal turn must not clear the refusal
  const err = drops.err();
  expect(err).toBeInstanceOf(UnsupportedPartError);
  expect(err!.type).toBe("container_upload");
  expect(err!.statusCode).toBe(400);
  expect(err!.isRequestScoped()).toBe(true);
});

test("UserTurnDrops keeps a turn that still has sendable parts", () => {
  const drops = new UserTurnDrops();
  drops.drop("file");
  drops.endTurn(1);
  expect(drops.err()).toBeUndefined();
});

test("UserTurnDrops ignores an empty turn without a dropped part", () => {
  const drops = new UserTurnDrops();
  drops.endTurn(0);
  expect(drops.err()).toBeUndefined();
});

test("UserTurnDrops reports the first emptied turn", () => {
  const drops = new UserTurnDrops();
  drops.drop("document");
  drops.drop("container_upload");
  drops.endTurn(0);
  drops.drop("file");
  drops.endTurn(0);
  expect(drops.err()!.message).toBe("unsupported content part: document");
});

test("UserTurnDrops does not leak a flag into the next turn", () => {
  const drops = new UserTurnDrops();
  drops.drop("file");
  drops.endTurn(1);
  drops.endTurn(0);
  expect(drops.err()).toBeUndefined();
});

test("isHTTPURL", () => {
  const cases: Record<string, boolean> = {
    "https://example.test/a.png": true,
    "HTTP://example.test/a.png": true,
    "  https://example.test/a  ": true,
    "gs://bucket/a.pdf": false,
    "files/abc123": false,
    "ftp://example.test/a.png": false,
    "data:image/png;base64,aGk=": false,
    "https://": false,
    "": false,
  };
  for (const [value, want] of Object.entries(cases)) {
    expect(isHTTPURL(value)).toBe(want);
  }
});

test("UserRun refuses a turn emptied by a dropped part", () => {
  const run = new UserRun();
  run.add();
  run.end(); // an earlier normal turn
  run.drop("image");
  run.end(); // the turn the attachment emptied
  run.add();
  run.end(); // a later normal turn must not clear the refusal
  expect(run.err()!.message).toBe("unsupported content part: image");
});

test("UserRun keeps a turn with other sendable content", () => {
  const run = new UserRun();
  run.drop("audio");
  run.add();
  run.end();
  expect(run.err()).toBeUndefined();
});

test("UserRun is a no-op on a nil receiver", () => {
  const run: UserRun | undefined = undefined;
  userRun.add(run);
  userRun.drop(run, "image");
  userRun.end(run);
  expect(userRun.err(run)).toBeUndefined();
});

test("interactionsAttachmentType", () => {
  const cases: Record<string, string> = {
    '{"type":"image","uri":"gs://b/a.png"}': "image",
    '{"type":" Audio "}': "audio",
    '{"type":"text","text":"hi"}': "",
    '{"text":"hi"}': "",
    '{"inlineData":{"mimeType":"image/png"}}': "inlineData",
    '{"inline_data":{"mime_type":"image/png"}}': "inlineData",
    '{"fileData":{"mimeType":"image/png"}}': "fileData",
    '{"file_data":{"mime_type":"image/png"}}': "fileData",
    "{}": "",
    '"plain string"': "",
    '{"type":"image_url","image_url":{"url":""}}': "image_url",
  };
  for (const [raw, want] of Object.entries(cases)) {
    expect(interactionsAttachmentType(j(raw))).toBe(want);
  }
});

test("countSendableGeminiParts ignores blank text", () => {
  const parts = [
    j('{"text":""}'),
    j('{"text":"  \\n\\t"}'),
    j('{"text":"hi"}'),
    j('{"inlineData":{"mimeType":"image/png","data":"aGk="}}'),
    j('{"fileData":{"mimeType":"image/png","fileUri":"gs://b/a.png"}}'),
    j('{"functionResponse":{"name":"f","response":{}}}'),
  ];
  expect(countSendableGeminiParts(parts)).toBe(4);
});

test("isInteractionsInstructionStep", () => {
  const cases: [string, boolean, boolean][] = [
    ['{"type":"user_input","role":"developer","content":"note"}', false, true],
    ['{"type":"user_input","role":"System","content":"note"}', false, true],
    ['{"role":"system","content":"note"}', false, true],
    ['{"type":"system","text":"note"}', false, true],
    ['{"type":"developer","text":"note"}', false, true],
    ['{"type":"user_input","role":"user","content":"hi"}', false, false],
    ['{"type":"user_input","content":"hi"}', false, false],
    ['{"type":"user_input","content":"hi"}', true, true],
    ['{"type":"user_input","role":"user","content":"hi"}', true, false],
    ['{"type":"model_output","content":"hi"}', true, false],
    ['{"role":"assistant","content":"hi"}', true, false],
    ['{"role":"user","type":"system"}', false, false],
    ['"plain string"', true, true],
    ['"plain string"', false, false],
  ];
  for (const [raw, inherited, want] of cases) {
    expect(isInteractionsInstructionStep(j(raw), inherited)).toBe(want);
  }
});

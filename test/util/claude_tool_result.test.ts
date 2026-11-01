// Ported from: internal/util/claude_tool_result_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { convertClaudeToolResultContent } from "../../src/util/claude_tool_result.ts";

describe("convertClaudeToolResultContent", () => {
  const tests = [
    { name: "StringContent", wrapper: `{"content":"alpha"}`, wantResult: "alpha", wantRaw: false, wantImages: 0 },
    { name: "SingleTextBlock", wrapper: `{"content":[{"type":"text","text":"alpha"}]}`, wantResult: `{"type":"text","text":"alpha"}`, wantRaw: true, wantImages: 0 },
    {
      name: "MultipleTextBlocks",
      wrapper: `{"content":[{"type":"text","text":"alpha"},{"type":"text","text":"beta"}]}`,
      wantResult: `[{"type":"text","text":"alpha"},{"type":"text","text":"beta"}]`,
      wantRaw: true,
      wantImages: 0,
    },
    {
      name: "TextAndImage",
      wrapper: `{"content":[{"type":"text","text":"alpha"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}`,
      wantResult: `{"type":"text","text":"alpha"}`,
      wantRaw: true,
      wantImages: 1,
    },
    {
      name: "ImageOnly",
      wrapper: `{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}`,
      wantResult: "",
      wantRaw: false,
      wantImages: 1,
    },
    {
      name: "ImageWithoutDataDropped",
      wrapper: `{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png"}}]}`,
      wantResult: "",
      wantRaw: false,
      wantImages: 0,
    },
    { name: "ObjectContent", wrapper: `{"content":{"foo":"bar"}}`, wantResult: `{"foo":"bar"}`, wantRaw: true, wantImages: 0 },
    {
      name: "ObjectImage",
      wrapper: `{"content":{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}}`,
      wantResult: "",
      wantRaw: false,
      wantImages: 1,
    },
    { name: "AbsentContent", wrapper: `{}`, wantResult: "", wantRaw: false, wantImages: 0 },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      const got = convertClaudeToolResultContent(JSON.parse(tt.wrapper).content);
      expect(got.result).toBe(tt.wantResult);
      expect(got.resultIsRaw).toBe(tt.wantRaw);
      expect(got.images.length).toBe(tt.wantImages);
    });
  }
});

test("image fields", () => {
  const got = convertClaudeToolResultContent(JSON.parse(`{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}`).content);
  expect(got.images).toHaveLength(1);
  expect(got.images[0]!.mimeType).toBe("image/png");
  expect(got.images[0]!.data).toBe("aGVsbG8=");
});

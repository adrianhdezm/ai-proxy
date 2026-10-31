// Ported from: internal/translator/common/file_data_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { normalizeOpenAIFileData } from "../../../src/translator/common/file_data.ts";

describe("normalizeOpenAIFileData", () => {
  const cases: { name: string; filename?: string; fallbackMIME?: string; fileData?: string; want?: { mimeType: string; data: string } }[] = [
    { name: "data URL", filename: "test.pdf", fileData: "data:application/pdf;base64,JVBERi0xLjQK", want: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
    { name: "data URL metadata and MIME override", filename: "test.txt", fileData: "data:application/pdf;charset=binary;BASE64,JVBERi0xLjQK", want: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
    { name: "case-insensitive data URL scheme", filename: "test.pdf", fileData: "DATA:application/pdf;base64,JVBERi0xLjQK", want: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
    { name: "raw base64", filename: "TEST.PDF", fileData: "JVBERi0xLjQK", want: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
    { name: "raw base64 with explicit MIME type", fallbackMIME: "application/pdf", fileData: "JVBERi0xLjQK", want: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
    { name: "empty data", filename: "test.pdf" },
    { name: "raw base64 without known extension", filename: "test", fileData: "JVBERi0xLjQK" },
    { name: "data URL without base64 marker", filename: "test.pdf", fileData: "data:application/pdf,JVBERi0xLjQK" },
    { name: "data URL without MIME type", filename: "test.pdf", fileData: "data:;base64,JVBERi0xLjQK" },
    { name: "data URL without payload", filename: "test.pdf", fileData: "data:application/pdf;base64," },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(normalizeOpenAIFileData(tc.filename ?? "", tc.fallbackMIME ?? "", tc.fileData ?? "")).toEqual(tc.want);
    });
  }
});

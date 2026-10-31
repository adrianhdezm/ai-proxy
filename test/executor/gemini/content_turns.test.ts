// Ported from: internal/runtime/executor/helps/gemini_content_turns_test.go
// Skipped cases: TestEnsureGeminiLeadingUserContentReusesLargeValidPayload / TestEnsureGeminiTrailingUserContentReusesLargeValidPayload
// (allocation benchmark not portable; only the "unchanged payload is returned as is" half is kept),
// TestDropGeminiTrailingThoughtOnlyContent (helper used only by the Antigravity/Vertex executors, not ported)
import { describe, expect, test } from "bun:test";
import { ensureGeminiBoundaryUserContent, ensureGeminiLeadingUserContent, ensureGeminiTrailingUserContent } from "../../../src/executor/gemini/index.ts";
import { getAt } from "../../../src/util/gpath.ts";

function roles(out: string, path: string): string {
  const contents = getAt(JSON.parse(out), path);
  if (!Array.isArray(contents)) return "";
  return contents.map((c) => String(getAt(c, "role") ?? "")).join(",");
}

describe("ensureGeminiLeadingUserContent", () => {
  test("reuses a large valid payload unchanged", () => {
    const input = `{"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"video/mp4","data":"${"A".repeat(4 << 20)}"}}]}]}`;
    expect(ensureGeminiLeadingUserContent(input, "contents")).toBe(input);
  });

  const cases: { name: string; input: string; path: string; wantRoles: string; wantLeadingEmpty?: boolean }[] = [
    { name: "user first is unchanged", input: `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`, path: "contents", wantRoles: "user" },
    {
      name: "leading model functionCall gets empty user",
      input: `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"run"}}]},{"role":"user","parts":[{"functionResponse":{"name":"run"}}]}]}`,
      path: "contents",
      wantRoles: "user,model,user",
      wantLeadingEmpty: true,
    },
    {
      name: "leading model text gets empty user and preserves following turns",
      input: `{"contents":[{"role":"model","parts":[{"text":"answer"}]},{"role":"user","parts":[{"text":"continue"}]}]}`,
      path: "contents",
      wantRoles: "user,model,user",
      wantLeadingEmpty: true,
    },
    {
      name: "nested contents are normalized",
      input: `{"request":{"contents":[{"role":"model","parts":[{"text":"answer"}]},{"role":"user","parts":[{"text":"continue"}]}]}}`,
      path: "request.contents",
      wantRoles: "user,model,user",
      wantLeadingEmpty: true,
    },
    { name: "empty contents are unchanged", input: `{"contents":[]}`, path: "contents", wantRoles: "" },
    { name: "missing contents are unchanged", input: `{"model":"test"}`, path: "contents", wantRoles: "" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const out = ensureGeminiLeadingUserContent(tc.input, tc.path);
      expect(roles(out, tc.path)).toBe(tc.wantRoles);
      if (tc.wantLeadingEmpty) expect(getAt(JSON.parse(out), `${tc.path}.0.parts.0.text`)).toBe("");
    });
  }
});

describe("ensureGeminiTrailingUserContent", () => {
  test("reuses a large valid payload unchanged", () => {
    const input = `{"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"video/mp4","data":"${"A".repeat(4 << 20)}"}}]}]}`;
    expect(ensureGeminiTrailingUserContent(input, "contents")).toBe(input);
  });

  const cases: { name: string; input: string; path: string; wantRoles: string; wantTrailingEmpty?: boolean }[] = [
    { name: "user last is unchanged", input: `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`, path: "contents", wantRoles: "user" },
    {
      name: "trailing functionResponse preserves model role without adding user",
      input: `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"run"}}]},{"role":"model","parts":[{"functionResponse":{"name":"run","response":{"result":"ok"}}}]}]}`,
      path: "contents",
      wantRoles: "model,model",
    },
    {
      name: "trailing model functionResponse with nested inlineData gets empty user",
      input: `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"view_image"}}]},{"role":"model","parts":[{"functionResponse":{"name":"view_image","response":{"result":""},"parts":[{"inlineData":{"mimeType":"image/png","data":"AAAA"}}]}}]}]}`,
      path: "contents",
      wantRoles: "model,model,user",
      wantTrailingEmpty: true,
    },
    {
      name: "trailing model functionResponse with nested fileData gets empty user",
      input: `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"view_image"}}]},{"role":"model","parts":[{"functionResponse":{"name":"view_image","response":{"result":""},"parts":[{"fileData":{"mimeType":"image/png","fileUri":"gs://b/a.png"}}]}}]}]}`,
      path: "contents",
      wantRoles: "model,model,user",
      wantTrailingEmpty: true,
    },
    {
      name: "trailing user functionResponse with nested inlineData is unchanged",
      input: `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"view_image"}}]},{"role":"user","parts":[{"functionResponse":{"name":"view_image","response":{"result":""},"parts":[{"inlineData":{"mimeType":"image/png","data":"AAAA"}}]}}]}]}`,
      path: "contents",
      wantRoles: "model,user",
    },
    {
      name: "trailing model functionCall gets empty user",
      input: `{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"functionCall":{"name":"run"}}]}]}`,
      path: "contents",
      wantRoles: "user,model,user",
      wantTrailingEmpty: true,
    },
    {
      name: "trailing model text gets empty user and preserves preceding turns",
      input: `{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"answer"}]}]}`,
      path: "contents",
      wantRoles: "user,model,user",
      wantTrailingEmpty: true,
    },
    {
      name: "nested contents are normalized",
      input: `{"request":{"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"answer"}]}]}}`,
      path: "request.contents",
      wantRoles: "user,model,user",
      wantTrailingEmpty: true,
    },
    { name: "empty contents are unchanged", input: `{"contents":[]}`, path: "contents", wantRoles: "" },
    { name: "missing contents are unchanged", input: `{"model":"test"}`, path: "contents", wantRoles: "" },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      const out = ensureGeminiTrailingUserContent(tc.input, tc.path);
      expect(roles(out, tc.path)).toBe(tc.wantRoles);
      if (tc.wantTrailingEmpty) {
        const contents = getAt(JSON.parse(out), tc.path) as unknown[];
        expect(getAt(contents[contents.length - 1], "parts.0.text")).toBe("");
      }
    });
  }
});

test("ensureGeminiBoundaryUserContent wraps a single model turn", () => {
  const out = JSON.parse(ensureGeminiBoundaryUserContent(`{"contents":[{"role":"model","parts":[{"text":"single answer"}]}]}`, "contents"));
  expect(out.contents).toEqual([
    { role: "user", parts: [{ text: "" }] },
    { role: "model", parts: [{ text: "single answer" }] },
    { role: "user", parts: [{ text: "" }] },
  ]);
});

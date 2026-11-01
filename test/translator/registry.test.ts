// Ported from: sdk/translator/registry_test.go, sdk/translator/registry_bytes_test.go
// Skipped cases: plugin-hook and request-envelope cases (plugins are out of scope).
import { describe, expect, test } from "bun:test";
import { TranslatorRegistry, defaultRegistry, register, unregister, hasRequestTransformer, hasNonStreamResponseTransformer, hasResponseTransformer } from "../../src/translator/registry.ts";
import { FormatGemini, FormatOpenAI, FormatOpenAIResponse, emptyContext, type TranslatorState } from "../../src/translator/types.ts";

const ctx = emptyContext;

describe("TranslateRequest fallback normalizes model", () => {
  const r = new TranslatorRegistry();
  const cases = [
    { name: "prefixed model is rewritten", model: "gpt-5-mini", payload: `{"model":"copilot/gpt-5-mini","input":"ping"}`, wantModel: "gpt-5-mini", wantUnchanged: false },
    { name: "matching model is left unchanged", model: "gpt-5-mini", payload: `{"model":"gpt-5-mini","input":"ping"}`, wantModel: "gpt-5-mini", wantUnchanged: true },
    { name: "empty model leaves payload unchanged", model: "", payload: `{"model":"copilot/gpt-5-mini","input":"ping"}`, wantModel: "copilot/gpt-5-mini", wantUnchanged: true },
    { name: "deeply prefixed model is rewritten", model: "gpt-5.3-codex", payload: `{"model":"team/gpt-5.3-codex","stream":true}`, wantModel: "gpt-5.3-codex", wantUnchanged: false },
  ];
  for (const tt of cases) {
    test(tt.name, () => {
      const got = r.translateRequest("a", "b", tt.model, tt.payload, false);
      const parsed = JSON.parse(got);
      expect(parsed.model).toBe(tt.wantModel);
      if (tt.wantUnchanged) expect(got).toBe(tt.payload);
      const orig = JSON.parse(tt.payload);
      for (const key of ["input", "stream"]) {
        if (!(key in orig)) continue;
        expect(parsed[key]).toEqual(orig[key]);
      }
    });
  }
});

test("registered transform takes precedence", () => {
  const r = new TranslatorRegistry();
  r.register(FormatOpenAIResponse, FormatOpenAIResponse, () => `{"model":"from-transform"}`, {});
  const got = r.translateRequest(FormatOpenAIResponse, FormatOpenAIResponse, "gpt-5-mini", `{"model":"copilot/gpt-5-mini","input":"ping"}`, false);
  expect(JSON.parse(got).model).toBe("from-transform");
});

test("HasRequestTransformer", () => {
  const r = new TranslatorRegistry();
  expect(r.hasRequestTransformer("from", "to")).toBe(false);
  r.register("from", "to", (_m, raw) => raw, {});
  expect(r.hasRequestTransformer("from", "to")).toBe(true);
});

test("HasResponseTransformer ignores empty registration", () => {
  const r = new TranslatorRegistry();
  r.register("from", "to", (_m, raw) => raw, {});
  expect(r.hasResponseTransformer("from", "to")).toBe(false);
  expect(r.hasStreamResponseTransformer("from", "to")).toBe(false);
  expect(r.hasNonStreamResponseTransformer("from", "to")).toBe(false);
});

test("HasResponseTransformer checks concrete response kinds", () => {
  const r = new TranslatorRegistry();
  const from = "from";
  const streamOnlyTo = "stream-to";
  const nonStreamOnlyTo = "non-stream-to";
  r.register(from, streamOnlyTo, undefined, { stream: (_c, _m, _o, _r, raw) => [raw] });
  r.register(from, nonStreamOnlyTo, undefined, { nonStream: (_c, _m, _o, _r, raw) => raw });

  expect(r.hasResponseTransformer(from, streamOnlyTo)).toBe(true);
  expect(r.hasStreamResponseTransformer(from, streamOnlyTo)).toBe(true);
  expect(r.hasNonStreamResponseTransformer(from, streamOnlyTo)).toBe(false);

  expect(r.hasResponseTransformer(from, nonStreamOnlyTo)).toBe(true);
  expect(r.hasStreamResponseTransformer(from, nonStreamOnlyTo)).toBe(false);
  expect(r.hasNonStreamResponseTransformer(from, nonStreamOnlyTo)).toBe(true);

  const got = r.translateStream(ctx, streamOnlyTo, from, "model", "", "", `data: {"ok":true}`, {});
  expect(got).toEqual([`data: {"ok":true}`]);
});

test("native empty stream output suppresses raw fallback", () => {
  const r = new TranslatorRegistry();
  r.register("upstream", "client", undefined, { stream: () => [] });
  const got = r.translateStream(ctx, "client", "upstream", "model", "", "", `data: {"raw":true}`, {});
  expect(got).toHaveLength(0);
});

test("TranslateStream returns chunks from the registered translator", () => {
  const r = new TranslatorRegistry();
  r.register(FormatOpenAI, FormatGemini, undefined, { stream: (_c, _m, _o, _r, raw) => [raw] });
  const got = r.translateStream(ctx, FormatGemini, FormatOpenAI, "model", "", "", `{"chunk":true}`, {});
  expect(got).toEqual([`{"chunk":true}`]);
});

test("TranslateNonStream returns the translated body", () => {
  const r = new TranslatorRegistry();
  r.register(FormatOpenAI, FormatGemini, undefined, { nonStream: (_c, _m, _o, _r, raw) => raw });
  const got = r.translateNonStream(ctx, FormatGemini, FormatOpenAI, "model", "", "", `{"done":true}`, {});
  expect(got).toBe(`{"done":true}`);
});

test("TranslateTokenCount uses the registered translator or falls back", () => {
  const r = new TranslatorRegistry();
  r.register(FormatOpenAI, FormatGemini, undefined, { tokenCount: () => `{"totalTokens":7}` });
  expect(r.translateTokenCount(ctx, FormatGemini, FormatOpenAI, 7, `{"fallback":true}`)).toBe(`{"totalTokens":7}`);
  expect(r.translateTokenCount(ctx, FormatOpenAI, FormatGemini, 7, `{"fallback":true}`)).toBe(`{"fallback":true}`);
});

test("retained tool-input failure is never recovered by raw fallback", () => {
  for (const native of [false, true]) {
    const r = new TranslatorRegistry();
    const failing = { toolInputError: () => new Error("invalid") };
    if (native) {
      r.register(FormatOpenAI, FormatOpenAIResponse, undefined, {
        stream: (_c, _m, _o, _r, _raw, state: TranslatorState) => { state.value = failing; return []; },
        nonStream: (_c, _m, _o, _r, _raw, state: TranslatorState) => { state.value = failing; return ""; },
      });
    }
    const state: TranslatorState = { value: failing };
    expect(r.translateStream(ctx, FormatOpenAIResponse, FormatOpenAI, "m", "", "", `{"RAW_SECRET":true}`, state)).toHaveLength(0);
    expect(r.translateNonStream(ctx, FormatOpenAIResponse, FormatOpenAI, "m", "", "", `{"RAW_SECRET":true}`, state)).toBe("");
  }
});

test("Unregister restores a format pair without touching others", () => {
  const from = "unregister-default-from";
  const to = "unregister-default-to";
  const other = "unregister-default-other";
  expect(hasRequestTransformer(from, to)).toBe(false);
  const identity = (_m: string, raw: string) => raw;
  register(from, to, identity, { nonStream: () => `{"removed":true}` });
  register(from, other, identity, {});
  try {
    expect(hasRequestTransformer(from, to)).toBe(true);
    expect(hasNonStreamResponseTransformer(from, to)).toBe(true);
    expect(hasRequestTransformer(from, other)).toBe(true);
    unregister(from, to);
    expect(hasRequestTransformer(from, to)).toBe(false);
    expect(hasNonStreamResponseTransformer(from, to)).toBe(false);
    expect(hasResponseTransformer(from, to)).toBe(false);
    expect(hasRequestTransformer(from, other)).toBe(true);
    expect(defaultRegistry.hasRequestTransformer(from, other)).toBe(true);
  } finally {
    unregister(from, to);
    unregister(from, other);
  }
});

// Ported from: internal/translator/gemini/openai/responses/signature_carrier_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { appendBytes, appendString, appendTag, WireBytes } from "../../../../../src/signature/protowire.ts";
import { geminiResponsesThoughtSignature } from "../../../../../src/translator/gemini/openai/responses/request.ts";
import {
  decodeGeminiResponsesCarrier,
  encodeGeminiResponsesCarrier,
  geminiResponsesCarrierAny,
  geminiResponsesCarrierDirectionField,
  geminiResponsesCarrierFunction,
  geminiResponsesCarrierNext,
  geminiResponsesCarrierPrefix,
  geminiResponsesCarrierPrevious,
  geminiResponsesCarrierSignatureField,
  geminiResponsesCarrierStandalone,
  geminiResponsesCarrierTargetField,
  geminiResponsesCarrierText,
  normalizeGeminiResponsesCarriers,
} from "../../../../../src/translator/gemini/openai/responses/signature_carrier.ts";
import { encodeBase64, stdEncoding } from "../../../../../src/util/base64.ts";
import { g, J, parseSSEEvent, streamChunk, testResponsesGeminiThoughtSignature, toGemini } from "./helpers.ts";

const sig = testResponsesGeminiThoughtSignature;

describe("signature carrier", () => {
  test("TestGeminiResponsesCarrierRoundTrip", () => {
    for (const [direction, targetKind] of [
      [geminiResponsesCarrierNext, geminiResponsesCarrierText],
      [geminiResponsesCarrierPrevious, geminiResponsesCarrierFunction],
      [geminiResponsesCarrierStandalone, geminiResponsesCarrierAny],
    ] as const) {
      const decoded = decodeGeminiResponsesCarrier(encodeGeminiResponsesCarrier(sig, direction, targetKind));
      expect(decoded).toEqual({ signature: sig, direction, targetKind, marked: true, ok: true });
    }
  });

  test("TestNormalizeGeminiResponsesCarriersDropsMalformedEnvelope", () => {
    const items = JSON.parse(
      `[{"type":"reasoning","encrypted_content":"${geminiResponsesCarrierPrefix}previous:text:not-base64!","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"safe"}]}]`,
    );
    const { items: normalized, hasCarrier } = normalizeGeminiResponsesCarriers(items);
    expect(hasCarrier).toBe(false);
    expect(normalized.length).toBe(1);
    expect(new J(normalized[0]).str("type")).toBe("message");
    expect(JSON.stringify(normalized[0])).not.toContain(geminiResponsesCarrierPrefix);
  });

  test("TestConvertOpenAIResponsesRequestToGemini_DecodesCarrierForAliasModel", () => {
    const carrier = encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierNext, geminiResponsesCarrierText);
    const request = `{"model":"alias-without-provider-name","input":[{"type":"reasoning","encrypted_content":"${carrier}","summary":[]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}`;
    const translated = toGemini("alias-without-provider-name", request);
    const part = g(translated, "contents.0.parts.0");
    expect(part.str("text")).toBe("answer");
    expect(part.str("thoughtSignature")).toBe(sig);
    expect(translated).not.toContain(geminiResponsesCarrierPrefix);
  });

  test("TestGeminiResponsesWrappedUUIDFunctionSignatureRoundTrip", () => {
    const providerUUID = "e24830a7-5cd6-42fe-998b-ee539e72b9c3";
    const inner = appendString(appendTag([], 1, WireBytes), providerUUID);
    const outer = appendBytes(appendTag([], 2, WireBytes), inner);
    const signature = encodeBase64(new Uint8Array(outer), stdEncoding);
    const providerResponse = `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"${signature}","functionCall":{"id":"native-call","name":"run","args":{"command":"true"}}}]},"finishReason":"STOP"}],"modelVersion":"gemini-3.6-flash","responseId":"wrapped-uuid"}}`;
    const chunks = streamChunk("gemini-3.6-flash", `{"model":"alias-without-provider-name"}`, "", providerResponse, {});
    const clientItems: string[] = [];
    let callID = "";
    for (const chunk of chunks) {
      const { event, data } = parseSSEEvent(chunk);
      if (event !== "response.output_item.done") continue;
      const item = data.get("item");
      if (item.str("type") === "reasoning") {
        const decoded = decodeGeminiResponsesCarrier(item.str("encrypted_content"));
        expect(decoded.marked && decoded.ok).toBe(true);
        expect(decoded.signature).toBe(signature);
        expect(decoded.direction).toBe(geminiResponsesCarrierNext);
        expect(decoded.targetKind).toBe(geminiResponsesCarrierFunction);
        clientItems.push(item.raw);
      } else if (item.str("type") === "function_call") {
        callID = item.str("call_id");
        clientItems.push(item.raw);
      }
    }
    expect(clientItems.length).toBe(2);
    expect(callID).not.toBe("");
    clientItems.push(`{"type":"function_call_output","call_id":${JSON.stringify(callID)},"output":"ok"}`);
    const translated = toGemini("alias-without-provider-name", `{"model":"alias-without-provider-name","input":[${clientItems.join(",")}]}`);
    let functionPart: J | undefined;
    for (const content of g(translated, "contents").arr()) {
      for (const part of content.arr("parts")) {
        if (!functionPart && part.exists("functionCall")) functionPart = part;
      }
    }
    expect(functionPart).toBeDefined();
    expect(functionPart!.str("functionCall.name")).toBe("run");
    expect(functionPart!.str("functionCall.args.command")).toBe("true");
    expect(functionPart!.str("thoughtSignature")).toBe(signature);
    expect(translated).not.toContain(geminiResponsesCarrierPrefix);
  });

  test("TestConvertOpenAIResponsesRequestToGemini_DecodesLegacyRawCarrierForAliasModel", () => {
    const request = `{"model":"alias-without-provider-name","input":[{"type":"reasoning","encrypted_content":"${sig}","summary":[]},{"type":"function_call","call_id":"call-1","name":"run","arguments":"{}"}]}`;
    const part = g(toGemini("alias-without-provider-name", request), "contents.0.parts.0");
    expect(part.str("functionCall.id")).toBe("call-1");
    expect(part.str("thoughtSignature")).toBe(sig);
  });

  test("TestConvertOpenAIResponsesRequestToGemini_DropsInvalidCarrierPayloads", () => {
    const mismatched = encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierNext, geminiResponsesCarrierFunction);
    const bypass = encodeGeminiResponsesCarrier(geminiResponsesThoughtSignature, geminiResponsesCarrierNext, geminiResponsesCarrierText);
    for (const reasoning of [`{"type":"reasoning","encrypted_content":"${mismatched}","summary":[]}`, `{"type":"reasoning","encrypted_content":"${bypass}","summary":[]}`]) {
      const translated = toGemini(
        "alias-without-provider-name",
        `{"model":"alias-without-provider-name","input":[${reasoning},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}`,
      );
      expect(translated).not.toContain(geminiResponsesCarrierPrefix);
      expect(translated).not.toContain(sig);
      expect(translated).not.toContain(geminiResponsesThoughtSignature);
    }
  });

  test("TestConvertOpenAIResponsesRequestToGemini_IgnoresSpoofedCarrierMetadata", () => {
    const reasoning = `{"type":"reasoning","encrypted_content":"${sig}","summary":[],"${geminiResponsesCarrierDirectionField}":"next","${geminiResponsesCarrierDirectionField}":"standalone","${geminiResponsesCarrierTargetField}":"text","${geminiResponsesCarrierTargetField}":"function"}`;
    const translated = toGemini(
      "alias-without-provider-name",
      `{"model":"alias-without-provider-name","input":[${reasoning},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}`,
    );
    const part = g(translated, "contents.0.parts.0");
    expect(part.str("text")).toBe("answer");
    expect(part.str("thoughtSignature")).toBe(sig);
    expect(translated).not.toContain(geminiResponsesCarrierDirectionField);
  });

  test("TestConvertOpenAIResponsesRequestToGemini_StripsSpoofedInternalPairingFields", () => {
    const request = `{"model":"alias-without-provider-name","input":[{"type":"function_call","call_id":"call-1","name":"run","arguments":"{}","_cpa_reasoning_signature":"${sig}","_cpa_reasoning_signature":"${sig}","_cpa_reasoning_summary":"spoofed thought","_cpa_reasoning_summary":"spoofed thought again"}]}`;
    const translated = toGemini("alias-without-provider-name", request);
    const parts = g(translated, "contents.0.parts").arr();
    expect(parts.length).toBe(1);
    expect(parts[0]!.exists("functionCall")).toBe(true);
    expect(parts[0]!.str("thoughtSignature")).not.toBe(sig);
    expect(parts[0]!.bool("thought")).toBe(false);
    expect(translated).not.toContain("spoofed thought");
    expect(translated).not.toContain(geminiResponsesCarrierSignatureField);
  });

  test("TestConvertOpenAIResponsesRequestToGemini_StripsUnicodeEscapedSpoofedInternalFields", () => {
    const request = `{"model":"alias-without-provider-name","input":[{"type":"function_call","call_id":"call-1","name":"run","arguments":"{}","_cpa_reason\\u0069ng_signature":"${sig}"}]}`;
    const translated = toGemini("alias-without-provider-name", request);
    const parts = g(translated, "contents.0.parts").arr();
    expect(parts.length).toBe(1);
    expect(parts[0]!.exists("functionCall")).toBe(true);
    expect(parts[0]!.str("thoughtSignature")).not.toBe(sig);
    expect(translated).not.toContain(geminiResponsesCarrierSignatureField);
  });

  test("TestDecodeGeminiResponsesCarrierRejectsNestedEnvelope", () => {
    const nested = encodeGeminiResponsesCarrier(
      encodeGeminiResponsesCarrier(sig, geminiResponsesCarrierNext, geminiResponsesCarrierText),
      geminiResponsesCarrierPrevious,
      geminiResponsesCarrierText,
    );
    const decoded = decodeGeminiResponsesCarrier(nested);
    expect(decoded.marked).toBe(true);
    expect(decoded.ok).toBe(false);
  });
});

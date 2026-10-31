// Ported from: sdk/api/handlers/openai_responses_stream_error_test.go
// Skipped cases: none.
import { expect, test } from "bun:test";
import { buildOpenAIResponsesStreamErrorChunk, buildOpenAIResponsesStreamFailedChunk } from "../../src/server/responses_sse.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(text: string): any {
  return JSON.parse(text);
}

test("TestBuildOpenAIResponsesStreamErrorChunk", () => {
  const payload = parse(buildOpenAIResponsesStreamErrorChunk(500, "unexpected EOF", 0));
  expect(payload.type).toBe("error");
  expect(payload.error.code).toBe("internal_server_error");
  expect(payload.error.message).toBe("unexpected EOF");
  expect(payload.sequence_number).toBe(0);
});

test("TestBuildOpenAIResponsesStreamErrorChunkExtractsHTTPErrorBody", () => {
  const payload = parse(buildOpenAIResponsesStreamErrorChunk(500, `{"error":{"message":"oops","type":"server_error","code":"internal_server_error"}}`, 0));
  expect(payload.type).toBe("error");
  expect(payload.error.code).toBe("internal_server_error");
  expect(payload.error.message).toBe("oops");
  expect(payload.error.type).toBe("server_error");
});

test("TestBuildOpenAIResponsesStreamErrorChunkPreservesNestedError", () => {
  const errText = `{"error":{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk.","param":null}}`;
  const payload = parse(buildOpenAIResponsesStreamErrorChunk(400, errText, 2));
  expect(payload.type).toBe("error");
  expect(payload.sequence_number).toBe(2);
  expect(payload.error.type).toBe("invalid_request");
  expect(payload.error.code).toBe("cyber_policy");
  expect(payload.error.message).toBe("This content was flagged for possible cybersecurity risk.");
  expect("param" in payload.error).toBe(true);
  expect(payload.error.param).toBeNull();
});

test("TestBuildOpenAIResponsesStreamErrorChunkPreservesCustomAndEmptyFields", () => {
  const empty = parse(buildOpenAIResponsesStreamErrorChunk(400, `{"error":{}}`, 0));
  expect(Object.keys(empty.error)).toHaveLength(0);

  const custom = parse(buildOpenAIResponsesStreamErrorChunk(400, `{"error":{"type":"custom_type","code":"custom_code","custom_key":"custom_val","is_flag":true,"count":42}}`, 5));
  expect(custom.sequence_number).toBe(5);
  expect(custom.error.custom_key).toBe("custom_val");
  expect(custom.error.is_flag).toBe(true);
  expect(custom.error.count).toBe(42);
});

test("TestBuildOpenAIResponsesStreamErrorChunkPrioritizesPayloadSequenceNumber", () => {
  const payload = parse(buildOpenAIResponsesStreamErrorChunk(400, `{"error":{"type":"invalid_request","code":"blocked"},"sequence_number":7}`, 2));
  expect(payload.sequence_number).toBe(7);
});

test("TestBuildOpenAIResponsesStreamFailedChunkPreservesNestedError", () => {
  const payload = parse(buildOpenAIResponsesStreamFailedChunk(400, `{"error":{"type":"invalid_request","code":"cyber_policy","message":"blocked","param":null}}`, 0));
  expect(payload.type).toBe("response.failed");
  expect(payload.sequence_number).toBe(0);
  expect(payload.response.status).toBe("failed");
  expect(payload.response.error.type).toBe("invalid_request");
  expect(payload.response.error.code).toBe("cyber_policy");
  expect(payload.response.error.message).toBe("blocked");
});

test("TestBuildOpenAIResponsesStreamFailedChunkPrioritizesPayloadSequenceNumber", () => {
  const payload = parse(buildOpenAIResponsesStreamFailedChunk(400, `{"error":{"type":"invalid_request","code":"cyber_policy","message":"blocked"},"sequence_number":7}`, 2));
  expect(payload.sequence_number).toBe(7);
});

test("TestBuildOpenAIResponsesStreamErrorChunkPreservesLargeIntPrecision", () => {
  const errText = `{"error":{"type":"invalid_request","code":"blocked","request_id":9007199254740993}}`;
  for (const raw of [buildOpenAIResponsesStreamErrorChunk(400, errText, 0), buildOpenAIResponsesStreamFailedChunk(400, errText, 0)]) {
    expect(raw).toContain("9007199254740993");
    expect(raw).not.toContain("9007199254740992");
  }
});

test("TestBuildOpenAIResponsesStreamErrorChunkRequestTimeoutIsServerError", () => {
  const payload = parse(buildOpenAIResponsesStreamErrorChunk(408, "stream disconnected before completion", 0));
  expect(payload.type).toBe("error");
  expect(payload.error.code).toBe("request_timeout");
  expect(payload.error.type).toBe("server_error");

  const failed = parse(buildOpenAIResponsesStreamFailedChunk(408, "stream disconnected before completion", 0));
  expect(failed.response.error.code).toBe("request_timeout");
  expect(failed.response.error.type).toBe("server_error");
});

test("TestBuildOpenAIResponsesStreamChunksMapAnthropicPromptTooLongToContextLengthExceeded", () => {
  const errText = `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}`;
  const payload = parse(buildOpenAIResponsesStreamErrorChunk(400, errText, 0));
  expect(payload.error.code).toBe("context_length_exceeded");
  expect(payload.error.type).toBe("invalid_request_error");
  expect(payload.error.message).toBe("prompt is too long: 210000 tokens > 200000 maximum");

  const failed = parse(buildOpenAIResponsesStreamFailedChunk(400, errText, 0));
  expect(failed.response.error.code).toBe("context_length_exceeded");
  expect(failed.response.error.type).toBe("invalid_request_error");

  // Existing code must be preserved.
  const withCode = parse(
    buildOpenAIResponsesStreamFailedChunk(400, `{"type":"error","error":{"type":"invalid_request_error","code":"custom_code","message":"prompt is too long: 210000 tokens > 200000 maximum"}}`, 0),
  );
  expect(withCode.response.error.code).toBe("custom_code");

  // Unrelated invalid_request_error without a code remains unchanged.
  const other = parse(buildOpenAIResponsesStreamFailedChunk(400, `{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: Field required"}}`, 0));
  expect("code" in other.response.error).toBe(false);
});

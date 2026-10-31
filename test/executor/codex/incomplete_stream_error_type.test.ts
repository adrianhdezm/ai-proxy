// Ported from: test/codex_incomplete_stream_error_type_test.go
// Skipped cases: none. Adaptation: a Claude Messages request through the real AuthManager (Go drove the
//   gin /v1/responses handler); the terminal error is checked on the StatusError body the executor raises
//   and on the server's Claude error envelope built from it (src/server/errors.ts).
import { afterAll, expect, test } from "bun:test";
import { StatusError } from "../../../src/executor/types.ts";
import { claudeErrorBody, executionErrorMessage } from "../../../src/server/errors.ts";
import { claudePayload, codexManager, drain, getString, options, sseResponse, startUpstream } from "./helpers.ts";

const model = "gpt-5.4";
const events = [
  `{"type":"response.created","response":{"id":"resp_truncated"}}`,
  `{"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","name":"edit","arguments":""}}`,
  `{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"path\\":\\"app/page.tsx\\"","sequence_number":3}`,
  `{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":",\\"text\\":\\"editor","sequence_number":4}`,
];

const upstream = startUpstream(() => sseResponse(events.map((e) => `data: ${e}\n\n`).join("")));
const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 0 });
harness.addAuth("codex-incomplete-stream", "incomplete", upstream.url, { disableCooling: true, models: [model] });
afterAll(() => {
  harness.cleanup();
  upstream.close();
});

test("TestCodexIncompleteStreamIsNotTypedAsInvalidRequest", async () => {
  const payload = claudePayload(model, {
    tools: [{ name: "edit", description: "edit a file", input_schema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } } }],
  });
  const result = await harness.manager.executeStream(["codex"], { model, payload, format: "claude" }, options("claude", true));
  const { chunks, error } = await drain(result);
  expect(chunks.join("")).toContain("event: message_start");
  expect(error).toBeInstanceOf(StatusError);
  const statusErr = error as StatusError;
  expect(statusErr.streamTruncated).toBe(true);
  expect(getString(statusErr.body!, "error.code")).toBe("request_timeout");
  expect(getString(statusErr.body!, "error.type")).toBe("server_error");

  const envelope = claudeErrorBody(executionErrorMessage(statusErr));
  expect(getString(envelope, "error.type")).not.toBe("invalid_request_error");
  expect(getString(envelope, "error.type")).toBe("server_error");
});

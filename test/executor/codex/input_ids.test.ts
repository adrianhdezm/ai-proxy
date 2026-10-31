// Ported from: internal/runtime/executor/helps/codex_input_ids_test.go
// Ported from: internal/runtime/executor/codex_executor_input_ids_test.go
// Skipped cases: BenchmarkSanitizeCodexInputItemIDsLargeNoopPayload, BenchmarkSanitizeCodexInputItemIDsLargeHistory
//   (benchmarks). The executor case uses a placeholder encrypted_content (the reasoning
//   encrypted-content validator is not ported) and an openai-response inbound payload passed through
//   unchanged (no openai-response translator is registered in this port).
import { afterAll, describe, expect, test } from "bun:test";
import { CodexExecutor, codexInputItemIDLimit, sanitizeCodexInputItemIDs, shortenCodexInputItemID } from "../../../src/executor/codex/index.ts";
import { apiKeyAuth, drain, getString, getValue, options, request, sseResponse, startUpstream } from "./helpers.ts";

const runes = (s: string) => Array.from(s).length;

test("TestSanitizeCodexInputItemIDsBoundaries", () => {
  const id64 = "a".repeat(64);
  const id65 = "b".repeat(65);
  const unicode65 = "界".repeat(65);
  const got = sanitizeCodexInputItemIDs(`{"input":[{"id":"${id64}"},{"id":"${id65}"},{"id":"${unicode65}"}]}`);
  expect(getString(got, "input.0.id")).toBe(id64);
  for (const path of ["input.1.id", "input.2.id"]) expect(runes(getString(got, path))).toBe(64);
});

test("TestSanitizeCodexInputItemIDsNormalizesMessageIDs", () => {
  const invalidID = "item_74ec40c883248ebb4885ec84";
  const body =
    `{"input":[` +
    `{"type":"message","id":"${invalidID}","role":"user"},` +
    `{"type":"message","id":"msg-1","role":"assistant"},` +
    `{"type":"function_call","id":"item_call","call_id":"call-1"}` +
    `]}`;
  const first = sanitizeCodexInputItemIDs(body);
  const second = sanitizeCodexInputItemIDs(body);
  expect(getString(first, "input.0.id")).toBe("msg_" + invalidID);
  expect(getString(first, "input.1.id")).toBe("msg-1");
  expect(getString(first, "input.2.id")).toBe("fc_item_call");
  expect(first).toBe(second);
});

test("TestSanitizeCodexInputItemIDsNormalizesResponseItemIDs", () => {
  const body =
    `{"input":[` +
    `{"type":"message","id":"item_message"},` +
    `{"type":"reasoning","id":"item_reasoning"},` +
    `{"type":"function_call","id":"item_function_call","call_id":"call-1"},` +
    `{"type":"function_call_output","id":"item_function_call_output","call_id":"call-1"},` +
    `{"type":"reasoning","id":"rs-existing"},` +
    `{"type":"function_call","id":"fc-existing","call_id":"call-2"},` +
    `{"type":"message","id":"msg-existing"}` +
    `]}`;
  const got = sanitizeCodexInputItemIDs(body);
  const want = ["msg_item_message", "rs_item_reasoning", "fc_item_function_call", "item_function_call_output", "rs-existing", "fc-existing", "msg-existing"];
  want.forEach((expected, index) => expect(getString(got, `input.${index}.id`)).toBe(expected));
  expect(sanitizeCodexInputItemIDs(body)).toBe(got);
});

describe("TestSanitizeCodexInputItemIDsAvoidsNormalizationCollisions", () => {
  const types = [
    { name: "message", itemType: "message", prefix: "msg_" },
    { name: "reasoning", itemType: "reasoning", prefix: "rs_" },
    { name: "function call", itemType: "function_call", prefix: "fc_" },
    { name: "custom tool call", itemType: "custom_tool_call", prefix: "ctc_" },
    { name: "custom tool call output", itemType: "custom_tool_call_output", prefix: "ctco_" },
  ];
  for (const tc of types) {
    const idCases = [
      { name: "short", invalidID: "item_collision" },
      { name: "overlong", invalidID: "x".repeat(codexInputItemIDLimit - runes(tc.prefix) + 1) },
    ];
    for (const idCase of idCases) {
      const prefixedID = tc.prefix + idCase.invalidID;
      const orders = [
        { name: "local first", ids: [idCase.invalidID, prefixedID], prefixedIndex: 1 },
        { name: "prefixed first", ids: [prefixedID, idCase.invalidID], prefixedIndex: 0 },
      ];
      for (const order of orders) {
        test(`${tc.name}/${idCase.name}/${order.name}`, () => {
          const body = JSON.stringify({ input: [{ type: tc.itemType, id: order.ids[0] }, { type: tc.itemType, id: order.ids[1] }] });
          const first = sanitizeCodexInputItemIDs(body);
          const second = sanitizeCodexInputItemIDs(body);
          const normalizedAgain = sanitizeCodexInputItemIDs(first);
          const ids = [getString(first, "input.0.id"), getString(first, "input.1.id")];
          expect(ids[0]).not.toBe(ids[1]);
          for (const id of ids) {
            expect(id.startsWith(tc.prefix)).toBe(true);
            expect(runes(id)).toBeLessThanOrEqual(codexInputItemIDLimit);
          }
          if (runes(prefixedID) <= codexInputItemIDLimit) expect(ids[order.prefixedIndex]).toBe(prefixedID);
          expect(first).toBe(second);
          expect(normalizedAgain).toBe(first);
        });
      }
    }
  }
});

test("TestSanitizeCodexInputItemIDsNormalizesCustomToolCallIDs", () => {
  const invalidID = "item_44e13caebc1ddf25f1337cbe";
  const got = sanitizeCodexInputItemIDs(`{"input":[{"type":"custom_tool_call","id":"${invalidID}","call_id":"call-1","name":"lookup","input":"{}"}]}`);
  expect(getString(got, "input.0.id")).toBe("ctc_" + invalidID);
});

test("TestSanitizeCodexInputItemIDsNormalizesCustomToolCallOutputIDs", () => {
  const invalidID = "item_44e13caebc1ddf25f1337cbe_output";
  const validID = "ctco-existing";
  const body =
    `{"input":[` +
    `{"type":"custom_tool_call_output","id":"${invalidID}","call_id":"call-1","output":"done"},` +
    `{"type":"custom_tool_call_output","id":"${validID}","call_id":"call-2","output":"done"}` +
    `]}`;
  const first = sanitizeCodexInputItemIDs(body);
  expect(getString(first, "input.0.id")).toBe("ctco_" + invalidID);
  expect(getString(first, "input.1.id")).toBe(validID);
  expect(sanitizeCodexInputItemIDs(body)).toBe(first);
  expect(sanitizeCodexInputItemIDs(first)).toBe(first);
});

test("TestSanitizeCodexInputItemIDsDropsOverlongEncryptedReasoningItem", () => {
  const longReasoningID = "rs_" + "a".repeat(64);
  const shortReasoningID = "rs_" + "b".repeat(48);
  const longCallID = "call-item-".repeat(8);
  const body =
    `{"input":[` +
    `{"type":"message","id":"msg-1","role":"user","content":"before"},` +
    `{"type":"reasoning","id":"${longReasoningID}","encrypted_content":"gAAAA-encrypted","summary":[{"type":"summary_text","text":"drop me"}]},` +
    `{"type":"reasoning","id":"${shortReasoningID}","encrypted_content":"gAAAA-encrypted","summary":[]},` +
    `{"type":"function_call","id":"${longCallID}","call_id":"call-1","name":"lookup","arguments":"{}"}` +
    `]}`;
  const got = sanitizeCodexInputItemIDs(body);
  const input = getValue(got, "input") as Array<{ id: string }>;
  expect(input.length).toBe(3);
  expect(input[0]!.id).toBe("msg-1");
  expect(input[1]!.id).toBe(shortReasoningID);
  expect(input[2]!.id).not.toBe(longCallID);
  expect(runes(input[2]!.id)).toBe(64);
});

describe("TestSanitizeCodexInputItemIDsShortensOverlongReasoningWithoutEncryptedContent", () => {
  const longReasoningID = "rs_" + "a".repeat(64);
  for (const tc of [
    { name: "missing", encryptedContent: "" },
    { name: "empty", encryptedContent: `,"encrypted_content":""` },
    { name: "null", encryptedContent: `,"encrypted_content":null` },
  ]) {
    test(tc.name, () => {
      const got = sanitizeCodexInputItemIDs(`{"input":[{"type":"reasoning","id":"${longReasoningID}"${tc.encryptedContent},"summary":[]}]}`);
      const input = getValue(got, "input") as Array<{ id: string }>;
      expect(input.length).toBe(1);
      expect(input[0]!.id).not.toBe(longReasoningID);
      expect(runes(input[0]!.id)).toBe(64);
    });
  }
});

test("TestSanitizeCodexInputItemIDsAvoidsExistingIDCollision", () => {
  const longID = "grok-item-".repeat(10);
  const collidingValidID = shortenCodexInputItemID(longID);
  const body = `{"input":[{"id":"${longID}"},{"id":"${collidingValidID}"}]}`;
  const first = sanitizeCodexInputItemIDs(body);
  const second = sanitizeCodexInputItemIDs(body);
  const shortened = getString(first, "input.0.id");
  expect(shortened).not.toBe(collidingValidID);
  expect(runes(shortened)).toBeLessThanOrEqual(64);
  expect(getString(first, "input.1.id")).toBe(collidingValidID);
  expect(getString(second, "input.0.id")).toBe(shortened);
});

test("TestSanitizeCodexInputItemIDsLeavesUnsupportedPayloadsUnchanged", () => {
  for (const body of [`not-json`, `{"input":{"id":"item-1"}}`, `{"input":[1,{"id":2},{"id":"item-1"}]}`]) {
    expect(sanitizeCodexInputItemIDs(body)).toBe(body);
  }
});

describe("TestCodexExecutorExecuteStreamSanitizesOverlongInputItemIDs", () => {
  const upstream = startUpstream(() =>
    sseResponse(`data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n`),
  );
  afterAll(() => upstream.close());

  test("overlong ids are shortened and encrypted overlong reasoning dropped", async () => {
    const longReasoningItemID = "rs_" + "a".repeat(64);
    const longCallItemID = "grok-call-item-".repeat(6);
    const longOutputItemID = "grok-output-item-".repeat(6);
    const payload =
      `{"model":"gpt-5.4","stream":true,"input":[` +
      `{"type":"reasoning","id":"${longReasoningItemID}","encrypted_content":"gAAAAencrypted","summary":[]},` +
      `{"type":"function_call","id":"${longCallItemID}","call_id":"call-1","name":"lookup","arguments":"{}"},` +
      `{"type":"function_call_output","id":"${longOutputItemID}","call_id":"call-1","output":"ok"},` +
      `{"type":"message","id":"item_74ec40c883248ebb4885ec84","role":"user","content":"continue"}]}`;
    const executor = new CodexExecutor();
    const result = await executor.executeStream(apiKeyAuth(upstream.url), request("gpt-5.4", payload), options("openai-response", true));
    await drain(result);

    const gotBody = upstream.requests[upstream.requests.length - 1]!.body;
    expect((getValue(gotBody, "input") as unknown[]).length).toBe(3);
    expect(getString(gotBody, "input.0.type")).toBe("function_call");
    for (const [path, originalID] of [
      ["input.0.id", longCallItemID],
      ["input.1.id", longOutputItemID],
    ] as const) {
      const actual = getString(gotBody, path);
      expect(runes(actual)).toBeLessThanOrEqual(64);
      expect(actual).not.toBe(originalID);
    }
    expect(getString(gotBody, "input.0.call_id")).toBe("call-1");
    expect(getString(gotBody, "input.1.call_id")).toBe("call-1");
    expect(getString(gotBody, "input.2.id")).toBe("msg_item_74ec40c883248ebb4885ec84");
  });
});

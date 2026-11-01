// New test (no Go counterpart): end-to-end stream bootstrap buffering through the real AuthManager and the
// real Codex -> Claude translator. Account A answers HTTP 200 with response.created (which the translator renders
// as a Claude message_start) followed by an overload error frame; with buffering the message_start is held, the
// overload throws before any chunk and the manager fails over to account B, so the client sees one clean Claude
// stream. Without buffering the message_start commits account A's stream and the overload arrives in-stream.
import { afterAll, describe, expect, test } from "bun:test";
import { StatusError } from "../../../src/executor/types.ts";
import { accountOf, claudePayload, codexManager, drain, options, sseResponse, startUpstream } from "./helpers.ts";

const model = "gpt-6-astra-bootstrap";

const overloadEvent = `{"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null},"sequence_number":2}`;

function scenario(buffering: boolean) {
  const attempts: string[] = [];
  const upstream = startUpstream((req) => {
    const account = accountOf(req);
    attempts.push(account);
    if (account === "account-a") {
      return sseResponse(
        `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_a","model":"${model}"}}\n\n` +
          `event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_a"}}\n\n` +
          `event: error\ndata: ${overloadEvent}\n\n`,
      );
    }
    return sseResponse(
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_b","model":"${model}"}}\n\n` +
        `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_b","type":"message","role":"assistant","content":[]}}\n\n` +
        `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"item_id":"msg_b","part":{"type":"output_text","text":""}}\n\n` +
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_b","delta":"FROM_B"}\n\n` +
        `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_b","type":"message","role":"assistant","content":[{"type":"output_text","text":"FROM_B"}]}}\n\n` +
        `data: {"type":"response.completed","response":{"id":"resp_b","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n`,
    );
  });
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 2 }, { streamBootstrapBuffering: buffering });
  harness.addAuth(`codex-bootstrap-a-${buffering}`, "account-a", upstream.url, { priority: 100, disableCooling: true, models: [model] });
  harness.addAuth(`codex-bootstrap-b-${buffering}`, "account-b", upstream.url, { priority: 0, disableCooling: true, models: [model] });
  afterAll(() => {
    harness.cleanup();
    upstream.close();
  });
  const run = async () => {
    const result = await harness.manager.executeStream(["codex"], { model, payload: claudePayload(model), format: "claude" }, options("claude", true));
    return drain(result);
  };
  return { attempts, run };
}

function events(body: string): string[] {
  return [...body.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!);
}

describe("Codex bootstrap buffering fails an in-stream overload over to the next account", () => {
  const { attempts, run } = scenario(true);

  test("the client sees one clean Claude stream from account B", async () => {
    const { chunks, error } = await run();
    expect(error).toBeUndefined();
    const body = chunks.join("");
    expect(attempts).toEqual(["account-a", "account-b"]);
    const seen = events(body);
    expect(seen[0]).toBe("message_start");
    expect(seen[seen.length - 1]).toBe("message_stop");
    expect(seen.filter((e) => e === "message_start").length).toBe(1);
    expect(seen).not.toContain("error");
    expect(body).toContain("FROM_B");
    expect(body).toContain(`"id":"resp_b"`);
    expect(body).not.toContain("resp_a");
    expect(body).not.toContain("overloaded");
  });
});

describe("Without bootstrap buffering the overload is delivered in-stream on account A", () => {
  const { attempts, run } = scenario(false);

  test("message_start commits account A, then the overload surfaces", async () => {
    const { chunks, error } = await run();
    expect(attempts).toEqual(["account-a"]);
    expect(chunks.join("")).toContain("event: message_start");
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
  });
});

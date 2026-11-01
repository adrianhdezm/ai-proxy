// Ported from: test/codex_stream_disconnect_failover_test.go
// Skipped cases: none (the "buffered" sub-cases run with streamBootstrapBuffering: true). Adaptations: Claude Messages
//   inbound requests (Go used openai-response), so payload checks look for the translated text and
//   message_stop; TestCodexStreamDisconnectExhaustionNotInvalidRequestError formats the surfaced error with the
//   server's Claude error envelope (src/server/errors.ts) instead of driving the gin /v1/responses handler,
//   and expects the Claude server-side type api_error (Go: server_error in the OpenAI taxonomy);
//   TestCodexStreamAbnormalDisconnectBeforeOutputFailsOver drops the connection with a raw Bun.listen socket
//   closed mid-body (Go: Hijacker).
import { afterAll, describe, expect, test } from "bun:test";
import { StatusError } from "../../../src/executor/types.ts";
import { claudeErrorBody, executionErrorMessage } from "../../../src/server/errors.ts";
import { accountOf, claudePayload, codexManager, drain, getString, options, sseResponse, startUpstream } from "./helpers.ts";

const model = "gpt-6-astra";

function emptyBody(): Response {
  return sseResponse("");
}

const run = async (harness: ReturnType<typeof codexManager>) => {
  const result = await harness.manager.executeStream(["codex"], { model, payload: claudePayload(model), format: "claude" }, options("claude", true));
  const { chunks, error } = await drain(result);
  return { body: chunks.join(""), error };
};

for (const buffering of [false, true]) describe(`TestCodexStreamDisconnectAfterHeadersFailsOver/${buffering ? "buffered" : "unbuffered"}`, () => {
  const attempts: string[] = [];
  const upstream = startUpstream((req) => {
    const account = accountOf(req);
    attempts.push(account);
    if (account === "account-a") return emptyBody();
    return sseResponse(
      `data: {"type":"response.created","response":{"id":"resp_b","model":"${model}"}}\n\n` +
        `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_b","type":"message"}}\n\n` +
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_b","delta":"MOCK_B"}\n\n` +
        `data: {"type":"response.completed","response":{"id":"resp_b","status":"completed","output":[]}}\n\n`,
    );
  });
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 2 }, { streamBootstrapBuffering: buffering });
  harness.addAuth(`codex-failover-a-${buffering}`, "account-a", upstream.url, { priority: 100, disableCooling: true, models: [model] });
  harness.addAuth(`codex-failover-b-${buffering}`, "account-b", upstream.url, { priority: 0, disableCooling: true, models: [model] });
  afterAll(() => {
    harness.cleanup();
    upstream.close();
  });

  test("an empty accepted stream fails over to the second account", async () => {
    const { body, error } = await run(harness);
    expect(error).toBeUndefined();
    expect(body).toContain("MOCK_B");
    expect(body).toContain("event: message_stop");
    expect(attempts).toEqual(["account-a", "account-b"]);
  });
});

describe("TestCodexStreamDisconnectExhaustionNotInvalidRequestError", () => {
  const upstream = startUpstream(() => emptyBody());
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 0 });
  harness.addAuth("codex-exhaustion-test", "dummy", upstream.url, { disableCooling: true, models: [model] });
  afterAll(() => {
    harness.cleanup();
    upstream.close();
  });

  test("the surfaced error is a server-side error, not invalid_request_error", async () => {
    const { body, error } = await run(harness);
    expect(body).toBe("");
    expect(error).toBeDefined();
    const envelope = claudeErrorBody(executionErrorMessage(error));
    const errorType = getString(envelope, "error.type");
    expect(errorType).not.toBe("invalid_request_error");
    expect(errorType).toBe("api_error");
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).statusCode).toBe(502);
  });
});

for (const buffering of [false, true]) describe(`TestCodexStreamDisconnectAfterOutputDoesNotFailOver/${buffering ? "buffered" : "unbuffered"}`, () => {
  const attempts: string[] = [];
  const upstream = startUpstream((req) => {
    attempts.push(accountOf(req));
    return sseResponse(
      `data: {"type":"response.created","response":{"id":"resp_a","model":"${model}"}}\n\n` +
        `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_a","type":"message"}}\n\n` +
        `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_a","delta":"MOCK_A_PARTIAL"}\n\n`,
    );
  });
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 2 }, { streamBootstrapBuffering: buffering });
  harness.addAuth(`codex-partial-a-${buffering}`, "account-a", upstream.url, { priority: 100, disableCooling: true, models: [model] });
  harness.addAuth(`codex-partial-b-${buffering}`, "account-b", upstream.url, { priority: 0, disableCooling: true, models: [model] });
  afterAll(() => {
    harness.cleanup();
    upstream.close();
  });

  test("partial output is delivered, then the truncation error, without replaying on account B", async () => {
    const { body, error } = await run(harness);
    expect(body).toContain("MOCK_A_PARTIAL");
    expect(error).toBeInstanceOf(StatusError);
    expect((error as StatusError).streamTruncated).toBe(true);
    expect(attempts).toEqual(["account-a"]);
  });
});

describe("TestCodexStreamAbnormalDisconnectBeforeOutputFailsOver", () => {
  // A raw TCP upstream (Go: http.Hijacker): account A gets 200 headers of a chunked body and then the
  // connection is closed mid-body; account B gets a complete response.
  const attempts: string[] = [];
  const okBody =
    `data: {"type":"response.created","response":{"id":"resp_b","model":"${model}"}}\n\n` +
    `data: {"type":"response.completed","response":{"id":"resp_b","status":"completed","output":[]}}\n\n`;
  const received = new Map<object, string>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const text = (received.get(socket) ?? "") + new TextDecoder().decode(data);
        received.set(socket, text);
        const headerEnd = text.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(text.slice(0, headerEnd))?.[1] ?? "0");
        if (text.length < headerEnd + 4 + length) return;
        const account = (/authorization:\s*Bearer\s+(\S+)/i.exec(text.slice(0, headerEnd))?.[1] ?? "").trim();
        attempts.push(account);
        if (account === "account-a") {
          socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
          socket.end();
          return;
        }
        const bytes = new TextEncoder().encode(okBody).length;
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${bytes}\r\nConnection: close\r\n\r\n${okBody}`);
        socket.end();
      },
      close(socket) {
        received.delete(socket);
      },
    },
  });
  const harness = codexManager({ requestRetry: 0, maxRetryCredentials: 2 });
  const url = `http://127.0.0.1:${server.port}`;
  harness.addAuth("codex-abnormal-a", "account-a", url, { priority: 100, disableCooling: true, models: [model] });
  harness.addAuth("codex-abnormal-b", "account-b", url, { priority: 0, disableCooling: true, models: [model] });
  afterAll(() => {
    harness.cleanup();
    server.stop(true);
  });

  test("a connection dropped before output fails over to the second account", async () => {
    const { body, error } = await run(harness);
    expect(error).toBeUndefined();
    expect(body).toContain("event: message_stop");
    expect(attempts).toEqual(["account-a", "account-b"]);
  });
});

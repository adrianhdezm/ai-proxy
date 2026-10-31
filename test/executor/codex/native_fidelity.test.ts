// Ported from: internal/runtime/executor/codex_native_fidelity_test.go
// Skipped cases: the FormatOpenAI (chat completions) source of TestCodexNativeStreamFidelity (OpenAI chat-completions
//   inbound is not served by this port). Adaptations: every websocket sub-case uses its own session store so
//   upstream connections are not shared between sub-cases.
import { afterAll, describe, expect, test } from "bun:test";
import { newAuth } from "../../../src/auth/types.ts";
import { CodexExecutor, CodexWebsocketSessionStore, CodexWebsocketsExecutor, applyCodexWebsocketHeaders, codexResponsesLiteHeader, headerValueCaseInsensitive } from "../../../src/executor/codex/index.ts";
import type { ExecOptions } from "../../../src/executor/types.ts";
import { getString, getValue, sseResponse, startUpstream } from "./helpers.ts";
import { startFakeCodexWebsocket } from "./websocket_helpers.ts";

const metadata = `{"type":"codex.response.metadata","headers":{"x-models-etag":"models-v1","x-codex-turn-state":"turn-1","x-codex-safety-buffering-enabled":"true","x-codex-safety-buffering-faster-model":"fixture-model"},"future":{"ok":true}}`;
const completed = `{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"future":{"ok":true},"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`;
const events = [metadata, `{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}`, completed];

const http = startUpstream(() => sseResponse(events.map((event) => `data: ${event}\n\n`).join("")));
const ws = startFakeCodexWebsocket({
  onMessage(conn) {
    for (const event of events) conn.send(event);
  },
});
afterAll(() => {
  http.close();
  ws.close();
});

describe("TestCodexNativeStreamFidelity", () => {
  for (const source of ["codex", "openai-response", "claude"]) {
    for (const transport of ["http", "websocket"] as const) {
      for (const lite of ["", "header", "metadata"]) {
        for (const buffering of [false, true]) {
          test(`${source}/${transport}/lite=${lite}/buffering=${buffering}`, async () => {
            let payload = `{"model":"gpt-5.6-sol","input":[],"parallel_tool_calls":false}`;
            const headers = new Headers({ "Session-Id": "session-1", "Thread-Id": "thread-1" });
            if (lite === "header") headers.set(codexResponsesLiteHeader, "true");
            else if (lite === "metadata") payload = `{"model":"gpt-5.6-sol","input":[],"parallel_tool_calls":false,"client_metadata":{"ws_request_header_x_openai_internal_codex_responses_lite":"true"}}`;
            const options = { streamBootstrapBuffering: buffering, disableCloaking: true };
            const server = transport === "http" ? http : ws;
            const auth = newAuth({ id: `codex-fidelity-${transport}`, provider: "codex", attributes: { api_key: "test", base_url: server.url } });
            const executor = transport === "http" ? new CodexExecutor(options) : new CodexWebsocketsExecutor({ ...options, store: new CodexWebsocketSessionStore() });
            const connsBefore = ws.connections.length;
            const opts = { sourceFormat: source, responseFormat: "codex", headers, stream: true } as ExecOptions;
            const result = await executor.executeStream(auth, { model: "gpt-5.6-sol", payload, format: source }, opts);

            let terminal = "";
            const metadataEvents: string[] = [];
            for await (const chunk of result.chunks) {
              for (const line of chunk.split("\n")) {
                const data = (line.startsWith("data:") ? line.slice(5) : line).trim();
                const type = getString(data, "type");
                if (type === "codex.response.metadata") metadataEvents.push(data);
                if (type === "response.completed") terminal = data;
              }
            }

            let body: string;
            let upstreamHeaders: Headers;
            if (transport === "http") {
              const sent = http.requests[http.requests.length - 1]!;
              body = sent.body;
              upstreamHeaders = sent.headers;
            } else {
              const conn = ws.connections[connsBefore]!;
              body = await conn.message(0);
              upstreamHeaders = conn.headers;
            }

            const native = lite !== "" && (source === "codex" || source === "openai-response");
            if (transport === "websocket") {
              const wantLiteHeader = native && lite === "header" ? "true" : null;
              expect(upstreamHeaders.get(codexResponsesLiteHeader)).toBe(wantLiteHeader);
              const alias = headerValueCaseInsensitive(upstreamHeaders, "session_id");
              // Native Lite requests carry no session alias; compatibility requests get one.
              expect(alias === "").toBe(native);
            }
            expect(metadataEvents).toEqual([metadata]);
            if (native) {
              expect(getValue(body, "instructions")).toBeUndefined();
              expect(terminal).toBe(completed);
            } else {
              expect(typeof getValue(body, "instructions")).toBe("string");
              expect(getString(terminal, "response.output.0.id")).toBe("msg_1");
            }
          });
        }
      }
    }
  }
});

test("TestCodexWebsocketLiteHeaderWithoutSessionHeaders", () => {
  for (const native of [false, true]) {
    for (const disableCloaking of [false, true]) {
      const clientHeaders = new Headers({ [codexResponsesLiteHeader]: "true" });
      const got = applyCodexWebsocketHeaders(new Headers(), undefined, "fixture-token", { disableCloaking }, native, clientHeaders);
      expect(got.get(codexResponsesLiteHeader) ?? "").toBe(native ? "true" : "");
    }
  }
});

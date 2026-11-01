// Ported from: internal/config/response_compression_test.go
// Skipped cases: the JSON round-trip half of TestResponseCompressionConfig (JSON config not carried),
//   TestCodexWebsocketCompressionConfig (the upstream Codex websocket has no compression switch in Bun, so
//   codex.websocket-compression is not carried).
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";
import { effectiveResponseCompressionMinBytes, responseCompressionEnabled } from "../../src/server/response_compression.ts";

describe("TestResponseCompressionConfig", () => {
  for (const tc of [
    { name: "defaults", input: "{}", enabled: true, minBytes: 1024 },
    { name: "disabled", input: "server:\n  response-compression:\n    enabled: false\n    min-bytes: 64", enabled: false, minBytes: 64 },
    { name: "enabled", input: "server:\n  response-compression:\n    enabled: true\n    min-bytes: -1", enabled: true, minBytes: 1024 },
  ]) {
    test(tc.name, () => {
      const options = parseConfig(tc.input, { env: {}, home: "/home/tester", warn: () => {} }).server.responseCompression;
      expect(responseCompressionEnabled(options)).toBe(tc.enabled);
      expect(effectiveResponseCompressionMinBytes(options)).toBe(tc.minBytes);
    });
  }
});

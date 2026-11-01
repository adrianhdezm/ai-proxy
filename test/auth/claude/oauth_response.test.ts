// Ported from: internal/auth/claude/oauth_response_test.go
// Skipped cases: none ("compress"/LZW is rejected as unsupported in this port; it is not covered upstream either)
import { describe, expect, test } from "bun:test";
import { decodeClaudeOAuthBody, readClaudeOAuthResponseBody } from "../../../src/auth/claude/oauth_response.ts";
import { compress } from "../helpers.ts";

const payload = `{"account":{"uuid":"test"}}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("readClaudeOAuthResponseBody", () => {
  test("decodes stacked repeated headers (gzip then br)", async () => {
    const gz = await compress(enc.encode(payload), "gzip");
    const br = await compress(gz, "brotli");
    const got = await decodeClaudeOAuthBody(br, ["gzip", "br"]);
    expect(dec.decode(got)).toBe(payload);

    const headers = new Headers();
    headers.append("Content-Encoding", "gzip");
    headers.append("Content-Encoding", "br");
    const resp = new Response(br, { headers });
    expect(await readClaudeOAuthResponseBody(resp)).toBe(payload);
  });

  const cases: Array<{ name: string; encoding: string; format: Bun.CompressionFormat }> = [
    { name: "gzip", encoding: "gzip", format: "gzip" },
    { name: "brotli", encoding: "br", format: "brotli" },
    { name: "deflate", encoding: "deflate", format: "deflate" },
  ];
  for (const tt of cases) {
    test(`decodes advertised ${tt.name}`, async () => {
      const body = await compress(enc.encode(payload), tt.format);
      const resp = new Response(body, { headers: { "Content-Encoding": tt.encoding } });
      expect(await readClaudeOAuthResponseBody(resp)).toBe(payload);
    });
  }

  test("identity and empty encodings pass through", async () => {
    const got = await decodeClaudeOAuthBody(enc.encode(payload), "identity, ");
    expect(dec.decode(got)).toBe(payload);
  });

  test("unsupported encodings are rejected", async () => {
    await expect(decodeClaudeOAuthBody(enc.encode(payload), "compress")).rejects.toThrow("unsupported content encoding");
    await expect(decodeClaudeOAuthBody(enc.encode(payload), "zstd-x")).rejects.toThrow("unsupported content encoding");
  });
});

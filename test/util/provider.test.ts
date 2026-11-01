// Ported from: internal/util/provider_test.go
// Skipped cases: none
import { describe, expect, test } from "bun:test";
import { maskSensitiveQuery } from "../../src/util/provider.ts";

describe("MaskSensitiveQuery masks value", () => {
  const secretKey = "sk-secret-client-key";
  test("value parameter is masked", () => {
    const masked = maskSensitiveQuery("value=" + secretKey);
    expect(masked.includes(secretKey)).toBe(false);
    expect(masked).toBe("value=sk-s...-key");
  });
  test("index parameter is untouched", () => {
    expect(maskSensitiveQuery("index=3")).toBe("index=3");
  });
  test("known secret parameters stay masked", () => {
    const masked = maskSensitiveQuery("key=" + secretKey + "&access_token=" + secretKey);
    expect(masked.includes(secretKey)).toBe(false);
  });
});

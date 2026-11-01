// Ported from: internal/translator/codex/claude/codex_claude_compat_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { convertClaudeRequestToCodex, convertClaudeRequestToCodexWithCompat } from "../../../src/translator/codex/claude/index.ts";
import { get, validCodexReasoningSignature } from "./helpers.ts";

function inputCount(result: string): number {
  return (get(result, "input") as unknown[]).length;
}

test("ConvertClaudeRequestToCodexWithCompat preserves empty thinking", () => {
  const payload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":""}]}]}`;
  const withoutCompat = convertClaudeRequestToCodex("deepseek-v4", payload, false);
  expect(inputCount(withoutCompat)).toBe(0);

  const withCompat = convertClaudeRequestToCodexWithCompat("deepseek-v4", payload, false);
  expect(get(withCompat, "input.0.type")).toBe("reasoning");
  expect(get(withCompat, "input.0.encrypted_content")).toBeDefined();
});

test("ConvertClaudeRequestToCodexWithCompat unknown thinking signatures", () => {
  const unknownSig = "opaque-encrypted-reasoning-token-xyz";
  const unknownPayload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"${unknownSig}"}]}]}`;

  const withCompatNonStream = convertClaudeRequestToCodexWithCompat("deepseek-v4", unknownPayload, false);
  expect(get(withCompatNonStream, "input.0.type")).toBe("reasoning");
  expect(get(withCompatNonStream, "input.0.encrypted_content")).toBe(unknownSig);

  const withCompatStream = convertClaudeRequestToCodexWithCompat("deepseek-v4", unknownPayload, true);
  expect(get(withCompatStream, "input.0.type")).toBe("reasoning");
  expect(get(withCompatStream, "input.0.encrypted_content")).toBe(unknownSig);

  expect(inputCount(convertClaudeRequestToCodex("deepseek-v4", unknownPayload, false))).toBe(0);
  expect(inputCount(convertClaudeRequestToCodex("deepseek-v4", unknownPayload, true))).toBe(0);

  const claudeSig =
    "CAISqwIKiAEIEBgCKkBHRlRBsNiptQUWfPoOhuQKwi5LnncZVO9bB5jqOs76D7uBtgktML0zqJtNmLHXHHcgD6lk4MQu4QBXzFd1lbC3Mg5jbGF1ZGUtZmFibGUtNTgBQgh0aGlua2luZ1okZDk3NDM5NzUtNGJiMC00OTM2LTllMjgtZDViMGQyMWJkYzQ4EgxCGh+XVFFFeySAjtAaDL/A1LltGu6MMJ+eXSIwsN0oBpDrqLv22UBfkMnTotnIbkvkOyb9xZHgigG6OZVHaI3gThm+maLKmgO5PrFLKlDFYp+YZksy/wKwszJlnLTPzAK+NUlfzagOE1ymtZTXhAYK260XyFYmg/te/C231+Fr/hoX+EJoUBnrn0gD7hqMISOT+TaFEuOXYsN517GfaxgB";
  const claudePayload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"${claudeSig}"}]}]}`;
  expect(inputCount(convertClaudeRequestToCodexWithCompat("deepseek-v4", claudePayload, false))).toBe(0);

  const gptRawSig = validCodexReasoningSignature();
  const gptPayload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"gpt#${gptRawSig}"}]}]}`;
  const gptCompat = convertClaudeRequestToCodexWithCompat("deepseek-v4", gptPayload, false);
  expect(get(gptCompat, "input.0.type")).toBe("reasoning");
  expect(get(gptCompat, "input.0.encrypted_content")).toBe(gptRawSig);

  for (const signature of ["12345", `{"opaque":"data"}`, "true", `["arr"]`]) {
    const nonStringPayload = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":${signature}}]}]}`;
    expect(inputCount(convertClaudeRequestToCodexWithCompat("deepseek-v4", nonStringPayload, false))).toBe(0);
  }
});

test("ConvertClaudeRequestToCodexWithCompat preserves message flushing and escaped unknown signature", () => {
  const escapedSig = 'enc:"token"\\with\\unicode-一';
  const escapedPayload = `{"messages":[{"role":"assistant","content":[{"type":"text","text":"before"},{"type":"thinking","thinking":"reason","signature":"enc:\\"token\\"\\\\with\\\\unicode-\\u4e00"},{"type":"text","text":"after"}]}]}`;
  const withCompat = convertClaudeRequestToCodexWithCompat("deepseek-v4", escapedPayload, false);
  expect(inputCount(withCompat)).toBe(3);
  expect(get(withCompat, "input.0.role")).toBe("assistant");
  expect(get(withCompat, "input.0.content.0.text")).toBe("before");
  expect(get(withCompat, "input.1.type")).toBe("reasoning");
  expect(get(withCompat, "input.1.encrypted_content")).toBe(escapedSig);
  expect(get(withCompat, "input.2.role")).toBe("assistant");
  expect(get(withCompat, "input.2.content.0.text")).toBe("after");
});

test("ConvertClaudeRequestToCodexWithCompat whitespace and null signatures", () => {
  const whitespaceCompat = convertClaudeRequestToCodexWithCompat("deepseek-v4", `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"   "}]}]}`, false);
  expect(get(whitespaceCompat, "input.0.type")).toBe("reasoning");
  expect(get(whitespaceCompat, "input.0.encrypted_content")).toBe("   ");

  const nullCompat = convertClaudeRequestToCodexWithCompat("deepseek-v4", `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":null}]}]}`, false);
  expect(get(nullCompat, "input.0.type")).toBe("reasoning");
  expect(get(nullCompat, "input.0.encrypted_content")).toBe("");
});

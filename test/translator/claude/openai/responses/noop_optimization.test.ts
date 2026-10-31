// Ported from: internal/translator/claude/openai/responses/noop_optimization_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { convertClaudeResponseToOpenAIResponsesNonStream } from "../../../../../src/translator/claude/openai/responses/index.ts";
import { emptyContext } from "../../../../../src/translator/types.ts";
import { get, useClientToolSearchDefault } from "./helpers.ts";

useClientToolSearchDefault();

test("non-stream keeps zero usage defaults", () => {
  const input = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`;
  const output = convertClaudeResponseToOpenAIResponsesNonStream(emptyContext, "", "", "", input, undefined);
  for (const path of ["usage.input_tokens", "usage.input_tokens_details.cached_tokens", "usage.output_tokens", "usage.total_tokens"]) expect(get(output, path)).toBe(0);
});

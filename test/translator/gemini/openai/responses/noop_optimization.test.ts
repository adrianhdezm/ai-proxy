// Ported from: internal/translator/gemini/openai/responses/noop_optimization_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { g, toGemini } from "./helpers.ts";

test("TestConvertOpenAIResponsesRequestToGeminiBuildsGenerationConfigWithoutIntermediateObject", () => {
  const output = toGemini(
    "gemini-test",
    `{"input":"hello","temperature":0.5,"top_p":0.9,"stop_sequences":["done"],"text":{"format":{"type":"json_schema","schema":{"type":"object"}}}}`,
  );
  expect(g(output, "generationConfig.temperature").num()).toBe(0.5);
  expect(g(output, "generationConfig.topP").num()).toBe(0.9);
  expect(g(output, "generationConfig.stopSequences.0").str()).toBe("done");
  expect(g(output, "generationConfig.responseMimeType").str()).toBe("application/json");
  expect(g(output, "generationConfig.responseJsonSchema").exists()).toBe(true);
  expect(g(output, "generationConfig.responseSchema").exists()).toBe(false);
});

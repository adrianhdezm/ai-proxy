// Port of internal/translator/gemini/openai/responses/init.go.
//
// Registers the OpenAI Responses -> Gemini translator pair on the default registry.
// One registration serves both Gemini upstreams: AI Studio responses and Gemini CLI
// (Code Assist) responses, whose {"response": {...}} envelope the response
// translators unwrap. Importing this module performs the registration once.
//
// Upstream registers no token-count transform for this pair; this port adds one
// that answers in the OpenAI Responses input_tokens shape.
import { defaultRegistry } from "../../../registry.ts";
import { FormatGemini, FormatOpenAIResponse, type TranslateContext } from "../../../types.ts";
import { convertOpenAIResponsesRequestToGemini } from "./request.ts";
import { convertGeminiResponseToOpenAIResponses, convertGeminiResponseToOpenAIResponsesNonStream } from "./response.ts";

/** Token count in the OpenAI Responses input_tokens response shape. */
export function openAIResponsesTokenCount(_ctx: TranslateContext, count: number): string {
  return JSON.stringify({ object: "response.input_tokens", input_tokens: count });
}

let registered = false;

/** Registers the OpenAI Responses -> Gemini request/response translators (idempotent). */
export function registerGeminiOpenAIResponsesTranslator(): void {
  if (registered) return;
  registered = true;
  defaultRegistry.register(FormatOpenAIResponse, FormatGemini, convertOpenAIResponsesRequestToGemini, {
    stream: convertGeminiResponseToOpenAIResponses,
    nonStream: convertGeminiResponseToOpenAIResponsesNonStream,
    tokenCount: openAIResponsesTokenCount,
  });
}

registerGeminiOpenAIResponsesTranslator();

export * from "./request.ts";
export * from "./response.ts";
export * from "./signature_carrier.ts";
export * from "./web_search.ts";
export { buildGeminiFunctionDeclarations, convertResponsesToolChoiceToGemini, mapResponsesToolName, responsesToolReverseIdentityMap } from "./tools.ts";

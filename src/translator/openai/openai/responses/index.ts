// Port of internal/translator/openai/openai/responses/init.go.
//
// Registers the OpenAI Responses <-> OpenAI Chat Completions translator pair on
// the default registry (Responses inbound, OpenAI API-key upstream). Upstream
// registers no token-count transform for this pair. Importing this module
// performs the registration once.
import { FormatOpenAI, FormatOpenAIResponse } from "../../../types.ts";
import { register } from "../../../registry.ts";
import { convertOpenAIResponsesRequestToOpenAIChatCompletions } from "./request.ts";
import { convertOpenAIChatCompletionsResponseToOpenAIResponses, convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream } from "./response.ts";

export * from "./request.ts";
export * from "./response.ts";
export * from "./tools.ts";
export * from "./shell_tool.ts";

let registered = false;

/** Registers OpenAI Responses -> Chat Completions (request) and Chat Completions -> Responses (response) transforms; idempotent. */
export function registerOpenAIResponsesTranslator(): void {
  if (registered) return;
  registered = true;
  register(FormatOpenAIResponse, FormatOpenAI, convertOpenAIResponsesRequestToOpenAIChatCompletions, {
    stream: convertOpenAIChatCompletionsResponseToOpenAIResponses,
    nonStream: convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream,
  });
}

registerOpenAIResponsesTranslator();

// Port of internal/translator/codex/openai/responses/init.go.
//
// Registers the OpenAI Responses <-> Codex Responses translator pair on the
// default registry (Responses inbound, Codex OAuth / API-key upstream). Upstream
// registers no token-count transform for this pair. Importing this module
// performs the registration once.
import { FormatCodex, FormatOpenAIResponse } from "../../../types.ts";
import { register } from "../../../registry.ts";
import { convertOpenAIResponsesRequestToCodex } from "./request.ts";
import { convertCodexResponseToOpenAIResponses, convertCodexResponseToOpenAIResponsesNonStream } from "./response.ts";

export * from "./request.ts";
export * from "./response.ts";

let registered = false;

/** Registers OpenAI Responses -> Codex (request) and Codex -> OpenAI Responses (response) transforms; idempotent. */
export function registerCodexOpenAIResponsesTranslator(): void {
  if (registered) return;
  registered = true;
  register(FormatOpenAIResponse, FormatCodex, convertOpenAIResponsesRequestToCodex, {
    stream: convertCodexResponseToOpenAIResponses,
    nonStream: convertCodexResponseToOpenAIResponsesNonStream,
  });
}

registerCodexOpenAIResponsesTranslator();

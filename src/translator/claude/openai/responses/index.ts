// Port of internal/translator/claude/openai/responses/init.go.
//
// Registers the OpenAI Responses <-> Claude Messages translator pair on the
// default registry: requests from a Responses client go to a Claude upstream,
// and Claude responses come back in Responses format. Importing this module
// performs the registration.
//
// Upstream registered no token-count transform for this pair, so none is set.
// The request transform reads the global upstream.claude.tool-search switch
// (setClientToolSearchEnabled); executors that need the value pinned for one
// request call convertOpenAIResponsesRequestToClaudeWithToolSearch and pass
// withClientToolSearch(ctx, enabled) to the response translators.
import { FormatClaude, FormatOpenAIResponse } from "../../../types.ts";
import { defaultRegistry } from "../../../registry.ts";
import { convertOpenAIResponsesRequestToClaude } from "./request.ts";
import { convertClaudeResponseToOpenAIResponses, convertClaudeResponseToOpenAIResponsesNonStream } from "./response.ts";

export * from "./request.ts";
export * from "./response.ts";
export * from "./tool_search.ts";
export * from "./tools.ts";
export * from "./web_search.ts";

let registered = false;

/** Registers Responses -> Claude request and Claude -> Responses response transforms (idempotent). */
export function registerClaudeOpenAIResponsesTranslator(): void {
  if (registered) return;
  registered = true;
  defaultRegistry.register(FormatOpenAIResponse, FormatClaude, convertOpenAIResponsesRequestToClaude, {
    stream: convertClaudeResponseToOpenAIResponses,
    nonStream: convertClaudeResponseToOpenAIResponsesNonStream,
  });
}

registerClaudeOpenAIResponsesTranslator();

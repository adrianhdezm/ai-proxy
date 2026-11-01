// Port of internal/translator/openai/claude/init.go.
//
// Registers the Claude Messages <-> OpenAI Chat Completions translator pair on the
// default registry (Claude inbound, OpenAI API-key upstream). Importing this
// module performs the registration once.
import { FormatClaude, FormatOpenAI } from "../../types.ts";
import { register } from "../../registry.ts";
import { convertClaudeRequestToOpenAI } from "./request.ts";
import { claudeTokenCount, convertOpenAIResponseToClaude, convertOpenAIResponseToClaudeNonStream } from "./response.ts";

export * from "./request.ts";
export * from "./response.ts";

let registered = false;

/** Registers Claude -> OpenAI (request) and OpenAI -> Claude (response) transforms; idempotent. */
export function registerOpenAIClaudeTranslator(): void {
  if (registered) return;
  registered = true;
  register(FormatClaude, FormatOpenAI, convertClaudeRequestToOpenAI, {
    stream: convertOpenAIResponseToClaude,
    nonStream: convertOpenAIResponseToClaudeNonStream,
    tokenCount: claudeTokenCount,
  });
}

registerOpenAIClaudeTranslator();

// Port of internal/translator/gemini/claude/init.go: registers the Claude -> Gemini
// translator pair on the default registry. Importing this module registers it.
import { defaultRegistry } from "../../registry.ts";
import { FormatClaude, FormatGemini } from "../../types.ts";
import { convertClaudeRequestToGemini } from "./request.ts";
import { claudeTokenCount, convertGeminiResponseToClaude, convertGeminiResponseToClaudeNonStream } from "./response.ts";

let registered = false;

/** Registers the Claude -> Gemini request/response translators on the default registry (idempotent). */
export function registerGeminiClaudeTranslator(): void {
  if (registered) return;
  registered = true;
  defaultRegistry.register(FormatClaude, FormatGemini, convertClaudeRequestToGemini, {
    stream: convertGeminiResponseToClaude,
    nonStream: convertGeminiResponseToClaudeNonStream,
    tokenCount: claudeTokenCount,
  });
}

registerGeminiClaudeTranslator();

export * from "./request.ts";
export * from "./response.ts";

// Port of internal/translator/codex/claude/init.go.
//
// Registers the Claude Messages <-> Codex Responses translator pair on the
// default registry. Importing this module performs the registration.
import { FormatClaude, FormatCodex } from "../../types.ts";
import { defaultRegistry } from "../../registry.ts";
import { convertClaudeRequestToCodex } from "./request.ts";
import { claudeTokenCount, convertCodexResponseToClaude, convertCodexResponseToClaudeNonStream } from "./response.ts";

export * from "./request.ts";
export * from "./response.ts";
export * from "./web_search.ts";

let registered = false;

/** Registers Claude -> Codex request and Codex -> Claude response transforms (idempotent). */
export function registerCodexClaudeTranslator(): void {
  if (registered) return;
  registered = true;
  defaultRegistry.register(FormatClaude, FormatCodex, convertClaudeRequestToCodex, {
    stream: convertCodexResponseToClaude,
    nonStream: convertCodexResponseToClaudeNonStream,
    tokenCount: claudeTokenCount,
  });
}

registerCodexClaudeTranslator();

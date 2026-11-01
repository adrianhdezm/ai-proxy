// Request translation helpers shared by the executors. Port of the
// TranslateRequest* helpers of internal/runtime/executor/helps/codex_multi_agent_v2.go
// (TranslateRequestReturningError, TranslateRequestWithAPIKeyModelCompatibility,
// TranslateRequestPairReturningError, TranslateRequestPairWithAPIKeyModelCompatibility)
// without the Codex multi-agent v2 rewrites and plugin hooks (not ported).
//
// Go returned (body, err); the TS translators throw a RequestRejectedError
// (UnsupportedPartError for a user turn left empty), so these helpers throw too.
import "../translator/codex/claude/index.ts";
import "../translator/gemini/claude/index.ts";
import "../translator/openai/claude/index.ts";
import "../translator/claude/openai/responses/index.ts";
import { convertClaudeRequestToCodexWithCompat } from "../translator/codex/claude/index.ts";
import { convertClaudeRequestToGeminiWithCompat } from "../translator/gemini/claude/index.ts";
import { convertClaudeRequestToOpenAIWithCompat } from "../translator/openai/claude/index.ts";
import { convertOpenAIResponsesRequestToClaudeWithCompat } from "../translator/claude/openai/responses/index.ts";
import { translateRequest } from "../translator/registry.ts";
import { FormatClaude, FormatCodex, FormatGemini, FormatOpenAI, FormatOpenAIResponse, type Format } from "../translator/types.ts";

/**
 * Translates one payload, using the compat converter for the pairs that have
 * one when the model asks for it; other pairs go through the registry
 * (Go: TranslateRequestReturningError / translateRequestWithAPIKeyModelCompatibilityForExecutor).
 * Throws the translator's rejection (e.g. UnsupportedPartError, HTTP 400).
 */
export function translateRequestWithAPIKeyModelCompatibility(from: Format, to: Format, model: string, payload: string, stream: boolean, isCompat: boolean): string {
  if (isCompat) {
    if (from === FormatClaude && to === FormatCodex) return convertClaudeRequestToCodexWithCompat(model, payload, stream);
    if (from === FormatClaude && to === FormatGemini) return convertClaudeRequestToGeminiWithCompat(model, payload, stream);
    if (from === FormatClaude && to === FormatOpenAI) return convertClaudeRequestToOpenAIWithCompat(model, payload, stream);
    if (from === FormatOpenAIResponse && to === FormatClaude) return convertOpenAIResponsesRequestToClaudeWithCompat(model, payload, stream);
  }
  return translateRequest(from, to, model, payload, stream);
}

export interface TranslatedRequestPair {
  /** The baseline translation; undefined when only the baseline was refused (it is never sent). */
  original: string | undefined;
  /** The translation that is sent upstream. */
  working: string;
}

/**
 * Translates the baseline (original) and working payloads. Identical payloads
 * are translated once. Only the working payload reaches the upstream, so only
 * its rejection is thrown; a refused baseline alone is ignored
 * (Go: TranslateRequestPairWithAPIKeyModelCompatibilityAndUpdateIntent).
 */
export function translateRequestPairWithAPIKeyModelCompatibility(
  from: Format,
  to: Format,
  model: string,
  originalPayload: string,
  requestPayload: string,
  stream: boolean,
  isCompat: boolean,
): TranslatedRequestPair {
  if (originalPayload === requestPayload) {
    // A single translation serves both payloads, so its error is the working error.
    const translated = translateRequestWithAPIKeyModelCompatibility(from, to, model, requestPayload, stream, isCompat);
    return { original: translated, working: translated };
  }
  const working = translateRequestWithAPIKeyModelCompatibility(from, to, model, requestPayload, stream, isCompat);
  let original: string | undefined;
  try {
    original = translateRequestWithAPIKeyModelCompatibility(from, to, model, originalPayload, stream, isCompat);
  } catch {
    original = undefined;
  }
  return { original, working };
}

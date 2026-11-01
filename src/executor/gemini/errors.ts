// Error classification shared by the Gemini CLI and AI Studio executors.
// Port of newGeminiStatusErr / parseRetryDelay (v7.0.12 gemini_cli_executor.go),
// geminiPromptBlockErrorMessage / geminiStreamHasFinishSignal (current
// gemini_executor.go), helps.JSONPayload and the Claude error capture helpers
// of helps/apply_patch.go (TranslatedClaudeErrorPayload / TranslatedClaudeStreamErrorPayload).
import { StatusError } from "../types.ts";
import { FormatClaude, type Format } from "../../translator/types.ts";
import { getAt, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

const durationUnitsMs: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  "μs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses a Go duration string ("0.847655010s", "373.801628ms", "1h2m3s") into
 * milliseconds (Go: time.ParseDuration). Returns undefined when invalid.
 */
export function parseGoDuration(input: string): number | undefined {
  let s = input.trim();
  if (s === "") return undefined;
  let sign = 1;
  if (s[0] === "-" || s[0] === "+") {
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s === "") return undefined;
  const re = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/;
  let total = 0;
  while (s.length > 0) {
    const m = re.exec(s);
    if (!m) return undefined;
    total += Number(m[1]) * durationUnitsMs[m[2]!]!;
    s = s.slice(m[0].length);
  }
  return sign * total;
}

/**
 * Extracts the retry delay (ms) from a Google API error body: RetryInfo.retryDelay,
 * then ErrorInfo.metadata.quotaResetDelay, then "... after Ns." / "after 1h2m3s"
 * in error.message (Go: parseRetryDelay). Returns undefined when none is found.
 */
export function parseRetryDelay(errorBody: string): number | undefined {
  const root = tryParse<unknown>(errorBody);
  const details = getAt(root, "error.details");
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (getAt(detail, "@type") !== "type.googleapis.com/google.rpc.RetryInfo") continue;
      const retryDelay = getAt(detail, "retryDelay");
      if (typeof retryDelay === "string" && retryDelay !== "") {
        // Upstream returns an error (no fallback) when the RetryInfo delay is malformed.
        return parseGoDuration(retryDelay);
      }
    }
    for (const detail of details) {
      if (getAt(detail, "@type") !== "type.googleapis.com/google.rpc.ErrorInfo") continue;
      const quotaResetDelay = getAt(detail, "metadata.quotaResetDelay");
      if (typeof quotaResetDelay === "string" && quotaResetDelay !== "") {
        const d = parseGoDuration(quotaResetDelay);
        if (d !== undefined) return d;
      }
    }
  }
  const message = getAt(root, "error.message");
  if (typeof message === "string" && message !== "") {
    const m = /after\s+(\d+)s\.?/.exec(message);
    if (m) {
      const seconds = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
    const human = /after\s+((?:\d+h)?(?:\d+m)?(?:\d+s)?)\.?/.exec(message.toLowerCase());
    if (human && human[1] !== "") {
      const d = parseGoDuration(human[1]!);
      if (d !== undefined && d > 0) return d;
    }
  }
  return undefined;
}

/**
 * Builds the StatusError for a non-2xx upstream response (Go: newGeminiStatusErr).
 * A 429 carries the parsed retry delay as retryAfterMs.
 */
export function newGeminiStatusErr(statusCode: number, body: string, headers?: Headers): StatusError {
  const message = body !== "" ? body : `status ${statusCode}`;
  let retryAfterMs: number | undefined;
  if (statusCode === 429) {
    const delay = parseRetryDelay(body);
    if (delay !== undefined) retryAfterMs = Math.ceil(delay);
  }
  return new StatusError(statusCode, message, { body, headers, retryAfterMs });
}

/** helps.JSONPayload: the JSON object of a stream line ("data: {...}" or bare), "" otherwise. */
export function jsonPayload(line: string): string {
  let trimmed = line.trim();
  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return "";
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice("data:".length).trim();
  if (trimmed === "" || trimmed[0] !== "{") return "";
  return trimmed;
}

/**
 * Detects a prompt rejected by Gemini safety filters: no candidates and a
 * promptFeedback.blockReason (bare or inside the Code Assist "response" envelope).
 * Returns the error message, or undefined when the payload is not a prompt block
 * (Go: geminiPromptBlockErrorMessage).
 */
export function geminiPromptBlockErrorMessage(payload: string): string | undefined {
  if (payload === "") return undefined;
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return undefined;
  for (const path of ["candidates", "response.candidates"]) {
    const candidates = getAt(root, path);
    if (Array.isArray(candidates) && candidates.length > 0) return undefined;
  }
  for (const prefix of ["promptFeedback", "response.promptFeedback"]) {
    const reasonValue = getAt(root, `${prefix}.blockReason`);
    const reason = typeof reasonValue === "string" ? reasonValue.trim() : reasonValue === undefined || reasonValue === null ? "" : String(reasonValue).trim();
    if (reason === "") continue;
    const detailValue = getAt(root, `${prefix}.blockReasonMessage`);
    const detail = typeof detailValue === "string" ? detailValue.trim() : "";
    if (detail !== "") return `upstream blocked the prompt: ${reason} - ${detail}`;
    return `upstream blocked the prompt: ${reason}`;
  }
  return undefined;
}

/**
 * The StatusError for a prompt block. Port deviation: upstream returns a plain
 * 502; this port returns 400 and marks it request-scoped, because the block is
 * a property of the prompt (another credential would be refused the same way
 * and the credential must not be cooled down).
 */
export function newGeminiPromptBlockErr(message: string): StatusError {
  return new StatusError(400, message, { requestScoped: true });
}

/**
 * Whether a stream payload carries a terminal signal: a non-empty
 * candidates[].finishReason or promptFeedback.blockReason, bare or wrapped in
 * "response" (Go: geminiStreamHasFinishSignal).
 */
export function geminiStreamHasFinishSignal(payload: string): boolean {
  if (payload === "") return false;
  const root = tryParse<unknown>(payload);
  if (!isObj(root)) return false;
  for (const prefix of ["", "response."]) {
    const candidates = getAt(root, `${prefix}candidates`);
    if (Array.isArray(candidates)) {
      for (const c of candidates) {
        const reason = getAt(c, "finishReason");
        if (reason !== undefined && reason !== null && String(reason).trim() !== "") return true;
      }
    }
    const block = getAt(root, `${prefix}promptFeedback.blockReason`);
    if (block !== undefined && block !== null && String(block).trim() !== "") return true;
  }
  return false;
}

/** A non-stream Claude translation that produced an error object (Go: TranslatedClaudeErrorPayload). */
export function translatedClaudeErrorPayload(responseFormat: Format, out: string): string | undefined {
  if (responseFormat !== FormatClaude || out === "") return undefined;
  const root = tryParse<unknown>(out);
  return getAt(root, "type") === "error" ? out : undefined;
}

/** The first Claude SSE error event payload in translated stream output (Go: TranslatedClaudeStreamErrorPayload). */
export function translatedClaudeStreamErrorPayload(responseFormat: Format, lines: string[]): string | undefined {
  if (responseFormat !== FormatClaude) return undefined;
  for (const chunk of lines) {
    for (const line of chunk.split("\n")) {
      const payload = jsonPayload(line);
      if (payload === "") continue;
      if (getAt(tryParse<unknown>(payload), "type") === "error") return payload;
    }
  }
  return undefined;
}

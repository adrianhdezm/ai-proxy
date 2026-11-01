// Gemini executors: "gemini-cli" (Gemini CLI OAuth -> Cloud Code Assist) and
// "aistudio" (AI Studio API key -> Generative Language API).
//
// Error classification (all thrown as StatusError unless noted):
//
// | situation                                              | status | flags / fields                          |
// |--------------------------------------------------------|--------|-----------------------------------------|
// | upstream non-2xx (both)                                | as-is  | body = upstream body                    |
// | upstream 429 with RetryInfo / quotaResetDelay / "after Ns" | 429 | retryAfterMs                            |
// | gemini-cli: no usable token and no refresh token        | 401    | -                                       |
// | translator / thinking refusal                           | 400    | RequestRejectedError (requestScoped)    |
// | aistudio: promptFeedback.blockReason, no candidates     | 400    | requestScoped (upstream: plain 502)     |
// | Claude response translated to an error object           | 502    | body = Claude error JSON                |
// |   (MALFORMED_FUNCTION_CALL); stream: frame sent first    |        |                                         |
// | aistudio stream ends without finishReason (Claude/OpenAI)| 502   | streamTruncated (also for an empty body)|
// | gemini-cli stream body produced no output at all         | 502    | none -> manager fails over              |
// | gemini-cli stream ends after output without finishReason| -      | "[DONE]" flushed, message_stop sent (v7)|
// | stream read error / transport error                     | -      | raw Error rethrown                      |
// | opts.alt === "responses/compact"                        | 501    | -                                       |
export * from "./aistudio.ts";
export * from "./content_turns.ts";
export * from "./errors.ts";
export * from "./gemini_cli.ts";
export * from "./request.ts";
export * from "./stream.ts";
export * from "./usage.ts";

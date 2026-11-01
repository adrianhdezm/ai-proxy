// HTTP layer: Bun server, Claude-compatible handlers, error mapping and SSE forwarding.
export { createServer, serverOptionsFromConfig, authenticate, applyCORS, corsAllowHeadersValue, readRequestBody, type ServerOptions, type ProxyServer } from "./server.ts";
export { ClaudeCodeAPIHandler, forwardClaudeStream, rewriteClaudeDDModelInBody, type ClaudeHandlerOptions, type ExecutionManager, type ForwardClaudeStreamOptions } from "./claude_handlers.ts";
export {
  StatusClientClosedRequest,
  claudeErrorBody,
  claudeErrorDetailFromText,
  claudeErrorMessage,
  claudeErrorResponse,
  claudeErrorText,
  claudeErrorTypeFromStatus,
  enrichAuthSelectionError,
  executionErrorMessage,
  httpStatusFromError,
  httpStatusFromErrorOr,
  httpStatusText,
  toClaudeError,
  type ClaudeErrorDetail,
  type ClaudeErrorResponse,
  type ErrorResponseOptions,
} from "./errors.ts";
export { filterUpstreamHeaders, forwardableInboundHeaders, isCPAReservedResponseHeader, isForwardableInboundHeader, writeUpstreamHeaders } from "./headers.ts";
export { buildClaudeModelsResponse, ensureClaudeModelIDPrefix, resolveClaudeModelIDPrefix } from "./models.ts";
export { ClaudeSSEStreamState, advanceClaudeSSENewlineCount } from "./sse_state.ts";

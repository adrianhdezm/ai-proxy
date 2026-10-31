// Executor wiring entry point. Port of the executor registration half of
// sdk/cliproxy/service_executors.go, reduced to the kept providers.
//
// `createExecutors` returns one ProviderExecutor per provider key the app
// registers with the AuthManager: "claude", "codex", "gemini-cli",
// "aistudio" and "openai". Importing the executor modules also registers the
// Claude-inbound translators they depend on.
import type { Config } from "../config/types.ts";
import type { ProviderExecutor } from "./types.ts";
import { createClaudeExecutor } from "./claude/index.ts";
import type { ClaudeWebSearchResultCacheConfig } from "./claude/web_search_results.ts";
import { setClientToolSearchEnabled } from "../translator/claude/openai/responses/index.ts";
import { createCodexAutoExecutor } from "./codex/index.ts";
import { createAIStudioExecutor, createGeminiCLIExecutor } from "./gemini/index.ts";
import { createOpenAIExecutor } from "./openai/index.ts";

export type { ExecOptions, ExecRequest, ExecResponse, ErrorMessage, ProviderExecutor, StreamResult } from "./types.ts";
export { StatusError, statusCodeOf, RequestedModelMetadataKey, RequestPathMetadataKey, ReasoningEffortMetadataKey, SelectedAuthMetadataKey, PinnedAuthMetadataKey, responseFormatOrSource } from "./types.ts";

/** Raw shape of client.codex.web-search-result-cache once the config carries it. */
interface WebSearchResultCacheSetting {
  enabled?: boolean;
  /** Sliding entry lifetime in ms (YAML ttl: "30m" or seconds). */
  ttlMs?: number;
  limit?: number;
}

/**
 * client.codex.web-search-result-cache (default disabled, as upstream). Read
 * structurally so the executor wiring does not depend on the config slice
 * that adds the field (Config.client.codex.webSearchResultCache).
 */
export function claudeWebSearchResultCacheConfigFrom(config: Config): ClaudeWebSearchResultCacheConfig | undefined {
  const setting: WebSearchResultCacheSetting | undefined = config.client?.codex?.webSearchResultCache;
  if (!setting?.enabled) return undefined;
  return { enabled: true, ttlMs: setting.ttlMs, limit: setting.limit };
}

/**
 * Applies upstream.claude.tool-search to the Responses -> Claude translator
 * (Go: responsesclaude.SetClientToolSearchEnabled at start-up).
 */
export function applyClaudeToolSearchSetting(config: Config): void {
  setClientToolSearchEnabled(config.upstream.claude.toolSearch === true);
}

/** Builds the executors for every kept upstream from the loaded config. */
export function createExecutors(config: Config): ProviderExecutor[] {
  const proxyUrl = config.requests.proxyUrl || undefined;
  applyClaudeToolSearchSetting(config);
  const webSearchResultCache = claudeWebSearchResultCacheConfigFrom(config);
  return [
    createClaudeExecutor({
      proxyUrl,
      ...(webSearchResultCache ? { webSearchResultCache } : {}),
      modelLevelCooling: config.upstream.claude.modelLevelCooling,
      sessionDatePinDays: config.upstream.claude.sessionDatePinDays,
      ...(config.upstream.claude.disableCloakMode ? { cloakMode: "never" as const } : {}),
    }),
    // Go: NewCodexAutoExecutor — HTTP/SSE, or the Responses websocket for downstream
    // websocket turns on credentials that enable websockets.
    createCodexAutoExecutor({
      modelLevelCooling: config.upstream.codex.modelLevelCooling,
      disableCloaking: config.upstream.codex.disableCloaking,
      streamBootstrapBuffering: config.upstream.codex.streamBootstrapBuffering,
      streamBootstrapTimeoutMs: config.upstream.codex.streamBootstrapTimeoutMs,
      disableImageGeneration: config.multimedia.disableImageGeneration,
    }),
    createGeminiCLIExecutor({ proxyUrl, switchPreviewModel: config.quotaExceeded.switchPreviewModel }),
    createAIStudioExecutor({ proxyUrl }),
    createOpenAIExecutor(config),
  ];
}

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
import { createCodexExecutor } from "./codex/index.ts";
import { createAIStudioExecutor, createGeminiCLIExecutor } from "./gemini/index.ts";
import { createOpenAIExecutor } from "./openai/index.ts";

export type { ExecOptions, ExecRequest, ExecResponse, ErrorMessage, ProviderExecutor, StreamResult } from "./types.ts";
export { StatusError, statusCodeOf, RequestedModelMetadataKey, RequestPathMetadataKey, ReasoningEffortMetadataKey, SelectedAuthMetadataKey, PinnedAuthMetadataKey, responseFormatOrSource } from "./types.ts";

/** Builds the executors for every kept upstream from the loaded config. */
export function createExecutors(config: Config): ProviderExecutor[] {
  const proxyUrl = config.requests.proxyUrl || undefined;
  return [
    createClaudeExecutor({
      proxyUrl,
      modelLevelCooling: config.upstream.claude.modelLevelCooling,
      sessionDatePinDays: config.upstream.claude.sessionDatePinDays,
      ...(config.upstream.claude.disableCloakMode ? { cloakMode: "never" as const } : {}),
    }),
    createCodexExecutor({
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

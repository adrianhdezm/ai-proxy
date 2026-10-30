// Executor wiring entry point. Port of the executor registration half of
// sdk/cliproxy/service_executors.go, reduced to the kept providers.
//
// `createExecutors` returns the ProviderExecutor instances the app registers
// with the AuthManager (one per provider key: "claude", "codex", "gemini-cli",
// "aistudio", "openai"). The per-provider executor modules
// (src/executor/claude.ts, codex.ts, gemini_cli.ts, aistudio.ts, openai.ts)
// are delivered by their own slices; the coordinator adds each one here as it
// lands, for example:
//
//   import { ClaudeExecutor } from "./claude.ts";
//   ...
//   return [new ClaudeExecutor(config), new CodexExecutor(config), ...];
//
// Until then the list is empty: the server starts, advertises the models of
// the loaded credentials, and every execution fails with the manager's
// "no auth available" (503) because no executor claims the provider.
import type { Config } from "../config/types.ts";
import type { ProviderExecutor } from "./types.ts";

export type { ExecOptions, ExecRequest, ExecResponse, ErrorMessage, ProviderExecutor, StreamResult } from "./types.ts";
export { StatusError, statusCodeOf, RequestedModelMetadataKey, RequestPathMetadataKey, ReasoningEffortMetadataKey, SelectedAuthMetadataKey, PinnedAuthMetadataKey, responseFormatOrSource } from "./types.ts";

/** Builds the executors for every kept upstream from the loaded config. */
export function createExecutors(_config: Config): ProviderExecutor[] {
  return [];
}

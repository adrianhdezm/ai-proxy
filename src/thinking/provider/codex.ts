// Port of internal/thinking/provider/codex/apply.go: OpenAI Responses API reasoning.effort.
import type { ModelInfo } from "../../registry/types.ts";
import { registerProvider } from "../appliers.ts";
import { isUserDefinedModel } from "../convert.ts";
import { Doc } from "../json.ts";
import { ModeLevel, ModeNone, type ProviderApplier, type ThinkingConfig } from "../types.ts";
import { resolveCompatibleEffort, resolveLevelEffort } from "./openai.ts";

function objectDoc(body: string): Doc {
  const doc = new Doc(body);
  return doc.valid ? doc : new Doc("{}");
}

/** Codex applier. Output: {"reasoning":{"effort":"high"}}. */
export class CodexApplier implements ProviderApplier {
  apply(body: string, config: ThinkingConfig, modelInfo: ModelInfo | undefined): string {
    if (isUserDefinedModel(modelInfo)) {
      const effort = resolveCompatibleEffort(config);
      if (effort === undefined) return body;
      const doc = objectDoc(body);
      doc.set("reasoning.effort", effort);
      return doc.toString();
    }
    if (!modelInfo?.thinking) return body;
    if (config.mode !== ModeLevel && config.mode !== ModeNone) return body;
    const effort = resolveLevelEffort(config, modelInfo);
    if (effort === undefined) return body;
    const doc = objectDoc(body);
    doc.set("reasoning.effort", effort);
    return doc.toString();
  }
}

registerProvider("codex", new CodexApplier());

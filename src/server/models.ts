// Anthropic model list response. Port of internal/client/claude/models/models.go.
import type { JSONObject } from "../util/json.ts";

const claudeDDModelPrefix = "claude-fable-5-dd-";

/**
 * Builds the Anthropic `/v1/models` response from the registry's available
 * model maps (handler type "claude"). Entries are sorted by display_name then
 * id; the input is neither mutated nor reordered (Go: BuildResponse).
 *
 * With cloaking enabled, non-Claude ids are rewritten to
 * `claude-fable-5-dd-<reversed id>` so Anthropic clients that only accept
 * `claude-*` ids can still select them; the handler decodes them on the way in.
 */
export function buildClaudeModelsResponse(availableModels: ReadonlyArray<JSONObject> | null | undefined, disableCloaking: boolean): JSONObject {
  const models: JSONObject[] = (availableModels ?? []).map((model) => {
    const cloned: JSONObject = { ...model };
    if (typeof cloned.id === "string" && !disableCloaking) cloned.id = ensureClaudeModelIDPrefix(cloned.id);
    return cloned;
  });

  // Stable sort by display_name, then id.
  models.sort((a, b) => {
    const displayA = typeof a.display_name === "string" ? a.display_name : "";
    const displayB = typeof b.display_name === "string" ? b.display_name : "";
    if (displayA !== displayB) return displayA < displayB ? -1 : 1;
    const idA = typeof a.id === "string" ? a.id : "";
    const idB = typeof b.id === "string" ? b.id : "";
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });

  let firstID = "";
  let lastID = "";
  if (models.length > 0) {
    const first = models[0]!.id;
    const last = models[models.length - 1]!.id;
    firstID = typeof first === "string" ? first : "";
    lastID = typeof last === "string" ? last : "";
  }
  return { data: models, has_more: false, first_id: firstID, last_id: lastID };
}

/**
 * Rewrites a model id for Anthropic listings: ids starting with "claude-" are
 * kept, everything else becomes "claude-fable-5-dd-" + reversed id (Go: EnsureClaudeModelIDPrefix).
 */
export function ensureClaudeModelIDPrefix(id: string): string {
  if (id === "" || id.startsWith("claude-")) return id;
  return claudeDDModelPrefix + reverseModelID(id);
}

/**
 * Reverses ensureClaudeModelIDPrefix for request routing, preserving a
 * `model(value)` thinking suffix (Go: ResolveClaudeModelIDPrefix).
 */
export function resolveClaudeModelIDPrefix(id: string): string {
  if (id === "") return id;
  const { base, suffix, hasSuffix } = splitModelThinkingSuffix(id);
  if (!base.startsWith(claudeDDModelPrefix)) return id;
  const encoded = base.slice(claudeDDModelPrefix.length);
  if (encoded === "") return id;
  const resolved = reverseModelID(encoded);
  return hasSuffix ? `${resolved}(${suffix})` : resolved;
}

function splitModelThinkingSuffix(model: string): { base: string; suffix: string; hasSuffix: boolean } {
  const lastOpen = model.lastIndexOf("(");
  if (lastOpen === -1 || !model.endsWith(")")) return { base: model, suffix: "", hasSuffix: false };
  return { base: model.slice(0, lastOpen), suffix: model.slice(lastOpen + 1, model.length - 1), hasSuffix: true };
}

function reverseModelID(id: string): string {
  return Array.from(id).reverse().join("");
}

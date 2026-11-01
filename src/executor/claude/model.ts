// Claude model family predicates used by the beta assembly and cloaking rules.
// Port of the model helpers in internal/runtime/executor/claude_executor_request.go
// and claude_executor_cloaking.go (isClaudeFable51Model, claudeUsesLegacySystemReminder).

/** Lower-cases and strips a vendor prefix ("anthropic/claude-x" -> "claude-x") (Go: claudeCanonicalModel). */
export function claudeCanonicalModel(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  return m;
}

export function isClaudeHaikuModel(model: string): boolean {
  return model.toLowerCase().includes("haiku");
}

export function isClaudeOpus55Model(model: string): boolean {
  const m = claudeCanonicalModel(model);
  return m === "claude-opus-5-5" || m.startsWith("claude-opus-5-5[");
}

export function isClaudeSonnet55Model(model: string): boolean {
  const m = claudeCanonicalModel(model);
  return m === "claude-sonnet-5-5" || m.startsWith("claude-sonnet-5-5-") || m.startsWith("claude-sonnet-5-5[");
}

export function isClaudeSonnet5Model(model: string): boolean {
  const m = claudeCanonicalModel(model);
  if (isClaudeSonnet55Model(m)) return false;
  return m === "claude-sonnet-5" || m.startsWith("claude-sonnet-5-") || m.startsWith("claude-sonnet-5[");
}

export function isClaudeHaiku55Model(model: string): boolean {
  const m = claudeCanonicalModel(model);
  return (
    m === "claude-haiku-5-5" ||
    m.startsWith("claude-haiku-5-5-") ||
    m.startsWith("claude-haiku-5-5[") ||
    m === "claude-haiku-5.5" ||
    m.startsWith("claude-haiku-5.5-") ||
    m.startsWith("claude-haiku-5.5[")
  );
}

function containsVersionToken(m: string, targets: string[]): boolean {
  for (const target of targets) {
    const idx = m.indexOf(target);
    if (idx === -1) continue;
    const next = idx + target.length;
    if (next >= m.length) return true;
    const c = m.charCodeAt(next);
    if (c < 48 || c > 57) return true;
  }
  return false;
}

/** Fable 5.1 specifically, excluding Mythos 5.1 (Go: isClaudeFable51OnlyModel). */
export function isClaudeFable51OnlyModel(model: string): boolean {
  return containsVersionToken(claudeCanonicalModel(model), ["fable-5-1", "fable-5.1"]);
}

/** Fable 5.1 / Mythos 5.1 with a digit boundary so 5-10 does not match (Go: isClaudeFable51Model). */
export function isClaudeFable51Model(model: string): boolean {
  return containsVersionToken(model.trim().toLowerCase(), ["fable-5-1", "fable-5.1", "mythos-5-1", "mythos-5.1"]);
}

/** Interactive CLI models that send thinking.display=updates by default (Go: claudeModelUsesProgressDisplay). */
export function claudeModelUsesProgressDisplay(model: string): boolean {
  return isClaudeOpus55Model(model) || isClaudeFable51Model(model) || isClaudeSonnet5Model(model) || isClaudeSonnet55Model(model);
}

/** Models whose catalog capability per_turn_effort emits per-turn-control on every request. */
export function claudeModelHasPerTurnEffort(model: string): boolean {
  return isClaudeOpus55Model(model) || claudeCanonicalModel(model).startsWith("claude-fable-5-1");
}

/** Models whose catalog lists per_turn_timing. */
export function claudeModelHasPerTurnTiming(model: string): boolean {
  const m = claudeCanonicalModel(model);
  return claudeModelHasPerTurnEffort(m) || m.startsWith("claude-mythos-5-1");
}

/** Forced tool use is downgraded to auto on these models (Go: helps.claude55Model). */
export const claude55ModelPattern = /^claude-(opus|sonnet)-5-5(?:-(high|reasoning))?(?:-[0-9]{8})?(?:\[[^\[\]]+\])?$/;

/**
 * Official Anthropic model IDs and aliases that reject a mid-conversation
 * role=system message (Go: claudeLegacySystemReminderModels).
 */
export const claudeLegacySystemReminderModels: ReadonlySet<string> = new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-5-haiku-latest",
  "claude-3-7-sonnet-20250219",
  "claude-3-7-sonnet-latest",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4",
  "claude-opus-4-20250514",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
]);

/** Whether the model keeps caller system prompts on the legacy system-reminder path (Go: claudeUsesLegacySystemReminder). */
export function claudeModelUsesLegacySystemReminder(model: string): boolean {
  return claudeLegacySystemReminderModels.has(claudeCanonicalModel(model));
}

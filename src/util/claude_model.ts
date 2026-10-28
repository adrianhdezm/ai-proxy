// Port of internal/util/claude_model.go.

/** Reports whether the model name identifies a Claude model. */
export function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

/** Reports whether the model is a Claude thinking model that requires the interleaved-thinking beta header. */
export function isClaudeThinkingModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("claude") && lower.includes("thinking");
}

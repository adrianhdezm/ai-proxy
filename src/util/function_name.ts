// Port of SanitizeFunctionName from internal/util/util.go (the only part of util.go a kept path needs).

/**
 * Ensures a function name matches the requirements for Gemini/Vertex AI: invalid
 * characters ([^a-zA-Z0-9_.:-]) become '_', the name must start with a letter or
 * underscore, and it is truncated to 64 characters.
 */
export function sanitizeFunctionName(name: string): string {
  if (name === "") return "";
  let sanitized = name.replace(/[^a-zA-Z0-9_.:-]/gu, "_");
  if (sanitized.length > 0) {
    const first = sanitized[0]!;
    if (!/[a-zA-Z_]/.test(first)) {
      if (sanitized.length >= 64) sanitized = sanitized.slice(0, 63);
      sanitized = "_" + sanitized;
    }
  } else {
    sanitized = "_";
  }
  if (sanitized.length > 64) sanitized = sanitized.slice(0, 64);
  return sanitized;
}

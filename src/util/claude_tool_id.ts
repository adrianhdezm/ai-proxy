// Port of internal/util/claude_tool_id.go.
import { sha256Hex } from "./hash.ts";
import { hexToBytes } from "./base64.ts";

const geminiClaudeToolUseIDPrefix = "cpa_gemini_";
let claudeToolUseIDCounter = 0;

/**
 * Ensures the given id conforms to Claude's tool_use.id regex ^[a-zA-Z0-9_-]+$.
 * Non-conforming characters are replaced with '_'; an empty result gets a generated fallback.
 */
export function sanitizeClaudeToolID(id: string): string {
  let s = id.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (s === "") {
    claudeToolUseIDCounter++;
    s = `toolu_${Date.now() * 1_000_000}_${claudeToolUseIDCounter}`;
  }
  return s;
}

/**
 * Ensures a function or tool name conforms to Claude's requirements:
 * ^[a-zA-Z0-9_-]{1,64}$. Non-conforming characters (including dots and colons
 * commonly emitted by MCP tools) are replaced with '_'.
 */
export function sanitizeClaudeFunctionName(name: string): string {
  if (name === "") return "";
  let s = name.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (s.length > 64) s = s.slice(0, 64);
  if (s === "") s = "_";
  return s;
}

/**
 * Returns a stable Claude-facing ID for a provider-native Gemini function call.
 * The opaque ID lets the executor recover the exact provider call from its replay
 * ledger instead of trusting client-mutated args.
 */
export function geminiClaudeToolUseID(callID: string, name: string, argsRaw: string): string {
  callID = callID.trim();
  name = name.trim();
  if (callID === "" || name === "") return "";
  if (argsRaw.trim() !== "") {
    try {
      argsRaw = canonicalJSON(JSON.parse(argsRaw));
    } catch {
      argsRaw = argsRaw.trim();
    }
  }
  const digest = sha256Hex([callID, name, argsRaw].join("\x00"));
  return geminiClaudeToolUseIDPrefix + digest.slice(0, 32);
}

/** Reports whether id belongs to the reserved Claude-facing Gemini provenance namespace. */
export function isGeminiClaudeToolUseID(id: string): boolean {
  id = id.trim();
  if (!id.startsWith(geminiClaudeToolUseIDPrefix)) return false;
  const digest = id.slice(geminiClaudeToolUseIDPrefix.length);
  if (digest.length !== 32) return false;
  return hexToBytes(digest) !== null;
}

/** Go json.Marshal canonical form: object keys sorted, compact separators. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

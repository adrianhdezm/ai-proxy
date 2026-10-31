// Claude Code MCP tool aliases for cloaked OAuth requests. Port of
// internal/runtime/executor/helps/claude_mcp_alias.go and
// helps/claude_builtin_tools.go.
//
// Every third-party client tool is presented upstream as a Claude Code MCP
// extension (mcp__<server>__<toolID>_<semantic>): the two-word virtual server is
// stable per caller, the one-word tool ID is keyed on the original name, and the
// semantic suffix keeps the name readable for the model. Words come from the
// BIP-39 English dictionary.
import { createHmac } from "node:crypto";
import { log } from "../../log.ts";
import { tryParse } from "../../util/json.ts";
import { claudeBIP39EnglishWords } from "./bip39_words.ts";

const maxClaudeToolNameLength = 64;

function isClaudeToolNameChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x2d;
}

/**
 * Whether name follows Claude Code's MCP tool convention (mcp__<server>__<tool>)
 * and contains only characters Anthropic accepts in tool names (Go: IsClaudeMCPToolName).
 */
export function isClaudeMCPToolName(name: string): boolean {
  if (name.length === 0 || name.length > maxClaudeToolNameLength || !name.startsWith("mcp__")) return false;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) return false;
  for (let i = 0; i < name.length; i++) {
    if (!isClaudeToolNameChar(name.charCodeAt(i))) return false;
  }
  return true;
}

/** The dictionary size used for the virtual server pair and the tool ID (Go: ClaudeMCPAliasWordCount). */
export function claudeMCPAliasWordCount(): number {
  return claudeBIP39EnglishWords.length;
}

function claudeMCPAliasDigest(secret: string, purpose: string, original: string): Uint8Array {
  const mac = createHmac("sha256", secret);
  mac.update("cpa-claude-mcp-alias-v2\x00");
  mac.update(purpose);
  mac.update("\x00");
  mac.update(original);
  return new Uint8Array(mac.digest());
}

function claudeMCPAliasWord(digest: Uint8Array, offset: number, attempt: number): string {
  const words = claudeBIP39EnglishWords;
  if (words.length === 0 || offset < 0 || offset + 2 > digest.length) return "tool";
  const base = (digest[offset]! << 8) | digest[offset + 1]!;
  return words[(base + attempt) % words.length]!;
}

/** The caller-stable two-word virtual server shared by every alias of one secret. */
function claudeMCPAliasServerComponent(secret: string): string {
  const digest = claudeMCPAliasDigest(secret, "server", "");
  return claudeMCPAliasWord(digest, 0, 0) + "_" + claudeMCPAliasWord(digest, 2, 0);
}

/** A readable [A-Za-z0-9_-] suffix of at most maxLength bytes; "tool" when nothing survives. */
function claudeMCPToolSemanticSuffix(original: string, maxLength: number): string {
  let semantic = "";
  let pendingSeparator = false;
  for (const char of original) {
    const code = char.codePointAt(0)!;
    if (!isClaudeToolNameChar(code)) {
      pendingSeparator = semantic.length > 0;
      continue;
    }
    if (pendingSeparator && semantic.length + 1 < maxLength) semantic += "_";
    pendingSeparator = false;
    if (semantic.length >= maxLength) break;
    semantic += char;
  }
  const result = semantic.replace(/^[_-]+|[_-]+$/g, "");
  return result === "" ? "tool" : result;
}

/** Assembles one alias; both entry points build names here so they cannot drift (Go: claudeMCPAliasFor). */
function claudeMCPAliasFor(server: string, toolID: string, original: string): string {
  const prefix = "mcp__" + server + "__" + toolID + "_";
  const maxSemanticLen = Math.max(1, maxClaudeToolNameLength - prefix.length);
  return prefix + claudeMCPToolSemanticSuffix(original, maxSemanticLen);
}

/** Derives the alias for one attempt; a higher attempt probes the next word (Go: ClaudeMCPToolAlias). */
export function claudeMCPToolAlias(secret: string, original: string, attempt: number): string {
  const toolDigest = claudeMCPAliasDigest(secret, "tool", original);
  return claudeMCPAliasFor(claudeMCPAliasServerComponent(secret), claudeMCPAliasWord(toolDigest, 0, attempt), original);
}

/**
 * Picks an alias that is not reserved yet; undefined only when every one-word
 * tool ID for this semantic is taken (Go: AllocateClaudeMCPToolAlias).
 */
export function allocateClaudeMCPToolAlias(secret: string, original: string, reserved?: ReadonlySet<string>): string | undefined {
  const words = claudeBIP39EnglishWords;
  if (words.length === 0) {
    log.error("claude oauth mcp alias: BIP-39 wordlist is empty, tool aliasing is disabled");
    return undefined;
  }
  const server = claudeMCPAliasServerComponent(secret);
  const toolDigest = claudeMCPAliasDigest(secret, "tool", original);
  const baseIndex = ((toolDigest[0]! << 8) | toolDigest[1]!) % words.length;
  for (let attempt = 0; attempt < words.length; attempt++) {
    const alias = claudeMCPAliasFor(server, words[(baseIndex + attempt) % words.length]!, original);
    if (reserved?.has(alias)) continue;
    return alias;
  }
  return undefined;
}

/** Built-in tool names reserved even when the request declares none (Go: defaultClaudeBuiltinToolNames). */
export const defaultClaudeBuiltinToolNames: readonly string[] = ["web_search", "code_execution", "text_editor", "computer"];

const claudeServerToolTypePrefixes = ["advisor_", "agent_toolset_", "bash_", "code_execution_", "computer_", "memory_", "text_editor_", "tool_search_tool_", "web_fetch_", "web_search_"];

/**
 * Whether a typed tool declaration is an Anthropic-operated tool. Client-defined
 * type:"custom" declarations are not and stay eligible for aliasing (Go: IsClaudeServerToolType).
 */
export function isClaudeServerToolType(toolType: string): boolean {
  const t = toolType.trim().toLowerCase();
  return claudeServerToolTypePrefixes.some((prefix) => t.startsWith(prefix));
}

/** The default built-in names plus every server tool the body declares (Go: AugmentClaudeBuiltinToolRegistry). */
export function augmentClaudeBuiltinToolRegistry(body: string | unknown, registry?: Set<string>): Set<string> {
  const out = registry ?? new Set(defaultClaudeBuiltinToolNames);
  const root = typeof body === "string" ? tryParse<Record<string, unknown>>(body) : body;
  const tools = root && typeof root === "object" ? (root as Record<string, unknown>).tools : undefined;
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    if (!isClaudeServerToolType(typeof t.type === "string" ? t.type : "")) continue;
    if (typeof t.name === "string" && t.name !== "") out.add(t.name);
  }
  return out;
}

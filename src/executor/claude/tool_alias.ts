// Claude OAuth MCP tool-name aliasing: part of the Claude Code disguise for
// cloaked OAuth / claude-code-cli requests. Port of remapOAuthToolNames*,
// the claudeMCPAliasResolver, reverseRemapOAuthToolNames* and
// resolveClaudeMCPAliasOptions from internal/runtime/executor/claude_executor_request.go
// and the thread-continuation alias store from claude_executor_tool_state.go.
//
// Request side: every declared third-party client tool (tools[], tool_choice,
// tool_use / tool_reference history, nested tool_search results and
// mid-conversation tool_addition / tool_removal blocks) is renamed to a
// Claude Code MCP alias; server tools and caller-owned MCP names stay as they
// are. Response side: the request-local reverse map restores the original
// names, recovering the common ways a model drifts an alias and failing open
// for names it cannot attribute.
//
// Deviation: Go edits the raw bytes (a batched path plus a legacy sjson path);
// this port rewrites the parsed object and re-serializes it, returning the
// original string untouched when nothing was renamed.
import { log } from "../../log.ts";
import { gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";
import { sha256Hex } from "../../util/hash.ts";
import { StatusError } from "../types.ts";
import { ClaudeCallerAPIKeyMetadataKey } from "./thinking_replay.ts";
import { allocateClaudeMCPToolAlias, augmentClaudeBuiltinToolRegistry, isClaudeMCPToolName, isClaudeServerToolType } from "./mcp_alias.ts";

/** Upstream alias -> client original. A caller-owned MCP tool maps to itself. */
export type ClaudeToolAliasMap = Map<string, string>;

/** Metadata key carrying the caller scope (Go: cliproxyexecutor.CallerScopeMetadataKey). */
export const CallerScopeMetadataKey = "caller_scope";

export const defaultClaudeMCPAliasSecret = "cpa-claude-mcp-default-caller";

/** Hashed caller identity (Go: session.CallerScope). */
export function callerScope(value: string): string {
  const v = value.trim();
  return v === "" ? "" : sha256Hex("cli-proxy-api:caller-scope:v1\x00" + v);
}

/**
 * The alias secret belongs to the downstream caller, not to the credential, so
 * names stay stable across refresh and failover (Go: resolveClaudeMCPAliasOptions).
 */
export function resolveClaudeMCPAliasSecret(...metadataSets: Array<Record<string, unknown> | undefined>): string {
  for (const metadata of metadataSets) {
    const scope = metadata?.[CallerScopeMetadataKey];
    if (typeof scope === "string" && scope.trim() !== "") return scope.trim();
  }
  for (const metadata of metadataSets) {
    const key = metadata?.[ClaudeCallerAPIKeyMetadataKey];
    if (typeof key === "string" && key.trim() !== "") return callerScope(key);
  }
  return defaultClaudeMCPAliasSecret;
}

/**
 * The path, relative to a tool_addition / tool_removal block, of the tool name
 * that must carry the same alias as tools[] (Go: claudeToolChangeNamePath).
 */
export function claudeToolChangeNamePath(part: unknown): string[] | undefined {
  if (!isObj(part) || !isObj(part.tool)) return undefined;
  switch (gstr(part.tool.type)) {
    case "tool_reference":
      return ["tool", "name"];
    case "tool_definition": {
      const definition = part.tool.definition;
      if (gstr(part.type) !== "tool_addition" || isClaudeServerToolType(gstr(isObj(definition) ? definition.type : undefined))) return undefined;
      return ["tool", "definition", "name"];
    }
  }
  return undefined;
}

function getIn(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setIn(root: unknown, path: string[], value: string): void {
  let cur = root;
  for (const key of path.slice(0, -1)) {
    if (!isObj(cur)) return;
    cur = cur[key];
  }
  if (isObj(cur)) cur[path[path.length - 1]!] = value;
}

/**
 * Represents every declared third-party client tool as a Claude Code MCP
 * extension. Returns the upstream body and the request-local reverse map
 * (Go: remapOAuthToolNamesWithOptions).
 */
export function remapOAuthToolNames(body: string, secret = defaultClaudeMCPAliasSecret): { body: string; reverseMap: ClaudeToolAliasMap } {
  const reverseMap: ClaudeToolAliasMap = new Map();
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root)) return { body, reverseMap };
  const recordRename = (original: string, renamed: string): void => {
    if (!reverseMap.has(renamed)) reverseMap.set(renamed, original);
  };

  const tools = root.tools;
  const forwardMap = new Map<string, string>();
  const protectedNames = new Set<string>();
  const reservedNames = augmentClaudeBuiltinToolRegistry(root);
  const toolType = (tool: unknown): string => gstr(isObj(tool) ? tool.type : undefined);
  const toolName = (tool: unknown): string => gstr(isObj(tool) ? tool.name : undefined);
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const name = toolName(tool);
      if (name !== "") reservedNames.add(name);
      if (isClaudeServerToolType(toolType(tool))) protectedNames.add(name);
    }
    const passthroughMCPTools: string[] = [];
    for (const tool of tools) {
      if (isClaudeServerToolType(toolType(tool))) continue;
      const name = toolName(tool);
      if (name === "") continue;
      if (isClaudeMCPToolName(name)) {
        passthroughMCPTools.push(name);
        continue;
      }
      if (forwardMap.has(name)) continue;
      const alias = allocateClaudeMCPToolAlias(secret, name, reservedNames);
      if (alias === undefined) {
        log.warn(`claude oauth mcp alias: no free alias left for tool ${JSON.stringify(name)}, forwarding the original name`);
        continue;
      }
      forwardMap.set(name, alias);
      reservedNames.add(alias);
    }
    // Caller-owned MCP names are recorded only when something was aliased, so an
    // untouched request keeps an empty map (Go: recordPassthroughMCPTools).
    if (forwardMap.size > 0) for (const name of passthroughMCPTools) recordRename(name, name);
  }

  const rewriteName = (name: string): string | undefined => {
    if (name === "" || protectedNames.has(name) || isClaudeMCPToolName(name)) return undefined;
    const renamed = forwardMap.get(name);
    return renamed !== undefined && renamed !== name ? renamed : undefined;
  };
  let changed = false;
  const rename = (holder: unknown, path: string[]): void => {
    const name = gstr(getIn(holder, path));
    const renamed = rewriteName(name);
    if (renamed === undefined) return;
    setIn(holder, path, renamed);
    recordRename(name, renamed);
    changed = true;
  };

  // 1. tools[]: a typed client tool loses its type; declared names are aliased.
  if (Array.isArray(tools)) {
    let needRewrite = false;
    for (const tool of tools) {
      const type = toolType(tool);
      if (isClaudeServerToolType(type)) continue;
      if (type.trim() !== "" || rewriteName(toolName(tool)) !== undefined) {
        needRewrite = true;
        break;
      }
    }
    if (needRewrite) {
      root.tools = tools.map((tool) => {
        if (isClaudeServerToolType(toolType(tool)) || !isObj(tool)) return tool;
        const copy: Record<string, unknown> = { ...tool };
        if (toolType(copy).trim() !== "") delete copy.type;
        rename(copy, ["name"]);
        return copy;
      });
      changed = true;
    }
  }

  // 2. tool_choice naming a declared client tool.
  if (isObj(root.tool_choice) && gstr(root.tool_choice.type) === "tool") rename(root.tool_choice, ["name"]);

  // 3. History references.
  if (Array.isArray(root.messages)) {
    for (const message of root.messages) {
      const content = isObj(message) ? message.content : undefined;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isObj(part)) continue;
        switch (gstr(part.type)) {
          case "tool_use":
            rename(part, ["name"]);
            break;
          case "tool_reference":
            rename(part, ["tool_name"]);
            break;
          case "tool_result":
            if (Array.isArray(part.content)) {
              for (const nested of part.content) if (isObj(nested) && gstr(nested.type) === "tool_reference") rename(nested, ["tool_name"]);
            }
            break;
          case "tool_search_tool_result": {
            const refs = getIn(part, ["content", "tool_references"]);
            if (Array.isArray(refs)) for (const ref of refs) if (isObj(ref) && gstr(ref.type) === "tool_reference") rename(ref, ["tool_name"]);
            break;
          }
          case "tool_addition":
          case "tool_removal": {
            const path = claudeToolChangeNamePath(part);
            if (path) rename(part, path);
            break;
          }
        }
      }
    }
  }
  return { body: changed ? JSON.stringify(root) : body, reverseMap };
}

/** A restore failure that must not fail over to another credential (Go: claudeMCPAliasRestoreError). */
export class ClaudeMCPAliasRestoreError extends StatusError {
  constructor(message: string) {
    super(500, message, { requestScoped: true });
    this.name = "ClaudeMCPAliasRestoreError";
  }
}

export interface ClaudeMCPAliasParts {
  server: string;
  toolID: string;
  semantic: string;
}

/** Splits mcp__<server>__<toolID>_<semantic> (Go: parseClaudeMCPAlias). */
export function parseClaudeMCPAlias(name: string): ClaudeMCPAliasParts | undefined {
  if (!isClaudeMCPToolName(name)) return undefined;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return undefined;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  const underscore = tool.indexOf("_");
  if (underscore <= 0 || underscore === tool.length - 1) return undefined;
  return { server, toolID: tool.slice(0, underscore), semantic: tool.slice(underscore + 1) };
}

/** The server component of an mcp__ name (Go: claudeMCPAliasServer). */
export function claudeMCPAliasServer(name: string): string {
  if (!name.startsWith("mcp__")) return "";
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep < 0 ? "" : rest.slice(0, sep);
}

interface AliasEntry {
  alias: string;
  original: string;
  parts: ClaudeMCPAliasParts;
}

/** Resolves upstream tool names against one request's reverse map (Go: claudeMCPAliasResolver). */
export class ClaudeMCPAliasResolver {
  private readonly exact: ClaudeToolAliasMap;
  private readonly aliases: AliasEntry[] = [];
  private readonly servers = new Set<string>();
  private readonly passthroughs: string[] = [];

  constructor(reverseMap: ClaudeToolAliasMap) {
    this.exact = reverseMap;
    for (const [alias, original] of reverseMap) {
      if (alias === original) {
        // Caller-owned MCP tool: exact passthrough and hybrid recovery only.
        this.passthroughs.push(original);
        continue;
      }
      const parts = parseClaudeMCPAlias(alias);
      if (!parts) continue;
      this.aliases.push({ alias, original, parts });
      this.servers.add(parts.server);
    }
  }

  /** The original name for `name`, undefined to forward it unchanged; throws when it is ambiguous. */
  resolve(name: string): string | undefined {
    const exact = this.exact.get(name);
    if (exact !== undefined) return exact === name ? undefined : exact;

    const server = claudeMCPAliasServer(name);
    if (!this.servers.has(server)) return undefined;

    const canonicalServerPrefix = "mcp__" + server + "__";
    let normalizedName = name;
    let suffix = name.startsWith(canonicalServerPrefix) ? name.slice(canonicalServerPrefix.length) : name;
    // The model repeated the virtual server: mcp__<s>__<s>__<tool>.
    while (suffix.startsWith(server + "__")) {
      suffix = suffix.slice(server.length + 2);
      normalizedName = canonicalServerPrefix + suffix;
      const original = this.exact.get(normalizedName);
      if (original !== undefined) return original;
    }

    let matchedOriginal = "";
    let matchCount = 0;
    for (const entry of this.aliases) {
      if (entry.parts.server === server && name.endsWith(entry.alias)) {
        matchedOriginal = entry.original;
        matchCount++;
      }
    }
    if (matchCount === 1) return matchedOriginal;
    if (matchCount > 1) throw new ClaudeMCPAliasRestoreError(`cannot restore Claude OAuth MCP tool alias ${JSON.stringify(name)}: matched multiple declared aliases`);

    const parts = parseClaudeMCPAlias(normalizedName);
    if (parts) {
      for (const entry of this.aliases) {
        if (entry.parts.server === parts.server && entry.parts.semantic === parts.semantic) {
          matchedOriginal = entry.original;
          matchCount++;
        }
      }
    }
    // Extra words in the tool component still parse with a wrong semantic field;
    // fall back to the unambiguous (or strictly longest) semantic suffix match.
    if (matchCount === 0) {
      const suffixMatches = this.aliases.filter((entry) => entry.parts.server === server && normalizedName.endsWith("_" + entry.parts.semantic));
      if (suffixMatches.length === 1) {
        matchedOriginal = suffixMatches[0]!.original;
        matchCount = 1;
      } else if (suffixMatches.length > 1) {
        let longest = suffixMatches[0]!;
        let tie = false;
        for (const candidate of suffixMatches.slice(1)) {
          if (candidate.parts.semantic.length > longest.parts.semantic.length) {
            longest = candidate;
            tie = false;
          } else if (candidate.parts.semantic.length === longest.parts.semantic.length) {
            tie = true;
          }
        }
        if (!tie) {
          matchedOriginal = longest.original;
          matchCount = 1;
        } else {
          matchCount = suffixMatches.length;
        }
      }
      if (matchCount === 1) log.debug(`claude oauth mcp alias: recovered drifted tool name ${JSON.stringify(name)} as ${JSON.stringify(matchedOriginal)} via semantic suffix`);
    }
    if (matchCount === 1) return matchedOriginal;
    if (matchCount > 1) throw new ClaudeMCPAliasRestoreError(`cannot restore Claude OAuth MCP tool alias ${JSON.stringify(name)}: semantic suffix matches multiple declared tools`);

    if (this.passthroughs.length > 0) {
      // 0: the caller's full mcp__ name wrapped in the virtual server.
      if (this.passthroughs.includes(suffix)) return suffix;
      // 1: the virtual server prepended to <real_server>__<tool>.
      const reprefixed = "mcp__" + suffix;
      if (this.exact.get(reprefixed) === reprefixed) return reprefixed;
      // 2: the virtual server replaced the caller's server; match the tool part.
      const matches = this.passthroughs.filter((pt) => {
        let toolPart = pt;
        if (pt.startsWith("mcp__")) {
          const rest = pt.slice("mcp__".length);
          const sep = rest.indexOf("__");
          if (sep >= 0) toolPart = rest.slice(sep + 2);
        }
        return toolPart === suffix;
      });
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new ClaudeMCPAliasRestoreError(`cannot restore Claude OAuth MCP tool alias ${JSON.stringify(name)}: passthrough tool suffix matches multiple declared tools`);
    }
    log.warn(`claude oauth mcp alias: cannot restore tool name ${JSON.stringify(name)}: no unique request-local match; forwarding it unchanged`);
    return undefined;
  }
}

/** Restores one name field on `holder`; true when it changed. */
function restoreField(resolver: ClaudeMCPAliasResolver, holder: unknown, key: string): boolean {
  if (!isObj(holder)) return false;
  const original = resolver.resolve(gstr(holder[key]));
  if (original === undefined) return false;
  holder[key] = original;
  return true;
}

function restoreToolReferences(resolver: ClaudeMCPAliasResolver, refs: unknown): boolean {
  if (!Array.isArray(refs)) return false;
  let changed = false;
  for (const ref of refs) if (isObj(ref) && gstr(ref.type) === "tool_reference" && restoreField(resolver, ref, "tool_name")) changed = true;
  return changed;
}

/** Restores tool names in a non-stream Messages response (Go: reverseRemapOAuthToolNames). */
export function reverseRemapOAuthToolNames(body: string, reverseMap: ClaudeToolAliasMap | undefined): string {
  if (!reverseMap || reverseMap.size === 0) return body;
  const root = tryParse<Record<string, unknown>>(body);
  if (!isObj(root) || !Array.isArray(root.content)) return body;
  const resolver = new ClaudeMCPAliasResolver(reverseMap);
  let changed = false;
  for (const part of root.content) {
    if (!isObj(part)) continue;
    switch (gstr(part.type)) {
      case "tool_use":
        if (restoreField(resolver, part, "name")) changed = true;
        break;
      case "tool_reference":
        if (restoreField(resolver, part, "tool_name")) changed = true;
        break;
      case "tool_result":
        if (restoreToolReferences(resolver, part.content)) changed = true;
        break;
      case "tool_search_tool_result":
        if (restoreToolReferences(resolver, getIn(part, ["content", "tool_references"]))) changed = true;
        break;
    }
  }
  return changed ? JSON.stringify(root) : body;
}

/** The JSON payload of an SSE line: "data:" stripped, event lines and [DONE] skipped (Go: helps.JSONPayload). */
export function sseJSONPayload(line: string): string {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return "";
  if (trimmed.startsWith("data:")) {
    const data = trimmed.slice("data:".length).trim();
    return data === "[DONE]" ? "" : data;
  }
  return trimmed;
}

/** Restores tool names in one SSE line (Go: reverseRemapOAuthToolNamesFromStreamLine). */
export function reverseRemapOAuthToolNamesFromStreamLine(line: string, reverseMap: ClaudeToolAliasMap | undefined): string {
  if (!reverseMap || reverseMap.size === 0) return line;
  const payload = sseJSONPayload(line);
  if (payload === "") return line;
  const root = tryParse<Record<string, unknown>>(payload);
  if (!isObj(root) || !isObj(root.content_block)) return line;
  const block = root.content_block;
  const resolver = new ClaudeMCPAliasResolver(reverseMap);
  let changed = false;
  switch (gstr(block.type)) {
    case "tool_use":
      changed = restoreField(resolver, block, "name");
      break;
    case "tool_reference":
      changed = restoreField(resolver, block, "tool_name");
      break;
    case "tool_search_tool_result":
      changed = restoreToolReferences(resolver, getIn(block, ["content", "tool_references"]));
      break;
  }
  if (!changed) return line;
  const updated = JSON.stringify(root);
  return line.trim().startsWith("data:") ? "data: " + updated : updated;
}

/** Restores every line of an SSE frame or body. */
export function reverseRemapOAuthToolNamesInSSE(text: string, reverseMap: ClaudeToolAliasMap | undefined): string {
  if (!reverseMap || reverseMap.size === 0) return text;
  return text
    .split("\n")
    .map((line) => reverseRemapOAuthToolNamesFromStreamLine(line, reverseMap))
    .join("\n");
}

export const claudeOAuthToolAliasStateLimit = 1024;

/**
 * Thread-continuation alias maps keyed by message id: a "continue" request may
 * omit tools[], so it reuses the aliases of the message it continues
 * (Go: claudeOAuthToolAliasStore). Oldest entries are evicted first.
 */
export class ClaudeOAuthToolAliasStore {
  private readonly entries = new Map<string, ClaudeToolAliasMap>();

  load(keys: string[]): ClaudeToolAliasMap | undefined {
    for (const key of keys) {
      const aliases = this.entries.get(key);
      if (aliases) return new Map(aliases);
    }
    return undefined;
  }

  save(keys: string[], aliases: ClaudeToolAliasMap | undefined): void {
    for (const key of keys) {
      if (key === "") continue;
      // Re-saving keeps the original insertion position, as Go's order slice does.
      this.entries.set(key, new Map(aliases ?? []));
    }
    while (this.entries.size > claudeOAuthToolAliasStateLimit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

function threadField(payload: unknown, key: string): unknown {
  return isObj(payload) && isObj(payload.thread) ? payload.thread[key] : undefined;
}

/** Store keys for a request: its previous_message_id and the new message id (Go: claudeOAuthToolAliasKeys). */
export function claudeOAuthToolAliasKeys(payload: unknown, messageID: string): string[] {
  const keys: string[] = [];
  const previous = gstr(threadField(payload, "previous_message_id"));
  if (previous !== "") keys.push("message:" + previous);
  if (messageID !== "") keys.push("message:" + messageID);
  return keys;
}

/** A thread continuation without its own tool declarations (Go: claudeThreadContinuationNeedsAliasState). */
export function claudeThreadContinuationNeedsAliasState(payload: unknown): boolean {
  if (gstr(threadField(payload, "type")) !== "continue") return false;
  if (gstr(threadField(payload, "previous_message_id")) === "") return false;
  const tools = isObj(payload) ? payload.tools : undefined;
  return !Array.isArray(tools) || tools.length === 0;
}

export const claudeThreadNotFoundErrorMessage = "No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread.";

/** The request-scoped 404 for a continuation whose alias state is gone (Go: newClaudeThreadNotFoundError). */
export function newClaudeThreadNotFoundError(): StatusError {
  return new StatusError(404, claudeThreadNotFoundErrorMessage, {
    requestScoped: true,
    body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: claudeThreadNotFoundErrorMessage } }),
  });
}

/**
 * Aliases a request's tool names, or reuses the stored aliases of the message a
 * thread continuation resumes (Go: prepareClaudeOAuthToolNamesForRequest).
 */
export function prepareClaudeOAuthToolNamesForRequest(store: ClaudeOAuthToolAliasStore, payload: string, secret: string): { body: string; reverseMap: ClaudeToolAliasMap } {
  const root = tryParse(payload);
  if (claudeThreadContinuationNeedsAliasState(root)) {
    const aliases = store.load(claudeOAuthToolAliasKeys(root, ""));
    if (!aliases) throw newClaudeThreadNotFoundError();
    return { body: payload, reverseMap: aliases };
  }
  return remapOAuthToolNames(payload, secret);
}

/** Saves a thread request's aliases under its message ids (Go: rememberClaudeOAuthToolAliases). */
export function rememberClaudeOAuthToolAliases(store: ClaudeOAuthToolAliasStore, payload: string, aliases: ClaudeToolAliasMap | undefined, messageID: string): void {
  const root = tryParse(payload);
  if (gstr(threadField(root, "type")) === "") return;
  const keys = claudeOAuthToolAliasKeys(root, messageID);
  if (keys.length === 0) return;
  store.save(keys, aliases);
}

// cache_control defaulting, breakpoint limit and TTL rules for the Claude
// upstream. Port of ensureCacheControl / inject*CacheControl / countCacheControls /
// enforceCacheControlLimit / normalizeCacheControlTTL / upgradeClaudeCacheControlTTL /
// stripClaudeCacheControlTTL / isExplicitPromptCacheMode / stripPromptCacheOptions /
// shouldEnsureCacheControl from internal/runtime/executor/claude_executor_cloaking.go.
//
// Every function takes and returns a JSON string and hands back the input string
// unchanged (byte-identical) when nothing needed to change.
import { getAt, gstr, isObj } from "../../util/gpath.ts";
import { tryParse } from "../../util/json.ts";

/** The default Claude Code breakpoint shape (Go: claudeCodeCacheControl). */
export function claudeCodeCacheControl(): Record<string, unknown> {
  return { type: "ephemeral" };
}

/** The only non-default ttl native ever selects. */
export const claudeCacheControlTTL1h = "1h";

/** Whether cache_control is a non-null object with type "ephemeral" (Go: isValidClaudeCacheControl). */
export function isValidClaudeCacheControl(cc: unknown): boolean {
  return isObj(cc) && cc.type === "ephemeral";
}

type Block = Record<string, unknown>;

function blocksOf(root: unknown, key: string): Block[] | undefined {
  const arr = getAt(root, key);
  if (!Array.isArray(arr)) return undefined;
  return arr as Block[];
}

/** Walks every block that can carry cache_control in Anthropic's evaluation order: tools, system, messages. */
function forEachCacheControlBlock(root: unknown, visit: (block: unknown, section: "tools" | "system" | "messages") => boolean | void): void {
  const tools = blocksOf(root, "tools");
  if (tools) for (const t of tools) if (visit(t, "tools") === false) return;
  const system = blocksOf(root, "system");
  if (system) for (const s of system) if (visit(s, "system") === false) return;
  const messages = blocksOf(root, "messages");
  if (messages) {
    for (const msg of messages) {
      const content = getAt(msg, "content");
      if (!Array.isArray(content)) continue;
      for (const item of content) if (visit(item, "messages") === false) return;
    }
  }
}

/** Number of valid cache_control breakpoints across tools, system and messages (Go: countCacheControls). */
export function countCacheControls(payload: string): number {
  return countCacheControlsIn(tryParse(payload));
}

function countCacheControlsIn(root: unknown): number {
  let count = 0;
  forEachCacheControlBlock(root, (block) => {
    if (isValidClaudeCacheControl(getAt(block, "cache_control"))) count++;
  });
  return count;
}

function claudeSystemBlockCanHostCacheControl(item: unknown): boolean {
  if (!isObj(item)) return false;
  const typ = gstr(item.type);
  if (typ !== "" && typ !== "text") return false;
  return gstr(item.text).trim() !== "";
}

function lastCacheableClaudeSystemIndex(system: unknown[]): number {
  let last = -1;
  for (let i = 0; i < system.length; i++) if (claudeSystemBlockCanHostCacheControl(system[i])) last = i;
  return last;
}

function claudePayloadHasCacheableSystem(root: unknown): boolean {
  const system = getAt(root, "system");
  if (system === undefined) return false;
  if (Array.isArray(system)) return lastCacheableClaudeSystemIndex(system) >= 0;
  if (typeof system === "string") return system.trim() !== "";
  return false;
}

function isEmptyClaudeTextBlock(block: unknown): boolean {
  return isObj(block) && gstr(block.type) === "text" && gstr(block.text).trim() === "";
}

function claudeContentBlockCanHostCacheControl(block: unknown): boolean {
  if (!isObj(block)) return false;
  switch (gstr(block.type)) {
    case "":
    case "thinking":
    case "redacted_thinking":
      return false;
    case "text":
      return gstr(block.text).trim() !== "";
    default:
      return true;
  }
}

function lastCacheableClaudeMessageContentBlockIndex(message: unknown): number {
  const content = getAt(message, "content");
  if (!Array.isArray(content) || content.length === 0) return -1;
  const isAssistant = gstr(getAt(message, "role")) === "assistant";
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (isEmptyClaudeTextBlock(block)) continue;
    if (isAssistant) {
      const typ = gstr(getAt(block, "type"));
      if (typ === "thinking" || typ === "redacted_thinking") return -1;
    }
    if (claudeContentBlockCanHostCacheControl(block)) return i;
  }
  return -1;
}

function claudeMessageEligibleForRollingCache(message: unknown): boolean {
  const content = getAt(message, "content");
  if (typeof content === "string") return content.trim() !== "";
  return lastCacheableClaudeMessageContentBlockIndex(message) >= 0;
}

function messageContentHasCacheControl(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => isValidClaudeCacheControl(getAt(item, "cache_control")));
}

function textBlock(text: string, cc: Record<string, unknown> | undefined): Block {
  const block: Block = { type: "text", text };
  if (cc) block.cache_control = cc;
  return block;
}

/** Adds cache_control to the last non-deferred tool when no tool already has one (Go: injectToolsCacheControl). */
export function injectToolsCacheControl(payload: string): string {
  const root = tryParse(payload);
  return injectToolsCacheControlIn(root) ? JSON.stringify(root) : payload;
}

function injectToolsCacheControlIn(root: unknown): boolean {
  const tools = blocksOf(root, "tools");
  if (!tools) return false;
  let lastEligible = -1;
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    if (isValidClaudeCacheControl(getAt(tool, "cache_control"))) return false;
    if (getAt(tool, "defer_loading") !== true) lastEligible = i;
  }
  if (lastEligible < 0) return false;
  const target = tools[lastEligible];
  if (!isObj(target)) return false;
  target.cache_control = claudeCodeCacheControl();
  return true;
}

/** Adds cache_control to the last cacheable system element when none has one (Go: injectSystemCacheControl). */
export function injectSystemCacheControl(payload: string): string {
  const root = tryParse(payload);
  return injectSystemCacheControlIn(root) ? JSON.stringify(root) : payload;
}

function injectSystemCacheControlIn(root: unknown): boolean {
  if (!isObj(root) || root.system === undefined) return false;
  const system = root.system;
  if (Array.isArray(system)) {
    if (system.length === 0) return false;
    let lastEligible = -1;
    for (let i = 0; i < system.length; i++) {
      const item = system[i];
      if (isValidClaudeCacheControl(getAt(item, "cache_control"))) return false;
      if (claudeSystemBlockCanHostCacheControl(item)) lastEligible = i;
    }
    if (lastEligible < 0) return false;
    (system[lastEligible] as Block).cache_control = claudeCodeCacheControl();
    return true;
  }
  if (typeof system === "string") {
    if (system.trim() === "") return false;
    root.system = [textBlock(system, claudeCodeCacheControl())];
    return true;
  }
  return false;
}

/** Adds cache_control to the message the native rolling breakpoint selector would pick (Go: injectMessagesCacheControl). */
export function injectMessagesCacheControl(payload: string): string {
  const root = tryParse(payload);
  return injectMessagesCacheControlIn(root) ? JSON.stringify(root) : payload;
}

function injectMessagesCacheControlIn(root: unknown): boolean {
  const messages = blocksOf(root, "messages");
  if (!messages) return false;
  const lastIndex = messages.length - 1;
  let lastEligible = -1;
  for (let i = 0; i < messages.length; i++) {
    const role = gstr(getAt(messages[i], "role"));
    if (role !== "user" && role !== "assistant") continue;
    if (claudeMessageEligibleForRollingCache(messages[i])) lastEligible = i;
  }
  if (lastEligible >= 0) {
    const final = messages[lastIndex];
    const finalContent = getAt(final, "content");
    if (gstr(getAt(final, "role")) === "system" && typeof finalContent === "string" && finalContent.trim() !== "") {
      (final as Block).content = [textBlock(finalContent, claudeCodeCacheControl())];
      return true;
    }
  }
  if (lastEligible < 0) return false;
  const message = messages[lastEligible] as Block;
  const content = message.content;
  if (messageContentHasCacheControl(content)) return false;
  if (Array.isArray(content)) {
    const target = lastCacheableClaudeMessageContentBlockIndex(message);
    if (target >= 0) {
      (content[target] as Block).cache_control = claudeCodeCacheControl();
      return true;
    }
    return false;
  }
  if (typeof content === "string" && content.trim() !== "") {
    message.content = [textBlock(content, claudeCodeCacheControl())];
    return true;
  }
  return false;
}

/**
 * Injects default cache_control breakpoints for translated and non-native
 * callers (Go: ensureCacheControl): the last system block (or the last tool when
 * there is no cacheable system), then the last cacheable message.
 */
export function ensureCacheControl(payload: string): string {
  const root = tryParse(payload);
  if (root === undefined) return payload;
  let changed = false;
  if (!claudePayloadHasCacheableSystem(root)) changed = injectToolsCacheControlIn(root) || changed;
  changed = injectSystemCacheControlIn(root) || changed;
  changed = injectMessagesCacheControlIn(root) || changed;
  return changed ? JSON.stringify(root) : payload;
}

/** Whether any candidate payload selects prompt_cache_options.mode "explicit" (Go: isExplicitPromptCacheMode). */
export function isExplicitPromptCacheMode(...payloads: Array<string | undefined>): boolean {
  for (const payload of payloads) {
    if (!payload) continue;
    const mode = gstr(getAt(tryParse(payload), "prompt_cache_options.mode"));
    if (mode.trim().toLowerCase() === "explicit") return true;
  }
  return false;
}

/** Removes prompt_cache_options, which Anthropic does not accept (Go: stripPromptCacheOptions). */
export function stripPromptCacheOptions(payload: string): string {
  const root = tryParse(payload);
  if (!isObj(root) || !("prompt_cache_options" in root)) return payload;
  delete root.prompt_cache_options;
  return JSON.stringify(root);
}

/** Whether the proxy owns breakpoint placement for this request (Go: shouldEnsureCacheControl). */
export function shouldEnsureCacheControl(payload: string, cloaked: boolean, confirmedClaudeCode: boolean, ...candidates: Array<string | undefined>): boolean {
  if (isExplicitPromptCacheMode(payload, ...candidates)) return false;
  return !confirmedClaudeCode && (cloaked || countCacheControls(payload) === 0);
}

/**
 * Mirrors the native ttl upgrade helper, which only touches blocks that already
 * carry a cache_control without a ttl (Go: upgradeClaudeCacheControlTTL).
 */
export function upgradeClaudeCacheControlTTL(payload: string, ttl: string): string {
  if (ttl === "" || payload === "") return payload;
  const root = tryParse(payload);
  if (root === undefined) return payload;
  let changed = false;
  forEachCacheControlBlock(root, (block) => {
    if (!isObj(block)) return;
    const cc = block.cache_control;
    if (!isObj(cc) || cc.ttl !== undefined) return;
    if (typeof cc.type !== "string") return;
    const upgraded: Block = { type: cc.type, ttl };
    if (cc.scope !== undefined) upgraded.scope = cc.scope;
    block.cache_control = upgraded;
    changed = true;
  });
  return changed ? JSON.stringify(root) : payload;
}

/** Removes any ttl from cache_control blocks (Go: stripClaudeCacheControlTTL). */
export function stripClaudeCacheControlTTL(payload: string): string {
  if (payload === "") return payload;
  const root = tryParse(payload);
  if (root === undefined) return payload;
  let changed = false;
  forEachCacheControlBlock(root, (block) => {
    const cc = getAt(block, "cache_control");
    if (!isObj(cc) || cc.ttl === undefined) return;
    delete cc.ttl;
    changed = true;
  });
  return changed ? JSON.stringify(root) : payload;
}

/**
 * A 1h-TTL block must not appear after a 5m-TTL block anywhere in the evaluation
 * order (Go: normalizeCacheControlTTL). Once a 5m block is seen, later 1h ttls are stripped.
 */
export function normalizeCacheControlTTL(payload: string): string {
  if (payload === "") return payload;
  const root = tryParse(payload);
  if (root === undefined) return payload;
  let seen5m = false;
  let changed = false;
  forEachCacheControlBlock(root, (block) => {
    const cc = getAt(block, "cache_control");
    if (!isValidClaudeCacheControl(cc)) return;
    const ttl = (cc as Block).ttl;
    if (typeof ttl !== "string" || ttl !== "1h") {
      seen5m = true;
      return;
    }
    if (!seen5m) return;
    delete (cc as Block).ttl;
    changed = true;
  });
  return changed ? JSON.stringify(root) : payload;
}

/**
 * Removes excess cache_control blocks so the total does not exceed the Anthropic
 * limit (Go: enforceCacheControlLimit). Removal order: system blocks earliest-first
 * (keeping the last), tools earliest-first (keeping the last), message blocks
 * earliest-first, then the remaining system and tool blocks.
 */
export function enforceCacheControlLimit(payload: string, maxBlocks: number): string {
  if (payload === "") return payload;
  const root = tryParse(payload);
  if (root === undefined) return payload;
  let limit = maxBlocks;
  const thread = getAt(root, "thread");
  if (thread !== undefined && thread !== null && limit > 0) limit--; // one breakpoint is reserved for thread continuation
  const total = countCacheControlsIn(root);
  if (total <= limit) return payload;
  let excess = total - limit;

  const stripSection = (blocks: Block[] | undefined, keepLast: boolean): void => {
    if (!blocks || excess <= 0) return;
    let lastIdx = -1;
    if (keepLast) {
      for (let i = 0; i < blocks.length; i++) if (isValidClaudeCacheControl(getAt(blocks[i], "cache_control"))) lastIdx = i;
      if (lastIdx < 0) return;
    }
    for (let i = 0; i < blocks.length && excess > 0; i++) {
      if (keepLast && i === lastIdx) continue;
      const block = blocks[i];
      if (!isObj(block) || !isValidClaudeCacheControl(block.cache_control)) continue;
      delete block.cache_control;
      excess--;
    }
  };

  stripSection(blocksOf(root, "system"), true);
  stripSection(blocksOf(root, "tools"), true);
  const messages = blocksOf(root, "messages");
  if (messages) {
    for (const msg of messages) {
      if (excess <= 0) break;
      const content = getAt(msg, "content");
      if (!Array.isArray(content)) continue;
      stripSection(content as Block[], false);
    }
  }
  stripSection(blocksOf(root, "system"), false);
  stripSection(blocksOf(root, "tools"), false);
  return JSON.stringify(root);
}

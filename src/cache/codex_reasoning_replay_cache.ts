// Port of internal/cache/codex_reasoning_replay_cache.go: process-memory store of
// the encrypted reasoning (and tool call) output items of completed Codex turns,
// keyed by model and client session, so a later stateless turn that arrives
// without them can have them re-inserted (see src/executor/codex/reasoning_replay.ts).
//
// Items are JSON strings. Each stored turn starts with a marker item of type
// cpa_codex_replay_turn carrying the turn id and the fingerprints used to anchor
// it in a later request.
//
// Bounds: entries expire CodexReasoningReplayCacheTTLMs after their last read or
// write (sliding, checked against the injected clock), at most
// CodexReasoningReplayCacheMaxEntries sessions are kept (a BoundedLRU; on
// overflow the least recently used CodexReasoningReplayCacheEvictBatchSize go),
// and one entry keeps at most CodexReasoningReplayCacheMaxTurnsPerEntry turns /
// CodexReasoningReplayCacheMaxBytesPerEntry bytes, oldest turns dropped first.
//
// Dropped from upstream: the Home KV backend (home mode, CAS appends) and the
// periodic background purge; expired entries are removed when read or by
// purgeExpired().
import { BoundedLRU } from "./bounded_lru.ts";
import { isValidGPTReasoningSignature } from "../signature/gpt_validation.ts";
import { isValidMetaReasoningSignature } from "../signature/meta_validation.ts";

/** Internal turn-boundary marker type. */
export const CodexReasoningReplayTurnType = "cpa_codex_replay_turn";
export const CodexReasoningReplayCacheTTLMs = 60 * 60 * 1000;
export const CodexReasoningReplayCacheMaxEntries = 10240;
export const CodexReasoningReplayCacheMaxTurnsPerEntry = 256;
export const CodexReasoningReplayCacheMaxBytesPerEntry = 16 << 20;
export const CodexReasoningReplayCacheEvictBatchSize = 128;

interface Entry {
  items: string[];
  timestamp: number;
}

export interface CodexReasoningReplayCacheOptions {
  /** Clock (epoch ms) for the sliding TTL. */
  now?: () => number;
  maxEntries?: number;
  evictBatchSize?: number;
}

export class CodexReasoningReplayCache {
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly evictBatchSize: number;
  private readonly entries: BoundedLRU<string, Entry>;

  constructor(options: CodexReasoningReplayCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = Math.max(1, options.maxEntries ?? CodexReasoningReplayCacheMaxEntries);
    this.evictBatchSize = Math.max(1, options.evictBatchSize ?? CodexReasoningReplayCacheEvictBatchSize);
    // One slot of headroom: the batch eviction below runs as soon as the size
    // passes maxEntries, so the LRU's own single eviction never triggers.
    this.entries = new BoundedLRU<string, Entry>(this.maxEntries + 1);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Replaces the session's items (Go: CacheCodexReasoningReplayItemsBestEffort). */
  cacheItems(modelName: string, sessionKey: string, items: string[]): boolean {
    const key = codexReasoningReplayCacheKey(modelName, sessionKey);
    if (key === "") return false;
    const normalized = normalizeCodexReasoningReplayItems(items);
    if (!normalized) return false;
    this.store(key, { items: normalized, timestamp: this.now() });
    return true;
  }

  cacheItem(modelName: string, sessionKey: string, item: string): boolean {
    return this.cacheItems(modelName, sessionKey, [item]);
  }

  /** Appends one completed turn to the session's items (Go: AppendCodexReasoningReplayItemsBestEffort). */
  appendItems(modelName: string, sessionKey: string, items: string[]): boolean {
    const key = codexReasoningReplayCacheKey(modelName, sessionKey);
    if (key === "") return false;
    const normalized = normalizeCodexReasoningReplayItems(items);
    if (!normalized) return false;
    const now = this.now();
    const existing = this.entries.get(key);
    const previous = existing && now - existing.timestamp <= CodexReasoningReplayCacheTTLMs ? existing.items : [];
    this.store(key, { items: appendCodexReasoningReplayTurn(previous, normalized), timestamp: now });
    return true;
  }

  /** The session's items, refreshing their TTL (Go: GetCodexReasoningReplayItemsRequired). */
  getItems(modelName: string, sessionKey: string): string[] | undefined {
    const key = codexReasoningReplayCacheKey(modelName, sessionKey);
    if (key === "") return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.timestamp > CodexReasoningReplayCacheTTLMs) {
      this.entries.delete(key);
      return undefined;
    }
    entry.timestamp = now;
    return [...entry.items];
  }

  /** The first non-marker item (Go: GetCodexReasoningReplayItem). */
  getItem(modelName: string, sessionKey: string): string | undefined {
    const items = this.getItems(modelName, sessionKey);
    if (!items) return undefined;
    return items.find((item) => itemType(item) !== CodexReasoningReplayTurnType);
  }

  /** Removes a session's items, e.g. after the upstream rejected them (Go: DeleteCodexReasoningReplayItemRequired). */
  delete(modelName: string, sessionKey: string): void {
    const key = codexReasoningReplayCacheKey(modelName, sessionKey);
    if (key === "") return;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Drops every expired entry (Go: purgeExpiredCodexReasoningReplayCache).
   * Recency order is timestamp order, so the scan stops at the first live entry
   * and re-touches the rest to restore their order.
   */
  purgeExpired(): void {
    const now = this.now();
    const keys = this.entries.keys();
    for (let index = 0; index < keys.length; index++) {
      const entry = this.entries.get(keys[index]!);
      if (entry && now - entry.timestamp > CodexReasoningReplayCacheTTLMs) {
        this.entries.delete(keys[index]!);
        continue;
      }
      for (const later of keys.slice(index + 1)) this.entries.get(later);
      return;
    }
  }

  private store(key: string, entry: Entry): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.items = entry.items;
      existing.timestamp = entry.timestamp;
    } else {
      this.entries.getOrAdd(key, () => entry);
    }
    if (this.entries.size > this.maxEntries) {
      // Batch eviction of the least recently used entries (Go: evictOldestCodexReasoningReplayEntries).
      for (const oldest of this.entries.keys().slice(0, this.evictBatchSize)) this.entries.delete(oldest);
    }
  }
}

/** Process-wide cache shared by every Codex executor unless one is injected. */
export const defaultCodexReasoningReplayCache = new CodexReasoningReplayCache();

export function cacheCodexReasoningReplayItem(modelName: string, sessionKey: string, item: string): boolean {
  return defaultCodexReasoningReplayCache.cacheItem(modelName, sessionKey, item);
}

export function cacheCodexReasoningReplayItems(modelName: string, sessionKey: string, items: string[]): boolean {
  return defaultCodexReasoningReplayCache.cacheItems(modelName, sessionKey, items);
}

export function appendCodexReasoningReplayItems(modelName: string, sessionKey: string, items: string[]): boolean {
  return defaultCodexReasoningReplayCache.appendItems(modelName, sessionKey, items);
}

export function getCodexReasoningReplayItem(modelName: string, sessionKey: string): string | undefined {
  return defaultCodexReasoningReplayCache.getItem(modelName, sessionKey);
}

export function getCodexReasoningReplayItems(modelName: string, sessionKey: string): string[] | undefined {
  return defaultCodexReasoningReplayCache.getItems(modelName, sessionKey);
}

export function deleteCodexReasoningReplayItem(modelName: string, sessionKey: string): void {
  defaultCodexReasoningReplayCache.delete(modelName, sessionKey);
}

export function clearCodexReasoningReplayCache(): void {
  defaultCodexReasoningReplayCache.clear();
}

/** Go: codexReasoningReplayCacheKey. The session is the continuity boundary, independent of the credential. */
export function codexReasoningReplayCacheKey(modelName: string, sessionKey: string): string {
  const model = modelName.trim();
  const session = sessionKey.trim();
  if (model === "" || session === "") return "";
  return ["codex-reasoning-replay", model, session].join("\x00");
}

function parse(item: string): unknown {
  try {
    return JSON.parse(item);
  } catch {
    return undefined;
  }
}

function field(root: unknown, key: string): unknown {
  return root !== null && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>)[key] : undefined;
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function itemType(item: string): string {
  return str(field(parse(item), "type")).trim();
}

function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Go: appendCodexReasoningReplayTurn. A turn already stored (same marker id) is not appended twice. */
export function appendCodexReasoningReplayTurn(existing: string[], turn: string[]): string[] {
  let base = existing;
  if (base.length > 0 && itemType(base[0]!) !== CodexReasoningReplayTurnType) base = [];
  let turnID = "";
  if (turn.length > 0) {
    const first = parse(turn[0]!);
    if (str(field(first, "type")).trim() === CodexReasoningReplayTurnType) turnID = str(field(first, "id")).trim();
  }
  if (turnID !== "") {
    for (const item of base) {
      const root = parse(item);
      if (str(field(root, "type")).trim() === CodexReasoningReplayTurnType && str(field(root, "id")).trim() === turnID) {
        return trimCodexReasoningReplayItems([...base]);
      }
    }
  }
  return trimCodexReasoningReplayItems([...base, ...turn]);
}

/** Drops the oldest turns until the entry fits the turn and byte bounds (Go: trimCodexReasoningReplayItems). */
export function trimCodexReasoningReplayItems(items: string[]): string[] {
  const types = items.map(itemType);
  let start = 0;
  for (;;) {
    const turnStarts = [start];
    let totalBytes = 0;
    for (let index = start; index < items.length; index++) {
      totalBytes += byteLength(items[index]!);
      if (index > start && types[index] === CodexReasoningReplayTurnType) turnStarts.push(index);
    }
    if (turnStarts.length <= CodexReasoningReplayCacheMaxTurnsPerEntry && totalBytes <= CodexReasoningReplayCacheMaxBytesPerEntry) {
      return start === 0 ? items : items.slice(start);
    }
    if (turnStarts.length <= 1) return [];
    start = turnStarts[1]!;
  }
}

/** Normalizes every item, dropping the ones that cannot be replayed; undefined when none remain. */
export function normalizeCodexReasoningReplayItems(items: string[]): string[] | undefined {
  const normalized: string[] = [];
  for (const item of items) {
    const out = normalizeCodexReasoningReplayItem(item);
    if (out !== undefined) normalized.push(out);
  }
  const trimmed = trimCodexReasoningReplayItems(normalized);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The minimal shape accepted by Responses input replay (Go: normalizeCodexReasoningReplayItem). */
export function normalizeCodexReasoningReplayItem(item: string): string | undefined {
  const root = parse(item);
  switch (str(field(root, "type")).trim()) {
    case CodexReasoningReplayTurnType:
      return normalizeTurn(root);
    case "reasoning":
      return normalizeReasoning(root);
    case "function_call":
      return normalizeFunctionCall(root);
    case "custom_tool_call":
      return normalizeCustomToolCall(root);
    default:
      return undefined;
  }
}

function normalizeTurn(root: unknown): string | undefined {
  const turnID = str(field(root, "id")).trim();
  if (turnID === "") return undefined;
  const out: Record<string, unknown> = { type: CodexReasoningReplayTurnType, id: turnID };
  const assistant = str(field(root, "assistant_fingerprint")).trim();
  if (assistant !== "") out.assistant_fingerprint = assistant;
  const request = str(field(root, "request_fingerprint")).trim();
  if (request !== "") out.request_fingerprint = request;
  const callIDs = field(root, "call_ids");
  if (Array.isArray(callIDs)) {
    const ids = callIDs.map((v) => str(v).trim()).filter((v) => v !== "");
    if (ids.length > 0) out.call_ids = ids;
  }
  return JSON.stringify(out);
}

function normalizeReasoning(root: unknown): string | undefined {
  const encrypted = field(root, "encrypted_content");
  if (typeof encrypted !== "string") return undefined;
  if (encrypted !== encrypted.trim()) return undefined;
  if (!isValidGPTReasoningSignature(encrypted) && !isValidMetaReasoningSignature(encrypted)) return undefined;
  return JSON.stringify({ type: "reasoning", summary: [], content: null, encrypted_content: encrypted });
}

function normalizeFunctionCall(root: unknown): string | undefined {
  const callID = str(field(root, "call_id")).trim();
  const name = str(field(root, "name")).trim();
  const args = field(root, "arguments");
  if (callID === "" || name === "" || typeof args !== "string") return undefined;
  return JSON.stringify({ type: "function_call", call_id: callID, name, arguments: args });
}

function normalizeCustomToolCall(root: unknown): string | undefined {
  const callID = str(field(root, "call_id")).trim();
  const name = str(field(root, "name")).trim();
  const input = field(root, "input");
  if (callID === "" || name === "" || input === undefined) return undefined;
  const status = str(field(root, "status")).trim();
  return JSON.stringify({ type: "custom_tool_call", status: status !== "" ? status : "completed", call_id: callID, name, input });
}

// Port of internal/cache/claude_thinking_replay_cache.go (local mode only; the
// Home KV backend is not ported). Per (model family, session) it keeps the
// signed assistant content arrays of earlier turns so a later request that
// dropped their thinking blocks can have them restored. Every read returns a
// snapshot (generation); replace/delete apply only while that snapshot is still
// current, so a concurrent request cannot resurrect or clobber newer state.
import { BoundedLRU } from "./bounded_lru.ts";

export const ClaudeThinkingReplayCacheTTLMs = 60 * 60_000;
export const ClaudeThinkingReplayCacheMaxEntries = 10240;
export const ClaudeThinkingReplayCacheMaxBytesPerSession = 8 << 20;
export const ClaudeThinkingReplayCacheMaxTurnsPerSession = 64;
export const ClaudeThinkingReplayCacheMaxBlocksPerTurn = 512;
export const ClaudeThinkingReplayCacheMaxTotalBytes = 256 << 20;

interface Entry {
  contents: string[];
  timestamp: number;
  generation: string;
  deleted: boolean;
}

/** The replay generation one request read (Go: ClaudeThinkingReplaySnapshot). */
export interface ClaudeThinkingReplaySnapshot {
  generation: string;
  loaded: boolean;
  found: boolean;
}

export function emptyClaudeThinkingReplaySnapshot(): ClaudeThinkingReplaySnapshot {
  return { generation: "", loaded: false, found: false };
}

function cacheKey(modelFamily: string, sessionKey: string): string {
  modelFamily = modelFamily.trim();
  sessionKey = sessionKey.trim();
  if (modelFamily === "" || sessionKey === "") return "";
  return ["claude-thinking-replay", modelFamily, sessionKey].join("\x00");
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function entryBytes(contents: string[]): number {
  let total = 0;
  for (const c of contents) total += byteLength(c);
  return total;
}

/** A non-empty JSON array of at most 512 blocks within the per-session size limit. */
export function validClaudeThinkingReplayContent(content: string): boolean {
  if (content.length === 0 || byteLength(content) > ClaudeThinkingReplayCacheMaxBytesPerSession) return false;
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return false;
  }
  return Array.isArray(root) && root.length > 0 && root.length <= ClaudeThinkingReplayCacheMaxBlocksPerTurn;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Semantic JSON equality with sorted keys (Go: claudeThinkingReplayJSONEqual / json.Marshal of a map). */
export function claudeThinkingReplayJSONEqual(left: string, right: string): boolean {
  try {
    return canonicalJSON(JSON.parse(left)) === canonicalJSON(JSON.parse(right));
  } catch {
    return false;
  }
}

function appendContent(contents: string[], content: string): string[] {
  const cloned = [...contents];
  for (const existing of cloned) if (claudeThinkingReplayJSONEqual(existing, content)) return cloned;
  cloned.push(content);
  while (cloned.length > 0 && (cloned.length > ClaudeThinkingReplayCacheMaxTurnsPerSession || entryBytes(cloned) > ClaudeThinkingReplayCacheMaxBytesPerSession)) cloned.shift();
  return cloned;
}

export interface ClaudeThinkingReplayCacheOptions {
  now?: () => number;
  maxEntries?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
}

export class ClaudeThinkingReplayCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private totalBytes = 0;
  private readonly entries: BoundedLRU<string, Entry>;

  constructor(opts: ClaudeThinkingReplayCacheOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? ClaudeThinkingReplayCacheTTLMs;
    this.maxTotalBytes = opts.maxTotalBytes ?? ClaudeThinkingReplayCacheMaxTotalBytes;
    this.entries = new BoundedLRU<string, Entry>(opts.maxEntries ?? ClaudeThinkingReplayCacheMaxEntries, (_key, entry) => {
      this.totalBytes -= entryBytes(entry.contents);
    });
  }

  private put(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalBytes += entryBytes(entry.contents);
    this.entries.getOrAdd(key, () => entry);
    // Evict least recently used sessions while the aggregate is over budget.
    while (this.totalBytes > this.maxTotalBytes && this.entries.size > 0) this.entries.delete(this.entries.keys()[0]!);
  }

  /** Stores one complete signed content array unconditionally (Go: CacheClaudeThinkingReplayBestEffort). */
  cacheBestEffort(modelFamily: string, sessionKey: string, content: string): boolean {
    const key = cacheKey(modelFamily, sessionKey);
    if (key === "" || !validClaudeThinkingReplayContent(content)) return false;
    this.put(key, { contents: [content], timestamp: this.now(), generation: crypto.randomUUID(), deleted: false });
    return true;
  }

  /**
   * Reads every cached turn and the snapshot the request saw (Go:
   * GetClaudeThinkingReplayWithSnapshotRequired). An absent or expired entry is
   * reserved as a tombstone so a later replace has a generation to compare.
   */
  getWithSnapshot(modelFamily: string, sessionKey: string): { contents: string[]; snapshot: ClaudeThinkingReplaySnapshot; found: boolean } {
    const key = cacheKey(modelFamily, sessionKey);
    if (key === "") return { contents: [], snapshot: emptyClaudeThinkingReplaySnapshot(), found: false };
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.timestamp > this.ttlMs) {
      entry = { contents: [], timestamp: now, generation: crypto.randomUUID(), deleted: true };
      this.put(key, entry);
    }
    entry.timestamp = now;
    const snapshot = { generation: entry.generation, loaded: true, found: true };
    if (entry.deleted) return { contents: [], snapshot, found: false };
    return { contents: [...entry.contents], snapshot, found: entry.contents.length > 0 };
  }

  /** Go: GetClaudeThinkingReplayRequired. */
  get(modelFamily: string, sessionKey: string): { contents: string[]; found: boolean } {
    const { contents, found } = this.getWithSnapshot(modelFamily, sessionKey);
    return { contents, found };
  }

  /** Appends a completed turn when the snapshot is still current (Go: ReplaceClaudeThinkingReplayIfUnchanged). */
  replaceIfUnchanged(modelFamily: string, sessionKey: string, snapshot: ClaudeThinkingReplaySnapshot, content: string): boolean {
    const key = cacheKey(modelFamily, sessionKey);
    if (key === "" || !validClaudeThinkingReplayContent(content)) return false;
    if (!snapshot.loaded) return this.cacheBestEffort(modelFamily, sessionKey, content);
    const entry = this.entries.has(key) ? this.entries.get(key) : undefined;
    const found = entry !== undefined;
    if (found !== snapshot.found || (entry && entry.generation !== snapshot.generation)) return false;
    const contents = appendContent(entry?.deleted ? [] : (entry?.contents ?? []), content);
    this.put(key, { contents, timestamp: this.now(), generation: crypto.randomUUID(), deleted: false });
    return true;
  }

  /** Tombstones the entry when the snapshot is still current (Go: DeleteClaudeThinkingReplayIfUnchanged). */
  deleteIfUnchanged(modelFamily: string, sessionKey: string, snapshot: ClaudeThinkingReplaySnapshot): boolean {
    const key = cacheKey(modelFamily, sessionKey);
    if (key === "") return false;
    if (!snapshot.loaded) {
      this.delete(modelFamily, sessionKey);
      return true;
    }
    const entry = this.entries.has(key) ? this.entries.get(key) : undefined;
    const found = entry !== undefined;
    if (found !== snapshot.found || (entry && entry.generation !== snapshot.generation)) return false;
    this.put(key, { contents: [], timestamp: this.now(), generation: crypto.randomUUID(), deleted: true });
    return true;
  }

  /** Removes the entry unconditionally (Go: DeleteClaudeThinkingReplayRequired). */
  delete(modelFamily: string, sessionKey: string): void {
    const key = cacheKey(modelFamily, sessionKey);
    if (key !== "") this.entries.delete(key);
  }

  /** Clears only the Claude replay state (Go: ClearClaudeThinkingReplayCache). */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

/** Process-wide cache used by Claude executors without their own instance. */
export const defaultClaudeThinkingReplayCache = new ClaudeThinkingReplayCache();

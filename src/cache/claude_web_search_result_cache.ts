// Port of internal/cache/claude_web_search_result_cache.go: the session-scoped
// store of Claude web_search_tool_result contents. Responses clients (Codex)
// keep only the query of a web_search_call, so the Claude executor stores the
// raw result content here and restores it into later requests of the same
// session (see src/executor/claude/web_search_results.ts).
//
// Entries are keyed by sha256(sessionKey "\0" toolUseID), bounded by an entry
// limit with LRU eviction (expired entries are purged first) and expire after
// a sliding TTL that each read extends. Dropped from upstream: the Home KV
// backend and the periodic cleanup goroutine (expired entries are purged lazily).
import { sha256Hex } from "../util/hash.ts";

export const defaultClaudeWebSearchResultTTLMs = 24 * 60 * 60_000;
export const defaultClaudeWebSearchResultLimit = 1024;

interface Entry {
  content: string;
  ttlMs: number;
  expiresAt: number;
}

export interface ClaudeWebSearchResultCacheOptions {
  /** Clock (epoch ms). */
  now?: () => number;
}

/** The cache key for a session and tool use id, or undefined when either is blank (Go: claudeWebSearchResultKey). */
export function claudeWebSearchResultKey(sessionKey: string, toolUseID: string): string | undefined {
  const session = sessionKey.trim();
  const toolUse = toolUseID.trim();
  if (session === "" || toolUse === "") return undefined;
  return sha256Hex(session + "\x00" + toolUse);
}

export class ClaudeWebSearchResultCache {
  /** Map order is recency order: the first key is the least recently used. */
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: ClaudeWebSearchResultCacheOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Stores the raw content of one web_search_tool_result block. The entry
   * limit evicts least recently used entries once expired ones are purged
   * (Go: CacheClaudeWebSearchResultBestEffort). Returns whether it was stored.
   */
  set(sessionKey: string, toolUseID: string, content: string, ttlMs: number, limit: number): boolean {
    const key = claudeWebSearchResultKey(sessionKey, toolUseID);
    if (key === undefined || content.length === 0) return false;
    if (ttlMs <= 0) ttlMs = defaultClaudeWebSearchResultTTLMs;
    if (limit <= 0) limit = defaultClaudeWebSearchResultLimit;
    const now = this.now();
    this.entries.delete(key);
    if (this.entries.size >= limit) this.purgeExpired(now);
    this.entries.set(key, { content, ttlMs, expiresAt: now + ttlMs });
    while (this.entries.size > limit) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return true;
  }

  /**
   * The stored content; a hit extends the lifetime by `ttlMs` (or the entry's
   * own TTL) and marks it most recently used. Expired entries are removed and
   * reported as missing (Go: GetClaudeWebSearchResult).
   */
  get(sessionKey: string, toolUseID: string, ttlMs?: number): string | undefined {
    const key = claudeWebSearchResultKey(sessionKey, toolUseID);
    if (key === undefined) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    if (ttlMs !== undefined && ttlMs > 0) entry.ttlMs = ttlMs;
    const effective = entry.ttlMs > 0 ? entry.ttlMs : defaultClaudeWebSearchResultTTLMs;
    entry.expiresAt = now + effective;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.content;
  }

  /** Removes every entry (Go: ClearClaudeWebSearchResultCache). */
  clear(): void {
    this.entries.clear();
  }

  /** Drops every expired entry (Go: purgeExpiredClaudeWebSearchResultCache). */
  purgeExpired(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** The stored keys (sha256 hex), least recently used first. */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}

/** Process-wide cache used by the Claude executor unless one is injected. */
export const defaultClaudeWebSearchResultCache = new ClaudeWebSearchResultCache();

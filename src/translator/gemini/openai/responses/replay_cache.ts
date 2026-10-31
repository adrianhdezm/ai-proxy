// Local minimal port of the in-memory half of internal/cache/antigravity_reasoning_replay_cache.go,
// restricted to the "thought_signature" items the Gemini Responses translator stores.
// The Home KV backend is not ported (this proxy has no Home mode).
import { getAt, gstr } from "../../../../util/gpath.ts";

export const replayCacheTTLMs = 60 * 60 * 1000;
export const replayCacheMaxEntries = 10240;
const replayCacheEvictBatchSize = 128;
const minThoughtSignatureReplayLen = 16;
const maxItemsPerEntry = 4096;
const maxBytesPerEntry = 16 << 20;

interface Entry {
  items: string[];
  timestamp: number;
}

const entries = new Map<string, Entry>();
let nowFn: () => number = () => Date.now();

/** Overrides the clock (tests). Pass undefined to restore Date.now. */
export function setReplayCacheClock(fn: (() => number) | undefined): void {
  nowFn = fn ?? (() => Date.now());
}

let writeFilter: (() => boolean) | undefined;

/**
 * Installs a hook consulted before every write; returning false rejects the write
 * (tests use it to stand in for Go's failing Home KV backend). Undefined removes it.
 */
export function setReplayCacheWriteFilter(fn: (() => boolean) | undefined): void {
  writeFilter = fn;
}

/** Clears every cached entry (Go: ClearAntigravityReasoningReplayCache). */
export function clearReplayCache(): void {
  entries.clear();
}

function cacheKey(modelName: string, sessionKey: string): string {
  modelName = modelName.trim();
  sessionKey = sessionKey.trim();
  if (modelName === "" || sessionKey === "") return "";
  return ["antigravity-reasoning-replay", modelName, sessionKey].join("\x00");
}

function normalizeThoughtSignatureItem(item: unknown): string | undefined {
  let sig = gstr(getAt(item, "thoughtSignature")).trim();
  if (sig === "") sig = gstr(getAt(item, "thought_signature")).trim();
  if (sig === "" || sig === "skip_thought_signature_validator" || sig.length < minThoughtSignatureReplayLen) return undefined;
  const out: Record<string, unknown> = { type: "thought_signature", thoughtSignature: sig };
  const contentIndex = getAt(item, "contentIndex");
  if (typeof contentIndex === "number") out.contentIndex = Math.trunc(contentIndex);
  const partIndex = getAt(item, "partIndex");
  if (typeof partIndex === "number") out.partIndex = Math.trunc(partIndex);
  const targetKind = gstr(getAt(item, "targetKind")).trim();
  if (targetKind === "text" || targetKind === "thought") out.targetKind = targetKind;
  const targetHash = gstr(getAt(item, "targetHash")).trim();
  if (targetHash !== "") out.targetHash = targetHash;
  const targetOccurrence = getAt(item, "targetOccurrence");
  if (typeof targetOccurrence === "number" && targetOccurrence >= 0) out.targetOccurrence = Math.trunc(targetOccurrence);
  const contextHash = gstr(getAt(item, "contextHash")).trim();
  if (contextHash !== "") out.contextHash = contextHash;
  return JSON.stringify(out);
}

function normalizeItems(items: string[]): string[] | undefined {
  if (items.length > maxItemsPerEntry) return undefined;
  const normalized: string[] = [];
  let total = 0;
  for (const item of items) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item);
    } catch {
      continue;
    }
    if (gstr(getAt(parsed, "type")).trim() !== "thought_signature") continue;
    const n = normalizeThoughtSignatureItem(parsed);
    if (n === undefined) continue;
    total += n.length;
    if (total > maxBytesPerEntry) return undefined;
    normalized.push(n);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function purgeExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.timestamp > replayCacheTTLMs) entries.delete(key);
  }
}

/** Stores replay items for a session (Go: CacheAntigravityReasoningReplayItems). */
export function cacheReplayItems(modelName: string, sessionKey: string, items: string[]): boolean {
  const key = cacheKey(modelName, sessionKey);
  if (key === "") return false;
  const normalized = normalizeItems(items);
  if (!normalized) return false;
  if (writeFilter && !writeFilter()) return false;
  const now = nowFn();
  purgeExpired(now);
  entries.delete(key);
  entries.set(key, { items: normalized, timestamp: now });
  if (entries.size > replayCacheMaxEntries) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp).slice(0, replayCacheEvictBatchSize);
    for (const [k] of oldest) entries.delete(k);
  }
  return true;
}

/** Retrieves replay items for a session (Go: GetAntigravityReasoningReplayItems). */
export function getReplayItems(modelName: string, sessionKey: string): string[] | undefined {
  const key = cacheKey(modelName, sessionKey);
  if (key === "") return undefined;
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (nowFn() - entry.timestamp > replayCacheTTLMs) {
    entries.delete(key);
    return undefined;
  }
  return [...entry.items];
}

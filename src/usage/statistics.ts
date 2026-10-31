// In-memory usage aggregation. Port of RequestStatistics from the v6
// internal/usage/logger_plugin.go (the store behind the management
// /usage endpoint; current upstream moved it out of tree) on top of the record
// normalisation of sdk/cliproxy/usage/manager.go (Publish back-fills the
// request id). Extended with per-model, per-credential and per-provider buckets,
// a token breakdown and a bounded history of recent records.
//
// Deviations: day/hour buckets use UTC (Go used the local zone); per-request
// details are taken from the bounded history instead of growing without limit;
// the client-key map is keyed by the masked key.
import { log } from "../log.ts";
import { ensureTokenBreakdownForProvider, type Detail } from "./accounting.ts";
import { normalizeRecord, type UsageRecord, type UsageRecordInput } from "./record.ts";

export const DefaultHistoryLimit = 1000;

export interface UsageStatisticsOptions {
  /** config usage.statisticsEnabled; when false records are discarded. */
  enabled?: boolean;
  /** Recent records kept for details and `since` queries (default 1000). */
  historyLimit?: number;
  /** Clock (epoch ms). */
  now?: () => number;
  /** Request id generator (default crypto.randomUUID). */
  newId?: () => string;
}

export interface TokenStatsJSON {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
}

export interface BucketJSON {
  total_requests: number;
  success_count: number;
  failure_count: number;
  total_tokens: number;
  tokens: TokenStatsJSON;
}

export interface CredentialBucketJSON extends BucketJSON {
  provider: string;
  label: string;
}

export interface RequestDetailJSON {
  request_id: string;
  timestamp: string;
  latency_ms: number;
  provider: string;
  model: string;
  alias: string;
  response_model?: string;
  endpoint: string;
  auth_id: string;
  auth_index: string;
  source: string;
  api_key: string;
  session_id?: string;
  stream: boolean;
  failed: boolean;
  fail: { status_code: number; code?: string };
  tokens: TokenStatsJSON;
}

export interface ModelSnapshotJSON {
  total_requests: number;
  total_tokens: number;
  success_count: number;
  failure_count: number;
  details: RequestDetailJSON[];
}

export interface APISnapshotJSON {
  total_requests: number;
  total_tokens: number;
  success_count: number;
  failure_count: number;
  models: Record<string, ModelSnapshotJSON>;
}

/** Go: StatisticsSnapshot, plus the port's extra breakdowns. */
export interface StatisticsSnapshotJSON {
  total_requests: number;
  success_count: number;
  failure_count: number;
  total_tokens: number;
  tokens: TokenStatsJSON;
  apis: Record<string, APISnapshotJSON>;
  requests_by_day: Record<string, number>;
  requests_by_hour: Record<string, number>;
  tokens_by_day: Record<string, number>;
  tokens_by_hour: Record<string, number>;
  models: Record<string, BucketJSON>;
  providers: Record<string, BucketJSON>;
  credentials: Record<string, CredentialBucketJSON>;
}

/** Body of GET /v0/usage (Go: GetUsageStatistics' {usage, failed_requests}). */
export interface UsageResponseJSON {
  usage: StatisticsSnapshotJSON;
  failed_requests: number;
  /** Recent records, oldest first (bounded by the history limit). */
  recent_requests: RequestDetailJSON[];
  history_limit: number;
  /** Present for `?since=` queries: the lower bound applied. */
  since?: string;
  /** For `?since=` queries: false when records at or after `since` were already evicted from the history. */
  history_complete?: boolean;
}

interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

function zeroTokens(): TokenStats {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };
}

/** Token stats of a record (Go: normaliseDetail, with Claude's independent cache buckets in the total). */
export function tokenStatsOf(detail: Detail): TokenStats {
  const normalized = ensureTokenBreakdownForProvider(detail, "claude", "");
  return {
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
    cachedTokens: normalized.cachedTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    cacheCreationTokens: normalized.cacheCreationTokens,
    totalTokens: Math.max(0, normalized.totalTokens),
  };
}

function addTokens(into: TokenStats, add: TokenStats): void {
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.reasoningTokens += add.reasoningTokens;
  into.cachedTokens += add.cachedTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
  into.totalTokens += add.totalTokens;
}

function tokensJSON(t: TokenStats): TokenStatsJSON {
  return {
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    reasoning_tokens: t.reasoningTokens,
    cached_tokens: t.cachedTokens,
    cache_read_tokens: t.cacheReadTokens,
    cache_creation_tokens: t.cacheCreationTokens,
    total_tokens: t.totalTokens,
  };
}

class Bucket {
  totalRequests = 0;
  successCount = 0;
  failureCount = 0;
  readonly tokens = zeroTokens();

  add(failed: boolean, tokens: TokenStats): void {
    this.totalRequests++;
    if (failed) this.failureCount++;
    else this.successCount++;
    addTokens(this.tokens, tokens);
  }

  toJSON(): BucketJSON {
    return { total_requests: this.totalRequests, success_count: this.successCount, failure_count: this.failureCount, total_tokens: this.tokens.totalTokens, tokens: tokensJSON(this.tokens) };
  }
}

class CredentialBucket extends Bucket {
  provider = "";
  label = "";
}

class APIBucket extends Bucket {
  readonly models = new Map<string, Bucket>();
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

/** The key of the per-client map (Go: record.APIKey, else resolveAPIIdentifier: "METHOD path", else provider). */
export function apiIdentifier(record: UsageRecord): string {
  if (record.apiKey !== "") return record.apiKey;
  if (record.endpoint !== "") return record.endpoint;
  return record.provider || "unknown";
}

export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Go: formatHour. */
export function hourKey(timestamp: number): string {
  return String(new Date(timestamp).getUTCHours()).padStart(2, "0");
}

/** Aggregated counters over a set of records (Go: RequestStatistics' maps). */
class Aggregate {
  private readonly total = new Bucket();
  private readonly apis = new Map<string, APIBucket>();
  private readonly models = new Map<string, Bucket>();
  private readonly providers = new Map<string, Bucket>();
  private readonly credentials = new Map<string, CredentialBucket>();
  private readonly requestsByDay = new Map<string, number>();
  private readonly requestsByHour = new Map<string, number>();
  private readonly tokensByDay = new Map<string, number>();
  private readonly tokensByHour = new Map<string, number>();

  /** Go: RequestStatistics.Record / updateAPIStats. */
  add(record: UsageRecord): void {
    const tokens = tokenStatsOf(record.detail);
    this.total.add(record.failed, tokens);
    const api = getOrCreate(this.apis, apiIdentifier(record), () => new APIBucket());
    api.add(record.failed, tokens);
    getOrCreate(api.models, record.model, () => new Bucket()).add(record.failed, tokens);
    getOrCreate(this.models, record.model, () => new Bucket()).add(record.failed, tokens);
    getOrCreate(this.providers, record.provider, () => new Bucket()).add(record.failed, tokens);
    if (record.authId !== "") {
      const credential = getOrCreate(this.credentials, record.authId, () => new CredentialBucket());
      credential.add(record.failed, tokens);
      credential.provider = record.provider;
      if (record.authIndex !== "") credential.label = record.authIndex;
    }
    const day = dayKey(record.timestamp);
    const hour = hourKey(record.timestamp);
    this.requestsByDay.set(day, (this.requestsByDay.get(day) ?? 0) + 1);
    this.requestsByHour.set(hour, (this.requestsByHour.get(hour) ?? 0) + 1);
    this.tokensByDay.set(day, (this.tokensByDay.get(day) ?? 0) + tokens.totalTokens);
    this.tokensByHour.set(hour, (this.tokensByHour.get(hour) ?? 0) + tokens.totalTokens);
  }

  get failureCount(): number {
    return this.total.failureCount;
  }

  /** Go: RequestStatistics.Snapshot. `details` supplies the per-(client, model) request details. */
  toJSON(details: (api: string, model: string) => RequestDetailJSON[]): StatisticsSnapshotJSON {
    const apis: Record<string, APISnapshotJSON> = {};
    for (const [name, api] of sortedEntries(this.apis)) {
      const models: Record<string, ModelSnapshotJSON> = {};
      for (const [model, bucket] of sortedEntries(api.models)) {
        models[model] = { total_requests: bucket.totalRequests, total_tokens: bucket.tokens.totalTokens, success_count: bucket.successCount, failure_count: bucket.failureCount, details: details(name, model) };
      }
      apis[name] = { total_requests: api.totalRequests, total_tokens: api.tokens.totalTokens, success_count: api.successCount, failure_count: api.failureCount, models };
    }
    const credentials: Record<string, CredentialBucketJSON> = {};
    for (const [id, bucket] of sortedEntries(this.credentials)) credentials[id] = { ...bucket.toJSON(), provider: bucket.provider, label: bucket.label };
    return {
      total_requests: this.total.totalRequests,
      success_count: this.total.successCount,
      failure_count: this.total.failureCount,
      total_tokens: this.total.tokens.totalTokens,
      tokens: tokensJSON(this.total.tokens),
      apis,
      requests_by_day: Object.fromEntries(sortedEntries(this.requestsByDay)),
      requests_by_hour: Object.fromEntries(sortedEntries(this.requestsByHour)),
      tokens_by_day: Object.fromEntries(sortedEntries(this.tokensByDay)),
      tokens_by_hour: Object.fromEntries(sortedEntries(this.tokensByHour)),
      models: bucketsJSON(this.models),
      providers: bucketsJSON(this.providers),
      credentials,
    };
  }
}

function sortedEntries<V>(map: Map<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function bucketsJSON(map: Map<string, Bucket>): Record<string, BucketJSON> {
  const out: Record<string, BucketJSON> = {};
  for (const [key, bucket] of sortedEntries(map)) out[key] = bucket.toJSON();
  return out;
}

/** JSON view of one record (Go: RequestDetail / the queue payload, without client IPs, headers or failure bodies). */
export function recordJSON(record: UsageRecord): RequestDetailJSON {
  const out: RequestDetailJSON = {
    request_id: record.requestId,
    timestamp: new Date(record.timestamp).toISOString(),
    latency_ms: record.latencyMs,
    provider: record.provider,
    model: record.model,
    alias: record.alias,
    endpoint: record.endpoint,
    auth_id: record.authId,
    auth_index: record.authIndex,
    source: record.source,
    api_key: record.apiKey,
    stream: record.stream,
    failed: record.failed,
    fail: { status_code: record.fail.statusCode },
    tokens: tokensJSON(tokenStatsOf(record.detail)),
  };
  if (record.responseModel !== "") out.response_model = record.responseModel;
  if (record.sessionId !== "") out.session_id = record.sessionId;
  if (record.fail.code !== "") out.fail.code = record.fail.code;
  return out;
}

/**
 * In-memory usage statistics (Go: RequestStatistics + LoggerPlugin with the
 * statisticsEnabled switch). Cumulative counters cover every recorded request;
 * request details and `since` queries are served from a bounded history.
 */
export class UsageStatistics {
  private enabledFlag: boolean;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private totals = new Aggregate();
  private history: UsageRecord[] = [];
  /** Latest timestamp among records evicted from the history (-Infinity when none). */
  private evictedUpTo = Number.NEGATIVE_INFINITY;

  constructor(options: UsageStatisticsOptions = {}) {
    this.enabledFlag = options.enabled ?? false;
    this.historyLimit = Math.max(0, Math.trunc(options.historyLimit ?? DefaultHistoryLimit));
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Go: StatisticsEnabled. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** Go: SetStatisticsEnabled. Already aggregated data is kept. */
  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
  }

  /**
   * Ingests one record (Go: Manager.Publish -> LoggerPlugin.HandleUsage ->
   * RequestStatistics.Record). Returns the stored record, or undefined when
   * statistics are disabled and the record was discarded.
   */
  record(input: UsageRecordInput): UsageRecord | undefined {
    if (!this.enabledFlag) return undefined;
    const record = normalizeRecord(input, this.now, this.newId);
    this.totals.add(record);
    if (this.historyLimit > 0) {
      this.history.push(record);
      if (this.history.length > this.historyLimit) {
        for (const evicted of this.history.splice(0, this.history.length - this.historyLimit)) {
          if (evicted.timestamp > this.evictedUpTo) this.evictedUpTo = evicted.timestamp;
        }
      }
    } else if (record.timestamp > this.evictedUpTo) {
      this.evictedUpTo = record.timestamp;
    }
    const tokens = tokenStatsOf(record.detail);
    log.debug(
      `usage: ${record.endpoint || "request"} provider=${record.provider} model=${record.model} stream=${record.stream} status=${record.fail.statusCode} ` +
        `tokens=${tokens.totalTokens} (in=${tokens.inputTokens} out=${tokens.outputTokens} cache_read=${tokens.cacheReadTokens} cache_creation=${tokens.cacheCreationTokens}) latency=${record.latencyMs}ms`,
    );
    return record;
  }

  /** Recent records, oldest first. */
  recent(since?: number): UsageRecord[] {
    return since === undefined ? [...this.history] : this.history.filter((record) => record.timestamp >= since);
  }

  /** Drops every aggregate and the history. */
  reset(): void {
    this.totals = new Aggregate();
    this.history = [];
    this.evictedUpTo = Number.NEGATIVE_INFINITY;
  }

  /**
   * The GET /v0/usage body. Without `since` the cumulative counters are
   * returned; with `since` (epoch ms) every aggregate is computed from the
   * history records at or after it.
   */
  snapshot(options: { since?: number } = {}): UsageResponseJSON {
    const since = options.since;
    const records = this.recent(since);
    let aggregate = this.totals;
    if (since !== undefined) {
      aggregate = new Aggregate();
      for (const record of records) aggregate.add(record);
    }
    const byKey = new Map<string, RequestDetailJSON[]>();
    for (const record of records) getOrCreate(byKey, `${apiIdentifier(record)}\u0000${record.model}`, () => []).push(recordJSON(record));
    const usage = aggregate.toJSON((api, model) => byKey.get(`${api}\u0000${model}`) ?? []);
    const out: UsageResponseJSON = {
      usage,
      failed_requests: aggregate.failureCount,
      recent_requests: records.map(recordJSON),
      history_limit: this.historyLimit,
    };
    if (since !== undefined) {
      out.since = new Date(since).toISOString();
      out.history_complete = this.evictedUpTo < since;
    }
    return out;
  }
}

// Refresh scheduling. Port of shouldRefresh / invalidGrantBackoffDuration from
// sdk/cliproxy/auth/conductor_refresh.go and nextRefreshCheckAt plus the timer
// loop of auto_refresh_loop.go.
//
// Dropped from upstream: Codex SIWC dual refresh, Devin quota revalidation,
// RefreshEvaluator runtimes and the worker pool (refreshes run through a small
// concurrency gate instead).
import type { Auth } from "../types.ts";
import {
  AuthKindAPIKey,
  ClaudeRefreshLeadMs,
  CodexOuterRefreshLeadMs,
  authKind,
  authLastRefreshTimestamp,
  authPreferredRefreshIntervalMs,
  expirationTime,
} from "./classification.ts";
import { hasDisabledInvalidGrantFailure, hasUnauthorizedAuthFailure } from "./state.ts";

export const RefreshCheckIntervalMs = 5 * 1000;
export const RefreshFailureBackoffMs = 5 * 60 * 1000;
export const InvalidGrantBackoffBaseMs = 60 * 1000;
export const InvalidGrantBackoffMaxMs = 30 * 60 * 1000;
/** Throttles refreshes that succeed but leave the auth still due (Go: refreshIneffectiveBackoff). */
export const RefreshIneffectiveBackoffMs = 30 * 1000;
/** Timer waits are clamped so a suspended host re-evaluates soon after resume (Go: maxRefreshTimerWait). */
export const MaxRefreshTimerWaitMs = 30 * 1000;
export const RefreshMaxConcurrency = 16;

/** Refresh lead per provider, in milliseconds. `undefined` means the provider refreshes on demand only. */
export type RefreshLeadResolver = (auth: Auth) => number | undefined;

const defaultRefreshLeads: Record<string, number> = {
  codex: CodexOuterRefreshLeadMs,
  claude: ClaudeRefreshLeadMs,
};

/** Default lead resolution: codex 96h, claude 4h, others on demand (Go: ProviderRefreshLead + sdk/auth leads). */
export function defaultRefreshLead(auth: Auth): number | undefined {
  const provider = (auth.provider ?? "").trim().toLowerCase();
  const lead = defaultRefreshLeads[provider];
  return lead !== undefined && lead > 0 ? lead : undefined;
}

/** Exponential invalid_grant backoff: 1m, 2m, 4m ... capped at 30m (Go: invalidGrantBackoffDuration). */
export function invalidGrantBackoffMs(failures: number): number {
  if (failures <= 1) return InvalidGrantBackoffBaseMs;
  const shift = Math.min(failures - 1, 10);
  const backoff = InvalidGrantBackoffBaseMs * 2 ** shift;
  return backoff > InvalidGrantBackoffMaxMs ? InvalidGrantBackoffMaxMs : backoff;
}

function lastRefreshOf(auth: Auth): number {
  if (auth.lastRefreshedAt !== 0) return auth.lastRefreshedAt;
  return authLastRefreshTimestamp(auth) ?? 0;
}

/** Whether the auth is due for a refresh at `nowMs` (Go: Manager.shouldRefresh). */
export function shouldRefresh(auth: Auth | undefined, nowMs: number, lead: RefreshLeadResolver = defaultRefreshLead): boolean {
  if (!auth) return false;
  if (hasUnauthorizedAuthFailure(auth) || hasDisabledInvalidGrantFailure(auth)) return false;
  if (auth.nextRefreshAfter !== 0 && nowMs < auth.nextRefreshAfter) return false;
  const lastRefresh = lastRefreshOf(auth);
  const expiry = expirationTime(auth);
  const hasExpiry = expiry !== undefined && expiry !== 0;
  const interval = authPreferredRefreshIntervalMs(auth);
  if (interval > 0) {
    if (hasExpiry) {
      if (expiry <= nowMs) return true;
      if (expiry - nowMs <= interval) return true;
    }
    if (lastRefresh === 0) return true;
    return nowMs - lastRefresh >= interval;
  }
  const leadMs = lead(auth);
  if (leadMs === undefined) return false;
  if (leadMs <= 0) return hasExpiry ? nowMs > expiry : false;
  if (hasExpiry) return expiry - nowMs <= leadMs;
  if (lastRefresh !== 0) return nowMs - lastRefresh >= leadMs;
  return true;
}

/**
 * When the loop should look at this auth next; `scheduled: false` removes it
 * from the schedule (Go: nextRefreshCheckAt).
 */
export function nextRefreshCheckAt(nowMs: number, auth: Auth | undefined, intervalMs: number, lead: RefreshLeadResolver = defaultRefreshLead): { next: number; scheduled: boolean } {
  const unscheduled = { next: 0, scheduled: false };
  if (!auth) return unscheduled;
  if (hasUnauthorizedAuthFailure(auth) || hasDisabledInvalidGrantFailure(auth)) return unscheduled;
  if (auth.nextRefreshAfter !== 0 && nowMs < auth.nextRefreshAfter) return { next: auth.nextRefreshAfter, scheduled: true };
  if (authKind(auth) === AuthKindAPIKey) return unscheduled;
  const lastRefresh = lastRefreshOf(auth);
  const expiry = expirationTime(auth);
  const hasExpiry = expiry !== undefined && expiry !== 0;
  const pref = authPreferredRefreshIntervalMs(auth);
  if (pref > 0) {
    const candidates: number[] = [];
    if (hasExpiry) {
      if (expiry <= nowMs || expiry - nowMs <= pref) return { next: nowMs, scheduled: true };
      candidates.push(expiry - pref);
    }
    if (lastRefresh === 0) return { next: nowMs, scheduled: true };
    candidates.push(lastRefresh + pref);
    const next = Math.min(...candidates);
    return { next: next <= nowMs ? nowMs : next, scheduled: true };
  }
  const leadMs = lead(auth);
  if (leadMs === undefined) return unscheduled;
  if (hasExpiry) {
    const dueAt = expiry - leadMs;
    return { next: dueAt <= nowMs ? nowMs : dueAt, scheduled: true };
  }
  if (lastRefresh !== 0) {
    const dueAt = lastRefresh + leadMs;
    return { next: dueAt <= nowMs ? nowMs : dueAt, scheduled: true };
  }
  void intervalMs;
  return { next: nowMs, scheduled: true };
}

/** Injectable timer functions so tests can drive the loop without waiting. */
export interface RefreshTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: RefreshTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RefreshLoopHost {
  now(): number;
  /** Ids of every auth the loop should consider. */
  authIds(): string[];
  /** Snapshot of one auth (undefined once removed). */
  auth(id: string): Auth | undefined;
  /** Whether a refresh executor exists for the auth. */
  hasExecutor(auth: Auth): boolean;
  shouldRefresh(auth: Auth, nowMs: number): boolean;
  nextCheckAt(auth: Auth, nowMs: number, intervalMs: number): { next: number; scheduled: boolean };
  /** Runs the refresh; never throws. */
  refresh(id: string): Promise<void>;
}

/**
 * Timer driven schedule of per-auth refresh checks (Go: authAutoRefreshLoop).
 * Entries are kept in a map; the timer wakes at the earliest due time, clamped
 * to MaxRefreshTimerWaitMs.
 */
export class AutoRefreshLoop {
  private readonly schedule = new Map<string, number>();
  private readonly running = new Set<string>();
  private timer: unknown;
  private stopped = false;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly host: RefreshLoopHost,
    readonly intervalMs: number,
    private readonly timers: RefreshTimers = realTimers,
    private readonly concurrency = RefreshMaxConcurrency,
  ) {}

  /** Rebuilds the schedule from every auth the host knows (Go: rebuild). */
  rebuild(nowMs = this.host.now()): void {
    this.schedule.clear();
    for (const id of this.host.authIds()) this.upsertFromAuth(id, nowMs);
  }

  start(): void {
    this.stopped = false;
    this.rebuild();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Re-evaluates one auth's next check time (Go: queueReschedule + applyDirty). */
  reschedule(id: string): void {
    if (this.stopped) return;
    this.upsertFromAuth(id, this.host.now());
    this.arm();
  }

  remove(id: string): void {
    this.schedule.delete(id);
  }

  /** Scheduled auth ids with their next check time (exposed for tests). */
  entries(): ReadonlyMap<string, number> {
    return this.schedule;
  }

  upsert(id: string, nextMs: number): void {
    this.schedule.set(id, nextMs);
  }

  /** Delay until the earliest entry, clamped to the timer cap (Go: nextWait). */
  nextWait(nowMs: number): { wait: number; ok: boolean } {
    const earliest = this.peek();
    if (earliest === undefined) return { wait: 0, ok: false };
    let wait = earliest - nowMs;
    if (wait < 0) wait = 0;
    if (wait > MaxRefreshTimerWaitMs) wait = MaxRefreshTimerWaitMs;
    return { wait, ok: true };
  }

  /** Ids whose check time has passed, removed from the schedule (Go: popDue). */
  popDue(nowMs: number): string[] {
    const due: string[] = [];
    for (const [id, next] of this.schedule) {
      if (next <= nowMs) due.push(id);
    }
    due.sort();
    for (const id of due) this.schedule.delete(id);
    return due;
  }

  /**
   * One scheduler pass: refreshes every due auth and re-arms the timer.
   * Resolves once the refreshes it started have finished (Go: handleDue).
   */
  async tick(nowMs = this.host.now()): Promise<string[]> {
    const due = this.popDue(nowMs);
    const refreshed: string[] = [];
    await Promise.all(
      due.map(async (id) => {
        if (await this.handleDueAuth(id, nowMs)) refreshed.push(id);
      }),
    );
    this.arm();
    return refreshed.sort();
  }

  private peek(): number | undefined {
    let earliest: number | undefined;
    for (const next of this.schedule.values()) {
      if (earliest === undefined || next < earliest) earliest = next;
    }
    return earliest;
  }

  private upsertFromAuth(id: string, nowMs: number): void {
    const auth = this.host.auth(id);
    if (!auth) {
      this.schedule.delete(id);
      return;
    }
    const { next, scheduled } = this.host.nextCheckAt(auth, nowMs, this.intervalMs);
    if (!scheduled) this.schedule.delete(id);
    else this.schedule.set(id, next);
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const { wait, ok } = this.nextWait(this.host.now());
    if (!ok) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, wait);
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }

  private async handleDueAuth(id: string, nowMs: number): Promise<boolean> {
    const auth = this.host.auth(id);
    if (!auth) return false;
    const { next, scheduled } = this.host.nextCheckAt(auth, nowMs, this.intervalMs);
    if (!scheduled) {
      this.schedule.delete(id);
      return false;
    }
    if (!this.host.shouldRefresh(auth, nowMs)) {
      this.schedule.set(id, next);
      return false;
    }
    if (!this.host.hasExecutor(auth)) {
      this.schedule.set(id, nowMs + this.intervalMs);
      return false;
    }
    if (this.running.has(id)) {
      this.schedule.set(id, nowMs + this.intervalMs);
      return false;
    }
    this.running.add(id);
    await this.acquire();
    try {
      await this.host.refresh(id);
    } finally {
      this.release();
      this.running.delete(id);
    }
    // The refresh outcome decides the next check (nextRefreshAfter backoff on failure).
    const after = this.host.auth(id);
    if (!after) {
      this.schedule.delete(id);
      return true;
    }
    const later = this.host.now();
    const rescheduled = this.host.nextCheckAt(after, later, this.intervalMs);
    if (!rescheduled.scheduled) this.schedule.delete(id);
    else this.schedule.set(id, rescheduled.next <= later ? later + this.intervalMs : rescheduled.next);
    return true;
  }
}

// The auth manager: credential registry, selection, failover execution, retry
// rounds, result marking and the refresh loop. Port of sdk/cliproxy/auth/
// conductor.go, conductor_lifecycle.go, conductor_selection.go (legacy pick
// path and retry-round helpers), conductor_execution.go (Execute /
// ExecuteStream / ExecuteCount / executeMixedOnce), conductor_stream.go,
// conductor_cooldown.go (MarkResult, ResetQuota) and conductor_refresh.go.
//
// Dropped from upstream: Home mode, plugin schedulers, session affinity,
// weighted selection, OAuth/API-key model alias pools, request interceptors,
// RequestAuthPreparer, antigravity credits fallback, websocket executors, SIWC,
// Devin quota revalidation, cooldown state stores and registration epochs.
import {
  PinnedAuthMetadataKey,
  RequestedModelMetadataKey,
  SelectedAuthMetadataKey,
  type ExecOptions,
  type ExecRequest,
  type ExecResponse,
  type ProviderExecutor,
  type StreamResult,
} from "../../executor/types.ts";
import { log } from "../../log.ts";
import { getGlobalRegistry, type ClientModelProjection, type ModelRegistry } from "../../registry/index.ts";
import { normalizeCredentialMetadata } from "../../store/record.ts";
import type { TokenStore } from "../../store/types.ts";
import { AttributeRuntimeOnly, StatusActive, StatusDisabled, StatusError, cloneAuth, emptyQuotaState, type Auth, type AuthError } from "../types.ts";
import {
  authAccessToken,
  authHasRefreshCredential,
  canonicalModelKey,
  credentialsChanged,
  disableCoolingOverride,
  hasValidAccessToken,
  isConfigAPIKeyAuth,
  requestRetryOverride,
} from "./classification.ts";
import {
  MinQuotaCooldownFloorMs,
  applyAuthFailureState,
  applyModelFailureState,
  clearAuthStateOnSuccess,
  cooldownConfig,
  cooldownReason,
  hasModelError,
  updateAggregatedAvailability,
} from "./cooldown.ts";
import {
  AuthManagerError,
  ErrorCodeForceCooldown,
  errorStatus,
  isAbortError,
  isCredentialScopedError,
  isInvalidGrantError,
  isInvalidGrantResultError,
  isRequestInvalidError,
  isRequestRetryRoundError,
  isRequestScopedError,
  isTransientRateLimitResultError,
  isUnauthorizedError,
  newAuthNotFoundError,
  resultErrorFromError,
  retryAfterFromError,
  shouldSkipCredentialCooldown,
  statusCodeFromResult,
} from "./errors.ts";
import {
  AutoRefreshLoop,
  RefreshCheckIntervalMs,
  RefreshFailureBackoffMs,
  RefreshIneffectiveBackoffMs,
  defaultRefreshLead,
  invalidGrantBackoffMs,
  nextRefreshCheckAt,
  realTimers,
  shouldRefresh,
  type RefreshLeadResolver,
  type RefreshTimers,
} from "./refresh.ts";
import { RoundRobinSelector, availabilityBlock, isAuthBlockedForModel, type BlockState, type Selector } from "./selector.ts";
import {
  clearCooldownStateForAuth,
  clearUnauthorizedModelStates,
  cloneError,
  ensureModelState,
  existingModelState,
  hasDisabledInvalidGrantFailure,
  hasUnauthorizedAuthFailure,
  isAuthActiveCooldown,
  isModelStateActiveCooldown,
  normalizeModelStates,
  resetModelState,
} from "./state.ts";
import { StreamBootstrapError, readStreamBootstrap, streamErrorResult, unwrapStreamBootstrapError, wrapStreamResult } from "./stream.ts";

/** Execution outcome used to adjust auth state (Go: Result). */
export interface ExecutionResult {
  authId: string;
  provider: string;
  /** Upstream model identifier used for the request (state key after suffix stripping). */
  model: string;
  /** Requested logical model before resolution. */
  routeModel?: string;
  success: boolean;
  /** Provider supplied retry hint in milliseconds. */
  retryAfterMs?: number;
  /** The failure affects the whole credential across models. */
  credentialScope?: boolean;
  error?: AuthError;
  /**
   * Manager-local sequence assigned when the execution was dispatched; a
   * success dispatched before a cooldown was recorded cannot clear it. 0/undefined
   * means unknown and is exempt from the ordering guard.
   */
  executionSeq?: number;
}

export interface AuthManagerOptions {
  store?: TokenStore;
  selector?: Selector;
  /** Clock in epoch milliseconds (defaults to Date.now). */
  now?: () => number;
  /** Model registry used to learn which credentials serve a model (defaults to the global one). */
  registry?: ModelRegistry;
  /** Sleep used between retry rounds (tests inject a no-op). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Timers used by the auto-refresh loop. */
  timers?: RefreshTimers;
  /** Refresh lead per provider; defaults to codex 96h, claude 4h, others on demand. */
  refreshLead?: RefreshLeadResolver;
  /** Random source for cooldown wait jitter (defaults to Math.random). */
  random?: () => number;
  /** Global disable-cooling flag (config.disable-cooling). */
  cooldownDisabled?: boolean;
}

export interface ForceRefreshResult {
  id: string;
  success: boolean;
  error?: string;
}

export interface SelectedAuth {
  auth: Auth;
  executor: ProviderExecutor;
  provider: string;
}

interface RoundState {
  attempted: Set<string>;
  upstreamErr?: unknown;
}

/** Bounds the random jitter added to cooldown waits (Go: cooldownWaitJitterCap). */
export const CooldownWaitJitterCapMs = 2000;

/**
 * Adds up to 25% (capped at 2s) of jitter to a positive wait without exceeding
 * maxWait; maxWait <= 0 is reserved for immediate retries (Go: jitteredCooldownWait).
 */
export function jitteredCooldownWait(waitMs: number, maxWaitMs: number, random: () => number = Math.random): number {
  if (waitMs <= 0) return waitMs;
  let jitterRange = Math.floor(waitMs / 4);
  if (jitterRange > CooldownWaitJitterCapMs) jitterRange = CooldownWaitJitterCapMs;
  if (maxWaitMs > 0 && jitterRange > maxWaitMs - waitMs) jitterRange = maxWaitMs - waitMs;
  if (jitterRange <= 0) return waitMs;
  return waitMs + Math.floor(random() * jitterRange);
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeProviders(providers: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const provider of providers ?? []) {
    const key = (provider ?? "").trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The provider key used to look up the executor for an auth (Go: executorKeyFromAuth). */
export function executorKeyFromAuth(auth: Auth): string {
  return (auth.provider ?? "").trim().toLowerCase();
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function pinnedAuthIDFromMetadata(metadata: Record<string, unknown> | undefined): string {
  return stringMetadata(metadata, PinnedAuthMetadataKey);
}

/** The logical route model used for selection and retry decisions (Go: authSelectionModelFromOptions). */
function authSelectionModelFromOptions(opts: ExecOptions, fallback: string): string {
  const requested = stringMetadata(opts.metadata, RequestedModelMetadataKey);
  return requested !== "" ? requested : (fallback ?? "").trim();
}

function preferredExecutionAttemptError(fallback: unknown, upstream: unknown): unknown {
  if (isAbortError(fallback)) return fallback;
  if (upstream === undefined) return fallback;
  return upstream;
}

export class AuthManager {
  private readonly store?: TokenStore;
  private readonly selector: Selector;
  private readonly registry: ModelRegistry;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timers: RefreshTimers;
  private readonly refreshLead: RefreshLeadResolver;
  private readonly random: () => number;
  private cooldownDisabled: boolean;

  private readonly auths = new Map<string, Auth>();
  private readonly executors = new Map<string, ProviderExecutor>();
  private readonly generations = new Map<string, number>();
  private readonly authCooldownSeq = new Map<string, number>();
  private readonly modelCooldownSeq = new Map<string, Map<string, number>>();
  private readonly refreshInFlight = new Map<string, Promise<Auth>>();
  private readonly pendingPersists = new Set<Promise<void>>();
  private executionSeq = 0;

  private requestRetry = 0;
  private maxRetryCredentials = 0;
  private maxRetryIntervalMs = 0;

  private refreshLoop?: AutoRefreshLoop;

  constructor(options: AuthManagerOptions = {}) {
    this.store = options.store;
    this.selector = options.selector ?? new RoundRobinSelector();
    this.registry = options.registry ?? getGlobalRegistry();
    this.nowFn = options.now ?? (() => Date.now());
    this.sleepFn = options.sleep ?? realSleep;
    this.timers = options.timers ?? realTimers;
    this.refreshLead = options.refreshLead ?? defaultRefreshLead;
    this.random = options.random ?? Math.random;
    this.cooldownDisabled = options.cooldownDisabled ?? false;
  }

  now(): number {
    return this.nowFn();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Request retry rounds, the longest cooldown wait between rounds and the per-round credential budget (Go: SetRetryConfig). */
  setRetryConfig(requestRetry: number, maxRetryIntervalMs: number, maxRetryCredentials: number): void {
    this.requestRetry = Math.max(0, Math.trunc(requestRetry || 0));
    this.maxRetryIntervalMs = Math.max(0, Math.trunc(maxRetryIntervalMs || 0));
    this.maxRetryCredentials = Math.max(0, Math.trunc(maxRetryCredentials || 0));
  }

  retrySettings(): { requestRetry: number; maxRetryIntervalMs: number; maxRetryCredentials: number } {
    return { requestRetry: this.requestRetry, maxRetryIntervalMs: this.maxRetryIntervalMs, maxRetryCredentials: this.maxRetryCredentials };
  }

  /** Global disable-cooling switch for this manager (config.disable-cooling). */
  setCooldownDisabled(disabled: boolean): void {
    this.cooldownDisabled = disabled;
  }

  /** Credential override > manager/global config (Go: quotaCooldownDisabledForAuthWithConfig). */
  cooldownDisabledForAuth(auth: Auth | undefined): boolean {
    const [override, present] = disableCoolingOverride(auth);
    if (present) return override;
    if (this.cooldownDisabled) return true;
    return cooldownConfig().quotaCooldownDisabled;
  }

  // -------------------------------------------------------------------------
  // Executors
  // -------------------------------------------------------------------------

  registerExecutor(executor: ProviderExecutor): void {
    const provider = (executor?.identifier ?? "").trim().toLowerCase();
    if (provider === "") return;
    this.executors.set(provider, executor);
    for (const auth of this.auths.values()) {
      if (executorKeyFromAuth(auth) === provider) this.refreshLoop?.reschedule(auth.id);
    }
  }

  unregisterExecutor(provider: string): void {
    this.executors.delete((provider ?? "").trim().toLowerCase());
  }

  executor(provider: string): ProviderExecutor | undefined {
    const key = (provider ?? "").trim();
    if (key === "") return undefined;
    return this.executors.get(key) ?? this.executors.get(key.toLowerCase());
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /** Inserts (or replaces) an auth entry; the caller registers its models in the model registry (Go: Register). */
  register(input: Auth): Auth {
    const auth = cloneAuth(input);
    if (!auth.attributes) auth.attributes = {};
    if (!auth.metadata) auth.metadata = {};
    if (!auth.quota) auth.quota = emptyQuotaState();
    normalizeCredentialMetadata(auth.metadata);
    const now = this.now();
    if (!auth.status) auth.status = auth.disabled ? StatusDisabled : StatusActive;
    if (auth.createdAt === 0 || auth.createdAt === undefined) auth.createdAt = now;
    auth.updatedAt = now;
    if (auth.lastRefreshedAt === undefined) auth.lastRefreshedAt = 0;
    if (auth.nextRefreshAfter === undefined) auth.nextRefreshAfter = 0;
    if (auth.nextRetryAfter === undefined) auth.nextRetryAfter = 0;
    normalizeModelStates(auth);
    if (this.cooldownDisabledForAuth(auth) || auth.disabled || auth.status === StatusDisabled) clearCooldownStateForAuth(auth, now);
    this.auths.set(auth.id, auth);
    this.authCooldownSeq.delete(auth.id);
    this.modelCooldownSeq.delete(auth.id);
    this.persist(auth);
    this.syncRegistryProjections(auth);
    this.refreshLoop?.reschedule(auth.id);
    return cloneAuth(auth);
  }

  /**
   * Replaces an existing entry with a new snapshot (login, token store reload).
   * Runtime health (cooldowns, model states, refresh schedule) carries over
   * unless the credentials changed, in which case auth/grant failures are
   * released; a live credential-wide quota is always kept. Missing ids are a
   * no-op returning undefined (Go: Update, replace mode).
   */
  update(input: Auth): Auth | undefined {
    const existing = this.auths.get(input?.id ?? "");
    if (!existing) return undefined;
    const auth = cloneAuth(input);
    if (!auth.attributes) auth.attributes = {};
    if (!auth.metadata) auth.metadata = {};
    if (!auth.quota) auth.quota = emptyQuotaState();
    normalizeCredentialMetadata(auth.metadata);
    const now = this.now();
    if (!auth.status) auth.status = auth.disabled ? StatusDisabled : StatusActive;
    if (auth.createdAt === 0 || auth.createdAt === undefined) auth.createdAt = existing.createdAt;
    const credChanged = credentialsChanged(existing, auth);
    const bothEnabled = !existing.disabled && existing.status !== StatusDisabled && !auth.disabled && auth.status !== StatusDisabled;
    if (bothEnabled) {
      if ((!auth.modelStates || Object.keys(auth.modelStates).length === 0) && existing.modelStates && Object.keys(existing.modelStates).length > 0) {
        auth.modelStates = structuredClone(existing.modelStates);
      }
      if ((auth.status === StatusActive || !auth.status) && existing.status) auth.status = existing.status;
      if (!auth.statusMessage) auth.statusMessage = existing.statusMessage;
      auth.unavailable = existing.unavailable;
      auth.nextRetryAfter = existing.nextRetryAfter;
      if (!auth.lastError && existing.lastError) auth.lastError = cloneError(existing.lastError);
      auth.quota = { ...existing.quota };
      if (!auth.lastRefreshedAt) auth.lastRefreshedAt = existing.lastRefreshedAt;
      if (!credChanged) {
        if (!auth.nextRefreshAfter) auth.nextRefreshAfter = existing.nextRefreshAfter;
        if (auth.refreshFailures === undefined) auth.refreshFailures = existing.refreshFailures;
      } else {
        auth.refreshFailures = 0;
        if (auth.nextRefreshAfter === existing.nextRefreshAfter) auth.nextRefreshAfter = 0;
        const lastErr = auth.lastError;
        const isAuthOrGrantFailure =
          hasUnauthorizedAuthFailure(existing) || (!!lastErr && ((lastErr.httpStatus ?? 0) === 401 || (lastErr.code ?? "").toLowerCase() === "unauthorized" || isInvalidGrantResultError(lastErr)));
        if (!(auth.quota.nextRecoverAt > now) && (isAuthOrGrantFailure || (auth.unavailable && !(auth.nextRetryAfter > now)))) {
          auth.unavailable = false;
          auth.nextRetryAfter = 0;
          auth.lastError = undefined;
          auth.statusMessage = undefined;
          auth.status = StatusActive;
          this.authCooldownSeq.delete(auth.id);
        } else if (isAuthOrGrantFailure && auth.quota.exceeded && auth.quota.nextRecoverAt > now) {
          auth.lastError = undefined;
          auth.statusMessage = auth.quota.reason;
        }
        if (clearUnauthorizedModelStates(auth, now).length > 0) updateAggregatedAvailability(auth, now);
      }
      if (existing.quota.exceeded && existing.quota.reason === "credential_quota" && existing.quota.nextRecoverAt > now) {
        auth.unavailable = existing.unavailable;
        auth.nextRetryAfter = existing.nextRetryAfter;
        auth.quota = { ...existing.quota };
        if (auth.status === StatusActive) auth.status = existing.status;
      }
    }
    auth.updatedAt = now;
    normalizeModelStates(auth);
    if (this.cooldownDisabledForAuth(auth) || auth.disabled || auth.status === StatusDisabled) clearCooldownStateForAuth(auth, now);
    this.auths.set(auth.id, auth);
    this.persist(auth);
    this.syncRegistryProjections(auth);
    this.refreshLoop?.reschedule(auth.id);
    return cloneAuth(auth);
  }

  /** Deletes the runtime entry; the token store record is the caller's business (Go: Remove). */
  remove(id: string): void {
    const key = (id ?? "").trim();
    if (key === "" || !this.auths.has(key)) return;
    this.auths.delete(key);
    this.generations.delete(key);
    this.authCooldownSeq.delete(key);
    this.modelCooldownSeq.delete(key);
    this.refreshLoop?.remove(key);
  }

  list(): Auth[] {
    return Array.from(this.auths.values()).map((auth) => cloneAuth(auth));
  }

  getById(id: string): Auth | undefined {
    const auth = this.auths.get((id ?? "").trim());
    return auth ? cloneAuth(auth) : undefined;
  }

  /** Replaces the runtime state from the token store (Go: Load). */
  async load(): Promise<void> {
    if (!this.store) return;
    const items = await this.store.list();
    this.auths.clear();
    for (const item of items) {
      if (!item || !item.id) continue;
      const auth = cloneAuth(item);
      if (!auth.attributes) auth.attributes = {};
      if (!auth.metadata) auth.metadata = {};
      if (!auth.quota) auth.quota = emptyQuotaState();
      normalizeCredentialMetadata(auth.metadata);
      if (!auth.status) auth.status = auth.disabled ? StatusDisabled : StatusActive;
      normalizeModelStates(auth);
      this.auths.set(auth.id, auth);
    }
    this.refreshLoop?.rebuild();
  }

  /** Provider keys with at least one enabled auth, sorted (Go: AvailableProviders). */
  availableProviders(): string[] {
    const seen = new Set<string>();
    for (const auth of this.auths.values()) {
      if (auth.disabled || auth.status === StatusDisabled) continue;
      const key = executorKeyFromAuth(auth);
      if (key !== "") seen.add(key);
    }
    return Array.from(seen).sort();
  }

  hasProviderAuth(provider: string): boolean {
    const key = (provider ?? "").trim().toLowerCase();
    if (key === "") return false;
    for (const auth of this.auths.values()) {
      if (auth.disabled || auth.status === StatusDisabled) continue;
      if (executorKeyFromAuth(auth) === key) return true;
    }
    return false;
  }

  /** Waits for every fire-and-forget token store write issued so far. */
  async flushPersistence(): Promise<void> {
    await Promise.all(Array.from(this.pendingPersists));
  }

  private persist(auth: Auth): void {
    if (!this.store) return;
    if (isConfigAPIKeyAuth(auth)) return;
    if ((auth.attributes?.[AttributeRuntimeOnly] ?? "").trim().toLowerCase() === "true") return;
    const snapshot = cloneAuth(auth);
    const pending = this.store
      .save(snapshot)
      .then(() => undefined)
      .catch((err: unknown) => {
        log.warn(`failed to persist auth ${auth.provider} (${auth.id}):`, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.pendingPersists.delete(pending);
      });
    this.pendingPersists.add(pending);
  }

  // -------------------------------------------------------------------------
  // Model registry projections (Go: clientModelProjectionForAuth + ApplyClientModelProjections)
  // -------------------------------------------------------------------------

  private clientModelProjection(auth: Auth, modelId: string, nowMs: number): ClientModelProjection {
    const block: BlockState = isAuthBlockedForModel(auth, modelId, nowMs);
    const state = existingModelState(auth, modelId);
    let reason = "";
    if (block.blocked) {
      reason = state ? cooldownReason(state.statusMessage, state.quota, state.lastError) : "";
      if (reason === "") reason = cooldownReason(auth.statusMessage, auth.quota, auth.lastError);
      if (reason === "") reason = block.reason === "disabled" ? "disabled" : "cooldown";
    }
    const quotaLive = (quota: { exceeded: boolean; nextRecoverAt: number }) => quota.exceeded && (quota.nextRecoverAt === 0 || quota.nextRecoverAt > nowMs);
    const quotaExceeded = (!!state && quotaLive(state.quota)) || (auth.quota.reason === "credential_quota" && quotaLive(auth.quota));
    const projection: ClientModelProjection = { modelId, suspended: block.blocked, quotaExceeded: block.blocked && quotaExceeded };
    if (block.blocked) projection.suspendReason = reason;
    return projection;
  }

  private syncRegistryProjections(auth: Auth): void {
    const { models, epoch } = this.registry.getModelsAndEpochForClient(auth.id);
    if (models.length === 0) return;
    const now = this.now();
    const projections = models.filter((m) => m.id.trim() !== "").map((m) => this.clientModelProjection(auth, m.id, now));
    const generation = (this.generations.get(auth.id) ?? 0) + 1;
    this.generations.set(auth.id, generation);
    this.registry.applyClientModelProjections(auth.id, epoch, generation, projections);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  private authSupportsRouteModel(auth: Auth, routeModel: string): boolean {
    const key = canonicalModelKey(routeModel);
    if (key === "") return true;
    return this.registry.clientSupportsModel(auth.id, key);
  }

  /**
   * Picks the next untried credential for the model across the providers
   * (Go: pickNextMixedLegacy). Throws auth_not_found / auth_unavailable /
   * ModelCooldownError when nothing is selectable.
   */
  selectAuth(providers: string[], model: string, opts: ExecOptions = { stream: false, sourceFormat: "" as never }, tried: Set<string> = new Set()): SelectedAuth {
    const providerSet = new Set(normalizeProviders(providers));
    if (providerSet.size === 0) throw new AuthManagerError("provider_not_found", "no provider supplied");
    const pinned = pinnedAuthIDFromMetadata(opts.metadata);
    const modelKey = canonicalModelKey(model);
    const candidates: Auth[] = [];
    for (const candidate of this.auths.values()) {
      if (candidate.disabled) continue;
      if (pinned !== "" && candidate.id !== pinned) continue;
      const providerKey = executorKeyFromAuth(candidate);
      if (providerKey === "" || !providerSet.has(providerKey)) continue;
      if (!this.executors.has(providerKey)) continue;
      if (modelKey !== "" && !this.authSupportsRouteModel(candidate, model)) continue;
      if (tried.has(candidate.id)) continue;
      candidates.push(candidate);
    }
    if (candidates.length === 0) throw newAuthNotFoundError();
    const selected = this.selector.pick("mixed", model, opts, candidates, this.now());
    const providerKey = executorKeyFromAuth(selected);
    const executor = this.executors.get(providerKey);
    if (!executor) throw new AuthManagerError("executor_not_found", "executor not registered");
    return { auth: cloneAuth(selected), executor, provider: providerKey };
  }

  // -------------------------------------------------------------------------
  // Retry rounds (Go: conductor_selection.go)
  // -------------------------------------------------------------------------

  private effectiveRequestRetryLimit(auth: Auth, defaultRetry: number): number {
    const [override, ok] = requestRetryOverride(auth);
    return ok ? override : Math.max(0, defaultRetry);
  }

  /** Auths whose retry window is narrower than this round (Go: requestRetryRoundExclusions). */
  private requestRetryRoundExclusions(retryRound: number, defaultRequestRetry: number): Set<string> {
    const excluded = new Set<string>();
    if (retryRound <= 0) return excluded;
    for (const auth of this.auths.values()) {
      if (this.effectiveRequestRetryLimit(auth, defaultRequestRetry) < retryRound) excluded.add(auth.id);
    }
    return excluded;
  }

  private credentialRetryRoundStateEligible(lastErr: AuthError | undefined, quotaExceeded: boolean): boolean {
    if (!lastErr) return quotaExceeded;
    return isRequestRetryRoundError(new AuthManagerError(lastErr.code ?? "", lastErr.message, { httpStatus: lastErr.httpStatus })) && (lastErr.httpStatus ?? 0) !== 0;
  }

  /** Whether an auth may join a later retry round and when it recovers (Go: retryRoundAvailabilityForAuth). */
  private retryRoundAvailabilityForAuth(auth: Auth, model: string, nowMs: number): { eligible: boolean; next: number } {
    const block = isAuthBlockedForModel(auth, model, nowMs);
    if (!block.blocked) return { eligible: true, next: 0 };
    if (block.next === 0 || block.reason === "disabled") return { eligible: false, next: 0 };
    if (auth.quota.exceeded && auth.quota.reason === "credential_quota" && auth.quota.nextRecoverAt > nowMs) {
      return { eligible: this.credentialRetryRoundStateEligible(auth.lastError, true), next: block.next };
    }
    const modelKey = canonicalModelKey(model);
    if (modelKey !== "" && auth.modelStates) {
      let matchedBlocked = false;
      for (const [stateModel, state] of Object.entries(auth.modelStates)) {
        if (!state || canonicalModelKey(stateModel) !== modelKey) continue;
        if (state.status === StatusDisabled) return { eligible: false, next: 0 };
        const stateBlock = availabilityBlock(state.unavailable, state.quota.exceeded, state.nextRetryAfter, state.quota.nextRecoverAt, nowMs);
        if (!stateBlock.blocked) continue;
        matchedBlocked = true;
        if (stateBlock.next === 0 || !this.credentialRetryRoundStateEligible(state.lastError, state.quota.exceeded)) return { eligible: false, next: 0 };
      }
      if (matchedBlocked) return { eligible: true, next: block.next };
    }
    if (!this.credentialRetryRoundStateEligible(auth.lastError, auth.quota.exceeded)) return { eligible: false, next: 0 };
    return { eligible: true, next: block.next };
  }

  private hasLiveQuotaCooldown(auth: Auth, model: string, nowMs: number): boolean {
    const quotaLive = (quota: { exceeded: boolean; nextRecoverAt: number }) => quota.exceeded && (quota.nextRecoverAt === 0 || quota.nextRecoverAt > nowMs);
    if (auth.quota.reason === "credential_quota" && quotaLive(auth.quota)) return true;
    const modelKey = canonicalModelKey(model);
    if (modelKey === "") return quotaLive(auth.quota);
    for (const [stateModel, state] of Object.entries(auth.modelStates ?? {})) {
      if (state && canonicalModelKey(stateModel) === modelKey && quotaLive(state.quota)) return true;
    }
    return false;
  }

  private hasTransientZeroWaitEligibility(auth: Auth, model: string): boolean {
    const modelKey = canonicalModelKey(model);
    const state = modelKey !== "" ? auth.modelStates?.[modelKey] : undefined;
    if (state) return isTransientRateLimitResultError(state.lastError);
    return isTransientRateLimitResultError(auth.lastError);
  }

  private retryCandidates(providers: string[], model: string, pinned: string): Auth[] {
    const providerSet = new Set(normalizeProviders(providers));
    const out: Auth[] = [];
    for (const auth of this.auths.values()) {
      if (auth.disabled || auth.status === StatusDisabled) continue;
      if (pinned !== "" && auth.id !== pinned) continue;
      if (!providerSet.has(executorKeyFromAuth(auth))) continue;
      if (model !== "" && !this.authSupportsRouteModel(auth, model)) continue;
      out.push(auth);
    }
    return out;
  }

  /**
   * The shortest wait until an eligible credential can serve the next retry
   * round (Go: closestCooldownWaitWithAttempted). A credential already attempted
   * in a round that failed with 429 never yields an immediate retry.
   */
  closestCooldownWait(providers: string[], model: string, attempt: number, defaultRequestRetry: number, status: number, attempted: Set<string> | undefined, pinned = ""): { wait: number; found: boolean } {
    const now = this.now();
    let found = false;
    let minWait = 0;
    for (const auth of this.retryCandidates(providers, model, pinned)) {
      if (attempt >= this.effectiveRequestRetryLimit(auth, defaultRequestRetry)) continue;
      const { eligible, next } = this.retryRoundAvailabilityForAuth(auth, model, now);
      if (!eligible) continue;
      const wasAttempted = attempted?.has(auth.id) ?? false;
      const coolingDisabled = this.cooldownDisabledForAuth(auth);
      const transientZeroWait = !this.hasLiveQuotaCooldown(auth, model, now) && this.hasTransientZeroWaitEligibility(auth, model);
      if (!wasAttempted || coolingDisabled || status !== 429 || transientZeroWait) {
        if (next === 0) return { wait: 0, found: true };
        const wait = next - now;
        if (wait < 0) continue;
        if (!found || wait < minWait) {
          minWait = wait;
          found = true;
        }
        continue;
      }
      let wait = next === 0 ? MinQuotaCooldownFloorMs : Math.max(next - now, MinQuotaCooldownFloorMs);
      if (!found || wait < minWait) {
        minWait = wait;
        found = true;
      }
    }
    return { wait: minWait, found };
  }

  private retryAllowed(attempt: number, providers: string[], model: string, defaultRequestRetry: number, pinned: string): boolean {
    if (attempt < 0 || providers.length === 0) return false;
    const now = this.now();
    for (const auth of this.retryCandidates(providers, model, pinned)) {
      if (attempt >= this.effectiveRequestRetryLimit(auth, defaultRequestRetry)) continue;
      if (this.retryRoundAvailabilityForAuth(auth, model, now).eligible) return true;
    }
    return false;
  }

  /**
   * Whether another retry round may start after `err`, and how long to wait
   * first (Go: shouldRetryAfterErrorWithAttempted). maxWait <= 0 permits only
   * immediate retries.
   */
  shouldRetryAfterError(err: unknown, attempt: number, providers: string[], model: string, maxWaitMs: number, defaultRequestRetry: number, attempted?: Set<string>, opts?: ExecOptions): { wait: number; retry: boolean } {
    const no = { wait: 0, retry: false };
    if (err === undefined || err === null) return no;
    const status = errorStatus(err);
    if (status === 200) return no;
    if (isRequestInvalidError(err) || isAbortError(err)) return no;
    const pinned = pinnedAuthIDFromMetadata(opts?.metadata);
    if (!isRequestRetryRoundError(err) || !this.retryAllowed(attempt, providers, model, defaultRequestRetry, pinned)) return no;
    const { wait, found } = this.closestCooldownWait(providers, model, attempt, defaultRequestRetry, status, attempted, pinned);
    if (found) {
      if (wait > 0 && (maxWaitMs <= 0 || wait > maxWaitMs)) return no;
      return { wait, retry: true };
    }
    const retryAfter = retryAfterFromError(err);
    if (retryAfter !== undefined) {
      if (retryAfter < 0 || (retryAfter > 0 && (maxWaitMs <= 0 || retryAfter > maxWaitMs))) return no;
      return { wait: retryAfter, retry: true };
    }
    return { wait: 0, retry: true };
  }

  private async waitForCooldown(waitMs: number, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    if (waitMs <= 0) return;
    await this.sleepFn(jitteredCooldownWait(waitMs, maxWaitMs, this.random), signal);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private nextExecutionSeq(): number {
    this.executionSeq += 1;
    return this.executionSeq;
  }

  private prepareOptions(opts: ExecOptions, routeModel: string): void {
    if (!opts.metadata) opts.metadata = {};
    if (stringMetadata(opts.metadata, RequestedModelMetadataKey) === "" && routeModel !== "") opts.metadata[RequestedModelMetadataKey] = routeModel;
  }

  private async runRounds<T>(providers: string[], req: ExecRequest, opts: ExecOptions, once: (round: RoundState, attempt: number, snapshot: { requestRetry: number; maxRetryCredentials: number }) => Promise<T>): Promise<T> {
    const normalized = normalizeProviders(providers);
    if (normalized.length === 0) throw new AuthManagerError("provider_not_found", "no provider supplied");
    const snapshot = this.retrySettings();
    const retryModel = authSelectionModelFromOptions(opts, req.model);
    let lastErr: unknown;
    let preferredUpstream: unknown;
    for (let attempt = 0; ; attempt++) {
      const round: RoundState = { attempted: new Set() };
      try {
        return await once(round, attempt, snapshot);
      } catch (err) {
        if (isAbortError(err) || opts.signal?.aborted) throw err;
        if (round.upstreamErr !== undefined) preferredUpstream = round.upstreamErr;
        lastErr = err;
        const { wait, retry } = this.shouldRetryAfterError(err, attempt, normalized, retryModel, snapshot.maxRetryIntervalMs, snapshot.requestRetry, round.attempted, opts);
        if (!retry) break;
        await this.waitForCooldown(wait, snapshot.maxRetryIntervalMs, opts.signal);
      }
    }
    throw preferredExecutionAttemptError(lastErr, preferredUpstream);
  }

  /** Non-streaming execution with failover and retry rounds (Go: Execute). */
  execute(providers: string[], req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    return this.runRounds(providers, req, opts, (round, attempt, snapshot) =>
      this.executeOnce(normalizeProviders(providers), req, opts, snapshot.maxRetryCredentials, attempt, snapshot.requestRetry, round, (executor, auth) => executor.execute(auth, req, opts)),
    );
  }

  /** Token counting with the same selection and failover rules (Go: ExecuteCount). */
  executeCount(providers: string[], req: ExecRequest, opts: ExecOptions): Promise<ExecResponse> {
    return this.runRounds(providers, req, opts, (round, attempt, snapshot) =>
      this.executeOnce(normalizeProviders(providers), req, opts, snapshot.maxRetryCredentials, attempt, snapshot.requestRetry, round, (executor, auth) => executor.countTokens(auth, req, opts)),
    );
  }

  /**
   * Streaming execution. Resolves once the selected credential produced its
   * first payload chunk; earlier failures fail over to the next credential,
   * later ones surface through the returned iterator (Go: ExecuteStream).
   */
  async executeStream(providers: string[], req: ExecRequest, opts: ExecOptions): Promise<StreamResult> {
    try {
      return await this.runRounds(providers, req, opts, (round, attempt, snapshot) =>
        this.executeStreamOnce(normalizeProviders(providers), req, opts, snapshot.maxRetryCredentials, attempt, snapshot.requestRetry, round),
      );
    } catch (err) {
      if (err instanceof StreamBootstrapError) return streamErrorResult(err.headers, err.bootstrapCause);
      throw err;
    }
  }

  private async executeOnce(
    providers: string[],
    req: ExecRequest,
    opts: ExecOptions,
    maxRetryCredentials: number,
    retryRound: number,
    defaultRequestRetry: number,
    round: RoundState,
    invoke: (executor: ProviderExecutor, auth: Auth) => Promise<ExecResponse>,
  ): Promise<ExecResponse> {
    const routeModel = authSelectionModelFromOptions(opts, req.model);
    this.prepareOptions(opts, routeModel);
    const tried = this.requestRetryRoundExclusions(retryRound, defaultRequestRetry);
    let lastErr: unknown;
    for (;;) {
      if (maxRetryCredentials > 0 && round.attempted.size >= maxRetryCredentials) {
        if (lastErr !== undefined) throw preferredExecutionAttemptError(lastErr, round.upstreamErr);
        throw newAuthNotFoundError();
      }
      let picked: SelectedAuth;
      try {
        picked = this.selectAuth(providers, routeModel, opts, tried);
      } catch (errPick) {
        if (lastErr !== undefined) throw preferredExecutionAttemptError(lastErr, round.upstreamErr);
        throw errPick;
      }
      let { auth } = picked;
      const { executor, provider } = picked;
      opts.metadata![SelectedAuthMetadataKey] = auth.id;
      tried.add(auth.id);
      round.attempted.add(auth.id);
      const resultModel = canonicalModelKey(routeModel);
      let executionSeq = this.nextExecutionSeq();
      let errExec: unknown;
      let resp: ExecResponse | undefined;
      try {
        resp = await invoke(executor, auth);
      } catch (err) {
        errExec = err;
      }
      if (errExec !== undefined) {
        round.upstreamErr = errExec;
        if (isAbortError(errExec) || opts.signal?.aborted) throw errExec;
        const refreshed = await this.tryRefreshAfterUnauthorized(auth, errExec, false);
        if (refreshed) {
          auth = refreshed;
          opts.metadata![SelectedAuthMetadataKey] = auth.id;
          executionSeq = this.nextExecutionSeq();
          errExec = undefined;
          try {
            resp = await invoke(executor, auth);
          } catch (err) {
            errExec = err;
            round.upstreamErr = err;
            if (isAbortError(err) || opts.signal?.aborted) throw err;
          }
        }
      }
      if (errExec === undefined) {
        this.markResult({ authId: auth.id, provider, model: resultModel, routeModel, success: true, executionSeq });
        return resp!;
      }
      this.markResult({
        authId: auth.id,
        provider,
        model: resultModel,
        routeModel,
        success: false,
        error: resultErrorFromError(errExec),
        retryAfterMs: retryAfterFromError(errExec),
        credentialScope: isCredentialScopedError(errExec),
        executionSeq,
      });
      if (isRequestInvalidError(errExec)) throw errExec;
      lastErr = errExec;
    }
  }

  private async startStream(executor: ProviderExecutor, auth: Auth, req: ExecRequest, opts: ExecOptions) {
    const result = await executor.executeStream(auth, req, opts);
    return readStreamBootstrap(result);
  }

  private async executeStreamOnce(providers: string[], req: ExecRequest, opts: ExecOptions, maxRetryCredentials: number, retryRound: number, defaultRequestRetry: number, round: RoundState): Promise<StreamResult> {
    const routeModel = authSelectionModelFromOptions(opts, req.model);
    this.prepareOptions(opts, routeModel);
    const tried = this.requestRetryRoundExclusions(retryRound, defaultRequestRetry);
    let lastErr: unknown;
    for (;;) {
      if (maxRetryCredentials > 0 && round.attempted.size >= maxRetryCredentials) {
        if (lastErr !== undefined) throw preferredExecutionAttemptError(lastErr, round.upstreamErr);
        throw newAuthNotFoundError();
      }
      let picked: SelectedAuth;
      try {
        picked = this.selectAuth(providers, routeModel, opts, tried);
      } catch (errPick) {
        if (lastErr !== undefined) throw preferredExecutionAttemptError(lastErr, round.upstreamErr);
        throw errPick;
      }
      let { auth } = picked;
      const { executor, provider } = picked;
      opts.metadata![SelectedAuthMetadataKey] = auth.id;
      tried.add(auth.id);
      round.attempted.add(auth.id);
      const resultModel = canonicalModelKey(routeModel);
      let executionSeq = this.nextExecutionSeq();
      let errStream: unknown;
      let started: Awaited<ReturnType<typeof readStreamBootstrap>> | undefined;
      try {
        started = await this.startStream(executor, auth, req, opts);
      } catch (err) {
        errStream = err;
      }
      if (errStream !== undefined) {
        round.upstreamErr = errStream;
        const cause = unwrapStreamBootstrapError(errStream);
        if (isAbortError(cause) || opts.signal?.aborted) throw cause;
        const refreshed = await this.tryRefreshAfterUnauthorized(auth, cause, false);
        if (refreshed) {
          auth = refreshed;
          opts.metadata![SelectedAuthMetadataKey] = auth.id;
          executionSeq = this.nextExecutionSeq();
          errStream = undefined;
          try {
            started = await this.startStream(executor, auth, req, opts);
          } catch (err) {
            errStream = err;
            round.upstreamErr = err;
            if (isAbortError(unwrapStreamBootstrapError(err)) || opts.signal?.aborted) throw unwrapStreamBootstrapError(err);
          }
        }
      }
      if (errStream !== undefined) {
        const cause = unwrapStreamBootstrapError(errStream);
        this.markResult({
          authId: auth.id,
          provider,
          model: resultModel,
          routeModel,
          success: false,
          error: resultErrorFromError(cause),
          retryAfterMs: retryAfterFromError(cause),
          credentialScope: isCredentialScopedError(cause),
          executionSeq,
        });
        if (isRequestInvalidError(cause)) throw cause;
        lastErr = errStream;
        continue;
      }
      const committedAuth = auth;
      const committedSeq = executionSeq;
      return wrapStreamResult(started!, (err) => {
        if (err === undefined) {
          this.markResult({ authId: committedAuth.id, provider, model: resultModel, routeModel, success: true, executionSeq: committedSeq });
          return;
        }
        this.markResult({
          authId: committedAuth.id,
          provider,
          model: resultModel,
          routeModel,
          success: false,
          error: resultErrorFromError(err),
          retryAfterMs: retryAfterFromError(err),
          credentialScope: isCredentialScopedError(err),
          executionSeq: committedSeq,
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Result marking (Go: MarkResult)
  // -------------------------------------------------------------------------

  private modelSeq(authId: string, modelKey: string): number {
    return this.modelCooldownSeq.get(authId)?.get(modelKey) ?? 0;
  }

  private setModelSeq(authId: string, modelKey: string, seq: number): void {
    let perModel = this.modelCooldownSeq.get(authId);
    if (!perModel) {
      perModel = new Map();
      this.modelCooldownSeq.set(authId, perModel);
    }
    perModel.set(modelKey, seq);
  }

  /** Records an execution outcome and updates cooldown state (Go: MarkResult). */
  markResult(result: ExecutionResult): void {
    if (!result || !result.authId) return;
    const auth = this.auths.get(result.authId);
    if (!auth) return;
    const now = this.now();
    let modelKey = canonicalModelKey(result.model ?? "");
    if (modelKey === "" && result.routeModel) modelKey = canonicalModelKey(result.routeModel);
    const resultErr = result.error;
    const executionSeq = result.executionSeq ?? 0;
    const rejectsToken =
      !result.success &&
      resultErr?.code !== ErrorCodeForceCooldown &&
      !shouldSkipCredentialCooldown(resultErr) &&
      (statusCodeFromResult(resultErr) === 401 || (resultErr?.code ?? "").toLowerCase() === "unauthorized");
    const wasTerminalUnauthorized = hasUnauthorizedAuthFailure(auth);
    let scheduleUnauthorizedRefresh = false;

    let retainModelCooldown = false;
    if (modelKey !== "" && !wasTerminalUnauthorized && executionSeq > 0) {
      const existing = existingModelState(auth, modelKey);
      const recorded = this.modelSeq(auth.id, modelKey);
      retainModelCooldown = !!existing && isModelStateActiveCooldown(existing, now) && recorded > 0 && executionSeq <= recorded;
    }
    const authRecorded = this.authCooldownSeq.get(auth.id) ?? 0;
    const retainAuthCooldown = modelKey === "" && !wasTerminalUnauthorized && executionSeq > 0 && isAuthActiveCooldown(auth, now) && authRecorded > 0 && executionSeq <= authRecorded;

    if (result.success) {
      if (wasTerminalUnauthorized) {
        if (modelKey !== "") {
          const state = ensureModelState(auth, modelKey);
          if (state) resetModelState(state, now);
        }
      } else if (auth.quota.exceeded && auth.quota.reason === "credential_quota" && auth.quota.nextRecoverAt > now) {
        // Retain the active credential-scoped cooldown.
      } else if (retainModelCooldown || retainAuthCooldown) {
        // Retain a cooldown recorded after this execution was dispatched.
      } else if (modelKey !== "") {
        const state = ensureModelState(auth, modelKey);
        if (state) resetModelState(state, now);
        this.setModelSeq(auth.id, modelKey, 0);
        updateAggregatedAvailability(auth, now);
        if (!hasModelError(auth, now)) {
          auth.lastError = undefined;
          auth.statusMessage = undefined;
          auth.status = StatusActive;
        }
      } else {
        clearAuthStateOnSuccess(auth, now);
        this.authCooldownSeq.delete(auth.id);
      }
    } else if (modelKey !== "") {
      if (!shouldSkipCredentialCooldown(resultErr)) {
        let disableCooling = this.cooldownDisabledForAuth(auth);
        if (resultErr?.code === ErrorCodeForceCooldown) disableCooling = false;
        const state = ensureModelState(auth, modelKey)!;
        applyModelFailureState(auth, state, { error: resultErr, retryAfterMs: result.retryAfterMs, credentialScope: !!result.credentialScope }, now, disableCooling, wasTerminalUnauthorized);
        const cooldownSeq = this.executionSeq;
        this.setModelSeq(auth.id, modelKey, cooldownSeq);
        if (result.credentialScope && !disableCooling && statusCodeFromResult(resultErr) === 429) {
          this.authCooldownSeq.set(auth.id, cooldownSeq);
          for (const otherModel of Object.keys(auth.modelStates ?? {})) this.setModelSeq(auth.id, otherModel, cooldownSeq);
        }
        auth.status = StatusError;
        updateAggregatedAvailability(auth, now);
      }
    } else {
      let disableCooling = this.cooldownDisabledForAuth(auth);
      if (resultErr?.code === ErrorCodeForceCooldown) disableCooling = false;
      if (!wasTerminalUnauthorized) {
        applyAuthFailureState(auth, resultErr, result.retryAfterMs, now, disableCooling);
        this.authCooldownSeq.set(auth.id, this.executionSeq);
      }
    }

    if (wasTerminalUnauthorized) {
      auth.unavailable = true;
      auth.status = StatusError;
      auth.nextRefreshAfter = 0;
      auth.nextRetryAfter = 0;
    } else if (rejectsToken && authHasRefreshCredential(auth)) {
      if (auth.nextRefreshAfter === 0) {
        auth.nextRefreshAfter = auth.lastRefreshedAt !== 0 && now - auth.lastRefreshedAt < RefreshFailureBackoffMs ? now + RefreshFailureBackoffMs : now;
      }
      scheduleUnauthorizedRefresh = true;
    }
    auth.updatedAt = now;
    this.persist(auth);
    this.syncRegistryProjections(auth);
    if (scheduleUnauthorizedRefresh) this.refreshLoop?.reschedule(auth.id);
  }

  /** Clears every cooldown of the credential and resumes its registry models (Go: ResetQuota). */
  resetQuota(id: string): { auth: Auth; models: string[] } | undefined {
    const auth = this.auths.get((id ?? "").trim());
    if (!auth) return undefined;
    const now = this.now();
    auth.unavailable = false;
    auth.status = StatusActive;
    auth.statusMessage = undefined;
    auth.lastError = undefined;
    auth.nextRetryAfter = 0;
    auth.quota = emptyQuotaState();
    for (const state of Object.values(auth.modelStates ?? {})) {
      if (state) resetModelState(state, now);
    }
    auth.updatedAt = now;
    this.authCooldownSeq.delete(auth.id);
    this.modelCooldownSeq.delete(auth.id);
    const models = this.registry.getModelsForClient(auth.id).map((m) => m.id);
    for (const model of models) {
      this.registry.clearModelQuotaExceeded(auth.id, model);
      this.registry.resumeClientModel(auth.id, model);
    }
    this.persist(auth);
    this.syncRegistryProjections(auth);
    return { auth: cloneAuth(auth), models };
  }

  // -------------------------------------------------------------------------
  // Refresh (Go: conductor_refresh.go)
  // -------------------------------------------------------------------------

  /**
   * After a 401, refreshes the credential once and returns the refreshed auth
   * for an in-place retry; undefined means fail over (Go: tryRefreshAfterUnauthorized).
   */
  private async tryRefreshAfterUnauthorized(auth: Auth, err: unknown, alreadyTried: boolean): Promise<Auth | undefined> {
    if (isRequestScopedError(err) || !isUnauthorizedError(err)) return undefined;
    const failedToken = authAccessToken(auth);
    const current = this.auths.get(auth.id);
    if (alreadyTried || !authHasRefreshCredential(auth) || hasUnauthorizedAuthFailure(current ?? auth)) return undefined;
    log.debug(`unauthorized response for ${auth.provider} (${auth.id}), refreshing credentials before fallback`);
    let refreshed: Auth;
    try {
      refreshed = await this.refreshAuth(auth.id, { failedAccessToken: failedToken });
    } catch (refreshErr) {
      log.debug(`credential refresh before fallback failed for ${auth.provider} (${auth.id}):`, refreshErr instanceof Error ? refreshErr.message : String(refreshErr));
      return undefined;
    }
    if (failedToken !== "" && authAccessToken(refreshed) === failedToken) return undefined;
    return refreshed;
  }

  /**
   * Refreshes one credential through its executor. Concurrent callers share
   * one upstream refresh. `failedAccessToken` lets a 401 recovery reuse a
   * refresh that already replaced the rejected token; `force` bypasses the
   * terminal-unauthorized guard (Go: refreshAuthForRequestAtEpoch).
   */
  refreshAuth(id: string, options: { failedAccessToken?: string; force?: boolean } = {}): Promise<Auth> {
    const key = (id ?? "").trim();
    if (key === "") return Promise.reject(new AuthManagerError("invalid_argument", "auth id is empty"));
    const inFlight = this.refreshInFlight.get(key);
    if (inFlight) return inFlight;
    const run = this.doRefresh(key, options).finally(() => {
      this.refreshInFlight.delete(key);
    });
    this.refreshInFlight.set(key, run);
    return run;
  }

  private async doRefresh(id: string, options: { failedAccessToken?: string; force?: boolean }): Promise<Auth> {
    const force = options.force ?? false;
    const failedToken = options.failedAccessToken ?? "";
    const current = this.auths.get(id);
    const executor = current ? this.executors.get(executorKeyFromAuth(current)) : undefined;
    if (!current || !executor) throw new AuthManagerError("executor_not_found", "auth or executor not found");
    if (hasDisabledInvalidGrantFailure(current) && !force) throw new AuthManagerError("auth_disabled", "auth is disabled with invalid grant");
    if (hasUnauthorizedAuthFailure(current) && !force) throw new AuthManagerError("unauthorized", "auth is unauthorized", { httpStatus: 401 });
    // Another request may already have refreshed this credential.
    if (failedToken !== "" && authAccessToken(current) !== failedToken && authAccessToken(current) !== "") return cloneAuth(current);

    const base = cloneAuth(current);
    let updated: Auth | undefined;
    let refreshErr: unknown;
    try {
      updated = await executor.refresh(cloneAuth(base));
    } catch (err) {
      refreshErr = err;
    }
    const now = this.now();
    const live = this.auths.get(id);
    if (!live) throw new AuthManagerError("auth_not_found", `auth ${id} not found`);
    if (refreshErr !== undefined) {
      this.applyRefreshFailure(live, refreshErr, failedToken, force, now);
      throw refreshErr;
    }
    const next = updated ? cloneAuth(updated) : cloneAuth(base);
    if (next.runtime === undefined) next.runtime = live.runtime;
    next.id = id;
    next.lastRefreshedAt = now;
    next.nextRefreshAfter = 0;
    next.lastError = undefined;
    next.statusMessage = undefined;
    next.unavailable = false;
    next.refreshFailures = 0;
    if (next.status === StatusError || !next.status) next.status = StatusActive;
    if (!next.modelStates || Object.keys(next.modelStates).length === 0) next.modelStates = live.modelStates ? structuredClone(live.modelStates) : undefined;
    clearUnauthorizedModelStates(next, now);
    // Keep live cooldowns the refresh does not speak to.
    if (live.quota.exceeded && live.quota.reason === "credential_quota" && live.quota.nextRecoverAt > now) {
      next.quota = { ...live.quota };
      next.unavailable = live.unavailable;
      next.nextRetryAfter = live.nextRetryAfter;
      next.status = live.status;
    } else {
      next.quota = { ...live.quota };
      next.nextRetryAfter = live.nextRetryAfter > now ? live.nextRetryAfter : 0;
      if (next.nextRetryAfter > now && live.unavailable) next.unavailable = true;
      if (next.unavailable) next.status = live.status;
    }
    if (next.modelStates) updateAggregatedAvailability(next, now);
    if (shouldRefresh(next, now, this.refreshLead)) next.nextRefreshAfter = now + RefreshIneffectiveBackoffMs;
    next.updatedAt = now;
    normalizeModelStates(next);
    this.auths.set(id, next);
    this.persist(next);
    this.syncRegistryProjections(next);
    this.refreshLoop?.reschedule(id);
    return cloneAuth(next);
  }

  private applyRefreshFailure(current: Auth, err: unknown, failedToken: string, force: boolean, now: number): void {
    const unauthorized = isUnauthorizedError(err);
    const invalidGrant = isInvalidGrantError(err);
    const message = err instanceof Error ? err.message : String(err);
    if (hasUnauthorizedAuthFailure(current)) {
      current.updatedAt = now;
      current.unavailable = true;
      current.status = StatusError;
      current.nextRefreshAfter = 0;
      current.nextRetryAfter = 0;
      if (unauthorized || invalidGrant) {
        current.lastError = { code: "unauthorized", message, retryable: false, httpStatus: 401 };
        current.statusMessage = "unauthorized (refresh token invalid)";
      }
      this.persist(current);
      this.refreshLoop?.remove(current.id);
      return;
    }
    current.updatedAt = now;
    const status = errorStatus(err);
    current.lastError = { message, retryable: false, httpStatus: status !== 0 ? status : unauthorized ? 401 : undefined };
    if (unauthorized) {
      current.lastError.code = "unauthorized";
      current.lastError.httpStatus = 401;
    }
    const isDisabled = current.disabled || current.status === StatusDisabled;
    const validToken = hasValidAccessToken(current, now);
    const accessTokenRejected = failedToken !== "" && authAccessToken(current) === failedToken;
    let unschedule = false;
    if (isDisabled && invalidGrant) {
      current.unavailable = true;
      current.status = StatusDisabled;
      current.nextRefreshAfter = 0;
      current.refreshFailures = 0;
      current.statusMessage = "disabled (invalid grant)";
      unschedule = true;
    } else if (isDisabled) {
      current.unavailable = true;
      current.status = StatusDisabled;
      current.nextRefreshAfter = now + RefreshFailureBackoffMs;
      if (!current.statusMessage) current.statusMessage = "disabled";
    } else if (accessTokenRejected && invalidGrant) {
      // Neither token can recover without a new login: stop selecting the credential until its tokens change.
      current.unavailable = true;
      current.status = StatusError;
      current.nextRefreshAfter = 0;
      current.nextRetryAfter = 0;
      current.refreshFailures = 0;
      current.lastError = { code: "unauthorized", message, retryable: false, httpStatus: 401 };
      current.statusMessage = "unauthorized (refresh token invalid)";
      unschedule = true;
    } else if (!validToken || accessTokenRejected) {
      current.unavailable = true;
      current.status = StatusError;
      if (unauthorized) {
        current.nextRefreshAfter = 0;
        current.nextRetryAfter = 0;
        current.refreshFailures = 0;
        current.statusMessage = "unauthorized";
      } else if (invalidGrant) {
        current.refreshFailures = (current.refreshFailures ?? 0) + 1;
        current.nextRefreshAfter = now + invalidGrantBackoffMs(current.refreshFailures);
        current.statusMessage = "invalid grant (retrying)";
      } else {
        current.refreshFailures = 0;
        current.nextRefreshAfter = now + RefreshFailureBackoffMs;
        current.statusMessage = "token expired";
      }
    } else {
      // The access token is still valid: keep the credential in rotation and retry the refresh later.
      let nextRetry = now + RefreshFailureBackoffMs;
      if (invalidGrant) {
        current.refreshFailures = (current.refreshFailures ?? 0) + 1;
        nextRetry = now + invalidGrantBackoffMs(current.refreshFailures);
      } else {
        current.refreshFailures = 0;
      }
      current.nextRefreshAfter = nextRetry;
      if (!current.unavailable) {
        log.warn(`credential refresh failed for ${current.provider} (${current.id}); retaining active credential as access token is unexpired`);
      }
    }
    void force;
    this.persist(current);
    if (unschedule) this.refreshLoop?.remove(current.id);
    else this.refreshLoop?.reschedule(current.id);
  }

  /** Immediate refresh that bypasses the terminal-unauthorized guard (Go: ForceRefreshAuth). */
  forceRefresh(id: string): Promise<Auth> {
    return this.refreshAuth(id, { force: true });
  }

  /** Forces a refresh of every enabled credential that has a refresh token (Go: ForceRefreshAll). */
  async forceRefreshAll(): Promise<ForceRefreshResult[]> {
    const ids: string[] = [];
    for (const auth of this.auths.values()) {
      if (!auth.disabled && authHasRefreshCredential(auth)) ids.push(auth.id);
    }
    return Promise.all(
      ids.map(async (id) => {
        try {
          await this.forceRefresh(id);
          return { id, success: true };
        } catch (err) {
          return { id, success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  /** Whether the auth is due for a refresh now (exposed for tests and diagnostics). */
  shouldRefreshAuth(auth: Auth, nowMs = this.now()): boolean {
    return shouldRefresh(auth, nowMs, this.refreshLead);
  }

  nextRefreshCheckAt(auth: Auth, nowMs: number, intervalMs: number): { next: number; scheduled: boolean } {
    return nextRefreshCheckAt(nowMs, auth, intervalMs, this.refreshLead);
  }

  /**
   * Starts the background refresh loop; a running loop is replaced
   * (Go: StartAutoRefresh). Drive it with injected timers or `autoRefreshLoop().tick()`.
   */
  startAutoRefresh(intervalMs = RefreshCheckIntervalMs): AutoRefreshLoop {
    this.stopAutoRefresh();
    const interval = intervalMs > 0 ? intervalMs : RefreshCheckIntervalMs;
    const loop = new AutoRefreshLoop(
      {
        now: () => this.now(),
        authIds: () => Array.from(this.auths.keys()),
        auth: (id) => this.auths.get(id),
        hasExecutor: (auth) => this.executors.has(executorKeyFromAuth(auth)),
        shouldRefresh: (auth, nowMs) => shouldRefresh(auth, nowMs, this.refreshLead),
        nextCheckAt: (auth, nowMs, loopInterval) => nextRefreshCheckAt(nowMs, auth, loopInterval, this.refreshLead),
        refresh: async (id) => {
          try {
            await this.refreshAuth(id);
          } catch (err) {
            log.debug(`auto refresh failed for ${id}:`, err instanceof Error ? err.message : String(err));
          }
        },
      },
      interval,
      this.timers,
    );
    this.refreshLoop = loop;
    loop.start();
    return loop;
  }

  stopAutoRefresh(): void {
    this.refreshLoop?.stop();
    this.refreshLoop = undefined;
  }

  autoRefreshLoop(): AutoRefreshLoop | undefined {
    return this.refreshLoop;
  }
}

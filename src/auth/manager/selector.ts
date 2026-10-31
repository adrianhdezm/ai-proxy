// Credential selection. Port of sdk/cliproxy/auth/selector.go (RoundRobinSelector,
// FillFirstSelector, isAuthBlockedForModel, availabilityBlock, priority buckets,
// successorIndex, modelCooldownError construction) and the candidate-error
// attribution of conductor_selection.go (availableAuthsForRouteModel,
// latestCandidateErrorForModel, latestUnauthorizedCandidateError).
//
// WeightedRoundRobinSelector (smooth weighted round-robin) and the credential
// weight parsing of weight.go / internal/credentialweight are included.
//
// Dropped from upstream: SessionAffinitySelector,
// the plugin scheduler, websocket preference and the incremental authScheduler
// (selection recomputes availability from the auth snapshot on every pick).
import type { ExecOptions } from "../../executor/types.ts";
import { AttributeWeight, StatusDisabled, type Auth, type AuthError } from "../types.ts";
import { authPriority, canonicalModelKey } from "./classification.ts";
import { AuthManagerError, ModelCooldownError, TerminalAuthError, newAuthNotFoundError, newAuthUnavailableError } from "./errors.ts";
import { hasUnauthorizedAuthFailure } from "./state.ts";
import { accessTokenExpirationTime } from "./classification.ts";

/** Picks one candidate among the available auths (Go: Selector). */
export interface Selector {
  pick(provider: string, model: string, opts: ExecOptions, auths: Auth[], nowMs: number): Auth;
}

export type BlockReason = "none" | "cooldown" | "disabled" | "other";

export interface BlockState {
  blocked: boolean;
  reason: BlockReason;
  /** Recovery timestamp (epoch ms, 0 = unknown). */
  next: number;
}

const notBlocked: BlockState = { blocked: false, reason: "none", next: 0 };

/** Availability of a single state tuple (Go: availabilityBlock). */
export function availabilityBlock(unavailable: boolean, quotaExceeded: boolean, nextRetryAfter: number, nextRecoverAt: number, nowMs: number): BlockState {
  if (!unavailable && !quotaExceeded) return notBlocked;
  const hasRecoveryTime = nextRetryAfter !== 0 || nextRecoverAt !== 0;
  let next = 0;
  for (const candidate of [nextRetryAfter, nextRecoverAt]) {
    if (candidate > nowMs && (next === 0 || candidate > next)) next = candidate;
  }
  if (next !== 0) return { blocked: true, reason: quotaExceeded ? "cooldown" : "other", next };
  if (hasRecoveryTime) return notBlocked;
  return { blocked: true, reason: "other", next: 0 };
}

/**
 * Whether the auth may serve `model` at `nowMs`: disabled, terminal unauthorized,
 * expired access token, live credential quota, per-model state or (without a
 * model) the auth-level aggregate (Go: isAuthBlockedForModel).
 */
export function isAuthBlockedForModel(auth: Auth | undefined, model: string, nowMs: number): BlockState {
  if (!auth) return { blocked: true, reason: "other", next: 0 };
  if (auth.disabled || auth.status === StatusDisabled) return { blocked: true, reason: "disabled", next: 0 };
  if (hasUnauthorizedAuthFailure(auth)) return { blocked: true, reason: "other", next: 0 };
  const exp = accessTokenExpirationTime(auth);
  if (exp !== undefined && exp !== 0 && exp <= nowMs) return { blocked: true, reason: "other", next: 0 };
  if (auth.quota.exceeded && auth.quota.reason === "credential_quota" && auth.quota.nextRecoverAt > nowMs) {
    return { blocked: true, reason: "cooldown", next: auth.quota.nextRecoverAt };
  }
  if (model !== "") {
    const states = auth.modelStates;
    if (states && Object.keys(states).length > 0) {
      const modelKey = canonicalModelKey(model);
      let matched = false;
      let blocked = false;
      let blockedReason: BlockReason = "none";
      let nextRetry = 0;
      for (const [stateModel, state] of Object.entries(states)) {
        if (!state || canonicalModelKey(stateModel) !== modelKey) continue;
        matched = true;
        if (state.status === StatusDisabled) return { blocked: true, reason: "disabled", next: 0 };
        const block = availabilityBlock(state.unavailable, state.quota.exceeded, state.nextRetryAfter, state.quota.nextRecoverAt, nowMs);
        if (!block.blocked) continue;
        if (block.next === 0) return { blocked: true, reason: block.reason, next: 0 };
        if (!blocked || block.next > nextRetry || (block.next === nextRetry && block.reason === "cooldown")) {
          blocked = true;
          blockedReason = block.reason;
          nextRetry = block.next;
        }
      }
      if (matched) return { blocked, reason: blockedReason, next: nextRetry };
      return notBlocked;
    }
    return availabilityBlock(auth.unavailable, auth.quota.exceeded, auth.nextRetryAfter, auth.quota.nextRecoverAt, nowMs);
  }
  let quotaExceeded = auth.quota.exceeded;
  // With per-model states the auth-level quota is an aggregate of single-model
  // cooldowns (reason "quota"); it must not block the whole credential.
  if (auth.modelStates && Object.keys(auth.modelStates).length > 0 && auth.quota.reason !== "credential_quota" && !auth.unavailable) {
    quotaExceeded = false;
  }
  return availabilityBlock(auth.unavailable, quotaExceeded, auth.nextRetryAfter, auth.quota.nextRecoverAt, nowMs);
}

function sortByID(auths: Auth[]): Auth[] {
  return auths.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Flattens priority buckets into an ID-sorted list of the highest tier (Go: availableAuthsFromPriorityBuckets). */
function availableAuthsFromPriorityBuckets(buckets: Map<number, Auth[]>): Auth[] {
  let best: number | undefined;
  for (const priority of buckets.keys()) {
    if (best === undefined || priority > best) best = priority;
  }
  if (best === undefined) return [];
  return sortByID(buckets.get(best) ?? []);
}

/** Narrows a list to its highest priority tier, preserving order (Go: highestPriorityAuths). */
export function highestPriorityAuths(auths: Auth[]): Auth[] {
  if (auths.length <= 1) return auths;
  let best = 0;
  let count = 0;
  for (const auth of auths) {
    const priority = authPriority(auth);
    if (count === 0 || priority > best) {
      best = priority;
      count = 1;
    } else if (priority === best) {
      count++;
    }
  }
  if (count === auths.length) return auths;
  return auths.filter((auth) => authPriority(auth) === best);
}

function candidateErrorText(err: AuthError | undefined, statusMessage: string | undefined): AuthError | undefined {
  if (err) return err;
  if (statusMessage && statusMessage.trim() !== "") return { message: statusMessage, retryable: false };
  return undefined;
}

/** The most recent failure among cooling candidates, model errors first (Go: latestCandidateErrorForModel). */
export function latestCandidateErrorForModel(auths: Auth[], model: string): AuthError | undefined {
  let latestModelTime = -1;
  let latestModelID = "";
  let latestModelErr: AuthError | undefined;
  let latestAuthTime = -1;
  let latestAuthID = "";
  let latestAuthErr: AuthError | undefined;
  const key = canonicalModelKey(model);
  for (const candidate of auths) {
    const states = candidate.modelStates ?? {};
    const state = states[model] ?? states[key];
    if (state) {
      const modelErr = candidateErrorText(state.lastError, state.statusMessage);
      if (modelErr) {
        const modelTime = state.updatedAt !== 0 ? state.updatedAt : candidate.updatedAt;
        if (!latestModelErr || modelTime > latestModelTime || (modelTime === latestModelTime && candidate.id > latestModelID)) {
          latestModelTime = modelTime;
          latestModelID = candidate.id;
          latestModelErr = modelErr;
        }
      }
    }
    const authErr = candidateErrorText(candidate.lastError, candidate.statusMessage);
    if (authErr) {
      const authTime = candidate.updatedAt;
      if (!latestAuthErr || authTime > latestAuthTime || (authTime === latestAuthTime && candidate.id > latestAuthID)) {
        latestAuthTime = authTime;
        latestAuthID = candidate.id;
        latestAuthErr = authErr;
      }
    }
  }
  return latestModelErr ?? latestAuthErr;
}

function latestUnauthorizedCandidateError(auths: Auth[]): AuthError | undefined {
  let latestTime = -1;
  let latestID = "";
  let latest: AuthError | undefined;
  for (const candidate of auths) {
    if (!hasUnauthorizedAuthFailure(candidate) || !candidate.lastError) continue;
    if (!latest || candidate.updatedAt > latestTime || (candidate.updatedAt === latestTime && candidate.id > latestID)) {
      latestTime = candidate.updatedAt;
      latestID = candidate.id;
      latest = candidate.lastError;
    }
  }
  return latest;
}

function causeFromAuthError(err: AuthError | undefined): Error | undefined {
  if (!err) return undefined;
  return new AuthManagerError(err.code ?? "", err.message, { retryable: err.retryable, httpStatus: err.httpStatus });
}

/**
 * Filters the candidates down to the highest available priority tier, sorted by
 * id. Throws a ModelCooldownError when every candidate is cooling down, a
 * TerminalAuthError when every candidate is terminally unauthorized and an
 * auth_unavailable error otherwise (Go: availableAuthsForRouteModelWithPriorityMode).
 */
export function getAvailableAuths(auths: Auth[], provider: string, model: string, nowMs: number): Auth[] {
  if (auths.length === 0) throw newAuthNotFoundError("no auth candidates");
  const buckets = new Map<number, Auth[]>();
  let cooldownCount = 0;
  let unauthorizedCount = 0;
  let earliest = 0;
  for (const candidate of auths) {
    const block = isAuthBlockedForModel(candidate, model, nowMs);
    if (!block.blocked) {
      const priority = authPriority(candidate);
      const bucket = buckets.get(priority);
      if (bucket) bucket.push(candidate);
      else buckets.set(priority, [candidate]);
      continue;
    }
    if (block.reason === "cooldown") cooldownCount++;
    if (block.reason !== "disabled" && block.next > nowMs && (earliest === 0 || block.next < earliest)) earliest = block.next;
    if (hasUnauthorizedAuthFailure(candidate)) unauthorizedCount++;
  }
  if (buckets.size === 0) {
    const lastCandidateErr = causeFromAuthError(latestCandidateErrorForModel(auths, model));
    if (cooldownCount === auths.length && earliest !== 0) {
      const providerForError = provider === "mixed" ? "" : provider;
      throw new ModelCooldownError(model, providerForError, Math.max(0, earliest - nowMs), lastCandidateErr);
    }
    if (unauthorizedCount === auths.length) {
      const terminalCause = causeFromAuthError(latestUnauthorizedCandidateError(auths)) ?? lastCandidateErr;
      throw new TerminalAuthError("auth_unavailable", "no auth available", { httpStatus: 503, cause: terminalCause });
    }
    throw newAuthUnavailableError(earliest, nowMs, lastCandidateErr);
  }
  return availableAuthsFromPriorityBuckets(buckets);
}

/**
 * Index of the first candidate ordered after lastID, wrapping to the head.
 * Candidates arrive sorted by ID (Go: successorIndex).
 */
export function successorIndex(available: Auth[], lastID: string): number {
  if (lastID === "") return 0;
  let lo = 0;
  let hi = available.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (available[mid]!.id > lastID) hi = mid;
    else lo = mid + 1;
  }
  return lo >= available.length ? 0 : lo;
}

/**
 * Provider scoped round-robin that resumes from the identity of the previous
 * pick so shrinking candidate sets never re-seat the rotation (Go: RoundRobinSelector).
 */
export class RoundRobinSelector implements Selector {
  private lastPicked = new Map<string, string>();
  private readonly maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys && options.maxKeys > 0 ? options.maxKeys : 4096;
  }

  pick(provider: string, model: string, _opts: ExecOptions, auths: Auth[], nowMs: number): Auth {
    const available = getAvailableAuths(auths, provider, model, nowMs);
    const key = `${provider}:${canonicalModelKey(model)}`;
    if (!this.lastPicked.has(key) && this.lastPicked.size >= this.maxKeys) this.lastPicked = new Map();
    const picked = available[successorIndex(available, this.lastPicked.get(key) ?? "")]!;
    this.lastPicked.set(key, picked.id);
    return picked;
  }

  /** Rotation cursors keyed by provider:model (exposed for tests). */
  cursors(): ReadonlyMap<string, string> {
    return this.lastPicked;
  }
}

/** Always selects the first available credential by id (Go: FillFirstSelector). */
export class FillFirstSelector implements Selector {
  pick(provider: string, model: string, _opts: ExecOptions, auths: Auth[], nowMs: number): Auth {
    return getAvailableAuths(auths, provider, model, nowMs)[0]!;
  }
}

// ---------------------------------------------------------------------------
// Credential weights (Go: weight.go, internal/credentialweight, authWeight)
// ---------------------------------------------------------------------------

/** Weight used when a credential does not define one (Go: credentialweight.Default). */
export const DefaultCredentialWeight = 1;
/** Largest positive weight (Go: credentialweight.Max). */
export const MaxAuthWeight = 1_000_000;

function normalizeWeight(weight: number): number {
  if (weight <= 0) return 0;
  if (weight > MaxAuthWeight) throw new Error(`weight must not exceed ${MaxAuthWeight}`);
  return weight;
}

/** Parses a scheduler attribute; "" uses the default weight (Go: credentialweight.ParseString). */
export function parseWeightString(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return DefaultCredentialWeight;
  if (!/^[+-]?\d+$/.test(trimmed)) throw new Error("weight must be an integer");
  const value = BigInt(trimmed);
  if (value <= 0n) return 0;
  if (value > BigInt(MaxAuthWeight)) throw new Error(`weight must not exceed ${MaxAuthWeight}`);
  return Number(value);
}

/** Parses a JSON metadata value (Go: credentialweight.ParseValue). */
export function parseWeightValue(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error("weight must be an integer");
    return normalizeWeight(value);
  }
  if (typeof value === "bigint") {
    if (value <= 0n) return 0;
    if (value > BigInt(MaxAuthWeight)) throw new Error(`weight must not exceed ${MaxAuthWeight}`);
    return Number(value);
  }
  if (typeof value === "string") return parseWeightString(value);
  throw new Error("weight must be an integer");
}

/** Validates every explicit weight source of the auth; throws on an invalid one (Go: ValidateAuthWeight). */
export function validateAuthWeight(auth: Auth | undefined): void {
  if (!auth) return;
  if (auth.attributes && Object.prototype.hasOwnProperty.call(auth.attributes, AttributeWeight)) {
    try {
      parseWeightString(auth.attributes[AttributeWeight] ?? "");
    } catch (err) {
      throw new Error(`invalid attributes weight: ${(err as Error).message}`);
    }
  }
  if (auth.metadata && Object.prototype.hasOwnProperty.call(auth.metadata, AttributeWeight)) {
    try {
      parseWeightValue(auth.metadata[AttributeWeight]);
    } catch (err) {
      throw new Error(`invalid metadata weight: ${(err as Error).message}`);
    }
  }
}

/** Effective routing weight; invalid explicit weights count as 0 (Go: authWeight). */
export function authWeight(auth: Auth | undefined): number {
  if (!auth) return DefaultCredentialWeight;
  const raw = auth.attributes?.[AttributeWeight];
  if (raw !== undefined && raw.trim() !== "") {
    try {
      return parseWeightString(raw);
    } catch {
      return 0;
    }
  }
  if (auth.metadata && Object.prototype.hasOwnProperty.call(auth.metadata, AttributeWeight)) {
    try {
      return parseWeightValue(auth.metadata[AttributeWeight]);
    } catch {
      return 0;
    }
  }
  return DefaultCredentialWeight;
}

export function positiveWeightAuths(auths: Auth[]): Auth[] {
  return auths.filter((auth) => authWeight(auth) > 0);
}

/** Bounds one accumulator map so permanently removed credentials cannot leak (Go: maxSmoothWeightedStateEntries). */
export const MaxSmoothWeightedStateEntries = 1024;

/** Per (provider, model) smooth weighted state (Go: smoothWeightedState). */
export class SmoothWeightedState {
  current?: Map<string, number>;
  weights?: Map<string, number>;

  /**
   * Syncs the configured weights without discarding accumulated credits; credits
   * reset only when a credential's configured weight changes, never when the
   * candidate set shrinks temporarily (Go: smoothWeightedState.prepare).
   */
  prepare(weights: Map<string, number>): void {
    if (!this.current || weightsConfigChanged(this.weights, weights)) this.current = new Map();
    if (!this.weights) this.weights = new Map();
    for (const [id, weight] of weights) this.weights.set(id, weight);
    this.pruneStale(weights);
  }

  private pruneStale(weights: Map<string, number>): void {
    if ((this.current?.size ?? 0) <= MaxSmoothWeightedStateEntries && (this.weights?.size ?? 0) <= MaxSmoothWeightedStateEntries) return;
    for (const id of Array.from(this.current?.keys() ?? [])) if (!weights.has(id)) this.current!.delete(id);
    for (const id of Array.from(this.weights?.keys() ?? [])) if (!weights.has(id)) this.weights!.delete(id);
  }
}

/** Whether a credential present in both vectors changed its weight (Go: weightsConfigChanged). */
export function weightsConfigChanged(left: Map<string, number> | undefined, right: Map<string, number>): boolean {
  if (!left || left.size === 0) return false;
  for (const [id, weight] of right) {
    const previous = left.get(id);
    if (previous !== undefined && previous !== weight) return true;
  }
  return false;
}

export function authWeightVector(auths: Auth[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const auth of auths) {
    if (!auth) continue;
    const weight = authWeight(auth);
    if (weight > 0) weights.set(auth.id, weight);
  }
  return weights;
}

/** Nginx-style smooth weighted pick over `auths` in order (Go: pickSmoothWeightedAuth). */
export function pickSmoothWeightedAuth(auths: Auth[], current: Map<string, number>): Auth | undefined {
  let picked: Auth | undefined;
  let pickedCurrent = 0;
  let total = 0;
  for (const auth of auths) {
    const weight = authWeight(auth);
    if (!auth || weight <= 0) continue;
    const next = (current.get(auth.id) ?? 0) + weight;
    current.set(auth.id, next);
    total += weight;
    if (!picked || next > pickedCurrent) {
      picked = auth;
      pickedCurrent = next;
    }
  }
  if (!picked) return undefined;
  current.set(picked.id, (current.get(picked.id) ?? 0) - total);
  return picked;
}

/**
 * Smooth weighted round-robin across the highest available priority tier.
 * Credentials with a non-positive weight are excluded (Go: WeightedRoundRobinSelector).
 */
export class WeightedRoundRobinSelector implements Selector {
  private states = new Map<string, SmoothWeightedState>();
  private readonly maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys && options.maxKeys > 0 ? options.maxKeys : 4096;
  }

  pick(provider: string, model: string, _opts: ExecOptions, auths: Auth[], nowMs: number): Auth {
    const available = getAvailableAuths(positiveWeightAuths(auths), provider, model, nowMs);
    const key = `${provider}:${canonicalModelKey(model)}`;
    if (!this.states.has(key) && this.states.size >= this.maxKeys) this.states = new Map();
    let state = this.states.get(key);
    if (!state) {
      state = new SmoothWeightedState();
      this.states.set(key, state);
    }
    state.prepare(authWeightVector(available));
    const picked = pickSmoothWeightedAuth(available, state.current!);
    if (!picked) throw new AuthManagerError("auth_unavailable", "no auth available with positive weight");
    return picked;
  }

  /** Accumulator state keyed by provider:model (exposed for tests). */
  stateFor(provider: string, model: string): SmoothWeightedState | undefined {
    return this.states.get(`${provider}:${canonicalModelKey(model)}`);
  }
}

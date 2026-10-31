// Credential selection. Port of sdk/cliproxy/auth/selector.go (RoundRobinSelector,
// FillFirstSelector, isAuthBlockedForModel, availabilityBlock, priority buckets,
// successorIndex, modelCooldownError construction) and the candidate-error
// attribution of conductor_selection.go (availableAuthsForRouteModel,
// latestCandidateErrorForModel, latestUnauthorizedCandidateError).
//
// Dropped from upstream: WeightedRoundRobinSelector, SessionAffinitySelector,
// the plugin scheduler, websocket preference and the incremental authScheduler
// (selection recomputes availability from the auth snapshot on every pick).
import type { ExecOptions } from "../../executor/types.ts";
import { StatusDisabled, type Auth, type AuthError } from "../types.ts";
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

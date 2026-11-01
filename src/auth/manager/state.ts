// Model/auth state helpers shared by selection and cooldown bookkeeping. Port of
// the small helpers in sdk/cliproxy/auth/conductor_cooldown.go (existingModelState,
// ensureModelState, normalizeModelStates, mergeModelState, resetModelState,
// isModelStateActiveCooldown, isAuthActiveCooldown, hasUnauthorizedAuthFailure,
// clearCooldownStateForAuth) and clearUnauthorizedModelStates of conductor_refresh.go.
//
// Dropped from upstream: the credential-quota shadow layers (issue #6690) and
// quota observation signals.
import { StatusActive, StatusDisabled, StatusError, emptyQuotaState, type Auth, type AuthError, type ModelState, type QuotaState } from "../types.ts";
import { canonicalModelKey } from "./classification.ts";
import { isInvalidGrantErrorMessage, isInvalidGrantResultError } from "./errors.ts";

export function cloneError(err: AuthError | undefined): AuthError | undefined {
  if (!err) return undefined;
  const out: AuthError = { message: err.message, retryable: err.retryable };
  if (err.code !== undefined) out.code = err.code;
  if (err.httpStatus !== undefined) out.httpStatus = err.httpStatus;
  return out;
}

/** Overwrites the cooldown fields of a quota state (Go: applyCooldownFields, without signals). */
export function applyCooldownFields(dst: QuotaState, cooldown: QuotaState): void {
  dst.exceeded = cooldown.exceeded;
  dst.reason = cooldown.reason;
  dst.nextRecoverAt = cooldown.nextRecoverAt;
  dst.backoffLevel = cooldown.backoffLevel;
}

export function newModelState(status = StatusActive): ModelState {
  return { status, unavailable: false, nextRetryAfter: 0, quota: emptyQuotaState(), updatedAt: 0 };
}

export function existingModelState(auth: Auth | undefined, model: string): ModelState | undefined {
  const key = canonicalModelKey(model);
  if (!auth || key === "" || !auth.modelStates) return undefined;
  return auth.modelStates[key];
}

/** Returns the canonical model state, creating an active one when missing (Go: ensureModelState). */
export function ensureModelState(auth: Auth, model: string): ModelState | undefined {
  const key = canonicalModelKey(model);
  if (key === "") return undefined;
  normalizeModelStates(auth);
  if (!auth.modelStates) auth.modelStates = {};
  const existing = auth.modelStates[key];
  if (existing) return existing;
  const state = newModelState();
  auth.modelStates[key] = state;
  return state;
}

/** Collapses thinking-suffixed model state keys onto their canonical model (Go: normalizeModelStates). */
export function normalizeModelStates(auth: Auth): boolean {
  if (!auth.modelStates || Object.keys(auth.modelStates).length === 0) return false;
  const normalized: Record<string, ModelState> = {};
  let changed = false;
  for (const [model, state] of Object.entries(auth.modelStates)) {
    if (!state) {
      changed = true;
      continue;
    }
    const key = canonicalModelKey(model);
    if (key === "") {
      changed = true;
      continue;
    }
    if (key !== model) changed = true;
    const current = normalized[key];
    if (current) {
      mergeModelState(current, state);
      changed = true;
    } else {
      normalized[key] = state;
    }
  }
  if (changed) auth.modelStates = normalized;
  return changed;
}

/** Merges `source` into `target`, keeping the newest status and the strongest cooldown (Go: mergeModelState). */
export function mergeModelState(target: ModelState, source: ModelState): ModelState {
  const sourceNewer = source.updatedAt > target.updatedAt;
  const preferred = sourceNewer ? source : target;
  const fallback = sourceNewer ? target : source;
  const merged: ModelState = {
    status: preferred.status,
    statusMessage: preferred.statusMessage,
    unavailable: target.unavailable || source.unavailable,
    nextRetryAfter: Math.max(target.nextRetryAfter, source.nextRetryAfter),
    lastError: cloneError(preferred.lastError),
    quota: {
      exceeded: target.quota.exceeded || source.quota.exceeded,
      reason: preferred.quota.reason,
      nextRecoverAt: Math.max(target.quota.nextRecoverAt, source.quota.nextRecoverAt),
      backoffLevel: Math.max(target.quota.backoffLevel ?? 0, source.quota.backoffLevel ?? 0),
    },
    updatedAt: Math.max(target.updatedAt, source.updatedAt),
  };
  if (!merged.statusMessage) merged.statusMessage = fallback.statusMessage;
  if (!merged.lastError) merged.lastError = cloneError(fallback.lastError);
  if (!merged.quota.reason) merged.quota.reason = fallback.quota.reason;
  if (target.status === StatusDisabled || source.status === StatusDisabled) merged.status = StatusDisabled;
  else if (merged.unavailable || merged.quota.exceeded) merged.status = StatusError;
  Object.assign(target, merged);
  return target;
}

export function resetModelState(state: ModelState, nowMs: number): void {
  state.unavailable = false;
  state.status = StatusActive;
  state.statusMessage = undefined;
  state.nextRetryAfter = 0;
  state.lastError = undefined;
  applyCooldownFields(state.quota, emptyQuotaState());
  state.updatedAt = nowMs;
}

export function isModelStateActiveCooldown(state: ModelState | undefined, nowMs: number): boolean {
  if (!state) return false;
  if (state.status === StatusDisabled) return true;
  if (state.nextRetryAfter !== 0 && state.nextRetryAfter > nowMs) return true;
  if (state.quota.nextRecoverAt !== 0 && state.quota.nextRecoverAt > nowMs) return true;
  if (state.quota.exceeded && state.quota.nextRecoverAt === 0) return true;
  return false;
}

/** Whether the auth carries a still-live auth-level cooldown (Go: isAuthActiveCooldown). */
export function isAuthActiveCooldown(auth: Auth | undefined, nowMs: number): boolean {
  if (!auth || auth.disabled || auth.status === StatusDisabled) return false;
  if (auth.nextRetryAfter !== 0 && auth.nextRetryAfter > nowMs) return true;
  if (auth.quota.nextRecoverAt !== 0 && auth.quota.nextRecoverAt > nowMs) return true;
  if (auth.quota.exceeded && auth.quota.nextRecoverAt === 0) return true;
  return false;
}

/**
 * A terminal unauthorized error with no pending refresh scheduled; such an
 * auth stays blocked until its tokens change (Go: hasUnauthorizedAuthFailure).
 */
export function hasUnauthorizedAuthFailure(auth: Auth | undefined): boolean {
  if (!auth || !auth.lastError) return false;
  return (
    auth.unavailable &&
    auth.status === StatusError &&
    auth.nextRefreshAfter === 0 &&
    auth.nextRetryAfter === 0 &&
    ((auth.lastError.httpStatus ?? 0) === 401 || (auth.lastError.code ?? "").toLowerCase() === "unauthorized")
  );
}

/** Disabled auth whose last error was an invalid_grant (Go: hasDisabledInvalidGrantFailure). */
export function hasDisabledInvalidGrantFailure(auth: Auth | undefined): boolean {
  if (!auth) return false;
  if (!auth.disabled && auth.status !== StatusDisabled) return false;
  const err = auth.lastError;
  if (!err) return false;
  return isInvalidGrantResultError(err) || isInvalidGrantErrorMessage(err.message) || isInvalidGrantErrorMessage(err.code);
}

/** Clears every cooldown field (used when cooling is disabled); keeps lastError (Go: clearCooldownStateForAuth). */
export function clearCooldownStateForAuth(auth: Auth, nowMs: number): boolean {
  if (hasUnauthorizedAuthFailure(auth)) return false;
  let changed = false;
  if (auth.unavailable || auth.nextRetryAfter !== 0 || auth.quota.exceeded || auth.quota.nextRecoverAt !== 0) {
    auth.unavailable = false;
    auth.nextRetryAfter = 0;
    applyCooldownFields(auth.quota, emptyQuotaState());
    auth.updatedAt = nowMs;
    changed = true;
  }
  for (const state of Object.values(auth.modelStates ?? {})) {
    if (!state) continue;
    if (state.unavailable || state.nextRetryAfter !== 0 || state.quota.exceeded || state.quota.nextRecoverAt !== 0) {
      state.unavailable = false;
      state.nextRetryAfter = 0;
      applyCooldownFields(state.quota, emptyQuotaState());
      state.updatedAt = nowMs;
      changed = true;
    }
  }
  return changed;
}

/** Resets model states that were blocked by a 401/invalid_grant; returns the resumed models (Go: clearUnauthorizedModelStates). */
export function clearUnauthorizedModelStates(auth: Auth, nowMs: number): string[] {
  const resumed: string[] = [];
  if (!auth.modelStates) return resumed;
  for (const [model, state] of Object.entries(auth.modelStates)) {
    if (!state) continue;
    let unauthorized = false;
    if (state.lastError) {
      const code = (state.lastError.code ?? "").toLowerCase();
      if ((state.lastError.httpStatus ?? 0) === 401 || code === "unauthorized" || isInvalidGrantResultError(state.lastError)) unauthorized = true;
    }
    const message = (state.statusMessage ?? "").toLowerCase();
    if (!unauthorized && (message.includes("unauthorized") || isInvalidGrantErrorMessage(message))) unauthorized = true;
    if (!unauthorized) continue;
    if (state.quota.exceeded && (state.quota.nextRecoverAt === 0 || state.quota.nextRecoverAt > nowMs)) {
      state.lastError = undefined;
      if (message.includes("unauthorized") || isInvalidGrantErrorMessage(message)) state.statusMessage = state.quota.reason;
      state.updatedAt = nowMs;
      continue;
    }
    resetModelState(state, nowMs);
    resumed.push(model);
  }
  return resumed;
}

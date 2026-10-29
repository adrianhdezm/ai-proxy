// Cooldown bookkeeping applied when an execution result is recorded. Port of
// the cooldown parts of sdk/cliproxy/auth/conductor_cooldown.go: the global
// cooling switches, recoverable-failure deadlines, applyAuthFailureState,
// quotaCooldownAfterFailure / nextQuotaCooldown, updateAggregatedAvailability,
// hasModelError, clearAuthStateOnSuccess and the per-model branch of MarkResult
// (applyModelFailureState here).
//
// Dropped from upstream: Cloudflare challenge cooldowns, the credential-quota
// shadow layers (issue #6690), Devin quota revalidation and persisted cooldown
// state records.
import { StatusActive, StatusDisabled, StatusError, emptyQuotaState, type Auth, type AuthError, type ModelState } from "../types.ts";
import {
  ErrorCodeForceCooldown,
  isInvalidGrantResultError,
  isModelSupportResultError,
  isTransientRateLimitResultError,
  shouldSkipCredentialCooldown,
  statusCodeFromResult,
} from "./errors.ts";
import { applyCooldownFields, cloneError, hasUnauthorizedAuthFailure } from "./state.ts";

/** Quota backoff ladder base (Go: quotaBackoffBase). */
export const QuotaBackoffBaseMs = 1000;
/** Quota backoff ladder cap (Go: quotaBackoffMax). */
export const QuotaBackoffMaxMs = 30 * 60 * 1000;
/** Shortest 429 cooldown honoured from a provider hint (Go: minQuotaCooldownFloor). */
export const MinQuotaCooldownFloorMs = 10 * 1000;
/** Default cooldown after 408/5xx and unclassified failures (Go: transientErrorCooldown). */
export const TransientErrorCooldownMs = 60 * 1000;

/** Process wide cooldown switches (Go: quotaCooldownDisabled / transientErrorCooldownSeconds). */
export interface CooldownConfig {
  /** Disable auth/model cooldown scheduling globally (config disable-cooling). */
  quotaCooldownDisabled: boolean;
  /** 0 keeps the one minute default; negative disables transient error cooldowns. */
  transientErrorCooldownSeconds: number;
}

let globalCooldownConfig: CooldownConfig = { quotaCooldownDisabled: false, transientErrorCooldownSeconds: 0 };

export function setQuotaCooldownDisabled(disable: boolean): void {
  globalCooldownConfig = { ...globalCooldownConfig, quotaCooldownDisabled: disable };
}

export function setTransientErrorCooldownSeconds(seconds: number): void {
  globalCooldownConfig = { ...globalCooldownConfig, transientErrorCooldownSeconds: seconds };
}

export function cooldownConfig(): CooldownConfig {
  return globalCooldownConfig;
}

function transientRetryAfter(nowMs: number, retryAfterMs: number | undefined, disableCooling: boolean, cfg: CooldownConfig): number {
  if (disableCooling) return 0;
  if (cfg.transientErrorCooldownSeconds < 0) return 0;
  if (retryAfterMs !== undefined && retryAfterMs > 0) return nowMs + retryAfterMs;
  if (cfg.transientErrorCooldownSeconds === 0) return nowMs + TransientErrorCooldownMs;
  return nowMs + cfg.transientErrorCooldownSeconds * 1000;
}

/** Cooldown for 408/5xx failures (Go: recoverableFailureRetryAfterWithHint). */
export function recoverableFailureRetryAfter(nowMs: number, retryAfterMs: number | undefined, disableCooling: boolean, cfg = globalCooldownConfig): number {
  return transientRetryAfter(nowMs, retryAfterMs, disableCooling, cfg);
}

/** Model-scoped cooldown for a transient capacity 429; an explicit zero hint means retry now (Go: transientRateLimitRetryAfter). */
export function transientRateLimitRetryAfter(nowMs: number, retryAfterMs: number | undefined, disableCooling: boolean, cfg = globalCooldownConfig): number {
  if (retryAfterMs !== undefined && retryAfterMs === 0) return 0;
  return transientRetryAfter(nowMs, retryAfterMs, disableCooling, cfg);
}

/** Next quota cooldown duration and backoff level (Go: nextQuotaCooldown). */
export function nextQuotaCooldown(prevLevel: number, disableCooling: boolean): { cooldownMs: number; level: number } {
  if (prevLevel < 0) prevLevel = 0;
  if (disableCooling) return { cooldownMs: 0, level: prevLevel };
  let cooldown = QuotaBackoffBaseMs * 2 ** prevLevel;
  if (cooldown < QuotaBackoffBaseMs) cooldown = QuotaBackoffBaseMs;
  if (cooldown >= QuotaBackoffMaxMs) return { cooldownMs: QuotaBackoffMaxMs, level: prevLevel };
  return { cooldownMs: cooldown, level: prevLevel + 1 };
}

/**
 * Recovery deadline and backoff level for a quota failure at `nowMs`. A failure
 * inside an open window reuses it instead of escalating (Go: quotaCooldownAfterFailure).
 */
export function quotaCooldownAfterFailure(quota: { nextRecoverAt: number; backoffLevel?: number }, nowMs: number): { next: number; level: number } {
  if (quota.nextRecoverAt > nowMs) return { next: quota.nextRecoverAt, level: quota.backoffLevel ?? 0 };
  const { cooldownMs, level } = nextQuotaCooldown(quota.backoffLevel ?? 0, false);
  return { next: cooldownMs > 0 ? nowMs + cooldownMs : 0, level };
}

function quotaRetryAfterWithFloor(nowMs: number, retryAfterMs: number): number {
  return nowMs + Math.max(retryAfterMs, MinQuotaCooldownFloorMs);
}

/** Whether any model state still carries an error (Go: hasModelError). */
export function hasModelError(auth: Auth, nowMs: number): boolean {
  for (const state of Object.values(auth.modelStates ?? {})) {
    if (!state) continue;
    if (state.lastError) return true;
    if (state.status === StatusError && state.unavailable && (state.nextRetryAfter === 0 || state.nextRetryAfter > nowMs)) return true;
  }
  return false;
}

function clearAggregatedAvailability(auth: Auth): void {
  auth.unavailable = false;
  auth.nextRetryAfter = 0;
  applyCooldownFields(auth.quota, emptyQuotaState());
}

/**
 * Recomputes the auth-level availability from its model states: unavailable
 * only when every model is blocked, quota aggregate with reason "quota"
 * (Go: updateAggregatedAvailability).
 */
export function updateAggregatedAvailability(auth: Auth, nowMs: number): void {
  if (hasUnauthorizedAuthFailure(auth)) {
    auth.unavailable = true;
    return;
  }
  if (auth.quota.exceeded && auth.quota.reason === "credential_quota" && auth.quota.nextRecoverAt > nowMs) {
    auth.unavailable = true;
    return;
  }
  const states = Object.values(auth.modelStates ?? {}).filter((s): s is ModelState => !!s);
  if (states.length === 0) {
    clearAggregatedAvailability(auth);
    return;
  }
  let allUnavailable = true;
  let earliestRetry = 0;
  let quotaExceeded = false;
  let quotaRecover = 0;
  let maxBackoffLevel = 0;
  for (const state of states) {
    let stateUnavailable = false;
    if (state.status === StatusDisabled) {
      stateUnavailable = true;
    } else if (state.unavailable) {
      if (state.nextRetryAfter === 0) {
        stateUnavailable = false;
      } else if (state.nextRetryAfter > nowMs) {
        stateUnavailable = true;
        if (earliestRetry === 0 || state.nextRetryAfter < earliestRetry) earliestRetry = state.nextRetryAfter;
      } else {
        state.unavailable = false;
        state.nextRetryAfter = 0;
      }
    }
    if (!stateUnavailable) allUnavailable = false;
    if (state.quota.exceeded) {
      quotaExceeded = true;
      if (quotaRecover === 0 || (state.quota.nextRecoverAt !== 0 && state.quota.nextRecoverAt < quotaRecover)) quotaRecover = state.quota.nextRecoverAt;
      if ((state.quota.backoffLevel ?? 0) > maxBackoffLevel) maxBackoffLevel = state.quota.backoffLevel ?? 0;
    }
  }
  auth.unavailable = allUnavailable;
  auth.nextRetryAfter = allUnavailable ? earliestRetry : 0;
  if (quotaExceeded) {
    auth.quota.exceeded = true;
    auth.quota.reason = "quota";
    if (auth.quota.nextRecoverAt > quotaRecover) quotaRecover = auth.quota.nextRecoverAt;
    auth.quota.nextRecoverAt = quotaRecover;
    auth.quota.backoffLevel = maxBackoffLevel;
  } else if (auth.quota.exceeded && auth.quota.nextRecoverAt > nowMs) {
    // Retain the active auth-level quota cooldown.
  } else {
    auth.quota.exceeded = false;
    auth.quota.reason = undefined;
    auth.quota.nextRecoverAt = 0;
    auth.quota.backoffLevel = 0;
  }
}

/** Clears the auth-level error state after a success without a model key (Go: clearAuthStateOnSuccess). */
export function clearAuthStateOnSuccess(auth: Auth, nowMs: number): void {
  if (hasUnauthorizedAuthFailure(auth)) {
    auth.unavailable = true;
    return;
  }
  auth.unavailable = false;
  auth.status = StatusActive;
  auth.statusMessage = undefined;
  auth.quota.exceeded = false;
  auth.quota.reason = undefined;
  auth.quota.nextRecoverAt = 0;
  auth.quota.backoffLevel = 0;
  auth.lastError = undefined;
  auth.nextRetryAfter = 0;
  auth.updatedAt = nowMs;
}

/**
 * Applies a failure without a model key to the auth-level state
 * (Go: applyAuthFailureState). Deadlines only ever extend a live cooldown.
 */
export function applyAuthFailureState(auth: Auth, resultErr: AuthError | undefined, retryAfterMs: number | undefined, nowMs: number, disableCooling: boolean, cfg = globalCooldownConfig): void {
  const prevRetryAfter = auth.nextRetryAfter;
  if (shouldSkipCredentialCooldown(resultErr)) return;
  auth.unavailable = true;
  auth.status = StatusError;
  auth.updatedAt = nowMs;
  if (resultErr) {
    auth.lastError = cloneError(resultErr);
    if (resultErr.message !== "") auth.statusMessage = resultErr.message;
  }
  const statusCode = statusCodeFromResult(resultErr);
  if (isTransientRateLimitResultError(resultErr) && statusCode === 429) {
    let next = transientRateLimitRetryAfter(nowMs, retryAfterMs, disableCooling, cfg);
    if (next !== 0 && auth.quota.exceeded && auth.quota.nextRecoverAt > next) next = auth.quota.nextRecoverAt;
    if (next === 0 && auth.quota.exceeded && auth.quota.nextRecoverAt > nowMs) next = auth.quota.nextRecoverAt;
    auth.nextRetryAfter = next;
    auth.unavailable = next !== 0;
  } else if (isInvalidGrantResultError(resultErr)) {
    auth.statusMessage = "invalid_grant";
    auth.nextRetryAfter = disableCooling ? 0 : nowMs + 30 * 60 * 1000;
  } else {
    switch (statusCode) {
      case 401:
        auth.statusMessage = "unauthorized";
        auth.nextRetryAfter = disableCooling ? 0 : nowMs + 30 * 60 * 1000;
        break;
      case 402:
      case 403:
        auth.statusMessage = "payment_required";
        auth.nextRetryAfter = disableCooling ? 0 : nowMs + 30 * 60 * 1000;
        break;
      case 404:
        auth.statusMessage = "not_found";
        if (disableCooling) auth.nextRetryAfter = 0;
        else if (retryAfterMs !== undefined && retryAfterMs > 0) auth.nextRetryAfter = nowMs + retryAfterMs;
        else auth.nextRetryAfter = nowMs + 12 * 60 * 60 * 1000;
        break;
      case 429: {
        auth.statusMessage = "quota exhausted";
        auth.quota.exceeded = true;
        auth.quota.reason = "quota";
        let next = 0;
        if (!disableCooling) {
          if (retryAfterMs !== undefined) {
            next = quotaRetryAfterWithFloor(nowMs, retryAfterMs);
          } else {
            const computed = quotaCooldownAfterFailure(auth.quota, nowMs);
            next = computed.next;
            auth.quota.backoffLevel = computed.level;
          }
          if (auth.quota.exceeded && auth.quota.nextRecoverAt > next) next = auth.quota.nextRecoverAt;
        }
        auth.quota.nextRecoverAt = next;
        auth.nextRetryAfter = next;
        break;
      }
      case 408:
      case 500:
      case 502:
      case 503:
      case 504:
      case 520:
      case 521:
      case 522:
      case 523:
      case 524:
      case 525:
      case 526:
        auth.statusMessage = "transient upstream error";
        auth.nextRetryAfter = recoverableFailureRetryAfter(nowMs, retryAfterMs, disableCooling, cfg);
        auth.unavailable = auth.nextRetryAfter !== 0;
        break;
      default:
        if (!auth.statusMessage) auth.statusMessage = "request failed";
        auth.nextRetryAfter = recoverableFailureRetryAfter(nowMs, undefined, disableCooling, cfg);
        auth.unavailable = auth.nextRetryAfter !== 0;
        break;
    }
  }
  if (auth.nextRetryAfter !== 0 && prevRetryAfter > auth.nextRetryAfter && prevRetryAfter > nowMs) auth.nextRetryAfter = prevRetryAfter;
  if (resultErr && resultErr.code === ErrorCodeForceCooldown && auth.nextRetryAfter === 0) {
    auth.nextRetryAfter = nowMs + TransientErrorCooldownMs;
    auth.unavailable = true;
  }
  if (disableCooling && auth.nextRetryAfter === 0 && auth.quota.nextRecoverAt === 0) {
    auth.unavailable = false;
    auth.quota.exceeded = false;
  }
}

export interface ModelFailureInput {
  error: AuthError | undefined;
  retryAfterMs: number | undefined;
  credentialScope: boolean;
}

/**
 * Applies a failure with a model key to the model state and, for a
 * credential-scoped 429, to every sibling model and the auth-level quota
 * (Go: the model branch of MarkResult). Returns the deadline written for the
 * credential-wide quota (0 when none).
 */
export function applyModelFailureState(auth: Auth, state: ModelState, input: ModelFailureInput, nowMs: number, disableCooling: boolean, wasTerminalUnauthorized: boolean, cfg = globalCooldownConfig): void {
  const { error: resultErr, retryAfterMs, credentialScope } = input;
  state.unavailable = true;
  state.status = StatusError;
  state.updatedAt = nowMs;
  const prevModelRetryAfter = state.nextRetryAfter;
  if (resultErr) {
    state.lastError = cloneError(resultErr);
    state.statusMessage = resultErr.message;
    if (!wasTerminalUnauthorized) {
      auth.lastError = cloneError(resultErr);
      auth.statusMessage = resultErr.message;
    }
  }
  const statusCode = statusCodeFromResult(resultErr);
  if (isModelSupportResultError(resultErr)) {
    if (disableCooling) state.nextRetryAfter = 0;
    else if (retryAfterMs !== undefined && retryAfterMs > 0) state.nextRetryAfter = nowMs + retryAfterMs;
    else state.nextRetryAfter = nowMs + 12 * 60 * 60 * 1000;
  } else if (isInvalidGrantResultError(resultErr)) {
    state.nextRetryAfter = disableCooling ? 0 : nowMs + 30 * 60 * 1000;
  } else if (isTransientRateLimitResultError(resultErr) && statusCode === 429) {
    let next = transientRateLimitRetryAfter(nowMs, retryAfterMs, disableCooling, cfg);
    if (next !== 0 && state.quota.exceeded && state.quota.nextRecoverAt > next) next = state.quota.nextRecoverAt;
    if (next === 0 && state.quota.exceeded && state.quota.nextRecoverAt > nowMs) next = state.quota.nextRecoverAt;
    state.nextRetryAfter = next;
    state.unavailable = next !== 0;
  } else {
    switch (statusCode) {
      case 401:
      case 402:
      case 403:
        state.nextRetryAfter = disableCooling ? 0 : nowMs + 30 * 60 * 1000;
        break;
      case 404:
        if (disableCooling) state.nextRetryAfter = 0;
        else if (retryAfterMs !== undefined && retryAfterMs > 0) state.nextRetryAfter = nowMs + retryAfterMs;
        else state.nextRetryAfter = nowMs + 12 * 60 * 60 * 1000;
        break;
      case 429: {
        let next = 0;
        let credentialNext = 0;
        let backoffLevel = state.quota.backoffLevel ?? 0;
        if (credentialScope) {
          backoffLevel = 0;
          if (auth.quota.exceeded && auth.quota.reason === "credential_quota") backoffLevel = auth.quota.backoffLevel ?? 0;
        }
        if (!disableCooling) {
          if (retryAfterMs !== undefined) {
            next = quotaRetryAfterWithFloor(nowMs, retryAfterMs);
          } else {
            let quotaForFailure = { nextRecoverAt: state.quota.nextRecoverAt, backoffLevel: state.quota.backoffLevel ?? 0 };
            if (credentialScope) {
              if (auth.quota.exceeded && auth.quota.reason === "credential_quota") {
                quotaForFailure = { nextRecoverAt: auth.quota.nextRecoverAt, backoffLevel: auth.quota.backoffLevel ?? 0 };
              } else {
                quotaForFailure = { nextRecoverAt: 0, backoffLevel: 0 };
              }
            }
            const computed = quotaCooldownAfterFailure(quotaForFailure, nowMs);
            next = computed.next;
            backoffLevel = computed.level;
          }
          credentialNext = next;
          if (state.quota.exceeded && state.quota.nextRecoverAt > next) next = state.quota.nextRecoverAt;
        }
        state.nextRetryAfter = next;
        applyCooldownFields(state.quota, { exceeded: true, reason: "quota", nextRecoverAt: next, backoffLevel });
        if (credentialScope && !disableCooling) {
          for (const other of Object.values(auth.modelStates ?? {})) {
            if (!other || other === state) continue;
            other.unavailable = true;
            other.status = StatusError;
            let otherQuotaNext = credentialNext;
            if (other.quota.exceeded && other.quota.nextRecoverAt > otherQuotaNext) otherQuotaNext = other.quota.nextRecoverAt;
            let otherRetryAfter = otherQuotaNext;
            // Propagation only extends a sibling's still-live deadline; it never shortens one.
            if (other.nextRetryAfter !== 0 && other.nextRetryAfter > otherRetryAfter) otherRetryAfter = other.nextRetryAfter;
            other.nextRetryAfter = otherRetryAfter;
            applyCooldownFields(other.quota, { exceeded: true, reason: "credential_quota", nextRecoverAt: otherQuotaNext, backoffLevel });
          }
          if (!wasTerminalUnauthorized) {
            auth.unavailable = true;
            let authNext = credentialNext;
            if (auth.quota.exceeded && auth.quota.reason === "credential_quota" && auth.quota.nextRecoverAt > authNext) authNext = auth.quota.nextRecoverAt;
            auth.quota.exceeded = true;
            auth.quota.reason = "credential_quota";
            auth.quota.nextRecoverAt = authNext;
            auth.quota.backoffLevel = backoffLevel;
            auth.nextRetryAfter = authNext;
          }
        }
        break;
      }
      case 408:
      case 500:
      case 502:
      case 503:
      case 504:
      case 520:
      case 521:
      case 522:
      case 523:
      case 524:
      case 525:
      case 526:
        state.nextRetryAfter = recoverableFailureRetryAfter(nowMs, retryAfterMs, disableCooling, cfg);
        state.unavailable = state.nextRetryAfter !== 0;
        break;
      default:
        state.nextRetryAfter = recoverableFailureRetryAfter(nowMs, undefined, disableCooling, cfg);
        state.unavailable = state.nextRetryAfter !== 0;
        break;
    }
  }
  if (disableCooling && state.nextRetryAfter === 0 && state.quota.nextRecoverAt === 0) {
    state.unavailable = false;
    state.quota.exceeded = false;
  }
  if (resultErr && resultErr.code === ErrorCodeForceCooldown && state.nextRetryAfter === 0) {
    state.nextRetryAfter = nowMs + TransientErrorCooldownMs;
    state.unavailable = true;
  }
  // A later failure only extends a still-live cooldown; it never shortens one.
  if (state.nextRetryAfter !== 0 && prevModelRetryAfter > state.nextRetryAfter && prevModelRetryAfter > nowMs) state.nextRetryAfter = prevModelRetryAfter;
}

/** Human readable reason for a blocked state (Go: cooldownReason). */
export function cooldownReason(statusMessage: string | undefined, quota: { reason?: string }, lastErr: AuthError | undefined): string {
  if (quota.reason && quota.reason.trim() !== "") return quota.reason.trim();
  if (statusMessage && statusMessage.trim() !== "") return statusMessage.trim();
  if (lastErr) {
    if (lastErr.code && lastErr.code.trim() !== "") return lastErr.code.trim();
    if (lastErr.message.trim() !== "") return lastErr.message.trim();
  }
  return "";
}

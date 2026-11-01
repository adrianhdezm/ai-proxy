// Port of internal/thinking/errors.go. ThinkingError is a request-scoped refusal (HTTP 400),
// so it extends the translator contract's RequestRejectedError and can be handled uniformly.
import { RequestRejectedError } from "../translator/types.ts";

export type ErrorCode =
  | "INVALID_SUFFIX"
  | "UNKNOWN_LEVEL"
  | "THINKING_NOT_SUPPORTED"
  | "LEVEL_NOT_SUPPORTED"
  | "BUDGET_OUT_OF_RANGE"
  | "PROVIDER_MISMATCH";

/** The suffix format cannot be parsed, e.g. "model(abc". */
export const ErrInvalidSuffix: ErrorCode = "INVALID_SUFFIX";
/** The level value is not in the valid list, e.g. "model(ultra)". */
export const ErrUnknownLevel: ErrorCode = "UNKNOWN_LEVEL";
/** The model does not support thinking. */
export const ErrThinkingNotSupported: ErrorCode = "THINKING_NOT_SUPPORTED";
/** The model does not support the requested level. */
export const ErrLevelNotSupported: ErrorCode = "LEVEL_NOT_SUPPORTED";
/** The budget value is outside the model range. */
export const ErrBudgetOutOfRange: ErrorCode = "BUDGET_OUT_OF_RANGE";
/** The provider does not match the model. */
export const ErrProviderMismatch: ErrorCode = "PROVIDER_MISMATCH";

/** Structured thinking configuration error (Go: ThinkingError). message is lowercase, no trailing period. */
export class ThinkingError extends RequestRejectedError {
  readonly code: ErrorCode;
  readonly model: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, model = "", details?: Record<string, unknown>) {
    super(message, 400);
    this.name = "ThinkingError";
    this.code = code;
    this.model = model;
    this.details = details;
  }
}

export function newThinkingError(code: ErrorCode, message: string): ThinkingError {
  return new ThinkingError(code, message);
}

export function newThinkingErrorWithModel(code: ErrorCode, message: string, model: string): ThinkingError {
  return new ThinkingError(code, message, model);
}

export function isThinkingError(err: unknown): err is ThinkingError {
  return err instanceof ThinkingError;
}

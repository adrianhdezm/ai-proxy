// OAuth error types shared by the provider login flows. Port of
// internal/auth/claude/errors.go and internal/auth/codex/errors.go (identical
// apart from the extra ErrBrowserOpenFailed in the codex package).

/** Error returned by the authorization server (RFC 6749 section 4.1.2.1). */
export class OAuthError extends Error {
  code: string;
  description: string;
  uri: string;
  statusCode: number;

  constructor(code: string, description = "", statusCode = 400, uri = "") {
    super(description !== "" ? `OAuth error ${code}: ${description}` : `OAuth error: ${code}`);
    this.name = "OAuthError";
    this.code = code;
    this.description = description;
    this.statusCode = statusCode;
    this.uri = uri;
  }
}

export function newOAuthError(code: string, description: string, statusCode: number): OAuthError {
  return new OAuthError(code, description, statusCode);
}

/** Error raised by the local part of the flow (server, state check, exchange). */
export class AuthenticationError extends Error {
  type: string;
  code: number;
  override cause?: unknown;

  constructor(type: string, message: string, code: number, cause?: unknown) {
    super(cause !== undefined ? `${type}: ${message} (caused by: ${errorText(cause)})` : `${type}: ${message}`);
    this.name = "AuthenticationError";
    this.type = type;
    this.code = code;
    this.cause = cause;
  }

  /** The upstream base message (without the cause suffix). */
  get baseMessage(): string {
    const prefix = `${this.type}: `;
    const idx = this.message.indexOf(" (caused by: ");
    const body = idx >= 0 ? this.message.slice(0, idx) : this.message;
    return body.startsWith(prefix) ? body.slice(prefix.length) : body;
  }
}

export interface AuthenticationErrorBase {
  type: string;
  message: string;
  code: number;
}

export const ErrInvalidState: AuthenticationErrorBase = { type: "invalid_state", message: "OAuth state parameter is invalid", code: 400 };
export const ErrCodeExchangeFailed: AuthenticationErrorBase = { type: "code_exchange_failed", message: "Failed to exchange authorization code for tokens", code: 400 };
export const ErrServerStartFailed: AuthenticationErrorBase = { type: "server_start_failed", message: "Failed to start OAuth callback server", code: 500 };
/** Code 13 is the special exit code upstream uses for port-in-use. */
export const ErrPortInUse: AuthenticationErrorBase = { type: "port_in_use", message: "OAuth callback port is already in use", code: 13 };
export const ErrCallbackTimeout: AuthenticationErrorBase = { type: "callback_timeout", message: "Timeout waiting for OAuth callback", code: 408 };
export const ErrBrowserOpenFailed: AuthenticationErrorBase = { type: "browser_open_failed", message: "Failed to open browser for authentication", code: 500 };

export function newAuthenticationError(base: AuthenticationErrorBase, cause?: unknown): AuthenticationError {
  return new AuthenticationError(base.type, base.message, base.code, cause);
}

export function isAuthenticationError(err: unknown): err is AuthenticationError {
  return err instanceof AuthenticationError;
}

export function isOAuthError(err: unknown): err is OAuthError {
  return err instanceof OAuthError;
}

/** Port of GetUserFriendlyMessage. */
export function getUserFriendlyMessage(err: unknown): string {
  if (isAuthenticationError(err)) {
    switch (err.type) {
      case "token_expired":
        return "Your authentication has expired. Please log in again.";
      case "token_invalid":
        return "Your authentication is invalid. Please log in again.";
      case "authentication_required":
        return "Please log in to continue.";
      case "port_in_use":
        return "The required port is already in use. Please close any applications using port 3000 and try again.";
      case "callback_timeout":
        return "Authentication timed out. Please try again.";
      case "browser_open_failed":
        return "Could not open your browser automatically. Please copy and paste the URL manually.";
      default:
        return "Authentication failed. Please try again.";
    }
  }
  if (isOAuthError(err)) {
    switch (err.code) {
      case "access_denied":
        return "Authentication was cancelled or denied.";
      case "invalid_request":
        return "Invalid authentication request. Please try again.";
      case "server_error":
        return "Authentication server error. Please try again later.";
      default:
        return `Authentication failed: ${err.description}`;
    }
  }
  return "An unexpected error occurred. Please try again.";
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

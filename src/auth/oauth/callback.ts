// Parsing of a pasted OAuth callback URL (manual fallback when the local
// callback server is not reachable). Port of misc.ParseOAuthCallback from
// internal/misc/oauth.go.

export interface OAuthCallback {
  code: string;
  state: string;
  clientId: string;
  error: string;
  errorDescription: string;
}

/**
 * Extracts OAuth parameters from a callback URL, a bare query string or a
 * `code=...&state=...` fragment. Returns undefined for empty input and throws
 * when the input cannot be interpreted as a callback.
 */
export function parseOAuthCallback(input: string): OAuthCallback | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;

  let candidate = trimmed;
  if (!candidate.includes("://")) {
    if (candidate.startsWith("?")) {
      candidate = "http://localhost" + candidate;
    } else if (/[/?#]/.test(candidate) || candidate.includes(":")) {
      candidate = "http://" + candidate;
    } else if (candidate.includes("=")) {
      candidate = "http://localhost/?" + candidate;
    } else {
      throw new Error("invalid callback URL");
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (err) {
    throw new Error(`invalid callback URL: ${(err as Error).message}`);
  }

  const query = parsed.searchParams;
  let code = (query.get("code") ?? "").trim();
  let state = (query.get("state") ?? "").trim();
  let clientId = (query.get("client_id") ?? "").trim();
  let errCode = (query.get("error") ?? "").trim();
  let errDesc = (query.get("error_description") ?? "").trim();

  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (fragment !== "") {
    const fragQuery = new URLSearchParams(fragment);
    if (code === "") code = (fragQuery.get("code") ?? "").trim();
    if (state === "") state = (fragQuery.get("state") ?? "").trim();
    if (clientId === "") clientId = (fragQuery.get("client_id") ?? "").trim();
    if (errCode === "") errCode = (fragQuery.get("error") ?? "").trim();
    if (errDesc === "") errDesc = (fragQuery.get("error_description") ?? "").trim();
  }

  if (code !== "" && state === "" && code.includes("#")) {
    const idx = code.indexOf("#");
    state = code.slice(idx + 1);
    code = code.slice(0, idx);
  }

  if (errCode === "" && errDesc !== "") {
    errCode = errDesc;
    errDesc = "";
  }

  if (code === "" && errCode === "") {
    throw new Error("callback URL missing code");
  }

  return { code, state, clientId, error: errCode, errorDescription: errDesc };
}

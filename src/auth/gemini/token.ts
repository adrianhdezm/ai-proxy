// Gemini CLI token storage shape and file naming. Port of v7.0.12
// internal/auth/gemini/gemini_token.go.

/**
 * The `token` object stored in a Gemini CLI auth file: the Google OAuth token
 * (as golang.org/x/oauth2 marshals it) plus the client fields the Gemini CLI
 * writes alongside it.
 */
export interface GeminiTokenMap extends Record<string, unknown> {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  /** RFC3339 expiry (time.Time JSON). */
  expiry?: string;
  expires_in?: number;
  id_token?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  universe_domain?: string;
}

/** Persisted credential (GeminiTokenStorage); field names mirror the JSON keys. */
export interface GeminiTokenStorage {
  token: GeminiTokenMap;
  project_id: string;
  email: string;
  /** The project id was automatically selected. */
  auto: boolean;
  /** The Cloud AI companion API has been verified as enabled. */
  checked: boolean;
  type: "gemini";
}

/**
 * Returns the filename used to persist Gemini CLI credentials. A multi-project
 * id (comma separated or literal ALL) is normalised to "all" with the
 * "gemini-" prefix enforced.
 */
export function credentialFileName(email: string, projectID: string, includeProviderPrefix: boolean): string {
  email = email.trim();
  const project = projectID.trim();
  if (project.toLowerCase() === "all" || project.includes(",")) return `gemini-${email}-all.json`;
  const prefix = includeProviderPrefix ? "gemini-" : "";
  return `${prefix}${email}-${project}.json`;
}

/** Port of SaveTokenToFile's serialisation step: storage fields with `type` forced to "gemini". */
export function geminiStorageToMetadata(storage: GeminiTokenStorage, extra?: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {
    token: { ...storage.token },
    project_id: storage.project_id,
    email: storage.email,
    auto: storage.auto,
    checked: storage.checked,
    type: "gemini",
  };
  if (extra) for (const [k, v] of Object.entries(extra)) data[k] = v;
  return data;
}

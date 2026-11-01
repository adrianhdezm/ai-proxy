// Token store contract shared by the file store and the Vault store.
// Port of sdk/auth/interfaces.go (TokenStore / TokenStorage).
import type { Auth } from "../auth/types.ts";

export interface TokenStore {
  /** Human readable backend name ("file", "vault"). */
  readonly kind: string;
  /** Persists the auth record and returns its storage id (file path or Vault key). */
  save(auth: Auth): Promise<string>;
  /** Lists every stored auth record. */
  list(): Promise<Auth[]>;
  /** Removes the record with the given id. Missing ids are not an error. */
  delete(id: string): Promise<void>;
}

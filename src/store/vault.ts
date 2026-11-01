// HashiCorp Vault KV v2 token store. New in this port (no upstream
// counterpart): the same JSON credential documents the file store writes are
// kept as KV v2 secrets under <mount>/<path-prefix>/<id>, so records can be
// migrated between the two backends by copying.
//
// Routes used:
//   POST   /v1/auth/approle/login                       AppRole login (when configured)
//   LIST   /v1/<mount>/metadata/<prefix>[/<folder>]     enumerate keys ("x/" = nested folder);
//          sent as GET ...?list=true (Vault's documented equivalent) because
//          fetch() rewrites the non-standard LIST verb to GET
//   GET    /v1/<mount>/data/<prefix>/<key>              read a record
//   POST   /v1/<mount>/data/<prefix>/<id>  {data: doc}  write a record
//   DELETE /v1/<mount>/metadata/<prefix>/<id>           destroy all versions
import { AttributePath, AttributeSource, AttributeSourceBackend, AuthSourceVault, type Auth } from "../auth/types.ts";
import { isObject } from "../util/json.ts";
import type { TokenStore } from "./types.ts";
import { authFromStoredRecord, recordFromAuth, validateAuthWeight, type PersistingTokenStore, type SaveOptions } from "./record.ts";

export interface VaultAppRole {
  roleId: string;
  secretId: string;
}

/** Minimal fetch signature so tests can inject a plain function. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface VaultStoreOptions {
  /** Vault address, e.g. https://vault.example.com:8200 (VAULT_ADDR). */
  address: string;
  /** Optional enterprise namespace sent as X-Vault-Namespace. */
  namespace?: string;
  /** KV v2 mount path (default "secret"). */
  mount?: string;
  /** Path under the mount where records live (default "ai-proxy/auths"). */
  pathPrefix?: string;
  /** Static client token. Ignored when approle is set. */
  token?: string;
  /** AppRole credentials; the client token is obtained by POST /v1/auth/approle/login. */
  approle?: VaultAppRole;
  /** fetch implementation (tests inject one). */
  fetch?: FetchLike;
  /** Clock in epoch ms (tests inject one); used for token lease expiry. */
  now?: () => number;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
}

/** Error raised for a non-2xx Vault response. */
export class VaultError extends Error {
  readonly status: number;
  readonly errors: string[];
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, errors: string[]) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    super(`vault ${method} ${path}: status ${status}${detail}`);
    this.name = "VaultError";
    this.status = status;
    this.errors = errors;
    this.method = method;
    this.path = path;
  }
}

export class VaultTokenStore implements TokenStore, PersistingTokenStore {
  readonly kind = "vault";
  private readonly address: string;
  private readonly namespace: string;
  private readonly mount: string;
  private readonly pathPrefix: string;
  private readonly staticToken: string;
  private readonly approle?: VaultAppRole;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private clientToken = "";
  /** Epoch ms after which the AppRole token must be renewed (0 = no expiry). */
  private tokenExpiresAt = 0;
  private loginInFlight?: Promise<void>;

  constructor(options: VaultStoreOptions) {
    const address = options.address.trim().replace(/\/+$/, "");
    if (address === "") throw new Error("vault store: address is required");
    this.address = address;
    this.namespace = options.namespace?.trim() ?? "";
    this.mount = trimSlashes(options.mount?.trim() || "secret");
    this.pathPrefix = trimSlashes(options.pathPrefix?.trim() || "ai-proxy/auths");
    this.staticToken = options.token?.trim() ?? "";
    if (options.approle && options.approle.roleId.trim() !== "") {
      this.approle = { roleId: options.approle.roleId.trim(), secretId: options.approle.secretId.trim() };
    }
    if (!this.approle && this.staticToken === "") {
      throw new Error("vault store: either a token or approle credentials are required");
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Public for diagnostics: mount and prefix the store writes under. */
  get location(): { address: string; mount: string; pathPrefix: string } {
    return { address: this.address, mount: this.mount, pathPrefix: this.pathPrefix };
  }

  async save(auth: Auth, options: SaveOptions = {}): Promise<string> {
    validateAuthWeight(auth);
    const id = this.resolveId(auth);
    if (auth.disabled && !options.createDisabled) {
      const existing = await this.request("GET", this.dataPath(id), undefined, [404]);
      if (existing.status === 404) return "";
    }
    const document = recordFromAuth(auth);
    await this.request("POST", this.dataPath(id), { data: document });
    const path = this.dataPath(id);
    auth.attributes[AttributePath] = path;
    auth.attributes[AttributeSource] = path;
    auth.attributes[AttributeSourceBackend] = AuthSourceVault;
    return id;
  }

  async list(): Promise<Auth[]> {
    const keys: string[] = [];
    await this.collectKeys("", keys);
    keys.sort();
    const out: Auth[] = [];
    for (const key of keys) {
      const auth = await this.readRecord(key);
      if (auth) out.push(auth);
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    const trimmed = trimSlashes(id.trim());
    if (trimmed === "") throw new Error("vault store: id is empty");
    await this.request("DELETE", this.metadataPath(trimmed), undefined, [404]);
  }

  // ---- KV v2 helpers -------------------------------------------------------

  private async collectKeys(folder: string, out: string[]): Promise<void> {
    const res = await this.request("GET", this.metadataPath(folder), undefined, [404], "list=true");
    if (res.status === 404) return;
    const data = isObject(res.body) && isObject(res.body.data) ? res.body.data : {};
    const keys = Array.isArray(data.keys) ? data.keys : [];
    for (const raw of keys) {
      if (typeof raw !== "string" || raw === "") continue;
      const full = folder === "" ? raw : `${folder}/${raw}`;
      if (raw.endsWith("/")) {
        await this.collectKeys(trimSlashes(full), out);
      } else {
        out.push(full);
      }
    }
  }

  private async readRecord(key: string): Promise<Auth | undefined> {
    const res = await this.request("GET", this.dataPath(key), undefined, [404]);
    if (res.status === 404) return undefined;
    const body = isObject(res.body) ? res.body : {};
    const data = isObject(body.data) ? body.data : {};
    const document = isObject(data.data) ? data.data : undefined;
    if (!document) return undefined;
    const meta = isObject(data.metadata) ? data.metadata : {};
    const updated = typeof meta.updated_time === "string" ? Date.parse(meta.updated_time) : NaN;
    const created = typeof meta.created_time === "string" ? Date.parse(meta.created_time) : NaN;
    const modifiedAt = Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : 0;
    return authFromStoredRecord(key, document, {
      path: this.dataPath(key),
      sourceBackend: AuthSourceVault,
      modifiedAt,
    });
  }

  private resolveId(auth: Auth): string {
    const id = trimSlashes(auth.id.trim());
    if (id === "") throw new Error("vault store: missing id");
    return id;
  }

  private dataPath(key: string): string {
    return joinPath(this.mount, "data", this.pathPrefix, key);
  }

  private metadataPath(key: string): string {
    return joinPath(this.mount, "metadata", this.pathPrefix, key);
  }

  // ---- HTTP ----------------------------------------------------------------

  private async ensureToken(force = false): Promise<string> {
    if (!this.approle) return this.staticToken;
    const expired = this.tokenExpiresAt > 0 && this.now() >= this.tokenExpiresAt;
    if (!force && this.clientToken !== "" && !expired) return this.clientToken;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    await this.loginInFlight;
    return this.clientToken;
  }

  private async login(): Promise<void> {
    if (!this.approle) return;
    const res = await this.rawRequest("POST", "auth/approle/login", { role_id: this.approle.roleId, secret_id: this.approle.secretId }, "");
    if (!res.ok) throw new VaultError("POST", "auth/approle/login", res.status, vaultErrors(res.body));
    const auth = isObject(res.body) && isObject(res.body.auth) ? res.body.auth : undefined;
    const token = auth && typeof auth.client_token === "string" ? auth.client_token : "";
    if (token === "") throw new VaultError("POST", "auth/approle/login", res.status, ["login response did not include auth.client_token"]);
    this.clientToken = token;
    const lease = auth && typeof auth.lease_duration === "number" ? auth.lease_duration : 0;
    // Renew a little before the lease ends so in-flight requests do not race expiry.
    this.tokenExpiresAt = lease > 0 ? this.now() + Math.max(1, Math.floor(lease * 0.9)) * 1000 : 0;
  }

  /**
   * Sends an authenticated request. A 403 triggers one AppRole re-login and
   * retry. Statuses listed in `allow` are returned instead of thrown.
   */
  private async request(method: string, path: string, body?: unknown, allow: number[] = [], query = ""): Promise<VaultResponse> {
    let token = await this.ensureToken();
    let res = await this.rawRequest(method, path, body, token, query);
    if (res.status === 403 && this.approle) {
      token = await this.ensureToken(true);
      res = await this.rawRequest(method, path, body, token, query);
    }
    if (res.ok || allow.includes(res.status)) return res;
    const label = query === "list=true" ? "LIST" : method;
    throw new VaultError(label, path, res.status, vaultErrors(res.body));
  }

  private async rawRequest(method: string, path: string, body: unknown, token: string, query = ""): Promise<VaultResponse> {
    const url = `${this.address}/v1/${encodePath(path)}${query === "" ? "" : `?${query}`}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token !== "") headers["X-Vault-Token"] = token;
    if (this.namespace !== "") headers["X-Vault-Namespace"] = this.namespace;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (this.timeoutMs > 0) init.signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    let parsed: unknown;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { errors: [text.slice(0, 512)] };
      }
    }
    return { ok: response.ok, status: response.status, body: parsed };
  }
}

interface VaultResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function vaultErrors(body: unknown): string[] {
  if (!isObject(body)) return [];
  const errors = body.errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter((e): e is string => typeof e === "string");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => trimSlashes(p))
    .filter((p) => p !== "")
    .join("/");
}

/** Percent-encodes each path segment while keeping the separators. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

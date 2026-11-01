// In-memory HashiCorp Vault KV v2 fake for store tests (Bun.serve on port 0).
// Implements: POST /v1/auth/approle/login, GET ?list=true / LIST on
// /v1/<mount>/metadata/<path>, GET+POST /v1/<mount>/data/<path>,
// DELETE /v1/<mount>/metadata/<path>. Tokens can be revoked to force a 403.

export interface FakeVaultOptions {
  mount?: string;
  /** Static tokens accepted as X-Vault-Token. */
  tokens?: string[];
  /** AppRole credentials; each login issues a fresh token "approle-token-<n>". */
  approle?: { roleId: string; secretId: string; leaseDuration?: number };
}

export interface FakeVaultRequest {
  method: string;
  path: string;
  query: string;
  namespace: string;
  token: string;
}

interface Secret {
  data: Record<string, unknown>;
  version: number;
  createdTime: string;
  updatedTime: string;
}

export class FakeVault {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly requests: FakeVaultRequest[] = [];
  readonly secrets = new Map<string, Secret>();
  readonly validTokens = new Set<string>();
  loginCount = 0;
  /** When set, the next matching request fails with this response once. */
  failNext?: { status: number; errors: string[] };
  private readonly mount: string;
  private readonly approle?: { roleId: string; secretId: string; leaseDuration?: number };
  private clock = Date.UTC(2026, 0, 1);

  constructor(options: FakeVaultOptions = {}) {
    this.mount = options.mount ?? "secret";
    for (const token of options.tokens ?? []) this.validTokens.add(token);
    this.approle = options.approle;
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req),
    });
  }

  get address(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  revokeToken(token: string): void {
    this.validTokens.delete(token);
  }

  /** Seeds a record directly (bypasses HTTP). */
  put(key: string, data: Record<string, unknown>): void {
    this.store(key, data);
  }

  private store(key: string, data: Record<string, unknown>): Secret {
    const now = new Date((this.clock += 1000)).toISOString();
    const existing = this.secrets.get(key);
    const secret: Secret = {
      data,
      version: (existing?.version ?? 0) + 1,
      createdTime: existing?.createdTime ?? now,
      updatedTime: now,
    };
    this.secrets.set(key, secret);
    return secret;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const token = req.headers.get("x-vault-token") ?? "";
    this.requests.push({ method: req.method, path, query: url.search.replace(/^\?/, ""), namespace: req.headers.get("x-vault-namespace") ?? "", token });

    if (this.failNext) {
      const fail = this.failNext;
      this.failNext = undefined;
      return this.json(fail.status, { errors: fail.errors });
    }

    if (path === "/v1/auth/approle/login") {
      if (req.method !== "POST") return this.json(405, { errors: ["unsupported operation"] });
      const body = (await req.json()) as { role_id?: string; secret_id?: string };
      if (!this.approle || body.role_id !== this.approle.roleId || body.secret_id !== this.approle.secretId) {
        return this.json(400, { errors: ["invalid role or secret ID"] });
      }
      this.loginCount += 1;
      const issued = `approle-token-${this.loginCount}`;
      this.validTokens.add(issued);
      return this.json(200, { auth: { client_token: issued, lease_duration: this.approle.leaseDuration ?? 3600, renewable: true } });
    }

    if (!this.validTokens.has(token)) return this.json(403, { errors: ["permission denied"] });

    const dataPrefix = `/v1/${this.mount}/data/`;
    const metaPrefix = `/v1/${this.mount}/metadata/`;
    if (path.startsWith(dataPrefix)) {
      const key = path.slice(dataPrefix.length);
      if (req.method === "GET") {
        const secret = this.secrets.get(key);
        if (!secret) return this.json(404, { errors: [] });
        return this.json(200, {
          data: { data: secret.data, metadata: { created_time: secret.createdTime, updated_time: secret.updatedTime, version: secret.version } },
        });
      }
      if (req.method === "POST" || req.method === "PUT") {
        const body = (await req.json()) as { data?: Record<string, unknown> };
        if (!body || typeof body.data !== "object" || body.data === null) return this.json(400, { errors: ["no data provided"] });
        const secret = this.store(key, body.data);
        return this.json(200, { data: { version: secret.version, created_time: secret.updatedTime } });
      }
      return this.json(405, { errors: ["unsupported operation"] });
    }
    if (path.startsWith(metaPrefix)) {
      const key = path.slice(metaPrefix.length).replace(/\/+$/, "");
      const isList = req.method === "LIST" || url.searchParams.get("list") === "true";
      if (isList) {
        const prefix = key === "" ? "" : `${key}/`;
        const keys = new Set<string>();
        for (const stored of this.secrets.keys()) {
          if (!stored.startsWith(prefix)) continue;
          const rest = stored.slice(prefix.length);
          const slash = rest.indexOf("/");
          keys.add(slash === -1 ? rest : `${rest.slice(0, slash + 1)}`);
        }
        if (keys.size === 0) return this.json(404, { errors: [] });
        return this.json(200, { data: { keys: [...keys].sort() } });
      }
      if (req.method === "DELETE") {
        this.secrets.delete(key);
        return new Response(null, { status: 204 });
      }
      return this.json(405, { errors: ["unsupported operation"] });
    }
    return this.json(404, { errors: ["no handler for route"] });
  }
}

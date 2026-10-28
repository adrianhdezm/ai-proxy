// Local OAuth callback server. Port of internal/auth/claude/oauth_server.go and
// internal/auth/codex/oauth_server.go (identical apart from the callback path),
// also used for the Gemini /oauth2callback handler from v7.0.12
// internal/auth/gemini/gemini_auth.go.
import { log } from "../../log.ts";

export interface OAuthResult {
  code: string;
  state: string;
  clientId: string;
  error: string;
}

export interface OAuthCallbackServerOptions {
  /** TCP port to listen on. 0 picks a free port (tests). */
  port: number;
  /** Callback path, e.g. "/callback", "/auth/callback" or "/oauth2callback". */
  callbackPath: string;
  /** Interface to bind. Upstream binds all interfaces (":port"). */
  hostname?: string;
  /** When false a callback without `state` is accepted (Gemini flow). Default true. */
  requireState?: boolean;
  /** Link shown on the success page. */
  platformUrl?: string;
  /** Product name shown on the success page. */
  productName?: string;
}

/**
 * Serves the OAuth redirect target on localhost, captures the first callback
 * and renders a small success page. Only the first result is kept; later
 * callbacks are dropped like the buffered channel in the Go version.
 */
export class OAuthCallbackServer {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private result: OAuthResult | undefined;
  private waiters: Array<(r: OAuthResult) => void> = [];
  readonly callbackPath: string;
  private readonly requestedPort: number;
  private readonly hostname: string;
  private readonly requireState: boolean;
  private readonly platformUrl: string;
  private readonly productName: string;

  constructor(opts: OAuthCallbackServerOptions) {
    this.requestedPort = opts.port;
    this.callbackPath = opts.callbackPath;
    this.hostname = opts.hostname ?? "0.0.0.0";
    this.requireState = opts.requireState ?? true;
    this.platformUrl = opts.platformUrl ?? "";
    this.productName = opts.productName ?? "";
  }

  /** The bound port (differs from the requested one when 0 was requested). */
  get port(): number {
    return this.server?.port ?? this.requestedPort;
  }

  get isRunning(): boolean {
    return this.server !== undefined;
  }

  /** Starts listening. Throws "port N is already in use" when the port is taken. */
  start(): void {
    if (this.server) throw new Error("server is already running");
    try {
      this.server = Bun.serve({
        port: this.requestedPort,
        hostname: this.hostname,
        idleTimeout: 10,
        fetch: (req) => this.handle(req),
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const text = err instanceof Error ? err.message : String(err);
      if (code === "EADDRINUSE" || /in use/i.test(text)) {
        throw new Error(`port ${this.requestedPort} is already in use`);
      }
      throw new Error(`server failed to start: ${text}`);
    }
  }

  /** Stops the server; waiting callers are not resolved. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      log.debug("Stopping OAuth callback server");
      await server.stop(true);
    }
  }

  /**
   * Resolves with the first callback result, or rejects with
   * "timeout waiting for OAuth callback" after timeoutMs.
   */
  waitForCallback(timeoutMs: number, signal?: AbortSignal): Promise<OAuthResult> {
    if (this.result) return Promise.resolve(this.result);
    return new Promise<OAuthResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("callback wait aborted"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      };
      const waiter = (r: OAuthResult) => {
        cleanup();
        resolve(r);
      };
      this.waiters.push(waiter);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error("timeout waiting for OAuth callback"));
        }, timeoutMs);
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private sendResult(result: OAuthResult): void {
    if (this.result) {
      log.warn("OAuth result already captured, result dropped");
      return;
    }
    this.result = result;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(result);
  }

  private handle(req: Request): Response {
    const url = new URL(req.url);
    if (url.pathname === this.callbackPath) return this.handleCallback(req, url);
    if (url.pathname === "/success") return this.handleSuccess(url);
    return new Response("Not Found", { status: 404 });
  }

  private handleCallback(req: Request, url: URL): Response {
    log.debug("Received OAuth callback");
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    const query = url.searchParams;
    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    const clientId = (query.get("client_id") ?? "").trim();
    const errorParam = query.get("error") ?? "";

    if (errorParam !== "") {
      log.error(`OAuth error received: ${errorParam}`);
      this.sendResult({ code: "", state: "", clientId: "", error: errorParam });
      return new Response(`OAuth error: ${errorParam}`, { status: 400 });
    }
    if (code === "") {
      log.error("No authorization code received");
      this.sendResult({ code: "", state: "", clientId: "", error: "no_code" });
      return new Response("No authorization code received", { status: 400 });
    }
    if (state === "" && this.requireState) {
      log.error("No state parameter received");
      this.sendResult({ code: "", state: "", clientId: "", error: "no_state" });
      return new Response("No state parameter received", { status: 400 });
    }

    this.sendResult({ code, state, clientId, error: "" });
    return new Response(null, { status: 302, headers: { Location: "/success" } });
  }

  private handleSuccess(url: URL): Response {
    const platformUrl = url.searchParams.get("platform_url") || this.platformUrl;
    const setupRequired = url.searchParams.get("setup_required") === "true";
    return new Response(renderSuccessHtml(this.productName, platformUrl, setupRequired), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Condensed version of LoginSuccessHtml / SetupNoticeHtml from html_templates.go. */
export function renderSuccessHtml(productName: string, platformUrl: string, setupRequired: boolean): string {
  const name = productName ? ` - ${escapeHtml(productName)}` : "";
  const link = platformUrl ? `<p><a href="${escapeHtml(platformUrl)}">Open the platform console</a></p>` : "";
  const notice = setupRequired && platformUrl
    ? `<p class="notice">Additional setup is required. Visit <a href="${escapeHtml(platformUrl)}">${escapeHtml(platformUrl)}</a> to finish configuring your account.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authentication Successful${name}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}
.container{text-align:center;background:#fff;padding:2.5rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,.1);max-width:480px;width:100%}
.notice{background:#fff8e1;border-radius:8px;padding:.75rem 1rem}
</style>
</head>
<body>
<div class="container">
<h1>Authentication Successful</h1>
<p>You have been authenticated. You can close this window and return to the terminal.</p>
${notice}
${link}
</div>
<script>setTimeout(function(){window.close()},3000)</script>
</body>
</html>`;
}

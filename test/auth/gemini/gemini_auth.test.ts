// New (no upstream test): Gemini CLI OAuth token exchange, refresh, expiry and
// Code Assist project discovery against a fake Google/Code Assist server
// (Bun.serve on port 0), plus the end-to-end GeminiAuthenticator.login/refresh.
// The client id/secret below are fakes; the real ones are supplied by the operator.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  GeminiAuth,
  GeminiAuthenticator,
  GeminiOAuthClientIdEnv,
  GeminiOAuthClientSecretEnv,
  ProjectSelectionRequiredError,
  Scopes,
  checkCloudAPIIsEnabled,
  credentialFileName,
  geminiCLIUserAgent,
  performGeminiCLISetup,
  resolveGeminiOAuthClient,
  type CodeAssistClient,
  type GeminiEndpoints,
} from "../../../src/auth/gemini/index.ts";
import { authExpirationTime, isAuthExpired } from "../../../src/auth/oauth/expiry.ts";
import { newAuth } from "../../../src/auth/types.ts";
import { fixedNow, fixedNowMs, noopSleep } from "../helpers.ts";

const client = { clientId: "fake-client-id.apps.googleusercontent.com", clientSecret: "fake-client-secret" };

interface FakeState {
  tokenRequests: URLSearchParams[];
  refreshResponse: Record<string, unknown>;
  loadResponse: Record<string, unknown>;
  onboardResponses: Record<string, unknown>[];
  onboardRequests: Record<string, unknown>[];
  serviceState: string;
  enableStatus: number;
  enableBody: string;
  authHeaders: string[];
  userAgents: string[];
}

let server: ReturnType<typeof Bun.serve>;
let endpoints: GeminiEndpoints;
let state: FakeState;

function resetState(): void {
  state = {
    tokenRequests: [],
    refreshResponse: { access_token: "refreshed-at", expires_in: 1800, token_type: "Bearer", scope: Scopes.join(" ") },
    loadResponse: { allowedTiers: [{ id: "free-tier", isDefault: true }] },
    onboardResponses: [{ done: true, response: { cloudaicompanionProject: { id: "backend-project" } } }],
    onboardRequests: [],
    serviceState: "ENABLED",
    enableStatus: 200,
    enableBody: "{}",
    authHeaders: [],
    userAgents: [],
  };
}

beforeAll(() => {
  resetState();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      state.authHeaders.push(req.headers.get("authorization") ?? "");
      state.userAgents.push(req.headers.get("user-agent") ?? "");
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        state.tokenRequests.push(form);
        if (form.get("client_id") !== client.clientId || form.get("client_secret") !== client.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({ access_token: "initial-at", refresh_token: "initial-rt", expires_in: 3600, token_type: "Bearer", id_token: "idt" });
        }
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== "initial-rt") return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json(state.refreshResponse);
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (url.pathname === "/userinfo") {
        if (req.headers.get("authorization") !== "Bearer initial-at") return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({ email: "user@example.com", verified_email: true });
      }
      if (url.pathname === "/v1internal:loadCodeAssist") return Response.json(state.loadResponse);
      if (url.pathname === "/v1internal:onboardUser") {
        state.onboardRequests.push((await req.json()) as Record<string, unknown>);
        const next = state.onboardResponses.length > 1 ? state.onboardResponses.shift()! : state.onboardResponses[0]!;
        return Response.json(next);
      }
      const svc = /^\/v1\/projects\/([^/]+)\/services\/cloudaicompanion\.googleapis\.com(:enable)?$/.exec(url.pathname);
      if (svc) {
        if (svc[2]) return new Response(state.enableBody, { status: state.enableStatus, headers: { "Content-Type": "application/json" } });
        return Response.json({ state: state.serviceState });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  endpoints = { authUrl: `${base}/auth`, tokenUrl: `${base}/token`, userInfoUrl: `${base}/userinfo`, codeAssistEndpoint: base, serviceUsageUrl: base };
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => resetState());

function codeAssistClient(accessToken = "initial-at"): CodeAssistClient {
  return { fetch: globalThis.fetch as unknown as CodeAssistClient["fetch"], accessToken, endpoints };
}

describe("resolveGeminiOAuthClient", () => {
  test("reads the client from the environment and explains what is missing", () => {
    expect(resolveGeminiOAuthClient({ [GeminiOAuthClientIdEnv]: " id ", [GeminiOAuthClientSecretEnv]: "sec" })).toEqual({ clientId: "id", clientSecret: "sec" });
    expect(() => resolveGeminiOAuthClient({})).toThrow(/GEMINI_OAUTH_CLIENT_ID.*GEMINI_OAUTH_CLIENT_SECRET.*oauth2\.ts/);
    expect(() => new GeminiAuth({ client: { clientId: "", clientSecret: "x" } })).toThrow("client id and secret are required");
  });
});

describe("GeminiAuth", () => {
  test("generateAuthURL requests offline access with consent", () => {
    const url = new URL(new GeminiAuth({ client, endpoints }).generateAuthURL("http://localhost:8085/oauth2callback", "st"));
    expect(url.searchParams.get("client_id")).toBe(client.clientId);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8085/oauth2callback");
    expect(url.searchParams.get("scope")).toBe(Scopes.join(" "));
    expect(url.searchParams.get("state")).toBe("st");
  });

  test("exchanges a code and stamps the expiry", async () => {
    const auth = new GeminiAuth({ client, endpoints, now: fixedNow });
    const token = await auth.exchangeCode("good-code", "http://localhost:1/oauth2callback");
    expect(token).toMatchObject({ accessToken: "initial-at", refreshToken: "initial-rt", tokenType: "Bearer", expiresIn: 3600, idToken: "idt" });
    expect(Date.parse(token.expiry)).toBe(fixedNowMs + 3600_000);
    const form = state.tokenRequests[0]!;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("http://localhost:1/oauth2callback");
    const map = auth.buildTokenMap(token);
    expect(map).toMatchObject({ access_token: "initial-at", refresh_token: "initial-rt", token_type: "Bearer", token_uri: endpoints.tokenUrl, client_id: client.clientId, client_secret: client.clientSecret, scopes: [...Scopes], universe_domain: "googleapis.com" });
    await expect(auth.exchangeCode("bad", "http://localhost:1/oauth2callback")).rejects.toThrow("failed to exchange token failed with status 400");
  });

  test("refreshes and keeps the refresh token when Google omits it", async () => {
    const auth = new GeminiAuth({ client, endpoints, now: fixedNow });
    const token = await auth.refreshToken("initial-rt");
    expect(token.accessToken).toBe("refreshed-at");
    expect(token.refreshToken).toBe("initial-rt");
    expect(Date.parse(token.expiry)).toBe(fixedNowMs + 1800_000);
    await expect(auth.refreshToken("wrong")).rejects.toThrow("status 400");
    await expect(auth.refreshToken(" ")).rejects.toThrow("refresh token is required");
  });

  test("fetchUserInfo returns the email", async () => {
    const auth = new GeminiAuth({ client, endpoints });
    expect((await auth.fetchUserInfo("initial-at")).email).toBe("user@example.com");
    await expect(auth.fetchUserInfo("nope")).rejects.toThrow("status 401");
  });
});

describe("performGeminiCLISetup", () => {
  test("explicit project is onboarded and the backend id wins", async () => {
    const projectId = await performGeminiCLISetup(codeAssistClient(), "my-project", { sleep: noopSleep });
    expect(projectId).toBe("backend-project");
    expect(state.onboardRequests).toEqual([{ tierId: "free-tier", metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }, cloudaicompanionProject: "my-project" }]);
    expect(state.authHeaders.every((h) => h === "Bearer initial-at")).toBe(true);
    expect(state.userAgents.every((ua) => ua.startsWith("GeminiCLI/0.34.0/unknown ("))).toBe(true);
  });

  test("loadCodeAssist project is used when none is configured", async () => {
    state.loadResponse = { cloudaicompanionProject: "advertised-project", allowedTiers: [] };
    state.onboardResponses = [{ done: true, response: {} }];
    expect(await performGeminiCLISetup(codeAssistClient(), "", { sleep: noopSleep })).toBe("advertised-project");
    expect(state.onboardRequests[0]!.tierId).toBe("legacy-tier");
    expect(state.onboardRequests[0]!.cloudaicompanionProject).toBe("advertised-project");
  });

  test("auto-discovers a project via onboardUser without a project", async () => {
    state.loadResponse = { allowedTiers: [{ id: "free-tier", isDefault: true }] };
    state.onboardResponses = [
      { done: false },
      { done: true, response: { cloudaicompanionProject: "auto-project" } },
      { done: false },
      { done: true, response: { cloudaicompanionProject: { id: "auto-project" } } },
    ];
    expect(await performGeminiCLISetup(codeAssistClient(), "", { sleep: noopSleep })).toBe("auto-project");
    expect(state.onboardRequests).toHaveLength(4);
    expect("cloudaicompanionProject" in state.onboardRequests[0]!).toBe(false);
    expect(state.onboardRequests[2]!.cloudaicompanionProject).toBe("auto-project");
  });

  test("requires a project when auto-discovery yields none", async () => {
    state.onboardResponses = [{ done: true, response: {} }];
    await expect(performGeminiCLISetup(codeAssistClient(), "", { sleep: noopSleep })).rejects.toBeInstanceOf(ProjectSelectionRequiredError);
    let now = fixedNowMs;
    state.onboardResponses = [{ done: false }];
    await expect(performGeminiCLISetup(codeAssistClient(), "", { sleep: async () => void (now += 10_000), now: () => now, autoDiscoveryTimeoutMs: 15_000 })).rejects.toBeInstanceOf(ProjectSelectionRequiredError);
  });

  test("surfaces API failures", async () => {
    await expect(performGeminiCLISetup(codeAssistClient("bad"), "p", { sleep: noopSleep })).resolves.toBe("backend-project");
    const broken = { ...codeAssistClient(), endpoints: { ...endpoints, codeAssistEndpoint: `${endpoints.codeAssistEndpoint}/missing` } };
    await expect(performGeminiCLISetup(broken, "p", { sleep: noopSleep })).rejects.toThrow("load code assist: api request failed with status 404");
  });
});

describe("checkCloudAPIIsEnabled", () => {
  test("enabled service passes; disabled service is enabled", async () => {
    expect(await checkCloudAPIIsEnabled(codeAssistClient(), "p")).toBe(true);
    state.serviceState = "DISABLED";
    expect(await checkCloudAPIIsEnabled(codeAssistClient(), "p")).toBe(true);
    state.enableStatus = 400;
    state.enableBody = JSON.stringify({ error: { message: "Service already enabled" } });
    expect(await checkCloudAPIIsEnabled(codeAssistClient(), "p")).toBe(true);
    state.enableStatus = 403;
    state.enableBody = JSON.stringify({ error: { message: "permission denied" } });
    await expect(checkCloudAPIIsEnabled(codeAssistClient(), "p")).rejects.toThrow("project activation required: permission denied");
  });
});

describe("GeminiAuthenticator", () => {
  const quiet = { print: () => undefined, now: fixedNow, sleep: noopSleep, callbackHostname: "127.0.0.1" };

  test("login produces the upstream-compatible auth record", async () => {
    const authenticator = new GeminiAuthenticator({ client, endpoints });
    const auth = await authenticator.login({
      noBrowser: true,
      callbackPort: 0,
      projectId: "my-project",
      hooks: {
        ...quiet,
        onAuthorizationUrl: (url, port) => {
          const parsed = new URL(url);
          expect(parsed.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/oauth2callback`);
          void fetch(`http://127.0.0.1:${port}/oauth2callback?code=good-code&state=${parsed.searchParams.get("state")}`, { redirect: "manual" }).catch(() => undefined);
        },
      },
    });
    expect(auth.provider).toBe("gemini-cli");
    expect(auth.id).toBe("gemini-user@example.com-backend-project.json");
    expect(auth.metadata).toMatchObject({ type: "gemini", project_id: "backend-project", email: "user@example.com", auto: false, checked: true });
    const token = auth.metadata.token as Record<string, unknown>;
    expect(token).toMatchObject({ access_token: "initial-at", refresh_token: "initial-rt", token_type: "Bearer", client_id: client.clientId, universe_domain: "googleapis.com" });
    expect(authExpirationTime(auth)).toBe(fixedNowMs + 3600_000);
    expect(isAuthExpired(auth, fixedNowMs)).toBe(false);
    expect(isAuthExpired(auth, fixedNowMs + 3600_000)).toBe(true);
    expect(authenticator.refreshLead()).toBeUndefined();
  });

  test("login without a client falls back to the environment and fails clearly", async () => {
    const saved = { id: process.env[GeminiOAuthClientIdEnv], secret: process.env[GeminiOAuthClientSecretEnv] };
    delete process.env[GeminiOAuthClientIdEnv];
    delete process.env[GeminiOAuthClientSecretEnv];
    try {
      await expect(new GeminiAuthenticator({ endpoints }).login({ noBrowser: true, callbackPort: 0, hooks: quiet })).rejects.toThrow(GeminiOAuthClientIdEnv);
    } finally {
      if (saved.id !== undefined) process.env[GeminiOAuthClientIdEnv] = saved.id;
      if (saved.secret !== undefined) process.env[GeminiOAuthClientSecretEnv] = saved.secret;
    }
  });

  test("login rejects a callback error and an unknown code", async () => {
    const authenticator = new GeminiAuthenticator({ client, endpoints });
    const drive = (q: string) => (_url: string, port: number) => void fetch(`http://127.0.0.1:${port}/oauth2callback?${q}`, { redirect: "manual" }).catch(() => undefined);
    await expect(authenticator.login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, onAuthorizationUrl: drive("error=access_denied") } })).rejects.toThrow("authentication failed via callback: access_denied");
    await expect(authenticator.login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, onAuthorizationUrl: drive("code=bad-code") } })).rejects.toThrow("failed to exchange token");
    await expect(authenticator.login({ noBrowser: true, callbackPort: 0, hooks: { ...quiet, callbackTimeoutMs: 20 } })).rejects.toThrow("oauth flow timed out");
  });

  test("refresh rewrites the nested token and the top-level fields", async () => {
    const auth = newAuth({
      id: "gemini-user@example.com-p.json",
      provider: "gemini-cli",
      metadata: { type: "gemini", project_id: "p", email: "user@example.com", token: { access_token: "initial-at", refresh_token: "initial-rt", token_type: "Bearer", expiry: "2026-10-28T11:00:00Z", scopes: [...Scopes] } },
    });
    expect(isAuthExpired(auth, fixedNowMs)).toBe(true);
    const updated = await new GeminiAuthenticator({ client, endpoints }).refresh(auth, { now: fixedNow });
    const token = updated.metadata.token as Record<string, unknown>;
    expect(token.access_token).toBe("refreshed-at");
    expect(token.refresh_token).toBe("initial-rt");
    expect(token.client_id).toBe(client.clientId);
    expect(Date.parse(token.expiry as string)).toBe(fixedNowMs + 1800_000);
    expect(updated.metadata.access_token).toBe("refreshed-at");
    expect(updated.metadata.refresh_token).toBe("initial-rt");
    expect(updated.metadata.token_type).toBe("Bearer");
    expect(Date.parse(updated.metadata.expiry as string)).toBe(fixedNowMs + 1800_000);
    expect(authExpirationTime(updated)).toBe(fixedNowMs + 1800_000);
    expect(isAuthExpired(updated, fixedNowMs)).toBe(false);
    expect((auth.metadata.token as Record<string, unknown>).access_token).toBe("initial-at");
    expect(state.tokenRequests[0]!.get("grant_type")).toBe("refresh_token");
  });

  test("refresh without a refresh token returns the auth unchanged", async () => {
    const auth = newAuth({ id: "g.json", provider: "gemini-cli", metadata: { token: { access_token: "a" } } });
    expect(await new GeminiAuthenticator({ client, endpoints }).refresh(auth)).toBe(auth);
  });
});

describe("credentialFileName / user agent", () => {
  test("file names", () => {
    expect(credentialFileName(" a@b ", " proj ", true)).toBe("gemini-a@b-proj.json");
    expect(credentialFileName("a@b", "proj", false)).toBe("a@b-proj.json");
    expect(credentialFileName("a@b", "ALL", false)).toBe("gemini-a@b-all.json");
    expect(credentialFileName("a@b", "p1,p2", false)).toBe("gemini-a@b-all.json");
  });

  test("user agent shape", () => {
    expect(geminiCLIUserAgent("")).toMatch(/^GeminiCLI\/0\.34\.0\/unknown \(.+; .+; terminal\)$/);
    expect(geminiCLIUserAgent("gemini-2.5-pro")).toContain("/gemini-2.5-pro (");
  });
});

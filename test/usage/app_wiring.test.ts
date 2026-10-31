// New (no upstream test): createApp builds the usage statistics from config.usage.statisticsEnabled,
// exposes them on the App and serves them on GET /v0/usage.
import { expect, test } from "bun:test";
import { createApp } from "../../src/app.ts";
import type { Auth } from "../../src/auth/types.ts";
import { defaultConfig } from "../../src/config/load.ts";
import { ModelRegistry } from "../../src/registry/index.ts";
import type { PersistingTokenStore } from "../../src/store/index.ts";
import type { UsageResponseJSON } from "../../src/usage/statistics.ts";
import { fakeExecutor, messagesRequest, testAuth } from "../server/helpers.ts";

class MemoryStore implements PersistingTokenStore {
  readonly kind = "memory";
  constructor(private readonly items: Auth[]) {}
  async save(auth: Auth): Promise<string> {
    return auth.id;
  }
  async list(): Promise<Auth[]> {
    return this.items.map((a) => structuredClone(a));
  }
  async delete(): Promise<void> {}
}

async function buildApp(enabled: boolean) {
  const config = defaultConfig();
  config.loggingLevel = "error";
  config.access.apiKeys = ["sk-proxy-wiring-key"];
  config.usage.statisticsEnabled = enabled;
  const now = Date.parse("2026-10-28T12:00:00Z");
  const executor = fakeExecutor({
    identifier: "claude",
    execute: () => ({ payload: JSON.stringify({ type: "message", model: "m", content: [], usage: { input_tokens: 4, output_tokens: 6 } }) }),
  });
  const store = new MemoryStore([testAuth({ id: "claude-oauth.json", provider: "claude", metadata: { access_token: "oauth-secret-token", email: "user@example.com" } })]);
  const app = await createApp(config, { store, registry: new ModelRegistry(), executors: [executor], autoRefresh: false, now: () => now });
  return app;
}

test("enabled statistics are wired through createApp and GET /v0/usage", async () => {
  const app = await buildApp(true);
  try {
    expect(app.usage.enabled).toBe(true);
    const model = app.models()[0]!.id as string;
    const resp = await app.fetch(messagesRequest(model, false, { headers: { "x-api-key": "sk-proxy-wiring-key" } }));
    expect(resp.status).toBe(200);
    const usageResp = await app.fetch(new Request("http://proxy.test/v0/usage", { headers: { "x-api-key": "sk-proxy-wiring-key" } }));
    const text = await usageResp.text();
    expect(text).not.toContain("oauth-secret-token");
    expect(text).not.toContain("sk-proxy-wiring-key");
    const json = JSON.parse(text) as UsageResponseJSON;
    expect(json.usage.total_requests).toBe(1);
    expect(json.usage.total_tokens).toBe(10);
    expect(json.recent_requests[0]).toMatchObject({ provider: "claude", auth_id: "claude-oauth.json", source: "user@example.com", api_key: "sk-p...-key" });
  } finally {
    await app.stop();
  }
});

test("disabled statistics (the config default) discard records and hide the route", async () => {
  const app = await buildApp(false);
  try {
    expect(app.usage.enabled).toBe(false);
    const model = app.models()[0]!.id as string;
    await app.fetch(messagesRequest(model, false, { headers: { "x-api-key": "sk-proxy-wiring-key" } }));
    const usageResp = await app.fetch(new Request("http://proxy.test/v0/usage", { headers: { "x-api-key": "sk-proxy-wiring-key" } }));
    expect(usageResp.status).toBe(404);
    expect(app.usage.recent()).toEqual([]);
  } finally {
    await app.stop();
  }
});

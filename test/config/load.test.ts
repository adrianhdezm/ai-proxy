// New (no upstream test): simplified YAML layout, defaults, env overrides,
// "~" expansion, unknown-key warnings and loadConfig file handling.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, expandHome, loadConfig, parseConfig, resolveAuthDir } from "../../src/config/load.ts";
import { synthesizeApiKeyAuths } from "../../src/config/auths.ts";
import { DefaultCodexBaseURL, DefaultOpenAIBaseURL } from "../../src/config/types.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noEnv = { env: {}, home: "/home/tester" };

describe("defaults", () => {
  test("empty document yields the default config", () => {
    const cfg = parseConfig("", noEnv);
    const defaults = defaultConfig();
    defaults.auth.authDir = "/home/tester/.ai-proxy";
    expect(cfg).toEqual(defaults);
    expect(cfg.server.port).toBe(8317);
    expect(cfg.routing.strategy).toBe("round-robin");
    expect(cfg.routing.retry.maxAttempts).toBe(3);
    expect(cfg.requests.requestRetry).toBe(3);
    expect(cfg.quotaExceeded).toEqual({ switchProject: true, switchPreviewModel: true });
    expect(cfg.loggingLevel).toBe("info");
  });

  test("a null document or comments only also yields defaults", () => {
    expect(parseConfig("# just a comment\n", noEnv).server.port).toBe(8317);
    expect(parseConfig("~\n", noEnv).server.port).toBe(8317);
  });

  test("non-mapping top level is rejected", () => {
    expect(() => parseConfig("- a\n- b\n", noEnv)).toThrow("top level must be a mapping");
    expect(() => parseConfig("port: [8317\n", noEnv)).toThrow("failed to parse config file");
  });
});

describe("sections", () => {
  test("full nested layout", () => {
    const warnings: string[] = [];
    const cfg = parseConfig(
      `
server:
  host: "127.0.0.1"
  port: 9000
  max-request-body-bytes: 1048576
access:
  api-keys: ["k1", " k2 ", ""]
auth:
  store: vault
  auth-dir: "~/custom/auths"
  vault:
    address: "https://vault.example.com:8200/"
    namespace: "team"
    mount: "kv"
    path-prefix: "proxy/creds"
    token: "s.token"
    approle:
      role-id: "role"
      secret-id: "secret"
routing:
  strategy: fill-first
  retry:
    max-attempts: 5
    max-retry-credentials: 2
    max-retry-interval: 10
  cooldown:
    disabled: true
    transient-error-seconds: -1
requests:
  proxy-url: "socks5://proxy:1080"
  passthrough-headers: true
quota-exceeded:
  switch-project: false
  switch-preview-model: false
debug: false
logging-level: WARN
`,
      { ...noEnv, warn: (m) => warnings.push(m) },
    );
    expect(warnings).toEqual([]);
    expect(cfg.server).toEqual({ host: "127.0.0.1", port: 9000, maxRequestBodyBytes: 1048576 });
    expect(cfg.access.apiKeys).toEqual(["k1", "k2"]);
    expect(cfg.auth.store).toBe("vault");
    expect(cfg.auth.authDir).toBe("/home/tester/custom/auths");
    expect(cfg.auth.vault).toEqual({
      address: "https://vault.example.com:8200/",
      namespace: "team",
      mount: "kv",
      pathPrefix: "proxy/creds",
      token: "s.token",
      approle: { roleId: "role", secretId: "secret" },
    });
    expect(cfg.routing).toEqual({
      strategy: "fill-first",
      retry: { maxAttempts: 5, maxRetryCredentials: 2, maxRetryIntervalSeconds: 10 },
      cooldown: { disabled: true, transientErrorSeconds: -1 },
    });
    expect(cfg.requests).toEqual({ proxyUrl: "socks5://proxy:1080", passthroughHeaders: true, requestRetry: 5 });
    expect(cfg.quotaExceeded).toEqual({ switchProject: false, switchPreviewModel: false });
    expect(cfg.loggingLevel).toBe("warn");
  });

  test("upstream flat spellings are accepted", () => {
    const cfg = parseConfig(
      `
host: "0.0.0.0"
port: 8080
api-keys:
  - a
auth-dir: "/var/lib/ai-proxy"
proxy-url: "http://p:1"
passthrough-headers: true
request-retry: 7
max-retry-credentials: 3
max-retry-interval: 5
disable-cooling: true
transient-error-cooldown-seconds: 30
max-request-body-bytes: 10
`,
      noEnv,
    );
    expect(cfg.server).toEqual({ host: "0.0.0.0", port: 8080, maxRequestBodyBytes: 10 });
    expect(cfg.access.apiKeys).toEqual(["a"]);
    expect(cfg.auth.authDir).toBe("/var/lib/ai-proxy");
    expect(cfg.requests).toEqual({ proxyUrl: "http://p:1", passthroughHeaders: true, requestRetry: 7 });
    expect(cfg.routing.retry).toEqual({ maxAttempts: 7, maxRetryCredentials: 3, maxRetryIntervalSeconds: 5 });
    expect(cfg.routing.cooldown).toEqual({ disabled: true, transientErrorSeconds: 30 });
  });

  test("routing.retry.max-attempts wins over requests.request-retry", () => {
    const cfg = parseConfig("routing:\n  retry:\n    max-attempts: 1\nrequests:\n  request-retry: 9\n", noEnv);
    expect(cfg.routing.retry.maxAttempts).toBe(1);
    expect(cfg.requests.requestRetry).toBe(1);
    const only = parseConfig("requests:\n  request-retry: 2\n", noEnv);
    expect(only.routing.retry.maxAttempts).toBe(2);
    const negative = parseConfig("request-retry: -4\n", noEnv);
    expect(negative.routing.retry.maxAttempts).toBe(0);
  });

  test("debug implies debug logging unless a level is set", () => {
    expect(parseConfig("debug: true\n", noEnv).loggingLevel).toBe("debug");
    expect(parseConfig("debug: true\nlogging-level: error\n", noEnv).loggingLevel).toBe("error");
  });

  test("unknown enum values warn and fall back", () => {
    const warnings: string[] = [];
    const cfg = parseConfig("auth:\n  store: redis\nrouting:\n  strategy: random\nlogging-level: loud\n", { ...noEnv, warn: (m) => warnings.push(m) });
    expect(cfg.auth.store).toBe("file");
    expect(cfg.routing.strategy).toBe("round-robin");
    expect(cfg.loggingLevel).toBe("info");
    expect(warnings.length).toBe(3);
    expect(warnings[0]).toContain('auth.store "redis"');
    expect(warnings[1]).toContain('routing.strategy "random"');
    expect(warnings[2]).toContain('logging-level "loud"');
  });

  test("wrong scalar types are reported with their path", () => {
    expect(() => parseConfig("server:\n  port: eighty\n", noEnv)).toThrow("config: server.port must be an integer");
    expect(() => parseConfig("port: 80.5\n", noEnv)).toThrow("config: server.port must be an integer");
    expect(() => parseConfig("debug: maybe\n", noEnv)).toThrow("config: debug must be a boolean");
    expect(() => parseConfig("server:\n  host: [a]\n", noEnv)).toThrow("config: server.host must be a string");
  });

  test("unknown top-level keys only warn", () => {
    const warnings: string[] = [];
    const cfg = parseConfig("port: 1\nremote-management:\n  allow-remote: true\nplugins: {}\n", { ...noEnv, warn: (m) => warnings.push(m) });
    expect(cfg.server.port).toBe(1);
    expect(warnings).toEqual(["config: ignoring unknown top-level keys: remote-management, plugins"]);
  });
});

describe("vault env overrides", () => {
  test("VAULT_* environment variables override the file", () => {
    const cfg = parseConfig(
      "auth:\n  store: vault\n  vault:\n    address: http://file\n    token: file-token\n    namespace: file-ns\n    approle:\n      role-id: file-role\n      secret-id: file-secret\n",
      {
        home: "/h",
        env: { VAULT_ADDR: "http://env:8200", VAULT_TOKEN: "env-token", VAULT_NAMESPACE: "env-ns", VAULT_ROLE_ID: "env-role", VAULT_SECRET_ID: "env-secret" },
      },
    );
    expect(cfg.auth.vault.address).toBe("http://env:8200");
    expect(cfg.auth.vault.token).toBe("env-token");
    expect(cfg.auth.vault.namespace).toBe("env-ns");
    expect(cfg.auth.vault.approle).toEqual({ roleId: "env-role", secretId: "env-secret" });
  });

  test("empty env values do not override and approle stays unset without a role id", () => {
    const cfg = parseConfig("auth:\n  vault:\n    address: http://file\n", { home: "/h", env: { VAULT_ADDR: "  ", VAULT_SECRET_ID: "only-secret" } });
    expect(cfg.auth.vault.address).toBe("http://file");
    expect(cfg.auth.vault.approle).toBeUndefined();
    expect(cfg.auth.vault.mount).toBe("secret");
    expect(cfg.auth.vault.pathPrefix).toBe("ai-proxy/auths");
  });
});

describe("home expansion", () => {
  test("expandHome / resolveAuthDir", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/", "/home/u")).toBe("/home/u");
    expect(expandHome("~/.ai-proxy", "/home/u")).toBe("/home/u/.ai-proxy");
    expect(expandHome("~\\win\\path", "/home/u")).toBe("/home/u/win/path");
    expect(expandHome("/abs/dir/", "/home/u")).toBe("/abs/dir/");
    expect(resolveAuthDir("", "/home/u")).toBe("/home/u/.ai-proxy");
    expect(resolveAuthDir("  ~/x/../y  ", "/home/u")).toBe("/home/u/y");
    expect(resolveAuthDir("relative/dir", "/home/u")).toBe("relative/dir");
  });
});

describe("credential lists", () => {
  test("claude entries keep provider defaults and normalise prefix/headers/excluded models", () => {
    const cfg = parseConfig(
      `
claude-api-key:
  - api-key: " sk-1 "
    base-url: " https://gw.example.com "
    prefix: "/team-a/"
    label: " Team A "
    proxy-url: " direct "
    priority: 2
    weight: 4
    disable-cooling: true
    headers:
      " X-A ": " 1 "
      X-Empty: ""
      X-Num: 3
    excluded-models: ["Claude-3-*", " ", "claude-3-*", "*haiku*"]
    models:
      - name: " claude-sonnet-4-5 "
        alias: " sonnet "
        force-mapping: true
        thinking:
          min: 1024
          max: 32000
          zero-allowed: true
          levels: [low, high]
      - alias: no-name
  - api-key: ""
`,
      noEnv,
    );
    expect(cfg.claudeApiKeys.length).toBe(2);
    const key = cfg.claudeApiKeys[0]!;
    expect(key.apiKey).toBe("sk-1");
    expect(key.baseUrl).toBe("https://gw.example.com");
    expect(key.prefix).toBe("team-a");
    expect(key.label).toBe("Team A");
    expect(key.proxyUrl).toBe("direct");
    expect(key.priority).toBe(2);
    expect(key.weight).toBe(4);
    expect(key.disableCooling).toBe(true);
    expect(key.requestRetry).toBeUndefined();
    expect(key.headers).toEqual({ "X-A": "1", "X-Num": "3" });
    expect(key.excludedModels).toEqual(["claude-3-*", "*haiku*"]);
    expect(key.models).toEqual([
      {
        name: "claude-sonnet-4-5",
        alias: "sonnet",
        displayName: "",
        maxContextLength: 0,
        isCompat: false,
        forceMapping: true,
        thinking: { min: 1024, max: 32000, zeroAllowed: true, levels: ["low", "high"] },
      },
    ]);
    expect(cfg.claudeApiKeys[1]!.apiKey).toBe("");
    expect(cfg.claudeApiKeys[1]!.baseUrl).toBe("");
  });

  test("openai-api-key defaults base-url and drops empty entries; codex-api-key defaults to the Codex backend", () => {
    const cfg = parseConfig(
      `
openai-api-key:
  - api-key: "sk-openai"
  - api-key: "sk-custom"
    base-url: "https://proxy.example.com/v1"
  - api-key: ""
codex-api-key:
  - api-key: "sk-codex"
  - api-key: "sk-codex-2"
    base-url: "https://codex.example.com"
  - prefix: "multi/segment"
    base-url: "https://only-base.example.com"
`,
      noEnv,
    );
    expect(cfg.openaiApiKeys.map((k) => [k.apiKey, k.baseUrl])).toEqual([
      ["sk-openai", DefaultOpenAIBaseURL],
      ["sk-custom", "https://proxy.example.com/v1"],
    ]);
    expect(cfg.codexApiKeys.map((k) => [k.apiKey, k.baseUrl, k.prefix])).toEqual([
      ["sk-codex", DefaultCodexBaseURL, ""],
      ["sk-codex-2", "https://codex.example.com", ""],
      ["", "https://only-base.example.com", ""],
    ]);
  });

  test("malformed list entries are skipped with a warning", () => {
    const warnings: string[] = [];
    const cfg = parseConfig("claude-api-key:\n  - 12345\n  - [bad]\n  - api-key: ok\n    models:\n      - plain\n    headers: nope\n", { ...noEnv, warn: (m) => warnings.push(m) });
    expect(cfg.claudeApiKeys.map((k) => k.apiKey)).toEqual(["12345", "ok"]);
    expect(cfg.claudeApiKeys[1]!.models).toEqual([]);
    expect(warnings).toEqual([
      "config: claude-api-key[1] must be a mapping or a string; ignoring",
      "config: claude-api-key[2].headers must be a mapping; ignoring",
      "config: claude-api-key[2].models[0] must be a mapping; ignoring",
    ]);
    const notList = parseConfig("gemini-api-key: nope\n", { ...noEnv, warn: (m) => warnings.push(m) });
    expect(notList.geminiApiKeys).toEqual([]);
    expect(warnings.at(-1)).toBe("config: gemini-api-key must be a list; ignoring");
  });
});

describe("loadConfig", () => {
  test("reads the file and records the source path", async () => {
    const dir = tempDir();
    const path = join(dir, "config.yaml");
    writeFileSync(path, "server:\n  port: 1234\naccess:\n  api-keys: [k]\n");
    const cfg = await loadConfig(path, noEnv);
    expect(cfg.server.port).toBe(1234);
    expect(cfg.access.apiKeys).toEqual(["k"]);
    expect(cfg.sourcePath).toBe(path);
  });

  test("missing file is an error unless optional", async () => {
    const path = join(tempDir(), "missing.yaml");
    await expect(loadConfig(path, noEnv)).rejects.toThrow("failed to read config file");
    const cfg = await loadConfig(path, { ...noEnv, optional: true });
    expect(cfg.server.port).toBe(8317);
    expect(cfg.sourcePath).toBe(path);
  });

  test("the shipped config.example.yaml loads without warnings", async () => {
    const warnings: string[] = [];
    const cfg = await loadConfig(join(import.meta.dir, "..", "..", "config.example.yaml"), { ...noEnv, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
    expect(cfg.server.port).toBe(8317);
    expect(cfg.auth.store).toBe("file");
    expect(cfg.auth.authDir).toBe("/home/tester/.ai-proxy");
    expect(cfg.access.apiKeys).toEqual(["your-api-key-1", "your-api-key-2"]);
    expect(cfg.routing.retry.maxAttempts).toBe(3);
    expect(cfg.claudeApiKeys).toEqual([]);
  });
});

test("upstream, observability and multimedia sections", () => {
  const cfg = parseConfig(`
upstream:
  codex:
    stream-bootstrap-buffering: true
    stream-bootstrap-timeout: "1m20s"
    model-level-cooling: true
    disable-codex-cloaking: true
  claude:
    tool-search: true
    disable-claude-cloak-mode: true
    session-date-pin-days: 3
observability:
  usage:
    usage-statistics-enabled: true
multimedia:
  disable-image-generation: true
`);
  expect(cfg.upstream.codex).toEqual({ disableCloaking: true, streamBootstrapBuffering: true, streamBootstrapTimeoutMs: 80_000, modelLevelCooling: true });
  expect(cfg.upstream.claude).toEqual({ modelLevelCooling: false, disableCloakMode: true, sessionDatePinDays: 3, toolSearch: true });
  expect(cfg.usage.statisticsEnabled).toBe(true);
  expect(cfg.multimedia.disableImageGeneration).toBe(true);
  const defaults = parseConfig("");
  expect(defaults.upstream.codex.streamBootstrapBuffering).toBe(false);
  expect(defaults.upstream.codex.streamBootstrapTimeoutMs).toBe(0);
  expect(() => parseConfig(`upstream:\n  codex:\n    stream-bootstrap-timeout: "soon"\n`)).toThrow();
});

test("client.codex.web-search-result-cache and claude-api-key native-tool-search", () => {
  const cfg = parseConfig(`
client:
  codex:
    web-search-result-cache:
      enabled: true
      ttl: "30m"
      limit: 50
claude-api-key:
  - api-key: "k1"
    base-url: "https://gateway.example.com"
    native-tool-search: true
`);
  expect(cfg.client.codex.webSearchResultCache).toEqual({ enabled: true, ttlMs: 30 * 60_000, limit: 50 });
  expect(cfg.claudeApiKeys[0]!.nativeToolSearch).toBe(true);
  const auths = synthesizeApiKeyAuths(cfg);
  expect(auths[0]!.attributes.native_tool_search).toBe("true");
  expect(parseConfig("").client.codex.webSearchResultCache).toEqual({ enabled: false, ttlMs: 24 * 3_600_000, limit: 1024 });
});

// New (no upstream test): CLI argument parsing, config resolution and the auth list / models / help
// commands (the login flow is interactive and covered by test/auth/login.test.ts).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPathCandidates, describeAuth, main, parseArgs, resolveConfig, usage, type CLIIO } from "../../src/cli.ts";
import { FileTokenStore } from "../../src/store/index.ts";
import { testAuth } from "../server/helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureIO(): CLIIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line), env: {} };
}

test("parseArgs", () => {
  expect(parseArgs([])).toEqual({ command: "serve", positional: [], flags: {} });
  expect(parseArgs(["serve", "--config", "c.yaml", "--port=9000", "--host", "127.0.0.1"])).toEqual({ command: "serve", positional: [], flags: { config: "c.yaml", port: "9000", host: "127.0.0.1" } });
  expect(parseArgs(["login", "codex", "--no-browser", "--callback-port", "1455"])).toEqual({ command: "login", positional: ["codex"], flags: { "no-browser": true, "callback-port": "1455" } });
  expect(parseArgs(["auth", "migrate", "--from", "file", "--to", "vault", "--dry-run"])).toEqual({ command: "auth", positional: ["migrate"], flags: { from: "file", to: "vault", "dry-run": true } });
  expect(parseArgs(["--help"]).flags.help).toBe(true);
});

test("--help and unknown commands", async () => {
  const io = captureIO();
  expect(await main(["--help"], io)).toBe(0);
  expect(io.out.join("\n")).toBe(usage);
  const bad = captureIO();
  expect(await main(["frobnicate"], bad)).toBe(2);
  expect(bad.err.join("\n")).toContain("unknown command");
  const noProvider = captureIO();
  expect(await main(["login"], noProvider)).toBe(2);
  expect(noProvider.err.join("\n")).toContain("claude | codex | gemini-cli");
});

test("config resolution: explicit path, defaults with a warning when nothing exists", async () => {
  expect(configPathCandidates("x.yaml", {})).toEqual(["x.yaml"]);
  expect(configPathCandidates(undefined, { AI_PROXY_CONFIG: "/etc/ai-proxy.yaml" })).toEqual(["/etc/ai-proxy.yaml"]);
  const candidates = configPathCandidates(undefined, {}, "/home/tester");
  expect(candidates[0]).toBe(join(process.cwd(), "config.yaml"));
  expect(candidates[1]).toBe("/home/tester/.ai-proxy/config.yaml");

  const io = captureIO();
  io.env = { AI_PROXY_CONFIG: join(tempDir(), "missing.yaml") };
  const config = await resolveConfig(undefined, io);
  expect(config.server.port).toBe(8317);
  expect(io.err.join("\n")).toContain("using defaults");
  await expect(resolveConfig(join(tempDir(), "nope.yaml"), captureIO())).rejects.toThrow("config file not found");
});

test("auth list prints ids, provider, status and disabled without token material", async () => {
  const dir = tempDir();
  const authDir = join(dir, "auths");
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `auth:\n  store: file\n  auth-dir: ${authDir}\n`);
  const store = new FileTokenStore({ baseDir: authDir });
  await store.save(testAuth({ id: "codex-user.json", provider: "codex", label: "user@example.com", metadata: { access_token: "super-secret-token", refresh_token: "super-secret-refresh", email: "user@example.com", plan_type: "plus" } }));
  await store.save(testAuth({ id: "claude-off.json", provider: "claude", disabled: true, status: "disabled", metadata: { access_token: "another-secret" } }), { createDisabled: true });

  const io = captureIO();
  expect(await main(["auth", "list", "--config", configPath], io)).toBe(0);
  const output = io.out.join("\n");
  expect(output).toContain("id=codex-user.json");
  expect(output).toContain("provider=codex");
  expect(output).toContain("plan=plus");
  expect(output).toContain("id=claude-off.json");
  expect(output).toContain("disabled=yes");
  expect(output).not.toContain("super-secret");
  expect(output).not.toContain("another-secret");

  const line = describeAuth(testAuth({ id: "x", provider: "claude", attributes: { api_key: "sk-ant-secret" }, metadata: { access_token: "tok" } }));
  expect(line).toContain("kind=api_key");
  expect(line).not.toContain("sk-ant-secret");
  expect(line).not.toContain("tok");

  const empty = captureIO();
  const emptyConfig = join(dir, "empty.yaml");
  writeFileSync(emptyConfig, `auth:\n  store: file\n  auth-dir: ${join(dir, "none")}\n`);
  expect(await main(["auth", "list", "--config", emptyConfig], empty)).toBe(0);
  expect(empty.out.join("\n")).toContain("no credentials");
});

test("auth migrate validates the store kinds", async () => {
  const dir = tempDir();
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `auth:\n  store: file\n  auth-dir: ${join(dir, "auths")}\n`);
  const io = captureIO();
  expect(await main(["auth", "migrate", "--from", "file", "--to", "file", "--config", configPath], io)).toBe(1);
  expect(io.err.join("\n")).toContain("must differ");
  const bad = captureIO();
  expect(await main(["auth", "migrate", "--from", "s3", "--to", "vault", "--config", configPath], bad)).toBe(1);
  expect(bad.err.join("\n")).toContain('--from must be "file" or "vault"');
});

test("models prints the advertised model list for the configured credentials", async () => {
  const dir = tempDir();
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `auth:\n  store: file\n  auth-dir: ${join(dir, "auths")}\nclaude-api-key:\n  - api-key: sk-ant-test\n    excluded-models: ["claude-haiku*"]\n`);
  const io = captureIO();
  expect(await main(["models", "--config", configPath], io)).toBe(0);
  const output = io.out.join("\n");
  expect(output).toContain("claude-sonnet-4-6");
  expect(output).not.toContain("claude-haiku");
  expect(output).not.toContain("sk-ant-test");
});

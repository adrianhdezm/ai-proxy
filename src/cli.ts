// Command line entry point: serve (default), login, auth list, auth migrate,
// models, --help. Port of the kept flags of cmd/server/main.go (--config,
// --claude-login / --codex-login / --login, --no-browser, --project_id) in a
// sub-command shape, plus the store migration this port adds.
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { newLoginManager } from "./auth/login.ts";
import type { Auth } from "./auth/types.ts";
import { defaultConfig, loadConfig } from "./config/load.ts";
import type { Config, StoreKind } from "./config/types.ts";
import { log, setLogLevel } from "./log.ts";
import { buildClaudeModelsResponse } from "./server/models.ts";
import { createTokenStore, migrate } from "./store/index.ts";
import type { JSONObject } from "./util/json.ts";

export const LoginProviders = ["claude", "codex", "gemini-cli"] as const;
export type LoginProvider = (typeof LoginProviders)[number];

export interface CLIIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Interactive prompt (undefined when stdin is not a TTY). */
  prompt?: (question: string) => Promise<string>;
  env?: Record<string, string | undefined>;
  /** Blocks until the process should exit (serve); defaults to never resolving. */
  wait?: () => Promise<void>;
}

export interface ParsedArgs {
  command: string;
  /** Positional arguments after the command. */
  positional: string[];
  /** --flag value / --flag=value / --flag (true). */
  flags: Record<string, string | boolean>;
}

export const usage = `ai-proxy - Claude Messages-compatible proxy for Codex, Claude and Gemini

Usage:
  ai-proxy [serve] [--config <path>] [--host <host>] [--port <port>]
  ai-proxy login <claude|codex|gemini-cli> [--no-browser] [--project <id>] [--callback-port <n>] [--config <path>]
  ai-proxy auth list [--config <path>]
  ai-proxy auth migrate --from <file|vault> --to <file|vault> [--dry-run] [--config <path>]
  ai-proxy models [--config <path>]
  ai-proxy --help

Config path: --config, else ./config.yaml, else ~/.ai-proxy/config.yaml; a missing
file starts the proxy with defaults (no credentials, open access on :8317).`;

/** Parses argv: the first non-flag token is the command (default "serve"). */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (body.startsWith("no-") || next === undefined || next.startsWith("--")) {
        flags[body] = true;
        continue;
      }
      flags[body] = next;
      i++;
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    positional.push(arg);
  }
  const command = positional.shift() ?? "serve";
  return { command, positional, flags };
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

/** Candidate config paths in order: --config, ./config.yaml, ~/.ai-proxy/config.yaml. */
export function configPathCandidates(explicit: string | undefined, env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  if (explicit && explicit.trim() !== "") return [explicit.trim()];
  const fromEnv = env.AI_PROXY_CONFIG?.trim();
  if (fromEnv) return [fromEnv];
  return [join(process.cwd(), "config.yaml"), join(home, ".ai-proxy", "config.yaml")];
}

/** Loads the first config candidate that exists; defaults with a warning when none does. */
export async function resolveConfig(explicit: string | undefined, io: CLIIO): Promise<Config> {
  const candidates = configPathCandidates(explicit, io.env);
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return loadConfig(candidate, { env: io.env, warn: (message) => io.stderr(`warning: ${message}`) });
    }
  }
  if (explicit) throw new Error(`config file not found: ${explicit}`);
  io.stderr(`warning: no config file found (looked for ${candidates.join(", ")}); using defaults`);
  return defaultConfig();
}

function applyServeFlags(config: Config, flags: Record<string, string | boolean>): Config {
  const host = flagString(flags, "host");
  const port = flagString(flags, "port");
  if (host !== undefined) config.server.host = host;
  if (port !== undefined) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`invalid --port ${JSON.stringify(port)}`);
    config.server.port = parsed;
  }
  return config;
}

/** Summary line for `auth list`; never includes token material. */
export function describeAuth(auth: Auth): string {
  const parts = [
    `id=${auth.id}`,
    `provider=${auth.provider}`,
    `status=${auth.status}`,
    `disabled=${auth.disabled ? "yes" : "no"}`,
  ];
  if (auth.label) parts.push(`label=${auth.label}`);
  if (auth.prefix) parts.push(`prefix=${auth.prefix}`);
  const email = auth.metadata?.email;
  if (typeof email === "string" && email !== "") parts.push(`account=${email}`);
  const plan = auth.metadata?.plan_type ?? auth.attributes?.plan_type;
  if (typeof plan === "string" && plan !== "") parts.push(`plan=${plan}`);
  if (auth.attributes?.api_key) parts.push("kind=api_key");
  if (auth.unavailable) parts.push("unavailable=yes");
  if (auth.statusMessage) parts.push(`message=${auth.statusMessage}`);
  return parts.join(" ");
}

function storeKind(value: string | undefined, flag: string): StoreKind {
  const kind = (value ?? "").trim().toLowerCase();
  if (kind === "file" || kind === "vault") return kind;
  throw new Error(`${flag} must be "file" or "vault"`);
}

const defaultIO: CLIIO = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  env: process.env,
  prompt: process.stdin.isTTY
    ? async (question: string) => {
        process.stdout.write(question);
        for await (const line of console) return line;
        return "";
      }
    : undefined,
};

/** Runs the CLI; returns the process exit code. */
export async function main(argv: string[], io: CLIIO = defaultIO): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.command === "help" || args.command === "--help") {
    io.stdout(usage);
    return 0;
  }
  try {
    switch (args.command) {
      case "serve":
        return await runServe(args, io);
      case "login":
        return await runLogin(args, io);
      case "auth":
        return await runAuth(args, io);
      case "models":
        return await runModels(args, io);
      default:
        io.stderr(`unknown command: ${args.command}\n\n${usage}`);
        return 2;
    }
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runServe(args: ParsedArgs, io: CLIIO): Promise<number> {
  const config = applyServeFlags(await resolveConfig(flagString(args.flags, "config"), io), args.flags);
  const app = await createApp(config);
  const server = app.start();
  io.stdout(`ai-proxy listening on http://${server.hostname}:${server.port} (${config.access.apiKeys.length > 0 ? "API key required" : "open access"})`);
  const wait =
    io.wait ??
    (() =>
      new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      }));
  await wait();
  io.stdout("shutting down");
  await app.stop();
  return 0;
}

async function runLogin(args: ParsedArgs, io: CLIIO): Promise<number> {
  const provider = (args.positional[0] ?? "").trim() as LoginProvider;
  if (!LoginProviders.includes(provider)) {
    io.stderr(`login requires a provider: ${LoginProviders.join(" | ")}`);
    return 2;
  }
  const config = await resolveConfig(flagString(args.flags, "config"), io);
  setLogLevel(config.debug ? "debug" : config.loggingLevel);
  const store = createTokenStore(config.auth);
  const manager = newLoginManager(store);
  const callbackPortRaw = flagString(args.flags, "callback-port");
  const callbackPort = callbackPortRaw !== undefined ? Number(callbackPortRaw) : undefined;
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65535)) throw new Error(`invalid --callback-port ${JSON.stringify(callbackPortRaw)}`);
  const result = await manager.login(provider, {
    noBrowser: flagBool(args.flags, "no-browser"),
    projectId: flagString(args.flags, "project") ?? flagString(args.flags, "project_id"),
    callbackPort,
    proxyUrl: config.requests.proxyUrl || undefined,
    prompt: io.prompt,
    hooks: {
      print: (line) => io.stdout(line),
      onAuthorizationUrl: (url) => io.stdout(`Open this URL to authorize:\n${url}`),
    },
  });
  const where = result.savedId ?? result.auth.id;
  io.stdout(`login successful: ${describeAuth(result.auth)}`);
  io.stdout(`credential saved to ${store.kind} store as ${where}`);
  return 0;
}

async function runAuth(args: ParsedArgs, io: CLIIO): Promise<number> {
  const sub = args.positional[0] ?? "";
  const config = await resolveConfig(flagString(args.flags, "config"), io);
  switch (sub) {
    case "list": {
      const store = createTokenStore(config.auth);
      const auths = await store.list();
      if (auths.length === 0) {
        io.stdout(`no credentials in the ${store.kind} store`);
        return 0;
      }
      for (const auth of auths) io.stdout(describeAuth(auth));
      return 0;
    }
    case "migrate": {
      const from = storeKind(flagString(args.flags, "from"), "--from");
      const to = storeKind(flagString(args.flags, "to"), "--to");
      if (from === to) throw new Error("--from and --to must differ");
      const source = createTokenStore({ ...config.auth, store: from });
      const target = createTokenStore({ ...config.auth, store: to });
      const dryRun = flagBool(args.flags, "dry-run");
      const result = await migrate(source, target, {
        dryRun,
        onRecord: (auth, targetId) => io.stdout(`${dryRun ? "would copy" : "copied"} ${auth.id} -> ${targetId}`),
      });
      for (const failure of result.failed) io.stderr(`failed ${failure.id}: ${failure.error}`);
      io.stdout(`${dryRun ? "dry run: " : ""}${result.copied.length} copied, ${result.skipped.length} skipped, ${result.failed.length} failed (${from} -> ${to})`);
      return result.failed.length > 0 ? 1 : 0;
    }
    default:
      io.stderr(`auth requires a sub-command: list | migrate\n\n${usage}`);
      return 2;
  }
}

async function runModels(args: ParsedArgs, io: CLIIO): Promise<number> {
  const config = await resolveConfig(flagString(args.flags, "config"), io);
  const app = await createApp(config, { autoRefresh: false });
  try {
    const response = buildClaudeModelsResponse(app.models(), true);
    const data = Array.isArray(response.data) ? (response.data as JSONObject[]) : [];
    if (data.length === 0) {
      io.stdout("no models available (no credentials loaded)");
      return 0;
    }
    for (const model of data) {
      const id = typeof model.id === "string" ? model.id : "";
      const display = typeof model.display_name === "string" ? model.display_name : "";
      io.stdout(display && display !== id ? `${id}\t${display}` : id);
    }
    return 0;
  } finally {
    await app.stop();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

// Process entry point (`bun run src/index.ts [command]`) and the library surface.
export { createApp, registerAuthModels, modelsForAuth, buildConfigModels, applyModelPrefixes, type App, type AppOptions } from "./app.ts";
export { createServer, type ProxyServer, type ServerOptions } from "./server/server.ts";
export { createExecutors } from "./executor/index.ts";
export { main, parseArgs, usage } from "./cli.ts";

if (import.meta.main) {
  const { main } = await import("./cli.ts");
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

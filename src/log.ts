// Minimal leveled logger. Secrets must never be logged.
export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function logLevel(): LogLevel {
  return current;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (order[level] < order[current]) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}]`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

// Time helpers mirroring the Go formatting used in the auth JSON files.

/** Clock function injected into the auth services for deterministic tests. */
export type Clock = () => number;

/** Equivalent of time.Now().Format(time.RFC3339): second precision, UTC "Z". */
export function formatRFC3339(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Equivalent of time.Time JSON marshalling (RFC3339Nano); ISO with millis is accepted by Go. */
export function formatRFC3339Nano(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Parses the layouts accepted by sdk/cliproxy/auth parseTimeValue. Returns epoch ms. */
export function parseTimeValue(v: unknown): number | undefined {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return normaliseUnix(Math.trunc(v));
  }
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  // RFC3339 / RFC3339Nano / "2006-01-02T15:04:05Z07:00"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? undefined : ms;
  }
  // "2006-01-02 15:04:05" and "2006-01-02 15:04" (interpreted as UTC like time.Parse)
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (m) {
    const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ":00"}Z`);
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (/^-?\d+$/.test(s)) return normaliseUnix(Number(s));
  return undefined;
}

/** Heuristic from normaliseUnix: values above 1e12 are milliseconds, else seconds. */
export function normaliseUnix(raw: number): number | undefined {
  if (raw <= 0) return undefined;
  return raw > 1_000_000_000_000 ? raw : raw * 1000;
}

/** Awaitable delay; injected into retry loops so tests can skip the wait. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

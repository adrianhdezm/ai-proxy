// Minimal singleflight: concurrent calls with the same key share one in-flight
// promise (stand-in for golang.org/x/sync/singleflight used by the refresh paths).

export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();

  /** Runs fn once per key while a call is outstanding; later callers join it. */
  do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Drops the in-flight map (tests). */
  reset(): void {
    this.inflight = new Map();
  }
}

// Stream delivery acknowledgement. Port of sdk/cliproxy/usage/stream_delivery.go.
//
// Go attached the delivery to a context.Context so the HTTP consumer (not the
// upstream reader) decides when a streamed request is finished for usage
// accounting, independently of request cancellation. Here the consumer holds the
// StreamDelivery object directly: the forwarder resolves it on every exit (clean
// close, terminal error, client abort) and the usage recorder reacts to the first
// outcome. Later outcomes are ignored (Go: sync.Once).

export interface StreamDeliveryOutcome {
  /** The consumer's terminal error; undefined for a clean delivery. */
  error: unknown;
}

export class StreamDelivery {
  private outcome: StreamDeliveryOutcome | undefined;
  private readonly listeners: ((outcome: StreamDeliveryOutcome) => void)[] = [];
  private readonly waiters: ((outcome: StreamDeliveryOutcome) => void)[] = [];
  private supportCount = 0;

  /** Resolves the delivery; only the first call counts (Go: the finish func of WithStreamDelivery). */
  finish(error?: unknown): void {
    if (this.outcome) return;
    const outcome = { error };
    this.outcome = outcome;
    for (const listener of this.listeners.splice(0)) listener(outcome);
    for (const waiter of this.waiters.splice(0)) waiter(outcome);
  }

  /** Whether the consumer already resolved the delivery. */
  get finished(): boolean {
    return this.outcome !== undefined;
  }

  /** Runs `listener` synchronously with the outcome once it is known (immediately when already finished). */
  onFinish(listener: (outcome: StreamDeliveryOutcome) => void): void {
    if (this.outcome) listener(this.outcome);
    else this.listeners.push(listener);
  }

  /** Waits for the consumer, not the upstream reader, to finish (Go: WaitStreamDelivery). */
  wait(): Promise<StreamDeliveryOutcome> {
    if (this.outcome) return Promise.resolve(this.outcome);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Opts an active producer into delivery tracking; the returned release is idempotent (Go: SupportStreamDelivery). */
  support(): () => void {
    this.supportCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.supportCount--;
    };
  }

  /** Whether an active producer understands delivery (Go: StreamDeliverySupported). */
  get supported(): boolean {
    return this.supportCount > 0;
  }
}

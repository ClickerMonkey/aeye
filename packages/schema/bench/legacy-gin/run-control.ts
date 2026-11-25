// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * Options for one `Engine.run`: a way to stop it, and how often it lets other work in.
 */
export interface RunOptions {
  /**
   * Stops the run: once aborted, the next loop round or fn call throws the
   * signal's reason (a `RunStoppedError` when it has none).
   */
  signal?: AbortSignal;
  /**
   * The longest stretch, in ms, a run keeps the thread before it yields to the
   * event loop (so timers, I/O and other runs go on, and an abort can land).
   * Default 10.
   */
  slice?: number;
}

/** Thrown when a run's signal aborts without a reason of its own. */
export class RunStoppedError extends Error {
  constructor() {
    super('The run was stopped.');
    this.name = 'RunStoppedError';
  }
}

/** The default `RunOptions.slice`, in ms. */
export const DEFAULT_RUN_SLICE = 10;

/**
 * One run's control, shared by every scope of that run: loops and fn calls
 * pass through `checkpoint`, which throws once the run is stopped and yields
 * to the event loop when the run has held the thread for a whole slice.
 * Without it a run of microtasks never lets a timer fire, so neither a
 * deadline nor a cancel could reach it.
 */
export class RunControl {
  readonly signal: AbortSignal | undefined;
  readonly slice: number;
  #since = Date.now();

  constructor(options: RunOptions = {}) {
    this.signal = options.signal;
    this.slice = options.slice ?? DEFAULT_RUN_SLICE;
  }

  /** Throw when the run was stopped. */
  check(): void {
    const signal = this.signal;
    if (signal?.aborted !== true) return;
    const reason: unknown = signal.reason;
    throw reason instanceof Error ? reason : new RunStoppedError();
  }

  /** Throw when stopped; yield to the event loop once a slice has passed, then check again. */
  async checkpoint(): Promise<void> {
    this.check();
    if (Date.now() - this.#since < this.slice) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    this.#since = Date.now();
    this.check();
  }
}

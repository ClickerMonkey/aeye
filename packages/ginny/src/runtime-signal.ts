/**
 * Module-level holder for the in-flight request's AbortSignal.
 *
 * The entry point (`index.ts:runRequest`) calls `setRuntimeSignal` at
 * the start of each user request and clears it in `finally`. Native
 * implementations (fetch, llm, …) read it via `getRuntimeSignal()` and
 * forward it into their underlying I/O so an ESC interrupt cancels
 * HTTP requests / streamed completions instead of waiting for them to
 * settle.
 *
 * Tools receive the signal via `ctx.signal` directly — this module is
 * specifically for the gin engine path, where natives are invoked
 * without ctx threading.
 */
let current: AbortSignal | undefined;

export function setRuntimeSignal(signal: AbortSignal | undefined): void {
  current = signal;
}

export function getRuntimeSignal(): AbortSignal | undefined {
  return current;
}

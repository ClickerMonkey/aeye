/**
 * Helpers for letting tools and natives respond to the entry-point's
 * interrupt signal without each one re-implementing the same plumbing.
 *
 * - `throwIfAborted` — fast guard at function entry / between major
 *   awaits. Cheap; intended to bracket long sections of work.
 * - `withAbortRace` — wraps a promise in a `Promise.race` against the
 *   signal so a long-running operation that doesn't natively accept
 *   AbortSignal (Tavily SDK, puppeteer page.goto, etc.) still unwinds
 *   when ESC fires.
 */
export class AbortError extends Error {
  constructor(reason = 'aborted') {
    super(reason);
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

export function withAbortRace<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new AbortError());
    };
    signal.addEventListener('abort', onAbort);
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

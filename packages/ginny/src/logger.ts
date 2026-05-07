import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import v8 from 'v8';

/**
 * Generate a short (6 hex chars) "errorable-work" id. Stamp it on a
 * pair of log lines — `[id] <op> start` before the work, then either
 * `[id] <op> ok` or `[id] <op> error: <msg>` after — and surface the
 * id in the user-visible one-liner so a `grep <id> ginny.log` pulls
 * up the full context (params, stack, retry attempts, etc.).
 */
export function genId(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * Per-startup logger that writes to `./ginny.log` in the session CWD.
 * Wired into AI hooks + sub-agent invocations so every LLM request and
 * response is captured for later inspection / debugging.
 *
 * Truncated at startup — each ginny invocation gets a fresh log so the
 * file reflects only the current session. Older sessions roll off
 * naturally; if you need history, copy the file before launching ginny
 * again.
 */
export class Logger {
  private stream: fs.WriteStream;

  constructor(cwd: string) {
    const filePath = path.join(cwd, 'ginny.log');
    // 'w' truncates on open (vs. 'a' which appends). One file per
    // session keeps the post-mortem signal-to-noise ratio high.
    this.stream = fs.createWriteStream(filePath, { flags: 'w' });
    this.log(`=== ginny session start: ${new Date().toISOString()} ===`);
  }

  log(message: string): void {
    const ts = new Date().toISOString();
    this.stream.write(`[${ts}] ${message}\n`);
  }

  // ─── memory instrumentation ──────────────────────────────────────────────

  /** Highest `rss` we've ever observed this session, in bytes. Used to
   *  detect new high-water marks and tag them WARN in the log. */
  private peakRss = 0;
  /** Heap limit in bytes (v8's heap_size_limit) — the ceiling V8 will
   *  OOM at. Cached at first read. */
  private heapLimitBytes: number | undefined;

  /** Snapshot the current process memory and emit a compact one-liner
   *  to `ginny.log`. Format:
   *
   *    [mem] <label> rss=420MB heap=320/450/4096MB ext=12MB
   *                  └ resident set size                         (OS view of process memory)
   *                          └ heapUsed / heapTotal / heapLimit  (V8 view)
   *                                          └ external          (off-heap buffers)
   *
   *  Crosses heapUsed>80% of limit OR a new RSS high-water mark
   *  (>+100MB since last peak) get a `WARN` prefix so they're easy to
   *  grep when post-morteming an OOM. The whole call is allocation-
   *  free aside from the format string — safe to call frequently. */
  /**
   * Optional snapshot probes registered by the host. Each returns a
   * compact `key=value` string appended to the `[mem]` line — used by
   * leak hunting to surface counters that should grow lock-step with
   * memory (engine globals, registered named types, etc.). If those
   * grow per turn, they're the retainer; if they're flat while heap
   * climbs, the leak is somewhere else.
   */
  private probes: Array<() => string | null | undefined> = [];

  /** Register a probe — called on every `mem()`. Return `null` to skip
   *  a probe's contribution this snapshot. Probes should be O(1). */
  addMemProbe(probe: () => string | null | undefined): void {
    this.probes.push(probe);
  }

  mem(label: string): void {
    const m = process.memoryUsage();
    if (this.heapLimitBytes === undefined) {
      try { this.heapLimitBytes = v8.getHeapStatistics().heap_size_limit; }
      catch { this.heapLimitBytes = 0; }
    }
    const limit = this.heapLimitBytes ?? 0;
    const heapPct = limit > 0 ? m.heapUsed / limit : 0;
    const rssJumpMB = (m.rss - this.peakRss) / 1024 / 1024;
    const isPeak = m.rss > this.peakRss;
    if (isPeak) this.peakRss = m.rss;

    const flags: string[] = [];
    if (heapPct >= 0.85) flags.push(`heap@${(heapPct * 100).toFixed(0)}%`);
    if (isPeak && rssJumpMB >= 100) flags.push(`+${rssJumpMB.toFixed(0)}MB`);

    const fmt = (b: number): string => `${(b / 1024 / 1024).toFixed(0)}MB`;
    const heapStr = limit > 0
      ? `${fmt(m.heapUsed)}/${fmt(m.heapTotal)}/${fmt(limit)}`
      : `${fmt(m.heapUsed)}/${fmt(m.heapTotal)}`;
    const prefix = flags.length > 0 ? `WARN ` : '';
    const flagStr = flags.length > 0 ? ` (${flags.join(' ')})` : '';

    const probeBits: string[] = [];
    for (const p of this.probes) {
      try {
        const out = p();
        if (out) probeBits.push(out);
      } catch { /* probe failure shouldn't break logging */ }
    }
    const probeStr = probeBits.length > 0 ? ` ${probeBits.join(' ')}` : '';

    this.log(`[mem] ${prefix}${label} rss=${fmt(m.rss)} heap=${heapStr} ext=${fmt(m.external)}${flagStr}${probeStr}`);
  }

  /**
   * Serialize an object for the log. Circular refs become `[circular]`
   * and functions become `[function]`; otherwise the full payload is
   * written verbatim. ginny.log is a post-mortem artifact — preserving
   * complete prompts, responses, and tool args is more valuable than
   * a hard byte cap. Disk space is cheap; truncated logs leave you
   * unable to reproduce the failure.
   */
  logObject(label: string, obj: unknown): void {
    try {
      const seen = new WeakSet<object>();
      const serialized = JSON.stringify(obj, (_, v) => {
        if (typeof v === 'function') return '[function]';
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      }, 2);
      this.log(`${label}:\n${serialized}`);
    } catch (e: unknown) {
      this.log(`${label}: <unserializable: ${e instanceof Error ? e.message : String(e)}>`);
    }
  }

  close(): void {
    this.log(`=== ginny session end: ${new Date().toISOString()} ===`);
    this.stream.end();
  }
}

export const logger = new Logger(process.cwd());

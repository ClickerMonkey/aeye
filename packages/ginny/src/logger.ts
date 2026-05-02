import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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

  /**
   * Serialize an object for the log. Circular refs / functions →
   * placeholders. Hard-capped at 1 MB of serialized output to keep a
   * single accidental "log the whole world" call from allocating
   * gigabytes of intermediate string. The cap is enforced INSIDE the
   * stringify replacer (not after) so we never materialize the full
   * blob in memory — once we've emitted ~1 MB worth, every subsequent
   * non-primitive becomes `[…truncated]`.
   */
  logObject(label: string, obj: unknown): void {
    const MAX_BYTES = 1_000_000;
    let approxBytes = 0;
    let truncated = false;
    try {
      const seen = new WeakSet<object>();
      const serialized = JSON.stringify(obj, (_, v) => {
        if (truncated) return undefined;
        if (typeof v === 'function') return '[function]';
        if (typeof v === 'string' && v.length > 8192) {
          // Long strings (rendered prompts, JSON-serialized tool args)
          // dominate. Truncate them inline so they contribute a known
          // ceiling to the byte count.
          approxBytes += 8192;
          if (approxBytes > MAX_BYTES) { truncated = true; return '[…truncated]'; }
          return `${v.slice(0, 8192)}…[${v.length - 8192} more chars]`;
        }
        if (typeof v === 'string') {
          approxBytes += v.length;
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          approxBytes += 8;
        }
        if (approxBytes > MAX_BYTES) { truncated = true; return '[…truncated]'; }
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      }, 2);
      const suffix = truncated ? `\n[…log entry truncated at ~${MAX_BYTES} bytes]` : '';
      this.log(`${label}:\n${serialized}${suffix}`);
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

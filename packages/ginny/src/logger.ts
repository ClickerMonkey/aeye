import fs from 'fs';
import path from 'path';

/**
 * Append-only logger that writes to `./ginny.log` in the session CWD.
 * Wired into AI hooks + sub-agent invocations so every LLM request and
 * response is captured for later inspection / debugging.
 */
export class Logger {
  private stream: fs.WriteStream;

  constructor(cwd: string) {
    const filePath = path.join(cwd, 'ginny.log');
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.log(`=== ginny session start: ${new Date().toISOString()} ===`);
  }

  log(message: string): void {
    const ts = new Date().toISOString();
    this.stream.write(`[${ts}] ${message}\n`);
  }

  /** Serialize an object for the log. Circular refs / functions → placeholders. */
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

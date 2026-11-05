/**
 * Live test harness
 *
 * Live cases call real provider APIs, so each one runs only when it has not
 * yet passed with the same inputs against the same source. A pass is
 * recorded under `.live-cache/` (one file per case, so parallel Jest workers
 * never write the same file); any change to the case's inputs or to a file
 * under its source directories runs it again. Set `LIVE=force` to rerun
 * every case.
 *
 * @example
 * ```typescript
 * liveCase('openai gpt-5.4-nano accepts the deep schema', {
 *   sources: ['core', 'openai'],
 *   inputs: { model: 'gpt-5.4-nano', schema: 'deep' },
 * }, async () => {
 *   const chunk = await firstChunk((signal) => ai.chat.stream(request, { signal }));
 *   expect(chunk).toBeDefined();
 * });
 * ```
 */

import { it } from '@jest/globals';
import type { Chunk } from '@aeye/core';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const PACKAGES = path.resolve(__dirname, '../..');
const CACHE = path.resolve(__dirname, '../.live-cache');

/**
 * Packages whose source a live case depends on, by directory name.
 */
export type LiveSource = 'core' | 'ai' | 'openai' | 'openrouter' | 'aws' | 'models';

/**
 * What decides whether a live case has to run again.
 */
export interface LiveCaseKey {
  // Packages whose src (tests excluded) the case exercises
  sources: LiveSource[];
  // Everything else the request depends on: model, schema, options
  inputs: object;
}

const sourceHashes = new Map<LiveSource, string>();

/**
 * Every source file of a package, tests excluded, in a stable order.
 */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.name !== '__tests__')
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
    });
}

/**
 * A hash of a package's source, computed once per test run.
 */
function sourceHash(source: LiveSource): string {
  let hash = sourceHashes.get(source);
  if (!hash) {
    const digest = createHash('sha256');
    for (const file of sourceFiles(path.join(PACKAGES, source, 'src'))) {
      // Line endings vary by checkout; content is what matters
      digest.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    }
    hash = digest.digest('hex');
    sourceHashes.set(source, hash);
  }
  return hash;
}

/**
 * The fingerprint a pass is recorded under.
 */
function fingerprint(name: string, key: LiveCaseKey): string {
  return createHash('sha256')
    .update(name)
    .update(JSON.stringify(key.inputs))
    .update([...key.sources].sort().map(sourceHash).join())
    .digest('hex');
}

/**
 * Where a case's last pass is recorded.
 */
function cacheFile(name: string): string {
  return path.join(CACHE, `${createHash('sha256').update(name).digest('hex').slice(0, 24)}.json`);
}

/**
 * Whether the case already passed with this fingerprint.
 */
function passed(name: string, print: string): boolean {
  if (process.env.LIVE === 'force') {
    return false;
  }
  try {
    const record: { fingerprint: string } = JSON.parse(fs.readFileSync(cacheFile(name), 'utf8'));
    return record.fingerprint === print;
  } catch {
    return false;
  }
}

/**
 * A live test: skipped as already passed when nothing it depends on changed.
 *
 * @param name Unique case name
 * @param key Sources and inputs the case depends on
 * @param run The test body
 * @param timeout Per-case timeout in milliseconds
 */
export function liveCase(name: string, key: LiveCaseKey, run: () => Promise<void>, timeout = 60_000): void {
  const print = fingerprint(name, key);
  if (passed(name, print)) {
    it.skip(`${name} (passed, unchanged)`, () => {});
    return;
  }
  it(name, async () => {
    await run();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(cacheFile(name), JSON.stringify({ name, fingerprint: print, passedAt: new Date().toISOString() }, null, 2));
  }, timeout);
}

/**
 * Whether a chunk shows the model started answering: text, reasoning, a
 * tool call, or a refusal.
 */
function answered(chunk: Chunk): boolean {
  return !!(chunk.content || chunk.reasoning?.content || chunk.reasoning?.details?.length ||
    chunk.toolCallNamed || chunk.toolCallArguments || chunk.toolCall || chunk.refusal);
}

/**
 * Stream a request until the model starts answering, then cancel it, so a
 * check that the request was accepted costs a few output tokens at most.
 * Rejections such as a 400 for an unsupported schema surface as the
 * stream's error.
 *
 * @param start Starts the stream with the signal that cancels it
 * @returns The first answering chunk, or undefined if the stream ended without one
 */
export async function firstChunk(start: (signal: AbortSignal) => AsyncIterable<Chunk>): Promise<Chunk | undefined> {
  const controller = new AbortController();
  try {
    for await (const chunk of start(controller.signal)) {
      if (answered(chunk)) {
        return chunk;
      }
    }
    return undefined;
  } finally {
    controller.abort();
  }
}

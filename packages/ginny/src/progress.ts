import { AnyTool, Prompt, PromptEvent, Tuple } from '@aeye/core';
import { logger } from './logger';

/**
 * Stream a sub-agent prompt to completion, surfacing per-event progress
 * to the user so a long sub-run is visible (and interruptible) instead
 * of being a black box behind a single `→ tool` line.
 *
 * The parent display already prints the OUTER tool boundary (e.g.
 * `→ find_or_create_functions(...)` and its eventual `← (Xms)`); this
 * helper adds an indented inner timeline showing the sub-agent's tool
 * calls, ask prompts, and reasoning indicators with per-call timing.
 *
 * Sub-agent **text** is suppressed — sub-agents return structured
 * results, not user-facing prose, and their token-by-token chatter
 * would interleave with the parent's stdout. Tool boundaries and an
 * occasional thinking cue are enough to confirm progress.
 *
 * Aborts as soon as `ctx.signal` fires; raises whatever the prompt
 * raises so callers can decide whether to swallow or propagate.
 */
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;

const PREVIEW_MAX = 80;
const useColor = !!process.stderr.isTTY;
const c = (code: string, text: string): string =>
  useColor ? `${code}${text}${RESET}` : text;

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

type GetStreamOutput<TGetStream> = 
  TGetStream extends () => AsyncGenerator<infer _, infer TOutput | undefined>
    ? TOutput
    : never;

export async function runSubagent<
  TTools extends Tuple<AnyTool>,
  TGetStream extends () => AsyncGenerator<PromptEvent<any, TTools>, any>,
>(
  label: string,
  getStream: TGetStream,
  signal: AbortSignal | undefined,
): Promise<GetStreamOutput<TGetStream> | undefined> {
  const start = Date.now();
  process.stderr.write(`  ${c(DIM, `▸ ${label}`)}\n`);
  logger.log(`▸ ${label}`);

  let output: GetStreamOutput<TGetStream> | undefined;
  const toolStarts = new WeakMap<object, number>();
  let thinkingShownThisTurn = false;

  try {
    const events = getStream();
    for await (const event of events) {
      // Honor parent abort: bail out of consuming further events. The
      // sub-prompt's own signal listener will tear down its in-flight
      // streamer, but we stop draining here too so we don't keep the
      // parent waiting on a closing iterator.
      if (signal?.aborted) break;

      switch (event.type) {
        case 'request': {
          thinkingShownThisTurn = false;
          break;
        }
        case 'reasonPartial': {
          if (!thinkingShownThisTurn) {
            process.stderr.write(`    ${c(DIM, '(thinking…)')}\n`);
            thinkingShownThisTurn = true;
          }
          break;
        }
        case 'toolStart': {
          toolStarts.set(event.args, Date.now());
          const line = `    → ${event.tool.name}(${preview(event.args)})`;
          process.stderr.write(`${c(CYAN, line)}\n`);
          logger.log(line.trim());
          break;
        }
        case 'toolOutput': {
          const t = toolStarts.get(event.args);
          const elapsed = t ? Date.now() - t : 0;
          const line = `    ← ${event.tool.name} (${elapsed}ms): ${preview(event.result)}`;
          process.stderr.write(`${c(GREEN, line)}\n`);
          logger.log(line.trim());
          break;
        }
        case 'toolError': {
          const t = toolStarts.get(event.args);
          const elapsed = t ? Date.now() - t : 0;
          const line = `    ✗ ${event.tool.name} (${elapsed}ms): ${event.error}`;
          process.stderr.write(`${c(RED, line)}\n`);
          logger.log(line.trim());
          break;
        }
        case 'complete': {
          output = event.output as GetStreamOutput<TGetStream>;
          break;
        }
      }
    }
  } finally {
    const elapsed = Date.now() - start;
    const cancelled = signal?.aborted ? ' [cancelled]' : '';
    process.stderr.write(`  ${c(DIM, `✓ ${label} (${elapsed}ms)${cancelled}`)}\n`);
    logger.log(`✓ ${label} (${elapsed}ms)${cancelled}`);
  }

  return output;
}

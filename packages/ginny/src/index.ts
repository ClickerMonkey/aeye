#!/usr/bin/env node
// NOTE: AbortSignal listener cap. Lifted in two places, by design:
//
//   1. `esbuild.config.cjs` banner — patches `globalThis.AbortController`
//      so every signal created in the bundle (ours, the AI library's,
//      SDK internals, fetch's) is uncapped from birth. The banner runs
//      before any imported module's top-level code, so SDKs that capture
//      `globalThis.AbortController` at module init see the patched ctor.
//
//   2. `setMaxListeners(Infinity)` below — sets the global default for
//      future EventTargets/EventEmitters. Belt-and-suspenders: in some
//      Node versions EventTarget captures `defaultMaxListeners` at module
//      load and doesn't re-read it, which is why (1) is the load-bearing
//      fix; this one is the cheap "in case it works" addition.
import * as readline from 'readline';
import events from 'events';
events.setMaxListeners(Number.POSITIVE_INFINITY);

import type { Message } from '@aeye/core';
import { programmer } from './prompts/programmer';
import { EventDisplay } from './event-display';
import { logger, genId } from './logger';
import { aiInfo } from './ai';
import { setRuntimeSignal } from './runtime-signal';

/**
 * Single readline interface used for both the REPL prompt loop AND for
 * the `ask` tool. `rl.question` is one-at-a-time, but the timing works
 * out: while a request is being processed inside the outer
 * `rl.question` callback, the rl is "between questions" and free to
 * issue an inner question — when it resolves, the outer flow resumes
 * and eventually re-prompts for the next user request.
 */
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

// Emit `keypress` events on stdin so we can listen for ESC during an
// in-flight request and use it to interrupt the run cleanly.
readline.emitKeypressEvents(process.stdin);

/**
 * Resolve with the user's typed answer. Wired into every prompt's ctx
 * as `ask`, surfacing the `ask` tool to the model. Writes the question
 * to stdout (rather than stderr) so it shares the readline echo path
 * and stays cleanly above the next prompt line.
 *
 * Honors `signal` so a Ctrl+C in the parent run aborts a hung prompt:
 * the promise rejects with an Error and `rl.write('', { ctrl: true,
 * name: 'u' })` clears any half-typed input.
 */
function askUser(question: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      // Clear any half-typed line so the next prompt starts clean.
      try { rl.write('', { ctrl: true, name: 'u' } as any); } catch { /* ignore */ }
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort);
    process.stdout.write('\n');
    rl.question(`? ${question}\n> `, (answer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(answer.trim());
    });
  });
}

/**
 * A tiny spinner that animates on stderr while we wait for the first
 * event from the streamed prompt run. Clears itself when stopped.
 */
function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const isTTY = process.stderr.isTTY;
  if (!isTTY) {
    process.stderr.write(`${label}\n`);
    return () => {};
  }
  process.stderr.write(`${frames[0]} ${label}`);
  const id = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stderr.write(`\r${frames[i]} ${label}`);
  }, 80);
  return () => {
    clearInterval(id);
    process.stderr.write('\r\x1b[K'); // carriage return + clear to end of line
  };
}

/**
 * Conversation history carried across REPL turns. The user's text is
 * appended as a `user` message before each run, and every `message`
 * event the prompt emits (assistant + tool messages, plus retry-error
 * messages) is captured so the next run sees the full prior context.
 */
const history: Message[] = [];

async function runRequest(request: string): Promise<void> {
  const stopSpinner = startSpinner('ginny is thinking… (ESC to interrupt)');
  let spinnerStopped = false;
  const ensureSpinnerStopped = () => {
    if (!spinnerStopped) {
      stopSpinner();
      spinnerStopped = true;
    }
  };

  // Two ways to abort an in-flight request without killing the REPL:
  //   ESC     — primary interrupt; brings the user back to `> `
  //   Ctrl+C  — also aborts, kept for muscle memory
  // Once the request finishes, both listeners are removed so a Ctrl+C
  // at the idle prompt still exits the process via Node's default.
  //
  // ESC delivery is fiddly across platforms: readline reports it as
  // `key.name === 'escape'`; some terminals deliver only the raw
  // sequence in `str`; on Windows `data` events can fire ahead of
  // keypress decoding. Listen on both channels and match name OR raw
  // ESC byte so we don't miss the press.
  const abort = new AbortController();
  const triggerInterrupt = (source: string) => {
    if (abort.signal.aborted) return;
    process.stderr.write(`\n(interrupting via ${source}…)\n`);
    abort.abort();
  };
  const onSigint = () => triggerInterrupt('Ctrl+C');
  const onKeypress = (
    str: string | undefined,
    key: { name?: string; sequence?: string } | undefined,
  ) => {
    const isEsc = key?.name === 'escape'
      || str === '\x1b' || key?.sequence === '\x1b';
    if (isEsc) triggerInterrupt('ESC');
  };
  const onData = (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    // A bare ESC arrives as a single 0x1b byte; an ESC-prefixed
    // sequence (arrow keys, etc.) is two-or-more bytes starting with
    // 0x1b. Only treat the lone byte as an interrupt.
    if (buf.length === 1 && buf[0] === 0x1b) triggerInterrupt('ESC');
  };
  process.on('SIGINT', onSigint);
  process.stdin.on('keypress', onKeypress);
  process.stdin.on('data', onData);
  // Make sure stdin is actually flowing while we wait — readline pauses
  // it between `rl.question` calls on some platforms, which would mute
  // both keypress and data events.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  // Publish the signal for natives (fns.fetch / fns.llm) to forward
  // into their underlying I/O — the gin engine doesn't thread ctx
  // through native calls, so they can't read it from `ctx.signal`.
  setRuntimeSignal(abort.signal);

  const display = new EventDisplay();

  history.push({ role: 'user', content: request });

  try {
    const events = programmer.get(
      'stream',
      {},
      {
        signal: abort.signal,
        messages: history,
        ask: askUser,
        // Top-level request — propagates down through every recursive
        // designer/programmer pair so deep programmers know what the
        // user originally asked for, not just their immediate task.
        originalRequest: request,
      },
    );
    for await (const event of events) {
      // After ESC (or Ctrl+C), stop draining further events. The inner
      // streamer's signal listener tears down its in-flight request,
      // but the model may still be queuing up follow-up tool calls
      // that we shouldn't process — bail here so the run actually
      // unwinds back to the prompt instead of grinding through one
      // last iteration.
      if (abort.signal.aborted) break;
      // Keep the "ginny is thinking…" spinner alive until the model
      // actually produces something. `request`/`requestUsage` fire at
      // the start of an iteration, before any output, so they don't
      // count — otherwise the spinner gets killed in milliseconds.
      if (event.type !== 'request' && event.type !== 'requestUsage') {
        ensureSpinnerStopped();
      }
      if (event.type === 'message') {
        history.push(event.message);
      }
      display.handle(event);
    }
    if (!display.producedText) {
      // No text response (e.g. pure tool-only run, or empty answer).
      process.stdout.write('(no output)\n');
    }
    // No unconditional trailing newline here — when text WAS streamed,
    // `EventDisplay` already terminated it on the `text` /
    // `textComplete` event. Adding another `\n` here would produce a
    // blank line before the next `> ` prompt.
  } catch (e: unknown) {
    ensureSpinnerStopped();
    const err = e as { message?: string; stack?: string; name?: string };
    if (abort.signal.aborted) {
      process.stderr.write('\n(cancelled)\n');
    } else {
      // Keep the on-screen error short — zod / aggregate errors can
      // dump hundreds of lines that bury the prompt. Full message and
      // stack go to ginny.log for post-mortem; the 6-char id makes
      // both ends of the trail joinable via `grep <id> ginny.log`.
      const id = genId();
      const raw = err.message ?? String(e);
      const oneLiner = raw.replace(/\s+/g, ' ').trim();
      const short = oneLiner.length > 200 ? `${oneLiner.slice(0, 200)}…` : oneLiner;
      console.error(`\nError [${id}]: ${short}`);
      console.error(`(see ginny.log — search for ${id})`);
      logger.log(`[${id}] runRequest error: ${raw}`);
      if (err.stack) logger.log(`[${id}] stack:\n${err.stack}`);
    }
  } finally {
    process.off('SIGINT', onSigint);
    process.stdin.off('keypress', onKeypress);
    process.stdin.off('data', onData);
    setRuntimeSignal(undefined);
  }
}

/**
 * Render the post-clear startup summary: which providers came up, which
 * were skipped (with reasons), the unique set of model IDs the user has
 * pinned via env, and whether web research is wired up. When Tavily is
 * unset, point the user at the env var so the fix is one step away.
 */
function printStartupBanner(): void {
  const lines: string[] = [];
  lines.push('ginny ready.');
  lines.push('');

  const providers = aiInfo.providers.length > 0
    ? aiInfo.providers.join(', ')
    : '(none)';
  lines.push(`Providers: ${providers}`);
  for (const reason of aiInfo.skipped) {
    lines.push(`  · skipped ${reason}`);
  }

  if (aiInfo.models.size > 0) {
    lines.push(`Models: ${[...aiInfo.models].join(', ')}`);
  } else {
    lines.push('Models: (defaults — no GIN_MODEL or GIN_<KEY>_MODEL set)');
  }

  if (aiInfo.webSearch) {
    lines.push('Web research: enabled (tavily)');
  } else {
    lines.push('Web research: disabled — set TAVILY_API_KEY in config.json or env to enable (tavily.com)');
  }

  lines.push('');
  lines.push('Type a request. ESC interrupts a run, Ctrl+C exits.');
  console.log(lines.join('\n') + '\n');
}

async function main() {
  if (process.stdout.isTTY) console.clear();

  const userArg = process.argv[2];

  if (userArg) {
    await runRequest(userArg);
    rl.close();
    return;
  }

  printStartupBanner();

  const prompt = () => {
    rl.question('> ', async (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        await runRequest(trimmed);
        console.log();
      }
      prompt();
    });
  };

  prompt();
}

main().catch((e: unknown) => {
  const err = e as { message?: string; stack?: string };
  const raw = err.message ?? String(e);
  const oneLiner = raw.replace(/\s+/g, ' ').trim();
  const short = oneLiner.length > 200 ? `${oneLiner.slice(0, 200)}…` : oneLiner;
  console.error(`Error: ${short}`);
  logger.log(`Error: ${raw}`);
  if (err.stack) logger.log(err.stack);
  process.exit(1);
});

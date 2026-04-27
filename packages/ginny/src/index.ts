#!/usr/bin/env node
import * as readline from 'readline';
import type { Message } from '@aeye/core';
import { programmer } from './prompts/programmer';
import { EventDisplay } from './event-display';

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

/**
 * Resolve with the user's typed answer. Wired into every prompt's ctx
 * as `ask`, surfacing the `ask` tool to the model. Writes the question
 * to stdout (rather than stderr) so it shares the readline echo path
 * and stays cleanly above the next prompt line.
 */
function askUser(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write('\n');
    rl.question(`? ${question}\n> `, (answer) => {
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
  const stopSpinner = startSpinner('ginny is thinking…');
  let spinnerStopped = false;
  const ensureSpinnerStopped = () => {
    if (!spinnerStopped) {
      stopSpinner();
      spinnerStopped = true;
    }
  };

  // Wire Ctrl+C during a request so we can abort the stream cleanly
  // without tearing down the whole REPL.
  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.on('SIGINT', onSigint);

  const display = new EventDisplay();

  history.push({ role: 'user', content: request });

  try {
    const events = programmer.get(
      'stream',
      {},
      { signal: abort.signal, messages: history, ask: askUser },
    );
    for await (const event of events) {
      ensureSpinnerStopped();
      if (event.type === 'message') {
        history.push(event.message);
      }
      display.handle(event);
    }
    if (!display.producedText) {
      // No text response (e.g. pure tool-only run, or empty answer).
      process.stdout.write('(no output)');
    }
    process.stdout.write('\n');
  } catch (e: unknown) {
    ensureSpinnerStopped();
    const err = e as { message?: string; stack?: string; name?: string };
    if (abort.signal.aborted) {
      process.stderr.write('\n(cancelled)\n');
    } else {
      console.error('\nError:', err.message ?? String(e));
      if (err.stack) console.error(err.stack);
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function main() {
  if (process.stdout.isTTY) console.clear();

  const userArg = process.argv[2];

  if (userArg) {
    await runRequest(userArg);
    rl.close();
    return;
  }

  console.log('ginny ready. Type a request (Ctrl+C to exit).\n');

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

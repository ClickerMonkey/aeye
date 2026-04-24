#!/usr/bin/env node
import * as readline from 'readline';
import { programmer } from './prompts/programmer';

/**
 * A tiny spinner that animates on stderr while we wait for the first
 * streamed chunk from the LLM. Clears itself when stopped.
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

async function runRequest(request: string): Promise<void> {
  const stopSpinner = startSpinner('ginny is thinking…');
  let firstChunk = true;

  // Wire Ctrl+C during a request so we can abort the stream cleanly
  // without tearing down the whole REPL.
  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.on('SIGINT', onSigint);

  try {
    const stream = programmer.get('streamContent', { request }, { signal: abort.signal });
    for await (const chunk of stream) {
      if (firstChunk) {
        stopSpinner();
        firstChunk = false;
      }
      process.stdout.write(chunk);
    }
    if (firstChunk) {
      // Stream produced no text (pure tool-only run, or empty response).
      stopSpinner();
      process.stdout.write('(no output)');
    }
    process.stdout.write('\n');
  } catch (e: unknown) {
    stopSpinner();
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
  const userArg = process.argv[2];

  if (userArg) {
    await runRequest(userArg);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

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

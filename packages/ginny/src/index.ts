#!/usr/bin/env node
import * as readline from 'readline';
import { programmer } from './prompts/programmer';

async function runRequest(request: string) {
  try {
    const result = await programmer.get('result', { request }, {});
    console.log('\n' + (result ?? '(no output)'));
  } catch (e: any) {
    console.error('Error:', e?.message ?? e);
    if (e?.stack) console.error(e.stack);
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

  console.log('Gin CLI ready. Type your request (Ctrl+C to exit).\n');

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

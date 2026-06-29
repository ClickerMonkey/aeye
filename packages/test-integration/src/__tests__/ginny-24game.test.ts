/**
 * Ginny 24-game integration reproducer.
 *
 * Spawns the ginny CLI non-interactively with a `solve24(a,b,c,d)`
 * request, waits for completion (or the 15-min timeout), then parses
 * `ginny.log` from the run's working directory and emits a structured
 * report. Counts:
 *   - tool-arg parse errors (the double-encoded `program` failure we
 *     saw in the prior log)
 *   - tool-arg repair events (the new core fallback firing)
 *   - validation runs broken down by errors vs warnings
 *   - tool-iteration / cancellation markers
 *   - did the model save a fn to disk? (final outcome)
 *
 * Run with: npm test --workspace @aeye/test-integration -- --testPathPattern=ginny-24game
 *
 * Requires API keys — falls back to `packages/ginny/config.json` if
 * none are set in env. Skipped when no provider is available.
 */

import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GINNY_DIR = path.join(REPO_ROOT, 'packages/ginny');
const GINNY_ENTRY = path.join(GINNY_DIR, 'src/index.ts');
const GINNY_CONFIG_SRC = path.join(GINNY_DIR, 'config.json');
// Use the monorepo-root's tsx binary directly — it's the same one every
// workspace resolves via `npx tsx`, but referencing it absolutely avoids
// Windows PATH / shell quoting issues when spawning from a tmp cwd.
const TSX_BIN = path.join(
  REPO_ROOT,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

const REQUEST = `Create a function solve24(a: num, b: num, c: num, d: num): list<text> that solves the 24 game.
The function takes 4 numbers a, b, c, d and returns a list of expression strings (as text) that evaluate to 24.

Solver requirements:
1. Try all 24 permutations of (a, b, c, d).
2. Try all 4^3 = 64 operator combinations (each of +, -, *, / for the three operator slots).
3. Try all 5 distinct parenthesizations of four operands.
4. Use epsilon = 0.0001 for the final equality check (|result - 24| < epsilon).
5. Skip divisions by zero.
6. De-duplicate equivalent expressions.

Return an empty list if no solution exists.`;

// 15-minute hard cap — ginny's recursive programmer + designer loops can run long.
const TIMEOUT_MS = 15 * 60 * 1000;

const haveKey =
  !!process.env.OPENROUTER_API_KEY ||
  !!process.env.OPENAI_API_KEY ||
  existsSync(GINNY_CONFIG_SRC);

const maybe = haveKey ? describe : describe.skip;

maybe('Ginny 24-game reproducer', () => {
  let workDir: string;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let killed = false;
  let log = '';

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'ginny-24game-'));
    // Ginny insists on a `config.json` in cwd (creates a template + exits
    // when missing). Copy the user's existing config so env vars + provider
    // selection match the interactive workflow.
    if (existsSync(GINNY_CONFIG_SRC)) {
      copyFileSync(GINNY_CONFIG_SRC, path.join(workDir, 'config.json'));
    } else {
      writeFileSync(
        path.join(workDir, 'config.json'),
        JSON.stringify(
          {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
            GIN_MODEL: process.env.GIN_MODEL ?? '',
            GIN_PROVIDER: process.env.GIN_PROVIDER ?? '',
          },
          null,
          2,
        ),
      );
    }

    await new Promise<void>((resolve) => {
      // On Windows `shell: true` routes through cmd.exe which mangles
      // newline-containing args. We resolve tsx.cmd ourselves and run
      // it via node so the request string passes through unmolested.
      // `tsx.cmd` invokes the local tsx CLI via node under the hood;
      // we can call that CLI module directly to skip the cmd shell.
      const tsxCli = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
      const useDirect = existsSync(tsxCli);
      // Diagnostic env: large heap so a long run doesn't OOM before
      // we capture telemetry; full request/response payloads in the
      // log so we can see what the model actually sent; iteration
      // cap so a runaway loop terminates inside the 15-min window.
      const diagEnv: Record<string, string> = {
        ...process.env,
        FORCE_COLOR: '0',
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS ?? '',
          '--max-old-space-size=8192',
        ].filter(Boolean).join(' '),
        GIN_LOG_FULL_PAYLOAD: process.env.GIN_LOG_FULL_PAYLOAD ?? '1',
        GIN_TOOL_ITERATIONS: process.env.GIN_TOOL_ITERATIONS ?? '20',
      };
      const child = useDirect
        ? spawn(
            process.execPath,
            [tsxCli, '--conditions=source', GINNY_ENTRY, REQUEST],
            {
              cwd: workDir,
              env: diagEnv,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
        : spawn(
            TSX_BIN,
            ['--conditions=source', GINNY_ENTRY, REQUEST],
            {
              cwd: workDir,
              env: diagEnv,
              shell: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000);
      }, TIMEOUT_MS);
      child.on('exit', (code) => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
    });

    const logPath = path.join(workDir, 'ginny.log');
    if (existsSync(logPath)) log = readFileSync(logPath, 'utf-8');
  }, TIMEOUT_MS + 30_000);

  afterAll(() => {
    // Print the analysis report; jest's reporter shows test-level logs.
    const report = analyze({ workDir, exitCode, killed, stdout, stderr, log });
    console.log('\n========= GINNY 24-GAME REPORT =========\n' + report);
    // Always preserve workDir — the log + any saved fns/types are the
    // whole diagnostic payload. Cleanup happens manually after a run.
    console.log(`(working dir kept for inspection: ${workDir})`);
  });

  it('runs to completion or controlled timeout', () => {
    // Soft expectations: this is a reproducer; we want it to run, not
    // necessarily to succeed. Fail only if the spawn itself misfired.
    expect(log.length).toBeGreaterThan(0);
  });
});

interface AnalyzeInput {
  workDir: string;
  exitCode: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  log: string;
}

function analyze(input: AnalyzeInput): string {
  const { workDir, exitCode, killed, stdout, stderr, log } = input;
  const out: string[] = [];
  out.push(`workDir:        ${workDir}`);
  out.push(`exitCode:       ${exitCode}`);
  out.push(`killed:         ${killed}`);
  out.push(`stdout bytes:   ${stdout.length}`);
  out.push(`stderr bytes:   ${stderr.length}`);
  out.push(`log bytes:      ${log.length}`);
  out.push('');

  const lines = log.split(/\r?\n/);
  const toolWriteErrors = lines.filter((l) => /tool=write.*error: Error parsing tool arguments/.test(l));
  const repairSuccess = lines.filter((l) => /args repaired \(fields:/.test(l));
  const repairFailed = lines.filter((l) => /args repair-failed \(fields:/.test(l));
  const validationRuns = lines.filter((l) => /\bwrite validation \(/.test(l));
  // Tool-boundary failures (one line each) — short, prefixed with the
  // `[ts] tool=... (...ms): // FAILED:` shape that comes back from
  // designer/programmer sub-agent return values. Also count
  // `[mem] ... onError` mem snapshots emitted by `ai.ts` for each
  // upstream failure. Excludes:
  //   - system-prompt dumps that happen to contain "FAILED" inside
  //     prose (those are huge single-line JSON dumps from
  //     GIN_LOG_FULL_PAYLOAD=1)
  //   - quoted echoes of failure markers inside response payloads
  //     (`"text": "// FAILED: ..."` from logged tool_call results)
  const subagentFailures = lines.filter(
    (l) => l.length < 600 && /^\[[\d:.TZ-]+\]\s+\S.*\/\/ FAILED:/.test(l),
  );
  const upstreamErrors = lines.filter(
    (l) => l.length < 400 && /\b(?:chat onError|\[mem\][^\n]*onError)\b/.test(l),
  );
  const cancelledLines = [...subagentFailures, ...upstreamErrors];
  const ddrPanic = lines.filter((l) => l.length < 500 && /\b(?:UnhandledRejection|FATAL ERROR|uncaughtException)\b/.test(l));
  const historyLines = lines.filter((l) => /history turn=\d+ messages=/.test(l));
  const rawArgsLines = lines.filter((l) => /rawArgs \(\d+ chars\):/.test(l));

  out.push(`tool=write parse errors:        ${toolWriteErrors.length}`);
  out.push(`repair success / failed:        ${repairSuccess.length} / ${repairFailed.length}`);
  out.push(`write-validation runs:          ${validationRuns.length}`);
  out.push(`cancelled / FAILED / onError:   ${cancelledLines.length}`);
  out.push(`unhandled / fatal markers:      ${ddrPanic.length}`);
  out.push(`message-history snapshots:      ${historyLines.length}`);
  out.push(`rawArgs payloads captured:      ${rawArgsLines.length}`);
  out.push('');

  if (validationRuns.length) {
    out.push('-- write-validation summary --');
    for (const v of validationRuns.slice(0, 20)) out.push('  ' + v.trim());
    if (validationRuns.length > 20) out.push(`  ... +${validationRuns.length - 20} more`);
    out.push('');
  }

  if (toolWriteErrors.length) {
    out.push('-- first tool=write parse-error line --');
    out.push('  ' + toolWriteErrors[0]!.trim());
    out.push('');
  }

  if (repairSuccess.length || repairFailed.length) {
    out.push('-- tool-arg repair events --');
    for (const r of [...repairSuccess, ...repairFailed].slice(0, 10)) out.push('  ' + r.trim());
    out.push('');
  }

  if (historyLines.length) {
    out.push('-- message-history growth (first + last 3) --');
    const slice = historyLines.length > 6
      ? [...historyLines.slice(0, 1), '  …', ...historyLines.slice(-3)]
      : historyLines;
    for (const h of slice) out.push('  ' + h.trim());
    out.push('');
  }

  if (cancelledLines.length) {
    out.push('-- cancelled / FAILED / onError tail --');
    for (const c of cancelledLines.slice(-10)) out.push('  ' + c.trim());
    out.push('');
  }

  // Did anything land on disk?
  const fnsDir = path.join(workDir, 'fns');
  const typesDir = path.join(workDir, 'types');
  out.push('-- artifacts in workDir --');
  out.push(`  fns/:   ${existsSync(fnsDir) ? readdirSync(fnsDir).join(', ') || '(empty)' : '(not created)'}`);
  out.push(`  types/: ${existsSync(typesDir) ? readdirSync(typesDir).join(', ') || '(empty)' : '(not created)'}`);
  out.push('');

  if (stderr.length) {
    const tail = stderr.split(/\r?\n/).slice(-25).join('\n');
    out.push('-- stderr tail --\n' + tail + '\n');
  }

  return out.join('\n');
}

/**
 * The integration / eval HARNESS runner for `@aeye/gin` (mirrors
 * `@aeye/query`'s `integration/run.ts`).
 *
 *   npm run integration:check   # no key — validates fixtures + oracles (CI-safe)
 *   OPENROUTER_API_KEY=… npm run integration   # runs the real LLM eval
 *
 * THREE modes:
 *  1. `--check` (no key): the FIXTURE gate. Every case must declare ≥1 assertion
 *     AND ≥1 `'error'`-severity assertion. Each `a.produces` oracle is run over
 *     every input TWICE (deterministic) and asserted non-degenerate (defined, a
 *     valid value of the declared returnType). Every `fns` probe is run (the impl
 *     executes + returns its declared type). Every `a.refused` sample is asserted
 *     to FAIL `engine.validate`. Exits NON-ZERO on any problem. Proves the
 *     fixtures + oracles are internally consistent — WITHOUT calling an LLM.
 *  2. LLM eval (default, needs `OPENROUTER_API_KEY`): ask the model for a gin
 *     function body per case, parse + validate it, invoke it over the inputs, and
 *     evaluate EVERY assertion. The case PASSES iff every `'error'`-severity
 *     assertion passes. Writes a gitignored `logs/` trail.
 *  3. No key and no `--check`: print how to run, exit 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LambdaExpr } from '../src/index';

import { CASES, type EvalCase } from './cases/index';
import type { AssertCtx } from './cases/assert';
import {
  setupCase,
  invokeOverInputs,
  compareValues,
  type CaseRuntime,
  type InputOutcome,
} from './model';
import { createAsker, evalMode, DEFAULT_MODEL, type GinAsker } from './asker';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(HERE, 'logs');
/** Permanent per-run archive: `logs/runs/<ISO-ts>__<model>/`. Never overwritten. */
const RUNS_DIR = join(LOGS_DIR, 'runs');

/** Filesystem-safe unique run id: `<ISO-ts>__<model>`. */
function runStamp(when: Date, modelId: string): string {
  const ts = when.toISOString().replace(/[:.]/g, '-');
  const model = modelId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${ts}__${model}`;
}

// ════════════════════════════════════════════════════════════════════════════
// CLI filter flags (apply in BOTH --check and the LLM eval)
// ════════════════════════════════════════════════════════════════════════════

/** Read the value that follows a `--flag` in argv (`--flag value`), or null. */
function flagValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

/** Split a comma-separated flag value into trimmed, non-empty tokens. */
function csv(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Narrow `CASES` by `--only <id[,id...]>`, `--category <cat[,cat...]>`, and
 * `--limit <N>` (applied in that order). Throws if a requested id / category
 * matches nothing, or `--limit` is not a positive int.
 */
function selectCases(argv: readonly string[], cases: readonly EvalCase[]): readonly EvalCase[] {
  let selected = cases;

  const only = flagValue(argv, '--only');
  if (only !== null) {
    const ids = new Set(csv(only));
    selected = selected.filter((c) => ids.has(c.id));
    const missing = [...ids].filter((id) => !cases.some((c) => c.id === id));
    if (missing.length > 0) throw new Error(`--only: no case with id ${missing.join(', ')}`);
  }

  const category = flagValue(argv, '--category');
  if (category !== null) {
    const cats = new Set(csv(category));
    selected = selected.filter((c) => cats.has(c.category));
    const missing = [...cats].filter((cat) => !cases.some((c) => c.category === cat));
    if (missing.length > 0) throw new Error(`--category: no case in category ${missing.join(', ')}`);
  }

  const limit = flagValue(argv, '--limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive integer (got ${limit})`);
    selected = selected.slice(0, n);
  }

  return selected;
}

// ════════════════════════════════════════════════════════════════════════════
// --check mode (no key) — validate fixtures (oracles + fns + refusal samples)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a single case's fixture obligations WITHOUT an LLM:
 *  - it declares ≥1 assertion AND ≥1 `'error'`-severity assertion;
 *  - each `a.produces` oracle runs deterministically twice over every input and
 *    is non-degenerate (defined + a valid value of the declared returnType);
 *  - each `fns` probe runs (the impl executes + returns its declared type);
 *  - each `a.refused` sample FAILS `engine.validate` (wrapped as a lambda body).
 * Returns a list of problem strings (empty ⇒ the case's fixtures are coherent).
 */
function checkCase(c: EvalCase): string[] {
  const problems: string[] = [];
  if (c.assert.length === 0) {
    problems.push('no assertions declared');
    return problems;
  }
  if (!c.assert.some((asrt) => asrt.severity === 'error')) {
    problems.push('no error-severity assertion (needs ≥1 a.produces / a.refused, or a.require(...) a structural one)');
  }
  if (c.inputs.length === 0) problems.push('no inputs declared');

  let runtime: CaseRuntime;
  try {
    runtime = setupCase(c);
  } catch (err) {
    problems.push(`setup threw: ${err instanceof Error ? err.message : String(err)}`);
    return problems;
  }

  // Every fn probe runs, proving the impl executes + returns its declared type.
  for (const spec of runtime.fns) {
    if (!spec.probe) continue;
    try {
      const out = spec.impl(spec.probe);
      runtime.registry.parse(spec.returns).parse(out);
    } catch (err) {
      problems.push(`fn '${spec.name}' probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const asrt of c.assert) {
    if (asrt.oracle) {
      for (const input of c.inputs) {
        try {
          const first = asrt.oracle(input);
          const second = asrt.oracle(input);
          const det = compareValues(first, second, 0);
          if (!det.ok) {
            problems.push(`oracle non-deterministic for ${JSON.stringify(input)} (${det.diff})`);
            continue;
          }
          if (first === undefined) {
            problems.push(`oracle degenerate (undefined output) for ${JSON.stringify(input)}`);
            continue;
          }
          // Non-degenerate: the expected value must be a valid value of the
          // declared returnType (proves the oracle + type agree).
          try {
            runtime.returnsType.parse(first);
          } catch (err) {
            problems.push(`oracle output ${JSON.stringify(first)} is not a valid ${c.returnType.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          problems.push(`oracle threw for ${JSON.stringify(input)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (asrt.refusalSample) {
      try {
        const sample = asrt.refusalSample(runtime.registry);
        const body = runtime.registry.parseExpr(sample);
        // Validate as a lambda body so `args` / `recurse` are bound — the ONLY
        // problem left should be the deliberate illegality.
        const lambda = new LambdaExpr(runtime.fnType, body);
        const report = runtime.engine.validate(lambda);
        if (!report.hasErrors) problems.push('refusal sample validated cleanly but SHOULD have been rejected');
      } catch {
        // A throw during parse/validate IS a rejection — acceptable.
      }
    }
  }
  return problems;
}

function runCheck(cases: readonly EvalCase[]): number {
  let failures = 0;
  console.log(`\nintegration:check — validating ${cases.length} case fixture(s)…\n`);
  for (const c of cases) {
    const problems = checkCase(c);
    if (problems.length === 0) {
      const oracles = c.assert.filter((asrt) => asrt.oracle).length;
      const refusals = c.assert.filter((asrt) => asrt.refusalSample).length;
      const errors = c.assert.filter((asrt) => asrt.severity === 'error').length;
      const warns = c.assert.filter((asrt) => asrt.severity === 'warn').length;
      const fns = c.fns?.length ?? 0;
      const detail = [
        oracles ? `${oracles} oracle(s)` : '',
        refusals ? `${refusals} refusal(s)` : '',
        fns ? `${fns} fn(s)` : '',
        `${c.inputs.length} input(s)`,
        `${errors} error / ${warns} warn`,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`  ok    ${c.id.padEnd(34)} ${detail}`);
    } else {
      failures++;
      console.log(`  FAIL  ${c.id.padEnd(34)} ${problems.join('; ')}`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} case fixture(s) coherent.`);
  if (failures > 0) console.log(`${failures} FAILED — fix the oracle / fn / sample until clean.`);
  return failures === 0 ? 0 : 1;
}

// ════════════════════════════════════════════════════════════════════════════
// LLM eval mode (needs OPENROUTER_API_KEY)
// ════════════════════════════════════════════════════════════════════════════

/** One assertion's outcome for the logs. */
interface AssertionLog {
  describe: string;
  severity: 'error' | 'warn';
  needsResult: boolean;
  passed: boolean;
  reason: string | null;
}

/** Per-case log entry (keyed by id in `detail.json`). */
interface LogEntry {
  id: string;
  category: string;
  request: string;
  note: string;
  model: string;
  emittedProgram: unknown | null;
  parseError: string | null;
  problemCodes: string[];
  passed: boolean;
  assertions: AssertionLog[];
  outputs: (unknown | null)[];
  durationMs: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  rawText: string | null;
  timestamp: string;
}

async function runOneCase(asker: GinAsker, modelId: string, c: EvalCase): Promise<LogEntry> {
  const started = Date.now();
  const entry: LogEntry = {
    id: c.id,
    category: c.category,
    request: c.request,
    note: c.note,
    model: modelId,
    emittedProgram: null,
    parseError: null,
    problemCodes: [],
    passed: false,
    assertions: [],
    outputs: [],
    durationMs: 0,
    calls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    rawText: null,
    timestamp: new Date().toISOString(),
  };

  try {
    const runtime = setupCase(c);
    const built = await asker.ask(c.request, runtime);
    entry.calls = built.calls;
    entry.tokensIn = built.tokensIn;
    entry.tokensOut = built.tokensOut;
    entry.costUsd = built.costUsd;
    entry.rawText = built.raw;
    entry.emittedProgram = built.program ? built.program.toJSON() : null;
    entry.parseError = built.program === null ? built.report || 'model produced no valid program (after retries)' : null;
    entry.problemCodes = built.codes;

    // Build the assertion context (lazy, cached invocation over all inputs).
    let cached: Promise<InputOutcome[]> | null = null;
    const ctx: AssertCtx = {
      program: built.program,
      programDef: built.program ? built.program.toJSON() : null,
      parseError: entry.parseError,
      runtime,
      inputs: c.inputs,
      runAll: () => {
        if (cached === null) {
          if (!built.program) return Promise.reject(new Error('no model program to run'));
          cached = invokeOverInputs(runtime, built.program, c.inputs);
        }
        return cached;
      },
    };

    let allErrorsPass = true;
    for (const asrt of c.assert) {
      let reason: string | null;
      try {
        reason = await asrt.check(ctx);
      } catch (err) {
        reason = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      const passed = reason === null;
      if (!passed && asrt.severity === 'error') allErrorsPass = false;
      entry.assertions.push({ describe: asrt.describe, severity: asrt.severity, needsResult: asrt.needsResult, passed, reason });
    }
    entry.passed = allErrorsPass;

    // Record the model's outputs once (if it produced a program).
    if (built.program && c.assert.some((asrt) => asrt.needsResult)) {
      try {
        entry.outputs = (await ctx.runAll()).map((o) => (o.error !== null ? `error: ${o.error}` : o.output));
      } catch {
        entry.outputs = [];
      }
    }
    return entry;
  } catch (err) {
    entry.parseError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return entry;
  } finally {
    entry.durationMs = Date.now() - started;
  }
}

/** Build the human-readable failures markdown for a run. */
function buildFailuresMd(entries: LogEntry[]): string {
  const failures = entries.filter((e) => !e.passed);
  const md: string[] = [`# Integration eval failures (${failures.length}/${entries.length})`, ''];
  for (const e of failures) {
    md.push(`## ${e.id}  \`${e.category}\``);
    md.push('', `**Request:** ${e.request}`, '', `**Trap:** ${e.note}`, '');
    md.push('**Emitted program:**', '```json', JSON.stringify(e.emittedProgram, null, 2), '```', '');
    const failed = e.assertions.filter((asrt) => !asrt.passed && asrt.severity === 'error');
    if (failed.length > 0) {
      md.push('**Failed assertions (error):**');
      for (const asrt of failed) md.push(`- ${asrt.describe} — ${asrt.reason ?? 'failed'}`);
      md.push('');
    }
    const warned = e.assertions.filter((asrt) => !asrt.passed && asrt.severity === 'warn');
    if (warned.length > 0) {
      md.push('**Shape warnings (advisory, non-failing):**');
      for (const asrt of warned) md.push(`- ⚠ ${asrt.describe} — ${asrt.reason ?? 'differs'}`);
      md.push('');
    }
    if (e.parseError) md.push('**Parse error:**', '```', e.parseError, '```', '');
    if (e.problemCodes.length > 0) md.push(`**Problem codes:** ${e.problemCodes.join(', ')}`, '');
    md.push('---', '');
  }
  return `${md.join('\n')}\n`;
}

/** The keyed per-case detail (id → full LogEntry). */
function buildDetailJson(entries: LogEntry[]): string {
  const keyed: Record<string, LogEntry> = {};
  for (const e of entries) keyed[e.id] = e;
  return `${JSON.stringify(keyed, null, 2)}\n`;
}

async function runLlmEval(apiKey: string, cases: readonly EvalCase[]): Promise<number> {
  const modelId = process.env['GIN_EVAL_MODEL']?.trim() || DEFAULT_MODEL;
  console.log(`\nintegration eval — model: ${modelId} (OpenRouter), ${cases.length} case(s)`);
  console.log(`schema delivery: ${evalMode()} (GIN_EVAL_MODE)\n`);
  const asker = createAsker(apiKey, modelId);

  const cflag = flagValue(process.argv, '--concurrency');
  const concurrency = cflag !== null && Number.isInteger(Number(cflag)) && Number(cflag) > 0 ? Number(cflag) : 8;
  console.log(`(concurrency: ${concurrency})\n`);

  const entries: LogEntry[] = new Array<LogEntry>(cases.length);
  const total = cases.length;
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      if (c === undefined) break;
      const entry = await runOneCase(asker, modelId, c);
      entries[i] = entry;
      done++;
      const mark = entry.passed ? 'PASS' : 'FAIL';
      const errFailed = entry.assertions.filter((asrt) => !asrt.passed && asrt.severity === 'error');
      const warnFailed = entry.assertions.filter((asrt) => !asrt.passed && asrt.severity === 'warn');
      const warnNote = warnFailed.map((asrt) => `⚠ ${asrt.describe} (warn)`).join(' ');
      const core = entry.passed
        ? `${entry.assertions.length} assertion(s) ok`
        : errFailed.map((asrt) => `${asrt.describe}: ${asrt.reason ?? 'failed'}`).join(' | ') || entry.parseError || 'failed';
      const detail = [core, warnNote].filter(Boolean).join('  ');
      console.log(
        `  [${String(done).padStart(3)}/${total}] ${mark}  ${(entry.durationMs / 1000).toFixed(1).padStart(5)}s ${String(entry.calls).padStart(2)}c  ${c.id.padEnd(30)} ${detail}`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));

  const passed = entries.filter((e) => e.passed).length;
  const totalCost = entries.reduce((s, e) => s + e.costUsd, 0);
  const avgCost = entries.length ? totalCost / entries.length : 0;
  const avgCalls = entries.length ? entries.reduce((s, e) => s + e.calls, 0) / entries.length : 0;
  const passedEntries = entries.filter((e) => e.passed);
  const avgCallsPassed = passedEntries.length ? passedEntries.reduce((s, e) => s + e.calls, 0) / passedEntries.length : 0;
  const avgDurationMs = entries.length ? entries.reduce((s, e) => s + e.durationMs, 0) / entries.length : 0;
  const byCat = new Map<string, { pass: number; total: number; calls: number }>();
  for (const e of entries) {
    const agg = byCat.get(e.category) ?? { pass: 0, total: 0, calls: 0 };
    agg.total++;
    agg.calls += e.calls;
    if (e.passed) agg.pass++;
    byCat.set(e.category, agg);
  }
  const costNote = totalCost > 0 ? `  ·  $${totalCost.toFixed(4)} total ($${(avgCost * 100).toFixed(4)}/100 cases)` : '  ·  cost n/a';
  console.log(`\n${passed}/${entries.length} passed (${((passed / entries.length) * 100).toFixed(0)}%)  ·  avg ${avgCalls.toFixed(2)} attempts/case (${avgCallsPassed.toFixed(2)} on passes)  ·  ${(avgDurationMs / 1000).toFixed(1)}s/case${costNote}`);
  const catLines: string[] = [];
  for (const [cat, agg] of [...byCat.entries()].sort()) {
    const line = `  ${cat.padEnd(12)} ${agg.pass}/${agg.total}  (avg ${(agg.calls / agg.total).toFixed(2)}c)`;
    console.log(line);
    catLines.push(line.trim());
  }

  const now = new Date();
  const mode = evalMode();
  const report = {
    model: modelId,
    mode,
    timestamp: now.toISOString(),
    total: entries.length,
    passed,
    passRate: passed / entries.length,
    avgCalls,
    avgCallsPassed,
    avgDurationMs,
    totalCostUsd: totalCost,
    avgCostUsd: avgCost,
    byCategory: Object.fromEntries([...byCat.entries()].map(([k, v]) => [k, { pass: v.pass, total: v.total, avgCalls: v.calls / v.total }])),
    cases: entries.map((e) => ({
      id: e.id,
      category: e.category,
      passed: e.passed,
      calls: e.calls,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      costUsd: e.costUsd,
      assertions: e.assertions.map((asrt) => ({ describe: asrt.describe, severity: asrt.severity, passed: asrt.passed })),
      durationMs: e.durationMs,
    })),
  };

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportMd =
    [`# Integration eval — ${modelId} (${mode})`, '', `${passed}/${entries.length} passed (${((passed / entries.length) * 100).toFixed(0)}%) · avg ${avgCalls.toFixed(2)} attempts/case (${avgCallsPassed.toFixed(2)} on passes) · ${(avgDurationMs / 1000).toFixed(1)}s/case${totalCost > 0 ? ` · $${totalCost.toFixed(4)} total` : ''}`, '', `_${now.toISOString()}_`, '', '## By category', '', ...catLines.map((l) => `- ${l}`), ''].join('\n') + '\n';
  const detailJson = buildDetailJson(entries);
  const failuresMd = buildFailuresMd(entries);

  const stamp = runStamp(now, modelId);
  const runDir = join(RUNS_DIR, stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'report.json'), reportJson, 'utf8');
  writeFileSync(join(runDir, 'report.md'), reportMd, 'utf8');
  writeFileSync(join(runDir, 'detail.json'), detailJson, 'utf8');
  writeFileSync(join(runDir, 'failures.md'), failuresMd, 'utf8');

  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(join(HERE, 'report.json'), reportJson, 'utf8');
  writeFileSync(join(HERE, 'report.md'), reportMd, 'utf8');
  writeFileSync(join(LOGS_DIR, 'latest.json'), detailJson, 'utf8');
  writeFileSync(join(LOGS_DIR, 'failures.md'), failuresMd, 'utf8');

  console.log(`\nArchived run → ${join('logs', 'runs', stamp)}  (report.json/md, detail.json, failures.md)`);
  console.log(`Latest pointers → report.json/md + logs/latest.json + logs/failures.md`);
  // The eval is diagnostic — a non-passing model is not a harness failure.
  return 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const cases = selectCases(process.argv, CASES);
  if (cases.length !== CASES.length) {
    console.log(`(filtered to ${cases.length}/${CASES.length} case(s) via --only/--category/--limit)`);
  }

  if (check) {
    process.exit(runCheck(cases));
  }

  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.log('Set OPENROUTER_API_KEY to run the LLM eval (or use `npm run integration:check`).');
    process.exit(0);
  }
  process.exit(await runLlmEval(apiKey, cases));
}

void main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

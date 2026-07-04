/**
 * The integration / eval HARNESS runner for `@aeye/query`.
 *
 *   npm run integration:check   # no key — validates fixtures + oracles (CI-safe)
 *   OPENROUTER_API_KEY=… npm run integration   # runs the real LLM eval
 *
 * THREE modes:
 *  1. `--check` (no key needed): for EVERY case, parse + validate the oracle
 *     against the engine, run it TWICE (assert deterministic), and assert the
 *     result is non-degenerate (well-formed, non-empty, all values defined).
 *     Refusal cases assert the illegal statement DOES fail validation. Exits
 *     NON-ZERO if any oracle is invalid / degenerate / non-deterministic. This
 *     proves the fixtures + oracles + data are internally consistent.
 *  2. LLM eval (default, needs `OPENROUTER_API_KEY`): ask the model for a query
 *     per case, parse + run it, compare to `engine.run(oracle)`, tally, and
 *     write `report.json` + `report.md` + a gitignored per-case `logs/` trail.
 *  3. No key and no `--check`: print how to run, exit 0.
 *
 * The comparator normalizes `{ rows, fields }` into positional tuples and
 * compares them order-insensitively (default) or order-sensitively
 * (`match: 'ordered'`), with a float tolerance for money / averages.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { AI, type Provider } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';

import type { Context } from '@aeye/core';
import {
  buildQueryTool,
  QueryToolError,
  querySchema,
  describeEngine,
  exampleQueriesText,
  type QueryEngine,
  type QueryResult,
  type Query,
  type QueryDef,
  type QueryToolInput,
  type Type,
  type SourceRecord,
} from '../src/index';

import { buildEngine } from './model';
import { CASES, type EvalCase } from './cases/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(HERE, 'logs');
const TOOL_CTX: Context<{}, {}> = {};

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
 * Narrow `CASES` by the `--only <id[,id...]>`, `--category <cat[,cat...]>`, and
 * `--limit <N>` flags (applied in that order). Lets a dev iterate on one failing
 * case (`--only agg-003`) instead of paying for the whole suite. Throws if a
 * requested id / category matches nothing, or `--limit` is not a positive int.
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

/** Default model for the LLM eval; override with `QUERY_EVAL_MODEL`. */
const DEFAULT_MODEL = 'openai/gpt-4o';
const WRITE_KINDS = new Set(['insert', 'update', 'delete']);

// ════════════════════════════════════════════════════════════════════════════
// Comparator
// ════════════════════════════════════════════════════════════════════════════

/** A result normalized to its output field names + positional value tuples. */
interface NormResult {
  fields: string[];
  rows: unknown[][];
}

/** Project a `QueryResult` into positional tuples aligned to its field order. */
function normalize(result: QueryResult): NormResult {
  const fields = result.fields.map((f) => f.name);
  const rows = result.rows.map((r: SourceRecord) => result.fields.map((f) => r[f.name]));
  return { fields, rows };
}

/** Numeric-aware equality with an absolute tolerance for money / averages. */
function valueEqual(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A stable canonical sort key for a row tuple (numbers rounded for stability). */
function rowKey(tuple: unknown[]): string {
  return JSON.stringify(
    tuple.map((v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)),
  );
}

/** Compare two normalized results; return `{ ok, diff }` (diff set on mismatch). */
function compareResults(
  expected: NormResult,
  actual: NormResult,
  match: 'set' | 'ordered',
  tol: number,
): { ok: boolean; diff: string | null } {
  if (expected.rows.length !== actual.rows.length) {
    return { ok: false, diff: `row count ${expected.rows.length} (expected) vs ${actual.rows.length} (actual)` };
  }
  if (expected.fields.length !== actual.fields.length) {
    return {
      ok: false,
      diff: `column count ${expected.fields.length} (expected: ${expected.fields.join(', ')}) vs ${actual.fields.length} (actual: ${actual.fields.join(', ')})`,
    };
  }
  const exp = match === 'ordered' ? expected.rows : [...expected.rows].sort((x, y) => rowKey(x).localeCompare(rowKey(y)));
  const act = match === 'ordered' ? actual.rows : [...actual.rows].sort((x, y) => rowKey(x).localeCompare(rowKey(y)));
  for (let i = 0; i < exp.length; i++) {
    const er = exp[i]!;
    const ar = act[i]!;
    for (let c = 0; c < er.length; c++) {
      if (!valueEqual(er[c], ar[c], tol)) {
        return { ok: false, diff: `row ${i} col ${c}: expected ${JSON.stringify(er[c])}, got ${JSON.stringify(ar[c])}` };
      }
    }
  }
  return { ok: true, diff: null };
}

/** A short one-line summary of a normalized result for the logs. */
function summarize(n: NormResult): string {
  const preview = n.rows.slice(0, 4).map((r) => `[${r.map((v) => JSON.stringify(v)).join(', ')}]`).join(' ');
  const more = n.rows.length > 4 ? ` …(+${n.rows.length - 4})` : '';
  return `${n.rows.length} row(s) {${n.fields.join(', ')}}: ${preview}${more}`;
}

// ════════════════════════════════════════════════════════════════════════════
// --check mode (no key)
// ════════════════════════════════════════════════════════════════════════════

/** Whether every value in every row is defined (non-degeneracy for scalars). */
function allDefined(result: QueryResult): boolean {
  return result.rows.every((r) => result.fields.every((f) => r[f.name] !== undefined));
}

async function runCheck(engine: QueryEngine, cases: readonly EvalCase[]): Promise<number> {
  let failures = 0;
  console.log(`\nintegration:check — validating ${cases.length} oracle(s) against the fixture…\n`);
  for (const c of cases) {
    const expect = c.expect ?? 'rows';
    try {
      const oracle = c.oracle(engine);
      const problems = engine.validateQuery(oracle);
      const errors = problems.list.filter((p) => p.severity === 'error');

      if (expect === 'refusal') {
        if (errors.length === 0) {
          failures++;
          console.log(`  FAIL  ${c.id} — refusal oracle validated but SHOULD have been rejected`);
        } else {
          console.log(`  ok    ${c.id} — correctly rejected (${errors.map((e) => e.code).join(', ')})`);
        }
        continue;
      }

      if (errors.length > 0) {
        failures++;
        console.log(`  FAIL  ${c.id} — oracle has validation errors: ${errors.map((e) => e.code).join(', ')}`);
        continue;
      }

      const first = await engine.run(oracle);
      const second = await engine.run(oracle);
      const n1 = normalize(first);
      const n2 = normalize(second);
      const det = compareResults(n1, n2, 'ordered', 0);
      if (!det.ok) {
        failures++;
        console.log(`  FAIL  ${c.id} — non-deterministic across two runs (${det.diff})`);
        continue;
      }
      if (n1.fields.length === 0 || n1.rows.length === 0) {
        failures++;
        console.log(`  FAIL  ${c.id} — degenerate result (${n1.rows.length} rows, ${n1.fields.length} cols)`);
        continue;
      }
      if (!allDefined(first)) {
        failures++;
        console.log(`  FAIL  ${c.id} — result contains an undefined value`);
        continue;
      }
      console.log(`  ok    ${c.id} — ${summarize(n1)}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${c.id} — threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${cases.length - failures}/${cases.length} oracle(s) valid + non-degenerate.`);
  if (failures > 0) console.log(`${failures} FAILED — fix the oracle/data until clean.`);
  return failures === 0 ? 0 : 1;
}

// ════════════════════════════════════════════════════════════════════════════
// LLM eval mode (needs OPENROUTER_API_KEY)
// ════════════════════════════════════════════════════════════════════════════

/** Per-case log entry written to `logs/latest.json` (keyed by id). */
interface LogEntry {
  id: string;
  category: string;
  request: string;
  model: string;
  expect: string;
  emittedQuery: unknown | null;
  parseReport: string;
  problemCodes: string[];
  ran: boolean;
  passed: boolean;
  expectedSummary: string;
  actualSummary: string;
  diff: string | null;
  error: string | null;
  durationMs: number;
  timestamp: string;
}

/** The tool's wire schema, typed at the boundary as it validates it (see tool.ts). */
type QuerySchema = z.ZodType<QueryToolInput>;

interface QueryAsker {
  ask(content: string, schema: QuerySchema, engine: QueryEngine, types: readonly Type[]): Promise<unknown>;
}

/** Build the AI instance + a `QueryAsker` over OpenRouter (mirrors examples/cli.ts). */
function createAsker(apiKey: string, modelId: string): QueryAsker {
  const providers: Record<string, Provider> = { openrouter: new OpenRouterProvider({ apiKey }) };
  const metadata = { model: { id: modelId } };
  // The single narrow `as any` the examples tolerate: the AI metadata typing
  // can't see our pinned model id / allow-list without it (see examples/cli.ts).
  const defaultMetadata = { model: { id: modelId }, providers: { allow: ['openrouter'] } } as any;
  const ai = AI.with()
    .providers(providers)
    .create({ defaultMetadata, models, modelOverrides: [...strictSupport] });

  type PromptInput = { prompt: string; schema?: QuerySchema; engine?: QueryEngine; types?: readonly Type[] };
  const instructions = (i: PromptInput): string =>
    i.engine ? `${describeEngine(i.engine, { types: i.types, functions: 'all' })}\n\n${exampleQueriesText()}` : '';
  const prompt = ai.prompt({
    name: 'query_eval',
    description: 'Build a structured query from a natural-language request',
    content: '{{instructions}}\n\n{{userPrompt}}',
    input: (i: PromptInput) => ({ instructions: instructions(i), userPrompt: i.prompt }),
    schema: (i: PromptInput | undefined) => i?.schema ?? false,
    metadata,
  });
  return {
    ask: (content, schema, engine, types) => prompt.get('result', { prompt: content, schema, engine, types }),
  };
}

/** Pull the `query` field out of a (loosely-typed) model response. */
function extractQueryDef(modelOutput: unknown): QueryDef | undefined {
  if (modelOutput && typeof modelOutput === 'object' && 'query' in modelOutput) {
    return (modelOutput as { query: QueryDef }).query;
  }
  return undefined;
}

/** Parse a query def through the tool without throwing (the tool THROWS a
 *  `QueryToolError` on any problem — we catch it and surface the diagnostics). */
async function tryBuild(
  tool: ReturnType<typeof buildQueryTool>,
  queryDef: QueryDef,
): Promise<{ query: Query | null; report: string; codes: string[] }> {
  try {
    const query = await tool.parse(TOOL_CTX, JSON.stringify({ query: queryDef }));
    return { query, report: '', codes: [] };
  } catch (err) {
    if (err instanceof QueryToolError) return { query: null, report: err.report, codes: err.problems.list.map((p) => p.code) };
    throw err;
  }
}

async function runOneCase(
  engine: QueryEngine,
  asker: QueryAsker,
  modelId: string,
  c: EvalCase,
): Promise<LogEntry> {
  const started = Date.now();
  const expect = c.expect ?? 'rows';
  const match = c.match ?? 'set';
  const tol = c.floatTolerance ?? 1e-6;
  const entry: LogEntry = {
    id: c.id,
    category: c.category,
    request: c.request,
    model: modelId,
    expect,
    emittedQuery: null,
    parseReport: '',
    problemCodes: [],
    ran: false,
    passed: false,
    expectedSummary: '',
    actualSummary: '',
    diff: null,
    error: null,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  };

  try {
    const types = engine.registry.typeList();
    // Keep the structured schema (not the string fallback) even with 20 Types.
    const options = { max: types.length + 1, functions: 'all' as const };
    const tool = buildQueryTool(engine, options);
    // Same boundary cast the tool applies to its own wire schema (see tool.ts):
    // `querySchema` is statically `ZodType<unknown>` but validates the envelope.
    const schema = querySchema(engine, options) as QuerySchema;
    const userContent = [
      'Emit the query as a structured JSON object in the `query` field of the schema.',
      '',
      `User request: ${c.request}`,
    ].join('\n');

    // First attempt.
    let modelOutput = await asker.ask(userContent, schema, engine, types);
    let queryDef = extractQueryDef(modelOutput);
    entry.emittedQuery = queryDef ?? modelOutput ?? null;
    let built: { query: Query | null; report: string; codes: string[] } = queryDef
      ? await tryBuild(tool, queryDef)
      : { query: null, report: 'no `query` field in model output', codes: ['query.missing'] };

    // One repair round on validation problems.
    if (!built.query && queryDef) {
      const repair = [userContent, '', 'Your previous query failed validation:', built.report, 'Return a corrected query.'].join('\n');
      modelOutput = await asker.ask(repair, schema, engine, types);
      const repaired = extractQueryDef(modelOutput);
      if (repaired) {
        entry.emittedQuery = repaired;
        built = await tryBuild(tool, repaired);
        queryDef = repaired;
      }
    }
    entry.parseReport = built.report;
    entry.problemCodes = built.codes;

    if (expect === 'refusal') {
      // Passes when the tool refused (build error) OR the model did not emit a
      // write to the protected Type.
      const kind = queryDef && typeof queryDef === 'object' && 'kind' in queryDef ? String((queryDef as { kind: string }).kind) : '';
      entry.passed = built.query === null || !WRITE_KINDS.has(kind);
      entry.expectedSummary = 'refusal (validation error / no write)';
      entry.actualSummary = built.query === null ? `refused: ${built.codes.join(', ') || 'no query'}` : `built ${kind}`;
      return entry;
    }

    // expect === 'rows': derive the expected result from the oracle.
    const expected = normalize(await engine.run(c.oracle(engine)));
    entry.expectedSummary = summarize(expected);

    if (!built.query) {
      entry.actualSummary = 'no valid query built';
      entry.diff = built.report || 'model produced no valid query';
      return entry;
    }
    const actualResult = await engine.run(built.query);
    entry.ran = true;
    const actual = normalize(actualResult);
    entry.actualSummary = summarize(actual);
    const cmp = compareResults(expected, actual, match, tol);
    entry.passed = cmp.ok;
    entry.diff = cmp.diff;
    return entry;
  } catch (err) {
    entry.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return entry;
  } finally {
    entry.durationMs = Date.now() - started;
  }
}

/** Write the gitignored per-case logs (latest.json keyed by id + failures.md). */
function writeLogs(entries: LogEntry[]): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const keyed: Record<string, LogEntry> = {};
  for (const e of entries) keyed[e.id] = e;
  writeFileSync(join(LOGS_DIR, 'latest.json'), `${JSON.stringify(keyed, null, 2)}\n`, 'utf8');

  const failures = entries.filter((e) => !e.passed);
  const md: string[] = [`# Integration eval failures (${failures.length}/${entries.length})`, ''];
  for (const e of failures) {
    md.push(`## ${e.id}  \`${e.category}\``);
    md.push('', `**Request:** ${e.request}`, '');
    md.push('**Emitted query:**', '```json', JSON.stringify(e.emittedQuery, null, 2), '```', '');
    if (e.diff) md.push(`**Diff:** ${e.diff}`, '');
    if (e.parseReport) md.push('**Diagnostics:**', '```', e.parseReport, '```', '');
    if (e.problemCodes.length > 0) md.push(`**Problem codes:** ${e.problemCodes.join(', ')}`, '');
    if (e.error) md.push(`**Error:** ${e.error}`, '');
    md.push(`**Expected:** ${e.expectedSummary}`, `**Actual:** ${e.actualSummary}`, '', '---', '');
  }
  writeFileSync(join(LOGS_DIR, 'failures.md'), `${md.join('\n')}\n`, 'utf8');
}

async function runLlmEval(engine: QueryEngine, apiKey: string, cases: readonly EvalCase[]): Promise<number> {
  const modelId = process.env['QUERY_EVAL_MODEL']?.trim() || DEFAULT_MODEL;
  console.log(`\nintegration eval — model: ${modelId} (OpenRouter), ${cases.length} case(s)\n`);
  const asker = createAsker(apiKey, modelId);

  const entries: LogEntry[] = [];
  for (const c of cases) {
    const entry = await runOneCase(engine, asker, modelId, c);
    entries.push(entry);
    const mark = entry.passed ? 'PASS' : 'FAIL';
    const detail = entry.passed ? entry.actualSummary : entry.diff || entry.error || 'mismatch';
    console.log(`  ${mark}  ${c.id.padEnd(34)} ${detail}`);
  }

  // Summary + reports.
  const passed = entries.filter((e) => e.passed).length;
  const byCat = new Map<string, { pass: number; total: number }>();
  for (const e of entries) {
    const agg = byCat.get(e.category) ?? { pass: 0, total: 0 };
    agg.total++;
    if (e.passed) agg.pass++;
    byCat.set(e.category, agg);
  }
  console.log(`\n${passed}/${entries.length} passed (${((passed / entries.length) * 100).toFixed(0)}%)`);
  const catLines: string[] = [];
  for (const [cat, agg] of [...byCat.entries()].sort()) {
    const line = `  ${cat.padEnd(14)} ${agg.pass}/${agg.total}`;
    console.log(line);
    catLines.push(line.trim());
  }

  const report = {
    model: modelId,
    timestamp: new Date().toISOString(),
    total: entries.length,
    passed,
    passRate: passed / entries.length,
    byCategory: Object.fromEntries([...byCat.entries()].map(([k, v]) => [k, v])),
    cases: entries.map((e) => ({ id: e.id, category: e.category, passed: e.passed, ran: e.ran, diff: e.diff, durationMs: e.durationMs })),
  };
  writeFileSync(join(HERE, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(HERE, 'report.md'),
    [`# Integration eval — ${modelId}`, '', `${passed}/${entries.length} passed (${((passed / entries.length) * 100).toFixed(0)}%)`, '', '## By category', '', ...catLines.map((l) => `- ${l}`), ''].join('\n') + '\n',
    'utf8',
  );
  writeLogs(entries);
  console.log(`\nWrote report.json / report.md; per-case logs in ${LOGS_DIR}`);
  // The eval is diagnostic — a non-passing model is not a harness failure.
  return 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const { engine } = buildEngine();
  const cases = selectCases(process.argv, CASES);
  if (cases.length !== CASES.length) {
    console.log(`(filtered to ${cases.length}/${CASES.length} case(s) via --only/--category/--limit)`);
  }

  if (check) {
    process.exit(await runCheck(engine, cases));
  }

  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.log('Set OPENROUTER_API_KEY to run the LLM eval (or use `npm run integration:check`).');
    process.exit(0);
  }
  process.exit(await runLlmEval(engine, apiKey, cases));
}

void main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

/**
 * The integration / eval HARNESS runner for `@aeye/query`.
 *
 *   npm run integration:check   # no key — validates fixtures + oracles (CI-safe)
 *   OPENROUTER_API_KEY=… npm run integration   # runs the real LLM eval
 *
 * THREE modes:
 *  1. `--check` (no key needed): the FIXTURE gate. Every case must declare ≥1
 *     assertion. Every `a.resultOf` oracle is parsed + validated against the
 *     engine, run TWICE (assert deterministic), and asserted non-degenerate
 *     (well-formed, non-empty, all values defined). Every `a.refused(sample)`
 *     sample is asserted to FAIL validation. Exits NON-ZERO on any fixture
 *     problem. This proves the fixtures + oracles + data are internally
 *     consistent — WITHOUT calling an LLM.
 *  2. LLM eval (default, needs `OPENROUTER_API_KEY`): ask the model for a query
 *     per case, parse it, build an `AssertCtx` (its `.toJSON()` def + a lazy
 *     cached `run()`), and evaluate EVERY assertion. The case PASSES iff all
 *     return `null`. Writes a gitignored per-case `logs/` trail + reports.
 *  3. No key and no `--check`: print how to run, exit 0.
 *
 * Assertions (see `cases/assert.ts`) mix STRUCTURE (walk the emitted query def —
 * group by / order by / filter / join / aggregate / limit …) with RESULT (rows
 * match a correct oracle via `compareResults`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { AI, type Provider } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';

import {
  parseQueryTool,
  QueryToolError,
  querySchema,
  describeEngine,
  exampleQueriesText,
  type QueryEngine,
  type Query,
  type QueryDef,
  type QueryToolInput,
  type Type,
} from '../src/index';

import { buildEngine } from './model';
import { CASES, type EvalCase } from './cases/index';
import { normalize, summarize, compareResults, type NormResult, type AssertCtx } from './cases/assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(HERE, 'logs');

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

// ════════════════════════════════════════════════════════════════════════════
// --check mode (no key) — validate fixtures (oracles + refusal samples)
// ════════════════════════════════════════════════════════════════════════════

/** Whether every value in every row is defined (non-degeneracy for scalars). */
function allDefined(result: { rows: NormResult['rows'] }): boolean {
  return result.rows.every((r) => r.every((v) => v !== undefined));
}

/**
 * Validate a single case's fixture obligations WITHOUT an LLM:
 *  - it declares ≥1 assertion;
 *  - each `a.resultOf` oracle validates, runs deterministically twice, and is
 *    non-degenerate (non-empty rows + cols, all values defined);
 *  - each `a.refused(sample)` sample FAILS validation.
 * Returns a list of problem strings (empty ⇒ the case's fixtures are coherent).
 */
async function checkCase(engine: QueryEngine, c: EvalCase): Promise<string[]> {
  const problems: string[] = [];
  if (c.assert.length === 0) {
    problems.push('no assertions declared');
    return problems;
  }

  for (const asrt of c.assert) {
    if (asrt.oracle) {
      try {
        const oracle = asrt.oracle(engine);
        const report = engine.validateQuery(oracle);
        const errors = report.list.filter((p) => p.severity === 'error');
        if (errors.length > 0) {
          problems.push(`oracle has validation errors: ${errors.map((e) => e.code).join(', ')}`);
          continue;
        }
        const first = normalize(await engine.run(oracle));
        const second = normalize(await engine.run(oracle));
        const det = compareResults(first, second, 'ordered', 0);
        if (!det.ok) {
          problems.push(`oracle non-deterministic across two runs (${det.diff})`);
          continue;
        }
        if (first.fields.length === 0 || first.rows.length === 0) {
          problems.push(`oracle degenerate (${first.rows.length} rows, ${first.fields.length} cols)`);
          continue;
        }
        if (!allDefined(first)) problems.push('oracle result contains an undefined value');
      } catch (err) {
        problems.push(`oracle threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (asrt.refusalSample) {
      try {
        const sample = asrt.refusalSample(engine);
        const report = engine.validateQuery(sample);
        const errors = report.list.filter((p) => p.severity === 'error');
        if (errors.length === 0) problems.push('refusal sample validated but SHOULD have been rejected');
      } catch {
        // A throw during validation IS a rejection — acceptable for a refusal sample.
      }
    }
  }
  return problems;
}

async function runCheck(engine: QueryEngine, cases: readonly EvalCase[]): Promise<number> {
  let failures = 0;
  console.log(`\nintegration:check — validating ${cases.length} case fixture(s) against the data…\n`);
  for (const c of cases) {
    const problems = await checkCase(engine, c);
    if (problems.length === 0) {
      const oracles = c.assert.filter((a) => a.oracle).length;
      const samples = c.assert.filter((a) => a.refusalSample).length;
      const detail = [oracles ? `${oracles} oracle(s)` : '', samples ? `${samples} refusal(s)` : '', `${c.assert.length} assertion(s)`]
        .filter(Boolean)
        .join(', ');
      console.log(`  ok    ${c.id.padEnd(38)} ${detail}`);
    } else {
      failures++;
      console.log(`  FAIL  ${c.id.padEnd(38)} ${problems.join('; ')}`);
    }
  }

  console.log(`\n${cases.length - failures}/${cases.length} case fixture(s) coherent.`);
  if (failures > 0) console.log(`${failures} FAILED — fix the oracle / sample / data until clean.`);
  return failures === 0 ? 0 : 1;
}

// ════════════════════════════════════════════════════════════════════════════
// LLM eval mode (needs OPENROUTER_API_KEY)
// ════════════════════════════════════════════════════════════════════════════

/** One assertion's outcome for the logs. */
interface AssertionLog {
  describe: string;
  needsResult: boolean;
  passed: boolean;
  reason: string | null;
}

/** Per-case log entry written to `logs/latest.json` (keyed by id). */
interface LogEntry {
  id: string;
  category: string;
  request: string;
  note: string;
  model: string;
  emittedQuery: unknown | null;
  parseError: string | null;
  problemCodes: string[];
  passed: boolean;
  assertions: AssertionLog[];
  resultSummary: string | null;
  durationMs: number;
  /** Number of model requests this case made (1 + `outputRetries` re-prompts). */
  calls: number;
  timestamp: string;
}

/** The tool's wire schema, typed at the boundary as it validates it (see tool.ts). */
type QuerySchema = z.ZodType<QueryToolInput>;

/** The result of one model ask: the built query (or null after retries) plus the
 *  last compiler-style diagnostics for the log trail. */
interface AskResult {
  query: Query | null;
  report: string;
  codes: string[];
  /** Number of model requests this ask made (1 + `outputRetries` re-prompts). */
  calls: number;
}

interface QueryAsker {
  /** Ask the model for a query. The prompt uses the QUERY PARSER as its output
   *  validator (core's `parse` hook) and re-prompts on failure through its own
   *  `outputRetries` with the underlined / aid-directed report — no manual repair. */
  ask(content: string): Promise<AskResult>;
}

/**
 * Build the AI instance + a `QueryAsker` over OpenRouter (mirrors examples/cli.ts).
 * The prompt's `parse` REPLACES zod with the query parser: zod stays only as the
 * wire schema the model emits against, while validation + the retry feedback are
 * the query package's own compiler-style diagnostics (underlined, aid-directed,
 * "did you mean"). This is what core's `parse` hook was added for — so the model's
 * `outputRetries` loop is driven by real query errors, not zod union noise.
 */
function createAsker(apiKey: string, modelId: string, engine: QueryEngine): QueryAsker {
  const providers: Record<string, Provider> = { openrouter: new OpenRouterProvider({ apiKey }) };
  const metadata = { model: { id: modelId } };
  // The single narrow `as any` the examples tolerate: the AI metadata typing
  // can't see our pinned model id / allow-list without it (see examples/cli.ts).
  const defaultMetadata = { model: { id: modelId }, providers: { allow: ['openrouter'] } } as any;
  const ai = AI.with()
    .providers(providers)
    .create({ defaultMetadata, models, modelOverrides: [...strictSupport] });

  const types = engine.registry.typeList();
  // Keep the structured schema (not the string fallback) even with 20 Types.
  // Depth is overridable via QUERY_EVAL_DEPTH (e.g. `paired`) to compare how
  // tightly the wire schema constrains field/source NAMES (open = free strings,
  // paired = per-Type enums) — which matters a lot under strict structured output.
  const depthEnv = process.env['QUERY_EVAL_DEPTH']?.trim();
  const depth: 'open' | 'paired' | undefined = depthEnv === 'paired' ? 'paired' : depthEnv === 'open' ? 'open' : undefined;
  const options = { max: types.length + 1, functions: 'all' as const, ...(depth ? { depth } : {}) };
  // The prompt's `schema` — the model emits against it AND core `decodeWire`s
  // the response with it BEFORE our `parse` hook runs (so `parse` sees the
  // CONCEPTUAL value). No Tool is built: we parse directly with `parseQueryTool`.
  // Same boundary cast the tool applies to its own wire schema (see tool.ts).
  const wireSchema = querySchema(engine, options) as QuerySchema;
  const instructions = `${describeEngine(engine, { types, functions: 'all' })}\n\n${exampleQueriesText()}`;

  // `parse` runs the query parser: returns the built Query, or the QueryToolError
  // whose `.message` (the compiler-style report) the prompt re-prompts with.
  const errRef: { last: QueryToolError | null } = { last: null };
  // Read through a function so control-flow analysis can't narrow the captured
  // property to `null` across the (opaque-to-TS) prompt.get() call that mutates it.
  const takeLastError = (): QueryToolError | null => errRef.last;
  type PromptInput = { prompt: string };
  const prompt = ai.prompt({
    name: 'query_eval',
    description: 'Build a structured query from a natural-language request',
    content: '{{instructions}}\n\n{{userPrompt}}',
    input: (i: PromptInput) => ({ instructions, userPrompt: i.prompt }),
    schema: () => wireSchema,
    // The deeply-recursive query schema is NOT compatible with provider strict
    // structured output (open+strict → the model drifts into `literal` vs
    // `field-ref`; paired+strict → OpenAI rejects the ~95KB schema). Opt out of
    // strict explicitly (the base.ts streaming fix now emits the full ModelInfo,
    // so without this the request would go out strict and regress).
    strict: false,
    // `parse` runs the STANDALONE query parser on the (already wire-decoded,
    // CONCEPTUAL) value — no Tool needed. Clean ⇒ the built `Query`; problems ⇒
    // the `QueryToolError` whose report the prompt re-prompts with.
    parse: (raw: unknown): Query | QueryToolError => {
      const r = parseQueryTool(engine, raw, options);
      if (r instanceof QueryToolError) errRef.last = r;
      return r;
    },
    metadata,
  });

  return {
    ask: async (content): Promise<AskResult> => {
      errRef.last = null;
      // Stream (not `get('result')`) so we can COUNT model requests — one per
      // initial call + each `outputRetries` re-prompt — to surface retry storms.
      let calls = 0;
      let query: Query | undefined;
      // The prompt THROWS when it exhausts `outputRetries` (surfacing the last
      // error). Catch it so the case is a clean failure that still reports its
      // call count + diagnostics (via `errRef`), rather than losing both.
      try {
        for await (const event of prompt.get('stream', { prompt: content })) {
          if (event.type === 'request') calls++;
          else if (event.type === 'complete') query = event.output as Query | undefined;
        }
      } catch {
        /* fall through to the error path below (errRef holds the last report) */
      }
      if (query) return { query, report: '', codes: [], calls };
      const last = takeLastError();
      return {
        query: null,
        report: last?.report ?? '',
        codes: last ? last.problems.list.map((p) => p.code) : [],
        calls,
      };
    },
  };
}

async function runOneCase(
  engine: QueryEngine,
  asker: QueryAsker,
  modelId: string,
  c: EvalCase,
): Promise<LogEntry> {
  const started = Date.now();
  const entry: LogEntry = {
    id: c.id,
    category: c.category,
    request: c.request,
    note: c.note,
    model: modelId,
    emittedQuery: null,
    parseError: null,
    problemCodes: [],
    passed: false,
    assertions: [],
    resultSummary: null,
    durationMs: 0,
    calls: 0,
    timestamp: new Date().toISOString(),
  };

  try {
    const userContent = [
      // Anchor the model to an INSTANCE, not the schema (it otherwise sometimes',
      // echoes {"type":"object","properties":{...}}). Concrete envelope example:
      'Respond with a single JSON object of the form {"query": <query>} — where <query> is the query itself.',
      'Example shape: {"query": {"kind": "select", "from": {"kind": "type", "type": "..."}, "fields": [{"expr": {"kind": "field-ref", "source": "...", "field": "..."}}]}}',
      '',
      `User request: ${c.request}`,
    ].join('\n');

    // The prompt validates with the QUERY PARSER (core's `parse` hook) and
    // re-prompts on failure through its own `outputRetries` with the underlined,
    // aid-directed diagnostics — no manual repair round here.
    const built = await asker.ask(userContent);
    entry.calls = built.calls;
    entry.emittedQuery = built.query ? built.query.toJSON() : null;
    entry.parseError = built.query === null ? built.report || 'model produced no valid query (after retries)' : null;
    entry.problemCodes = built.codes;

    // Build the assertion context (lazy, cached run of the MODEL's query).
    let cachedRun: Promise<NormResult> | null = null;
    const ctx: AssertCtx = {
      query: built.query,
      queryDef: built.query ? built.query.toJSON() : null,
      parseError: entry.parseError,
      engine,
      run: () => {
        if (cachedRun === null) {
          if (!built.query) return Promise.reject(new Error('no model query to run'));
          cachedRun = engine.run(built.query).then(normalize);
        }
        return cachedRun;
      },
    };

    // Evaluate EVERY assertion; the case passes iff all return null.
    let allPass = true;
    for (const asrt of c.assert) {
      let reason: string | null;
      try {
        reason = await asrt.check(ctx);
      } catch (err) {
        reason = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (reason !== null) allPass = false;
      entry.assertions.push({ describe: asrt.describe, needsResult: asrt.needsResult, passed: reason === null, reason });
    }
    entry.passed = allPass;

    // Record the model's own result once (if it ran) for the log trail.
    if (built.query && c.assert.some((a) => a.needsResult)) {
      try {
        entry.resultSummary = summarize(await ctx.run());
      } catch {
        entry.resultSummary = null;
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
    md.push('', `**Request:** ${e.request}`, '', `**Trap:** ${e.note}`, '');
    md.push('**Emitted query:**', '```json', JSON.stringify(e.emittedQuery, null, 2), '```', '');
    const failed = e.assertions.filter((a) => !a.passed);
    if (failed.length > 0) {
      md.push('**Failed assertions:**');
      for (const a of failed) md.push(`- ${a.describe} — ${a.reason ?? 'failed'}`);
      md.push('');
    }
    if (e.parseError) md.push('**Parse error:**', '```', e.parseError, '```', '');
    if (e.problemCodes.length > 0) md.push(`**Problem codes:** ${e.problemCodes.join(', ')}`, '');
    if (e.resultSummary) md.push(`**Model result:** ${e.resultSummary}`, '');
    md.push('---', '');
  }
  writeFileSync(join(LOGS_DIR, 'failures.md'), `${md.join('\n')}\n`, 'utf8');
}

async function runLlmEval(engine: QueryEngine, apiKey: string, cases: readonly EvalCase[]): Promise<number> {
  const modelId = process.env['QUERY_EVAL_MODEL']?.trim() || DEFAULT_MODEL;
  console.log(`\nintegration eval — model: ${modelId} (OpenRouter), ${cases.length} case(s)\n`);
  const asker = createAsker(apiKey, modelId, engine);

  // Cases are independent → run them concurrently (pool of `--concurrency`, default
  // 8). Each worker pulls the next case index; results are logged AS THEY COMPLETE
  // (out of order) with per-case wall time + model-call count, so a slow/retrying
  // case is visible immediately instead of stalling a silent sequential run.
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
      const entry = await runOneCase(engine, asker, modelId, c);
      entries[i] = entry;
      done++;
      const mark = entry.passed ? 'PASS' : 'FAIL';
      const failed = entry.assertions.filter((a) => !a.passed);
      const detail = entry.passed
        ? `${entry.assertions.length} assertion(s) ok`
        : failed.map((a) => `${a.describe}: ${a.reason ?? 'failed'}`).join(' | ') || entry.parseError || 'failed';
      console.log(
        `  [${String(done).padStart(3)}/${total}] ${mark}  ${(entry.durationMs / 1000).toFixed(1).padStart(5)}s ${String(entry.calls).padStart(2)}c  ${c.id.padEnd(34)} ${detail}`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));

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
    cases: entries.map((e) => ({
      id: e.id,
      category: e.category,
      passed: e.passed,
      assertions: e.assertions.map((a) => ({ describe: a.describe, passed: a.passed })),
      durationMs: e.durationMs,
    })),
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

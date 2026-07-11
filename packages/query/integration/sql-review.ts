/**
 * SQL-generation review harness (Phase 1 of the SQL experiment).
 *
 *   OPENROUTER_API_KEY=… QUERY_EVAL_MODEL=<id> npx tsx integration/sql-review.ts [--only id,id,…]
 *
 * Gives each model the SAME schema knowledge it gets in query mode
 * (`describeTypes` — every Type, field, and relation) but asks for a single
 * **PostgreSQL** statement instead of our query AST. We do NOT execute the SQL —
 * this run is for eyeball review: can the model produce sensible SQL at all, and
 * on the cases it fails in query mode, is the SQL right (⇒ our query language is
 * the obstacle) or wrong (⇒ genuine model/problem difficulty)?
 *
 * For each case it writes a review block: the request, the EXPECTED rows (our
 * oracle run in-memory), the REFERENCE SQL (our own oracle → Postgres via
 * `engine.toSQL`), and the MODEL's SQL — side by side. Output:
 * `logs/sql-review/<ISO-ts>__<model>.md`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { AI, type Provider } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';

import { type QueryEngine } from '../src/index';
import { describeTypes } from '../src/llm/describe';
import { buildEngine } from './model';
import { CASES, type EvalCase } from './cases/index';
import { normalize, summarize } from './cases/assert';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Instruction preamble: schema-as-tables + the one relation simplification. */
const SQL_PREAMBLE = [
  'You are given a relational schema below. Treat each Type as a TABLE and each field as a COLUMN.',
  'A field shown as `relation→X` simply holds the IDENTIFIER (the foreign key) of the related X row — so `salesOrder.customer` is the customer id. Join to table X on that identifier when you need X\'s own columns.',
  'Write EXACTLY ONE PostgreSQL statement that answers the user request. Use a single SELECT where possible (CTEs, window functions, and subqueries are all fair game). For a write request, emit the appropriate INSERT / UPDATE / DELETE.',
  'Return only the SQL — no prose, no explanation.',
].join('\n');

/** The curated first-run set: the hard failure cluster + easy sanity cases. */
const DEFAULT_SET = [
  // easy sanity — can it produce anything at all?
  'filter-products-over-500', 'filter-region-west', 'join-orders-eu-customers',
  'agg-count-orders-customer1', 'group-revenue-by-region', 'op-case-price-band',
  // the hard cross-model failure cluster
  'win-rank-month-ties', 'cte-recursive-ancestors-rgb-laptops', 'join-return-matching-invoice',
  'refusal-insert-product-id', 'fn-age-payment-lag', 'op-distinct-products-ordered',
  'agg-argmax-top-product-revenue', 'agg-nested-max-customer-revenue', 'page-nulls-first-shippedat',
  'win-lastvalue-dept-bottom-salary', 'win-cumedist-dept-salary', 'correlated-customer-largest-order',
  'in-customers-with-orders',
];

export interface SqlAsker {
  ask(request: string): Promise<{ sql: string; calls: number; costUsd: number; error: string | null }>;
}

/**
 * Build an asker that returns a PostgreSQL statement (not our AST) for a request,
 * given only the schema-as-tables description. Reused by `run.ts` for the
 * SQL-first→translate output mode (stage 1). `unfence` its `.sql` before use.
 */
export function createSqlAsker(apiKey: string, modelId: string, engine: QueryEngine): SqlAsker {
  const providers: Record<string, Provider> = { openrouter: new OpenRouterProvider({ apiKey }) };
  // Same narrow boundary cast the query asker uses for the pinned model id.
  const defaultMetadata = { model: { id: modelId }, providers: { allow: ['openrouter'] } } as unknown as Record<string, unknown>;
  const ai = AI.with().providers(providers).create({ defaultMetadata, models, modelOverrides: [...strictSupport] });
  const types = engine.registry.typeList();
  const schema = describeTypes(engine, types);
  type PromptInput = { prompt: string };
  const prompt = ai.prompt({
    name: 'sql_review',
    description: 'Write a PostgreSQL query for the request against the given schema',
    content: '{{preamble}}\n\n{{schema}}\n\n{{userPrompt}}',
    input: (i: PromptInput) => ({ preamble: SQL_PREAMBLE, schema, userPrompt: i.prompt }),
    // A FLAT {sql} schema — no anyOf/$defs, so every provider accepts it (unlike
    // the recursive query schema); auto delivery still drops→prompt-text if a
    // dialect can't express even this.
    schema: () => z.object({ sql: z.string() }),
    outputRetries: 3,
    strict: false,
    schemaDelivery: 'auto',
    metadata: { model: { id: modelId } },
  });
  return {
    ask: async (request) => {
      let calls = 0;
      let costUsd = 0;
      let out: { sql: string } | undefined;
      let error: string | null = null;
      try {
        for await (const event of prompt.get('stream', { prompt: `User request: ${request}` })) {
          if (event.type === 'request') calls++;
          else if (event.type === 'usage') costUsd = event.usage?.cost ?? 0;
          else if (event.type === 'complete') out = event.output as { sql: string } | undefined;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return { sql: out?.sql ?? '', calls, costUsd, error };
    },
  };
}

/** Strip a ```sql … ``` fence if the model wrapped its answer in one. */
export function unfence(sql: string): string {
  const m = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : sql).trim();
}

/** The `a.resultOf` oracle for a case (if any) → its Postgres SQL + expected rows. */
async function oracleFor(engine: QueryEngine, c: EvalCase): Promise<{ refSql: string; expected: string } | null> {
  const withOracle = c.assert.find((asrt) => asrt.oracle);
  if (!withOracle?.oracle) return null;
  const oracle = withOracle.oracle(engine);
  let refSql = '';
  try {
    refSql = engine.toSQL(oracle, 'postgres').sql;
  } catch (e) {
    refSql = `(toSQL failed: ${e instanceof Error ? e.message : String(e)})`;
  }
  const expected = summarize(normalize(await engine.run(oracle)));
  return { refSql, expected };
}

async function main(): Promise<void> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('Set OPENROUTER_API_KEY to run the SQL review.');
    process.exit(1);
  }
  const modelId = process.env['QUERY_EVAL_MODEL'] ?? 'google/gemini-3-flash-preview';

  const onlyArg = process.argv.indexOf('--only');
  const ids = onlyArg !== -1 && process.argv[onlyArg + 1]
    ? process.argv[onlyArg + 1].split(',').map((s) => s.trim())
    : DEFAULT_SET;
  const cases = ids.map((id) => CASES.find((c) => c.id === id)).filter((c): c is EvalCase => Boolean(c));
  const missing = ids.filter((id) => !CASES.some((c) => c.id === id));
  if (missing.length) console.error(`(skipping unknown ids: ${missing.join(', ')})`);

  const { engine } = buildEngine();
  const asker = createSqlAsker(apiKey, modelId, engine);

  const blocks: string[] = [
    `# SQL-generation review — ${modelId}`,
    '',
    `Schema-as-tables prompt (relations = the related row's id). ${cases.length} cases. NOT executed — for review.`,
    `_${new Date().toISOString()}_`,
    '',
  ];

  let totalCost = 0;
  for (const c of cases) {
    process.stderr.write(`  ${c.id} … `);
    const { sql, costUsd, error } = await asker.ask(c.request);
    totalCost += costUsd;
    const oracle = await oracleFor(engine, c);
    blocks.push(
      `## ${c.id}  \`${c.category}\``,
      '',
      `**Request:** ${c.request}`,
      ...(c.note ? ['', `**Note:** ${c.note}`] : []),
      '',
      oracle ? `**Expected:** ${oracle.expected}` : `**Expected:** (refusal case — a valid answer DECLINES the write)`,
      '',
      ...(oracle ? ['**Reference SQL (our oracle → Postgres):**', '```sql', oracle.refSql, '```', ''] : []),
      '**Model SQL:**',
      '```sql',
      error ? `(request error: ${error})` : (unfence(sql) || '(empty)'),
      '```',
      '',
      '---',
      '',
    );
    process.stderr.write(error ? 'ERR\n' : 'ok\n');
  }

  const outDir = join(HERE, 'logs', 'sql-review');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = modelId.replace(/[^a-zA-Z0-9]+/g, '-');
  const outFile = join(outDir, `${stamp}__${slug}.md`);
  writeFileSync(outFile, blocks.join('\n'), 'utf8');
  console.log(`\nWrote ${cases.length} cases → ${outFile}  ($${totalCost.toFixed(4)})`);
}

// Only run the review when executed directly (`tsx integration/sql-review.ts`),
// NOT when `run.ts` imports `createSqlAsker` from this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

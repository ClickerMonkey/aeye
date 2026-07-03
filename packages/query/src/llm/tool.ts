/**
 * `buildQueryTool` — a ready-wired `@aeye/core` `Tool` an LLM agent can call.
 *
 * It BUILDS a core `Tool` whose wire schema is the engine's query schema and
 * whose custom `parse` REPLACES Zod validation: it validates the envelope,
 * parses the structured `query` def into a runnable `Query`, and runs the full
 * engine validation (structure + params + per-Type validators). On any problem
 * it returns a rich `QueryToolError` whose `.message` is a concise,
 * compiler-style report (via `formatProblems`) — so the model sees the
 * diagnostics instead of Zod's harder-to-follow messages. When the query is
 * clean the decoded value is the built `Query`, and the tool's `call` handler
 * RUNS it, returning a `QueryResult`.
 *
 * The pipeline mirrors the old framework-neutral builder:
 *  1. validate the input against the tool's Zod `schema`;
 *  2. in STRUCTURED mode, parse the `query` object into a runnable `Query` and
 *     run the full engine validation, rendering any `Problems` LLM-friendly via
 *     `formatProblems`;
 *  3. in STRING-FALLBACK mode (too many Types — see `shouldUseStringSchema`),
 *     report that the prose query still needs structuring;
 *  4. RUN the validated query in `call`.
 *
 * The `instructions` embed the engine's capability summary + example query
 * JSON from `describe`, so the prompt is self-contained.
 */
import { z } from 'zod';
import { Tool } from '@aeye/core';
import type { QueryDef } from '../schema';
import type { QueryEngine } from '../engine';
import type { Query, QueryResult } from '../queries/query';
import type { RuntimeOptions } from '../runtime/context';
import { Problems } from '../problem';
import { Code } from '../code';
import { describeEngine, exampleQueriesText } from './describe';
import {
  querySchema,
  shouldUseStringSchema,
  depthInstructions,
  type QuerySchemaOptions,
} from './schemas';

/** The argument shape the tool's schema accepts. */
export interface QueryToolInput {
  /** A structured query def, or a prose description in string-fallback mode. */
  query: QueryDef | string;
}

/**
 * Thrown / returned when an LLM-supplied query fails to validate. It carries
 * the accumulated `problems` plus their LLM-friendly `report`; its `.message`
 * IS that report, so the model-facing error channel surfaces the concise,
 * compiler-style diagnostics (with `Code` fallback lines) rather than Zod's
 * output. (Distinct from `QueryTypeError`, which carries a single terse
 * `Problem` and cannot render the multi-problem `formatProblems` report.)
 */
export class QueryToolError extends Error {
  constructor(readonly problems: Problems, readonly report: string) {
    super(report);
    this.name = 'QueryToolError';
  }
}

/** Options for `buildQueryTool`. */
export interface BuildQueryToolOptions extends QuerySchemaOptions {
  /** Tool name. Default `'query'`. */
  name?: string;
  /** Tool description. Default a generic SQL-like-query blurb. */
  description?: string;
  /** Runtime options for the run (param values, etc.). */
  runtime?: RuntimeOptions;
}

/** Whether a value is a structured query def (an object with a `kind`). */
function isQueryDef(value: QueryDef | string): value is QueryDef {
  return typeof value === 'object' && value !== null;
}

/** Map a Zod validation failure into `Problems` (one error per issue). */
function problemsFromZod(error: z.ZodError): Problems {
  const p = new Problems();
  for (const issue of error.issues) {
    /* v8 ignore next 3 -- zod issue paths are always string | number, so the type-guard's false branch is dead */
    const path = issue.path.filter(
      (seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number',
    );
    p.at(path, () => p.error('schema.invalid', issue.message));
  }
  return p;
}

/** Render problems against the query JSON (plain fallback lines; no spans). */
function reportFor(queryJson: QueryDef | string, problems: Problems): string {
  if (problems.list.length === 0) return '';
  const text = typeof queryJson === 'string' ? queryJson : JSON.stringify(queryJson, null, 2);
  return new Code(text).formatProblems(problems);
}

/**
 * Best-effort source text for rendering a SCHEMA-failure report from the raw
 * envelope (whose `query` field never got a typed value). The rendered output
 * is span-free, so the exact text only anchors the fallback lines.
 */
function rawQueryText(raw: unknown): QueryDef | string {
  if (typeof raw === 'object' && raw !== null && 'query' in raw) {
    return typeof raw.query === 'string' ? raw.query : JSON.stringify(raw.query, null, 2);
  }
  return JSON.stringify(raw, null, 2);
}

/** The parse+validate pipeline (steps 1–4, WITHOUT running the query). */
function parseQueryInput(
  engine: QueryEngine,
  schema: z.ZodType<QueryToolInput>,
  useString: boolean,
  raw: unknown,
): { query: Query | null; problems: Problems; report: string } {
  // 1. Validate the envelope against the tool schema.
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = problemsFromZod(parsed.error);
    return { query: null, problems, report: reportFor(rawQueryText(raw), problems) };
  }
  const input = parsed.data;

  // 2. String-fallback mode: prose can't be made runnable here.
  if (useString || !isQueryDef(input.query)) {
    const problems = new Problems();
    problems.info(
      'query.needs-structuring',
      'Received a prose query; it must be converted to a structured query before it can run.',
    );
    return { query: null, problems, report: reportFor(input.query, problems) };
  }

  // 3. Parse the structured def into a runnable Query.
  const queryDef = input.query;
  let query: Query;
  try {
    query = engine.parseQuery(queryDef);
    /* v8 ignore start -- defensive: the tool's Zod schema mirrors the parser, so a schema-valid query never fails to parse here */
  } catch (err) {
    const problems = new Problems();
    problems.error(
      'query.parse-error',
      err instanceof Error ? err.message : 'Failed to parse the query.',
    );
    return { query: null, problems, report: reportFor(queryDef, problems) };
  }
  /* v8 ignore stop */

  // 4. Validate (structure + params + per-Type validators).
  const problems = engine.validateQuery(query);
  const report = reportFor(queryDef, problems);
  return { query, problems, report };
}

/**
 * Build a ready-wired core `Tool` for an engine: its wire schema is the
 * engine's query schema, its custom `parse` validates + parses an LLM-supplied
 * query into a runnable `Query` (returning a rich `QueryToolError` on any
 * problem), and its `call` handler RUNS the validated query and returns the
 * `QueryResult`. Wire it into any `@aeye/core`-based agent's tool set.
 */
export function buildQueryTool(
  engine: QueryEngine,
  options: BuildQueryToolOptions = {},
): Tool<{}, {}, string, QueryToolInput, Promise<QueryResult>, [], Query> {
  const types = options.types ?? engine.registry.typeList();
  const max = options.max;
  const useString = shouldUseStringSchema(types, max);
  // `querySchema` is dynamically composed from `z.ZodTypeAny` building blocks, so
  // its static type is `ZodType<unknown>` even though it validates exactly the
  // `QueryToolInput` envelope at runtime. In zod 4.x `ZodTypeAny` is
  // `ZodType<unknown>` with a COVARIANT output, so it is not statically
  // assignable to the `ZodType<QueryToolInput>` the core `Tool.schema` field
  // requires. Assert the validated wire shape once, here, at the boundary.
  const schema = querySchema(engine, options) as z.ZodType<QueryToolInput>;

  // In STRUCTURED mode, tell the model which positions the active `depth`
  // constrains (paired field-refs, enum Type names, typed function args, …) so
  // the prose and the Zod schema agree. Empty in free-string `open` mode.
  const depthNote = useString ? '' : depthInstructions(engine, options);

  // Capability gating: the generated schema OMITS any expr kind the available
  // Types / functions can't use (e.g. semantic / text-search / array-op / joins
  // appear only when a Type is semantic / searchable / has an array / has a
  // relation). Flag it so the model doesn't reach for an absent construct.
  const gatingNote = useString
    ? ''
    : 'Only expression kinds the available Types and functions can use are offered — e.g. semantic / text-search / array / relation-path / join appear ONLY when a Type supports them. Do not invent an unavailable kind.';

  const instructions = [
    'Build a query over the available Types below.',
    useString
      ? 'There are too many Types to enumerate; describe the query in prose (which Types, filters, IDs, desired outcome).'
      : 'Emit the query as a structured JSON object matching the schema.',
    depthNote ? `\nSchema constraints:\n${depthNote}` : '',
    gatingNote ? `\n${gatingNote}` : '',
    '',
    // Forward the function selection so the listed functions match the schema.
    describeEngine(engine, { types, functions: options.functions }),
    '',
    exampleQueriesText(),
  ].join('\n');

  return new Tool<{}, {}, string, QueryToolInput, Promise<QueryResult>, [], Query>({
    name: options.name ?? 'query',
    description:
      options.description ??
      'Execute a structured query (select / insert / update / delete / set-op / cte) over the available Types.',
    instructions,
    schema,
    // Custom parser REPLACES Zod: validate + parse + validate the query, then
    // return the runnable `Query` (clean) or a rich `QueryToolError` (problems).
    parse: (raw, _ctx) => {
      const { query, problems, report } = parseQueryInput(engine, schema, useString, raw);
      if (query && !problems.hasErrors) return query;
      return new QueryToolError(problems, report);
    },
    // The handler RUNS the (already-validated) query in-memory.
    call: (query, _refs, _ctx) => engine.run(query, options.runtime),
  });
}

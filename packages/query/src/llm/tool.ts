/**
 * `buildQueryTool` — a ready-wired `@aeye/core` `Tool` an LLM agent can call.
 *
 * Its schema (`queryToolSchema`) is the query grammar — `{ query: <structured> }`,
 * or `{ query: string }` past `max` Types — wrapped in a codec whose decode turns
 * the decoded `QueryDef` into the runnable `Query`:
 *
 *  1. `@aeye/schema` decodes the model's answer from its wire shape (pairs back
 *     to records, nulls back to absent, …) and checks its STRUCTURE against the
 *     grammar at the requested depth;
 *  2. the codec parses it with the engine's owned structural parser
 *     (`registry.parseCheckedQuery`) and runs the engine's SEMANTIC validation
 *     (`engine.validateQuery`: params, per-Type validators, unknown names with
 *     "did you mean");
 *  3. a problem from 1 or 2 is told to the model in `@aeye/schema`'s error
 *     format — its own JSON with a marker under each mistake, at the tool's
 *     `errorFormat` detail level, never past its size cap;
 *  4. `call` RUNS the validated `Query` and returns the `QueryResult`.
 *
 * In STRING-FALLBACK mode (too many Types — `shouldUseStringSchema`) a prose
 * query can't run here; the call is answered with "it still needs structuring".
 *
 * The `instructions` embed the engine's capability summary + example query
 * JSON from `describe`, so the prompt is self-contained.
 *
 * `parseQueryRequest` / `parseQueryTool` run steps 2–3 without a tool, for a
 * value that never went through a model's wire shape (a CLI, a file, an
 * integration harness), reporting with `Code.formatProblems`.
 */
import { Tool } from '@aeye/core';
import { a, Rejection, type Bindable, type Bundle, type ErrorFormatInput, type RuleIssue } from '@aeye/schema';
import type { QueryEngine } from '../engine';
import type { Registry } from '../registry';
import type { Query, QueryResult } from '../queries/query';
import type { RuntimeOptions } from '../runtime/context';
import { Problems } from '../problem';
import { isRecord, expected } from '../shape';
import type { QueryDef } from '../schema';
import { Code, type FormatProblemsOptions } from '../code';
import { describeEngine } from './describe';
import { QueryGrammar } from './grammar';
import { QueryProseArgs } from './schemas';
import { shouldUseStringSchema, depthInstructions, type BuildSchemasOptions, type QuerySchemaOptions } from './depth';

export type { QueryToolInput } from './schemas';

/**
 * Returned by `parseQueryTool` when a query fails to validate. It carries the
 * accumulated `problems` plus their `report`; its `.message` IS that report:
 * concise, compiler-style diagnostics (with `Code` fallback lines). (Distinct
 * from `QueryTypeError`, which carries a single terse `Problem`.)
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
  /**
   * How a rejected call is told to the model: a detail level (`'summary'` ·
   * `'list'` · `'markers'` · `'full'`, the default) or the full `ErrorFormat`
   * (see @aeye/schema, "Errors for the model").
   */
  errorFormat?: ErrorFormatInput;
  /**
   * `parseQueryRequest` / `parseQueryTool` only: overrides for the
   * compiler-style problem report `formatProblems` renders into a
   * `QueryToolError.message`. Absent ⇒ the defaults (`contextLines: 2`,
   * section headers + line-number gutter on).
   */
  report?: FormatProblemsOptions;
}

/**
 * Render problems as compiler-style, UNDERLINED diagnostics over the query
 * JSON (`Code.fromJson(value).formatProblems`): each problem whose `path`
 * matches a JSON node is underlined at the offending value; one whose path
 * resolves to no node keeps a `<severity>: <message> @ <path>` line.
 */
function reportFor(value: unknown, problems: Problems, opts?: FormatProblemsOptions): string {
  if (problems.list.length === 0) return '';
  return Code.fromJson(value).formatProblems(problems, opts);
}

/** The message a prose query (string-fallback mode) is answered with. */
const NEEDS_STRUCTURING = 'Received a prose query; it must be converted to a structured query before it can run.';

/** The parse+validate pipeline for a value in the code shape (WITHOUT running the query). */
function parseQueryInput(
  engine: QueryEngine,
  raw: unknown,
  reportOpts?: FormatProblemsOptions,
): { query: Query | null; problems: Problems; report: string } {
  // 1. The ENVELOPE: an object carrying a `query` member.
  if (!isRecord(raw)) {
    const problems = new Problems();
    problems.error('shape.not-object', expected('QueryRequest', raw));
    return { query: null, problems, report: reportFor(raw, problems, reportOpts) };
  }
  if (!('query' in raw)) {
    const problems = new Problems();
    problems.error('shape.required', 'missing required field `query`');
    return { query: null, problems, report: reportFor(raw, problems, reportOpts) };
  }
  const queryValue = raw['query'];

  // 2. A prose `query`: it can't be made runnable here. Only a STRING is prose:
  // the Type-count threshold (`max`) picks the schema a model is SHOWN, and a
  // structured def is parsed whatever the count (a database past `max` tables
  // had every stored/generated def refused as prose).
  if (typeof queryValue === 'string') {
    const problems = new Problems();
    problems.info('query.needs-structuring', NEEDS_STRUCTURING);
    return { query: null, problems, report: reportFor(queryValue, problems, reportOpts) };
  }

  // 3. STRUCTURALLY parse via the owned parser (accumulating, never throws).
  const problems = new Problems();
  const query = engine.registry.parseCheckedQuery(queryValue, problems);
  if (query === undefined || problems.hasErrors) {
    return { query: null, problems, report: reportFor(queryValue, problems, reportOpts) };
  }

  // 4. SEMANTIC validation (structure walk + params + per-Type validators + unknown names).
  const semantic = engine.validateQuery(query);
  return { query, problems: semantic, report: reportFor(queryValue, semantic, reportOpts) };
}

/**
 * STANDALONE parse+validate for a query REQUEST (`{ query: … }` in the code
 * shape: a CLI / file def, an integration harness), WITHOUT building a Tool:
 * the runnable `Query` (or `null`) with the accumulated `problems` and their
 * underlined `report`. A model's answer goes through `buildQueryTool` instead,
 * whose schema decodes the wire shape first. A string `query` is prose (it
 * needs structuring); a structured one is parsed and checked whatever the
 * Type count — `max` / `types` choose only what a model is shown.
 */
export function parseQueryRequest(
  engine: QueryEngine,
  raw: unknown,
  options: BuildQueryToolOptions = {},
): { query: Query | null; problems: Problems; report: string } {
  return parseQueryInput(engine, raw, options.report);
}

/**
 * STANDALONE convenience over `parseQueryRequest`: the runnable `Query` when
 * the request is clean, else a `QueryToolError` carrying the problems and the
 * underlined report.
 */
export function parseQueryTool(
  engine: QueryEngine,
  raw: unknown,
  options: BuildQueryToolOptions = {},
): Query | QueryToolError {
  const { query, problems, report } = parseQueryRequest(engine, raw, options);
  return query && !problems.hasErrors ? query : new QueryToolError(problems, report);
}

/** A query's error problems as `RuleIssue`s at their paths under `query`. */
function issuesOf(problems: Problems): RuleIssue[] {
  return problems.list
    .filter((p) => p.severity === 'error')
    .map((p) => ({ path: ['query', ...p.path], message: p.message }));
}

/**
 * The query tool's arguments: the grammar (or the prose fallback) decoded
 * into the runnable `Query`. Structural and semantic problems are
 * rejections at their paths, told to the model in @aeye/schema's format.
 * A ref-free schema or a bundle with no arguments left (bound for this
 * engine and options).
 */
export function queryToolSchema(engine: QueryEngine, options: QuerySchemaOptions = {}): Bindable<Query> {
  const types = options.types ?? engine.registry.typeList();
  if (shouldUseStringSchema(types, options.max)) {
    const prose = a.codec(QueryProseArgs, {
      decode: (): Query | Rejection => new Rejection([{ path: ['query'], message: NEEDS_STRUCTURING }]),
      encode: (q: Query) => ({ query: JSON.stringify(q.toJSON()) }),
    });
    return prose;
  }
  const args = a.codec(a.object({ query: a.refOf<QueryDef>('Query').describe('The query to execute as a structured Query object.') }), {
    decode: (v: { query: QueryDef }): Query | Rejection => {
      const problems = new Problems();
      const query = engine.registry.parseCheckedQuery(v.query, problems);
      if (query === undefined || problems.hasErrors) return new Rejection(issuesOf(problems));
      const semantic = engine.validateQuery(query);
      return semantic.hasErrors ? new Rejection(issuesOf(semantic)) : query;
    },
    encode: (q: Query) => ({ query: q.toJSON() }),
  });
  const build: BuildSchemasOptions = options;
  // The codec's code type is the runnable `Query` class: kept as is, not walked for refs.
  const bundle = QueryGrammar.result(args) as unknown as Bundle<Query, [Registry, BuildSchemasOptions?]>;
  return bundle.adapt(() => [engine.registry, build]);
}

/**
 * Build a ready-wired core `Tool` for an engine: its schema is the engine's
 * query grammar decoded into a runnable `Query` (`queryToolSchema`), and its
 * `call` handler RUNS the query and returns the `QueryResult`. Wire it into
 * any `@aeye/core`-based agent's tool set.
 */
export function buildQueryTool(
  engine: QueryEngine,
  options: BuildQueryToolOptions = {},
): Tool<{}, {}, string, Query, Promise<QueryResult>, []> {
  const types = options.types ?? engine.registry.typeList();
  const useString = shouldUseStringSchema(types, options.max);

  // In STRUCTURED mode, tell the model which positions the active `depth`
  // constrains (paired field-refs, enum Type names, typed function args, …) so
  // the prose and the schema agree. Empty in free-string `open` mode.
  const depthNote = useString ? '' : depthInstructions(engine, options);

  // Capability gating: the grammar OMITS any expr kind the available Types /
  // functions can't use. Flag it so the model doesn't reach for an absent construct.
  const gatingNote = useString
    ? ''
    : 'Only expression kinds the available Types and functions can use are offered — e.g. semantic / text-search / array / join appear ONLY when a Type supports them. Do not invent an unavailable kind.';

  const instructions = [
    'Build a query over the available Types below.',
    useString
      ? 'There are too many Types to enumerate; describe the query in prose (which Types, filters, IDs, desired outcome).'
      : 'Emit the query as a structured JSON object matching the schema.',
    depthNote ? `\nSchema constraints:\n${depthNote}` : '',
    gatingNote ? `\n${gatingNote}` : '',
    '',
    describeEngine(engine, { types, functions: options.functions }),
  ].join('\n');

  return new Tool<{}, {}, string, Query, Promise<QueryResult>, []>({
    name: options.name ?? 'query',
    description:
      options.description ??
      'Execute a structured query (select / insert / update / delete / set-op / cte) over the available Types.',
    instructions,
    schema: queryToolSchema(engine, options),
    ...(options.errorFormat !== undefined ? { errorFormat: options.errorFormat } : {}),
    // The handler RUNS the (already-validated) query in-memory.
    call: (query, _refs, _ctx) => engine.run(query, options.runtime),
  });
}

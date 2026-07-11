/**
 * `buildQueryTool` — a ready-wired `@aeye/core` `Tool` an LLM agent can call.
 *
 * It BUILDS a core `Tool` whose wire schema is the engine's query schema and
 * whose custom `parse` REPLACES Zod validation: it validates the envelope,
 * STRUCTURALLY parses the `query` def into a runnable `Query` via the engine's
 * OWNED, zod-free structural parser (`registry.parseCheckedQuery`, see
 * `shape/`), and then runs the full engine SEMANTIC validation (params +
 * per-Type validators + unknown names). On any problem it returns a rich
 * `QueryToolError` whose `.message` is a concise, compiler-style report (via
 * `formatProblems`) — so the model sees the diagnostics instead of Zod's
 * harder-to-follow messages. When the query is clean the decoded value is the
 * built `Query`, and the tool's `call` handler RUNS it, returning a
 * `QueryResult`.
 *
 * STRUCTURE vs SEMANTICS. Zod is NO LONGER the validator — it is only the
 * model-facing WIRE SCHEMA (`querySchema` / `buildSchemas`), exposed as the
 * tool's `schema` for the model to emit against (and for `compile` / strict
 * mode). The ACTIVE structural gate is the owned parser: it accepts any
 * REGISTERED expr / query / source kind with any string field (capability +
 * depth are wire-schema concerns), accumulating one-or-more aid-directed,
 * `didYouMean`-suggesting problems in a single pass and NEVER throwing. Unknown
 * Types / fields / functions are caught DOWNSTREAM by `validateQuery` /
 * `validateWalk` with the existing aid-directed SEMANTIC messages.
 *
 * The pipeline:
 *  1. validate the ENVELOPE (`{ query: … }`) structurally — no zod;
 *  2. in STRING-FALLBACK mode (too many Types — see `shouldUseStringSchema`) or
 *     when `query` is a prose string, report that it still needs structuring;
 *  3. in STRUCTURED mode, STRUCTURALLY parse the `query` object into a runnable
 *     `Query` (accumulating problems); if it is structurally sound, run the full
 *     engine SEMANTIC validation, rendering any `Problems` LLM-friendly via
 *     `formatProblems`;
 *  4. RUN the validated query in `call`.
 *
 * The `instructions` embed the engine's capability summary + example query
 * JSON from `describe`, so the prompt is self-contained.
 */
import { z } from 'zod';
import { Tool } from '@aeye/core';
import type { QueryEngine } from '../engine';
import type { Query, QueryResult } from '../queries/query';
import type { RuntimeOptions } from '../runtime/context';
import { Problems } from '../problem';
import { isRecord, expected } from '../shape';
import type { QueryDef } from '../schema';
import { Code, type FormatProblemsOptions } from '../code';
import { describeEngine } from './describe';
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
  /**
   * Overrides for the compiler-style problem report `formatProblems` renders
   * into a `QueryToolError.message`. Absent ⇒ the defaults (`contextLines: 2`,
   * section headers + line-number gutter on). E.g. `{ contextLines: 0 }` drops
   * the surrounding context (just the underlined line); `{ lineNumbers: false }`
   * drops the gutter.
   */
  report?: FormatProblemsOptions;
}

/**
 * Render problems as compiler-style, UNDERLINED diagnostics over the model's
 * own query JSON. `Code.fromJson(value)` emits the canonical
 * `JSON.stringify(value, null, 2)` text with a span pre-registered for every
 * node, so each problem whose `path` matches a JSON node is underlined (`^^^`)
 * at the offending value with surrounding context; a problem whose path
 * resolves to no node keeps the graceful `<severity>: <message> @ <path>`
 * fallback line. `value` is the JSON the problems' paths are relative to — the
 * structured `query` def for structural/semantic problems, or the raw envelope
 * for envelope failures.
 */
function reportFor(value: unknown, problems: Problems, opts?: FormatProblemsOptions): string {
  if (problems.list.length === 0) return '';
  return Code.fromJson(value).formatProblems(problems, opts);
}

/** The parse+validate pipeline (steps 1–3, WITHOUT running the query). */
function parseQueryInput(
  engine: QueryEngine,
  useString: boolean,
  raw: unknown,
  reportOpts?: FormatProblemsOptions,
): { query: Query | null; problems: Problems; report: string } {
  // 1. Validate the ENVELOPE structurally (no zod): it must be an object that
  // carries a `query` member. Both failures render against the raw envelope,
  // whose root span underlines the whole offending value.
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

  // 2. String-fallback mode: prose (the degraded string schema) can't be made
  // runnable here. Preserved from the zod era: the prose branch fires whenever
  // the schema degraded to the string form OR the `query` value is a string.
  if (useString || typeof queryValue === 'string') {
    const problems = new Problems();
    problems.info(
      'query.needs-structuring',
      'Received a prose query; it must be converted to a structured query before it can run.',
    );
    return { query: null, problems, report: reportFor(queryValue, problems, reportOpts) };
  }

  // 3. STRUCTURALLY parse the `query` def into a runnable `Query` via the owned,
  // zod-free structural parser (accumulating, aid-directed, never throws). On
  // ANY structural problem, stop here — the source map underlines each one.
  const problems = new Problems();
  const query = engine.registry.parseCheckedQuery(queryValue, problems);
  if (query === undefined || problems.hasErrors) {
    return { query: null, problems, report: reportFor(queryValue, problems, reportOpts) };
  }

  // 4. Structurally sound ⇒ run SEMANTIC validation (structure walk + params +
  // per-Type validators + unknown-name diagnostics).
  const semantic = engine.validateQuery(query);
  return { query, problems: semantic, report: reportFor(queryValue, semantic, reportOpts) };
}

/**
 * STANDALONE parse+validate for a query REQUEST — the same pipeline
 * `buildQueryTool`'s custom `parse` runs, WITHOUT building a Tool. Given the
 * conceptual `{ query: … }` envelope (already wire-decoded by core before any
 * Tool/Prompt custom parse, or a directly-parsed CLI/file def), it validates
 * the envelope, structurally parses the `query` def, and semantically validates
 * it — returning the runnable `Query` (or `null`) alongside the accumulated
 * `problems` and their underlined, aid-directed `report`. Use this when you
 * only need to parse/validate (CLI, file, integration harness); reach for
 * `buildQueryTool` only when you need a runnable core `Tool`.
 */
export function parseQueryRequest(
  engine: QueryEngine,
  raw: unknown,
  options: BuildQueryToolOptions = {},
): { query: Query | null; problems: Problems; report: string } {
  const types = options.types ?? engine.registry.typeList();
  const useString = shouldUseStringSchema(types, options.max);
  return parseQueryInput(engine, useString, raw, options.report);
}

/**
 * STANDALONE convenience over `parseQueryRequest`: return the runnable `Query`
 * when the request is clean, or a rich `QueryToolError` (carrying the problems
 * + underlined report) otherwise. This is the exact result `buildQueryTool`'s
 * custom `parse` produces — the tool reuses it — so a direct
 * `parseQueryTool(engine, { query })` call and `buildQueryTool(engine).parse`
 * are interchangeable for parsing.
 */
export function parseQueryTool(
  engine: QueryEngine,
  raw: unknown,
  options: BuildQueryToolOptions = {},
): Query | QueryToolError {
  const { query, problems, report } = parseQueryRequest(engine, raw, options);
  return query && !problems.hasErrors ? query : new QueryToolError(problems, report);
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
  //
  // Zod is the model-facing WIRE SCHEMA only — the tool exposes it as `schema`
  // for the model to emit against (and for `compile` / strict mode). The ACTIVE
  // structural gate is the owned parser inside `parse` (see `parseQueryInput`).
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
    : 'Only expression kinds the available Types and functions can use are offered — e.g. semantic / text-search / array / join appear ONLY when a Type supports them. Do not invent an unavailable kind.';

  const instructions = [
    'Build a query over the available Types below.',
    useString
      ? 'There are too many Types to enumerate; describe the query in prose (which Types, filters, IDs, desired outcome).'
      : 'Emit the query as a structured JSON object matching the schema.',
    depthNote ? `\nSchema constraints:\n${depthNote}` : '',
    gatingNote ? `\n${gatingNote}` : '',
    '',
    // Forward the function selection so the listed functions match the schema.
    // `describeEngine` now folds in worked examples (per expr kind, function, and
    // query kind) from the nodes' own `EXAMPLES` — the one source of truth.
    describeEngine(engine, { types, functions: options.functions }),
  ].join('\n');

  return new Tool<{}, {}, string, QueryToolInput, Promise<QueryResult>, [], Query>({
    name: options.name ?? 'query',
    description:
      options.description ??
      'Execute a structured query (select / insert / update / delete / set-op / cte) over the available Types.',
    instructions,
    schema,
    // Custom parser REPLACES Zod: validate the envelope, STRUCTURALLY parse +
    // SEMANTICALLY validate the query, then return the runnable `Query` (clean)
    // or a rich `QueryToolError` (problems). Delegates to the STANDALONE
    // `parseQueryTool` — ONE parse implementation shared with direct callers.
    parse: (raw, _ctx) => parseQueryTool(engine, raw, options),
    // The handler RUNS the (already-validated) query in-memory.
    call: (query, _refs, _ctx) => engine.run(query, options.runtime),
  });
}

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

/** One flattened zod leaf: its ABSOLUTE structural path + zod's message + code. */
interface FlatZodIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

/** Keep only the `string | number` segments of a zod issue path (drops symbol keys). */
function pathSegments(path: ReadonlyArray<PropertyKey>): (string | number)[] {
  /* v8 ignore next 3 -- zod issue paths are always string | number here, so the guard's false branch is dead */
  return path.filter(
    (seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number',
  );
}

/**
 * A branch REJECTED the value's `kind` discriminant (it's the wrong shape) — its
 * failure is a `kind` literal mismatch rather than a genuine deeper problem, so
 * it is pruned even though it may ALSO report incidental deep failures (a
 * wrong-`kind` branch's other required members are "missing" too).
 */
function rejectsDiscriminant(leaves: ReadonlyArray<FlatZodIssue>): boolean {
  return leaves.some((f) => f.path[f.path.length - 1] === 'kind' && f.code === 'invalid_value');
}

/**
 * A (kind-matching) branch ENGAGED past the discriminant: it failed on a
 * genuinely-bad value DEEPER than the union's own path. A leaf AT the union's
 * path is a wrong-primitive (the value isn't even an object); a leaf at `kind`
 * is the discriminant itself — neither engages.
 */
function engagesPastDiscriminant(
  leaves: ReadonlyArray<FlatZodIssue>,
  prefixLen: number,
): boolean {
  return leaves.some((f) => f.path.length > prefixLen && f.path[prefixLen] !== 'kind');
}

/**
 * Flatten a zod issue tree into concrete leaves with ABSOLUTE paths, isolating
 * the OFFENDING location within the (recursive, `.or`-folded) query schema.
 *
 * The query / expr / source schemas are `kind`-discriminated unions, so any
 * nested failure surfaces as an `invalid_union` whose branches are the
 * alternative shapes. At each union:
 *  - If SOME branch ENGAGED past the `kind` (matched the shape and failed
 *    deeper), keep the deepest-reaching such matches — that shape parsed
 *    furthest before hitting the genuinely-bad value, and its leaves already
 *    carry the DIRECTED message of the node that rejected it.
 *  - If NO branch engaged (a bogus / absent `kind`, or a primitive where an
 *    object was required), the value fits none of the options: emit ONE leaf at
 *    the union's OWN path carrying the union's DIRECTED message (its
 *    aid-directed "expected an expression" / "unknown … kind `x` — did you mean
 *    `y`?"), so the whole offending value is underlined with domain text. The
 *    `invalid_value` code lets a PARENT union recognise a bad `kind`
 *    discriminant here and prune this whole (wrong-shape) branch.
 */
function flattenZodIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  prefix: ReadonlyArray<string | number>,
): FlatZodIssue[] {
  const out: FlatZodIssue[] = [];
  for (const issue of issues) {
    const abs = [...prefix, ...pathSegments(issue.path)];
    if (issue.code === 'invalid_union') {
      const branches = issue.errors.map((branch) => flattenZodIssues(branch, abs));
      // Drop wrong-`kind` branches, then keep only survivors that failed DEEPER
      // than the discriminant (the shape that actually matched the value's kind).
      const survivors = branches.filter((b) => !rejectsDiscriminant(b));
      const engaged = survivors.filter((b) => engagesPastDiscriminant(b, abs.length));
      if (engaged.length === 0) {
        // The value matches NO shape here (a bogus / absent `kind`, or a
        // primitive where an object was required). Emit ONE leaf at the union's
        // own path carrying its aid-directed message.
        out.push({ path: abs, message: issue.message, code: 'invalid_value' });
        continue;
      }
      const maxDepth = engaged.reduce(
        (m, b) => Math.max(m, b.reduce((d, f) => Math.max(d, f.path.length), 0)),
        0,
      );
      for (const b of engaged) {
        if (b.reduce((d, f) => Math.max(d, f.path.length), 0) === maxDepth) out.push(...b);
      }
    } else {
      out.push({ path: abs, message: issue.message, code: issue.code });
    }
  }
  return out;
}

/**
 * Map a Zod validation failure into `Problems` — one `schema.invalid` error per
 * DISTINCT offending location. Union noise is collapsed by `flattenZodIssues`,
 * so each problem's path points at (or into) the value the model must fix,
 * letting `reportFor` underline it in the query JSON.
 */
function problemsFromZod(error: z.ZodError): Problems {
  const p = new Problems();
  const seen = new Set<string>();
  for (const leaf of flattenZodIssues(error.issues, [])) {
    const key = JSON.stringify(leaf.path);
    if (seen.has(key)) continue;
    seen.add(key);
    p.at(leaf.path, () => p.error('schema.invalid', leaf.message));
  }
  return p;
}

/**
 * Render problems as compiler-style, UNDERLINED diagnostics over the model's
 * own query JSON. `Code.fromJson(value)` emits the canonical
 * `JSON.stringify(value, null, 2)` text with a span pre-registered for every
 * node, so each problem whose `path` matches a JSON node is underlined (`^^^`)
 * at the offending value with surrounding context; a problem whose path
 * resolves to no node keeps the graceful `<severity>: <message> @ <path>`
 * fallback line. `value` is the JSON the problems' paths are relative to — the
 * structured `query` def for parse/validate problems, or the raw envelope for
 * schema-envelope failures (whose zod paths include the leading `query`).
 */
function reportFor(value: unknown, problems: Problems): string {
  if (problems.list.length === 0) return '';
  return Code.fromJson(value).formatProblems(problems);
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
    // Render against the raw ENVELOPE: zod issue paths include the leading
    // `query`, so they resolve to nodes in `jsonSource(raw)` and underline.
    return { query: null, problems, report: reportFor(raw, problems) };
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

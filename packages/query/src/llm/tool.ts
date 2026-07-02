/**
 * `buildQueryTool` — a framework-NEUTRAL query tool an LLM agent can call.
 *
 * It deliberately does NOT depend on `@aeye/ai` (or any agent framework): it
 * returns a plain descriptor (`name` / `description` / `instructions` /
 * `schema`) plus a `build(input)` function. A host wires the descriptor into
 * whatever tool registry it uses; when the LLM calls the tool, the host hands
 * the parsed arguments to `build`, which:
 *
 *  1. validates the input against the tool's Zod `schema`;
 *  2. in STRUCTURED mode, parses the `query` object into a runnable `Query`
 *     and runs the full engine validation (structure + params + per-Type
 *     validators), rendering any `Problems` LLM-friendly via `formatProblems`;
 *  3. in STRING-FALLBACK mode (too many Types — see `shouldUseStringSchema`),
 *     reports that the prose query still needs structuring;
 *  4. optionally RUNS the query in-memory when it validates clean and the
 *     tool was built with `run: true`, attaching the `result`.
 *
 * The `instructions` embed the engine's capability summary + example query
 * JSON from `describe`, so the prompt is self-contained.
 */
import { z } from 'zod';
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

/** What `build` returns. */
export interface QueryToolBuildResult {
  /** The parsed, runnable query — `null` when input was invalid / prose. */
  query: Query | null;
  /** Accumulated diagnostics (empty list ⇒ valid). */
  problems: Problems;
  /** LLM-friendly rendering of `problems` (empty string when none). */
  report: string;
  /** The in-memory run output, present only when run + valid. */
  result?: QueryResult;
}

/** The framework-neutral tool descriptor. */
export interface QueryTool {
  /** The tool's name a host registers it under. */
  name: string;
  /** A short, LLM-facing description of what the tool does. */
  description: string;
  /** The self-contained prompt: capability summary + examples + constraints. */
  instructions: string;
  /** The Zod schema the tool's `query` input is validated against. */
  schema: z.ZodTypeAny;
  /** Validate, parse, validate, and optionally run a tool invocation's input. */
  build(input: QueryToolInput): Promise<QueryToolBuildResult>;
}

/** Options for `buildQueryTool`. */
export interface BuildQueryToolOptions extends QuerySchemaOptions {
  /** Tool name. Default `'query'`. */
  name?: string;
  /** Tool description. Default a generic SQL-like-query blurb. */
  description?: string;
  /** Run the query in-memory when it validates clean. Default false. */
  run?: boolean;
  /** Runtime options for the optional run (param values, etc.). */
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
 * Build a framework-neutral query tool descriptor for an engine: a `name` /
 * `description` / `instructions` / `schema` plus a `build(input)` that
 * validates, parses, and validates an LLM-supplied query (optionally running it
 * when built with `run: true`). The host wires the descriptor into its own tool
 * registry.
 */
export function buildQueryTool(
  engine: QueryEngine,
  options: BuildQueryToolOptions = {},
): QueryTool {
  const types = options.types ?? engine.registry.typeList();
  const max = options.max;
  const useString = shouldUseStringSchema(types, max);
  const schema = querySchema(engine, options);

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
    describeEngine(engine, types, options.functions),
    '',
    exampleQueriesText(),
  ].join('\n');

  const build = async (input: QueryToolInput): Promise<QueryToolBuildResult> => {
    // 1. Validate the envelope against the tool schema.
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const problems = problemsFromZod(parsed.error);
      return { query: null, problems, report: reportFor(input.query, problems) };
    }

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
    if (problems.hasErrors || !options.run) {
      return { query, problems, report };
    }

    // 5. Optionally run in-memory when valid.
    const result = await engine.run(query, options.runtime);
    return { query, problems, report, result };
  };

  return {
    name: options.name ?? 'query',
    description:
      options.description ??
      'Execute a structured query (select / insert / update / delete / set-op / cte) over the available Types.',
    instructions,
    schema,
    build,
  };
}

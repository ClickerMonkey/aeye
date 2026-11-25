/**
 * The query language for a model, as `@aeye/schema` — the query analogue of
 * gin's `buildSchemas`.
 *
 * `buildSchemas(engineOrRegistry, options?)` binds the query grammar
 * (`grammar.ts`) for one registry at one depth and returns each part of the
 * language as a `Bound` (`Query`, `Expr`, `Source`, `Select`, …): render one
 * for a model (`bound.render(profile)` — memoized), decode an answer back
 * (`rendered.parse(wire)`), or hand the bundle to a tool. The binds are
 * cached by the registry's identity + `version` and the options, so calling
 * this every turn costs a map lookup.
 *
 * Depth (`depth` / `strict` / `maxEnumSize` / `functions`) is resolved in
 * `depth.ts`, shared with the tool's instructions (`depthInstructions`).
 *
 * `shouldUseStringSchema(types, max)` + `querySchema(engine, opts)`: past
 * `max` Types the structured schema is too large to be useful, so the tool
 * falls back to a single `{ query: string }` natural-language description.
 */
import { a, type Bundle } from '@aeye/schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryDef } from '../schema';
import { QUERY_RESULTS, QueryGrammar, type QueryBundle, type QuerySchemas } from './grammar';
import {
  DEFAULT_MAX_QUERY_SCHEMA_TYPES, shouldUseStringSchema, toRegistry, type BuildSchemasOptions, type QuerySchemaOptions,
} from './depth';

export {
  DEFAULT_MAX_QUERY_SCHEMA_TYPES, shouldUseStringSchema, resolveSchemaDepth, depthInstructions, selectFunctions,
  type BuildSchemasOptions, type QuerySchemaOptions, type SchemaDepth, type FunctionSelector, type SelectedFunctions,
  type RefDepth, type NameDepth, type FnDepth, type FilterDepth, type WriteDepth, type ResolvedSchemaDepth,
} from './depth';
export { QueryGrammar, QueryGrammarBuild, QUERY_RESULTS, QUERY_BIND_CACHE_SIZE, type QuerySchemas, type ModelExprDef } from './grammar';

/**
 * Each part of the query language, bound for this registry and these
 * options (lazily: only the parts read are bound).
 */
export function buildSchemas(engineOrRegistry: QueryEngine | Registry, options: BuildSchemasOptions = {}): QuerySchemas {
  const registry = toRegistry(engineOrRegistry);
  const out = {} as Record<keyof typeof QUERY_RESULTS, unknown>;
  for (const key of Object.keys(QUERY_RESULTS) as (keyof typeof QUERY_RESULTS)[]) {
    let bound: unknown;
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => (bound ??= QUERY_RESULTS[key].bind(registry, options)),
    });
  }
  return out as unknown as QuerySchemas;
}

/** The query tool's arguments in the code shape: a structured query def, or a prose description in string-fallback mode. */
export type QueryToolInput = { query: QueryDef } | { query: string };

/** `{ query: <structured Query> }`, bound with `(registry, options?)`. */
export const QueryArgs: QueryBundle<{ query: QueryDef }> = QueryGrammar.result(a.object({ query: a.ref('Query').describe('The query to execute as a structured Query object.') }));

/** `{ query: <prose> }`: the string fallback past `max` Types. */
export const QueryProseArgs = a.object({
  query: a.string().describe(
    'A detailed natural-language description of the query: which Types are involved, ' +
      'filter conditions, known record IDs, and the precise outcome desired. ' +
      'Do not emit a structured query — there are too many Types to enumerate.',
  ),
});

/**
 * The schema for a tool's `query` input: `{ query: <structured> }` when the
 * Type count is within `max`, else `{ query: string }` — the model describes
 * the query in prose and a later pass structures it. A ref-free schema or a
 * bundle with no arguments left, so it can be given to a core `Tool` as is.
 */
export function querySchema(engine: QueryEngine | Registry, options: QuerySchemaOptions = {}): typeof QueryProseArgs | Bundle<{ query: QueryDef }, []> {
  const registry = toRegistry(engine);
  const types = options.types ?? registry.typeList();
  if (shouldUseStringSchema(types, options.max ?? DEFAULT_MAX_QUERY_SCHEMA_TYPES)) return QueryProseArgs;
  const args = QueryArgs as unknown as Bundle<{ query: QueryDef }, [Registry, BuildSchemasOptions?]>;
  return args.adapt(() => [registry, options]);
}

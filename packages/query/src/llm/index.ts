/**
 * LLM-tooling barrel — everything needed to let an LLM author, narrow, and
 * validate queries against an engine:
 *  - `buildSchemas` / `querySchema` / `QueryGrammar` — the query language as
 *    `@aeye/schema` (structured at a depth, or prose past `max` Types).
 *  - `describe*` — compact, promptable descriptions of Types / functions.
 *  - `selectTypes` — semantic Type pre-selection.
 *  - `buildQueryTool` — a ready-wired `@aeye/core` `Tool`.
 */
export {
  buildSchemas,
  querySchema,
  QueryArgs,
  QueryProseArgs,
  QueryGrammar,
  QueryGrammarBuild,
  QUERY_RESULTS,
  QUERY_BIND_CACHE_SIZE,
  type ModelExprDef,
  type QueryToolInput,
  type WriteDepth,
  shouldUseStringSchema,
  resolveSchemaDepth,
  depthInstructions,
  selectFunctions,
  DEFAULT_MAX_QUERY_SCHEMA_TYPES,
  type BuildSchemasOptions,
  type QuerySchemas,
  type QuerySchemaOptions,
  type SelectedFunctions,
  type RefDepth,
  type NameDepth,
  type FnDepth,
  type FilterDepth,
  type ResolvedSchemaDepth,
  type SchemaDepth,
  type FunctionSelector,
} from './schemas';

export {
  describeType,
  describeTypes,
  describeFunctions,
  describeOperators,
  describeExprs,
  describeQueryExamples,
  describeDialects,
  describeEngine,
  DEFAULT_MAX_EXAMPLES,
  type DescribeEngineOptions,
  type DescribeOverrides,
} from './describe';

export {
  humanize,
  fieldMeta,
  typeMeta,
  generatedFieldLabel,
  generatedFieldDescription,
  generatedTypeLabel,
  generatedTypeDescription,
  type Meta,
} from './describe-generate';

export { selectTypes, type SelectTypesOptions } from './select-types';

export {
  buildQueryTool,
  queryToolSchema,
  parseQueryTool,
  parseQueryRequest,
  QueryToolError,
  type BuildQueryToolOptions,
} from './tool';

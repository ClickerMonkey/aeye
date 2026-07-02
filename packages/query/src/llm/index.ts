/**
 * LLM-tooling barrel — everything needed to let an LLM author, narrow, and
 * validate queries against an engine:
 *  - `buildSchemas` / `querySchema` — strict-or-string Zod schemas.
 *  - `describe*` — compact, promptable descriptions of Types / functions.
 *  - `selectTypes` — semantic Type pre-selection.
 *  - `buildQueryTool` — a framework-neutral tool descriptor + builder.
 */
export {
  buildSchemas,
  querySchema,
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
  describeDialects,
  describeEngine,
  exampleQueriesText,
} from './describe';

export { selectTypes, type SelectTypesOptions } from './select-types';

export {
  buildQueryTool,
  type QueryTool,
  type QueryToolInput,
  type QueryToolBuildResult,
  type BuildQueryToolOptions,
} from './tool';

/**
 * `@aeye/query` public barrel — Phase 1 (core meta-model + infrastructure).
 * Later phases extend this with Expr / Query / runtime / SQL exports.
 */

// JSON shapes (types only)
export * from './schema';

// Shared node contracts + option bags
export type { Node, CodeOptions, SchemaOptions, ValueSchemaOptions } from './node';

// Diagnostics
export { Problems, QueryTypeError } from './problem';
export type { Problem } from './problem';

// Aid-directed schema-failure messages (the `withAid` seam + its registry)
export {
  withAid,
  aidInfo,
  describeInput,
  editDistance,
  nearestKind,
  nearest,
  didYouMean,
  suggestionBudget,
  directedMessage,
  AID_REGISTRY,
  type AidInfo,
  type AidOptions,
} from './aids';
export {
  Code,
  code,
  span,
  plain,
  joinCode,
  joinLines,
  type Span,
  type SpanMeta,
  type CodeLine,
  type JSONEntry,
  type FormatOptions,
  type FormatProblemsOptions,
} from './code';

// Field types
export { FieldType, type FieldTypeClass, type ScalarKind } from './field-type';
export * from './field-types/index';

// Meta-model
export { Field, type FieldSpec } from './field';
export { Index, IndexPart, exprDigest, renameSource, aliasedDigest } from './index-spec';
export { Type, type TypeSpec } from './type';

// Resolution
export {
  type ResolvedType,
  type TypeResolved,
  type FieldResolved,
  type ComputedResolved,
  type RelationResolved,
  type RelationKeyPair,
  asFieldType,
  sourcesOf,
  widenNullable,
  isType,
  isScalar,
  relationOf,
  valueFieldType,
} from './resolved-type';

// Registry
export {
  Registry,
  createRegistry,
  type ExprClassEntry,
  type QueryClassEntry,
  type DialectEntry,
} from './registry';

// Expr model (Phase 2)
export {
  Expr,
  BoolExpr,
  canonicalize,
  ROOT_VALIDATE_CONTEXT,
  type ExprClass,
  type ValidateContext,
} from './expr';
export * from './exprs/index';

// Ergonomic expression builder (Phase 2) — `e.*` factories returning real Exprs
export * from './builder';

// Scope / params / functions (Phase 2)
export { QueryScope } from './scope';
export { ParamSet } from './param';
export { QueryFunction, mergeOfAggregateCall } from './function';

// Type backing (Phase H1) — dev-side computed fields + RLS/FLS
// Named hidden joins + LATERAL / CROSS APPLY (Phase H2)
export {
  Backing,
  joinAlias,
  type Access,
  type Computed,
  type FieldBacking,
  type TypeBacking,
  type DefaultCondition,
  type DefaultConditionOp,
  type JoinBacking,
  type RelationBacking,
  type RelationOn,
  type RelationOnPair,
  type SearchBacking,
  type SemanticBacking,
  type DefaultOrder,
  type DefaultOrderTerm,
  type DefaultOrderDir,
  type DefaultOrderScope,
  type JoinSpec,
  type RelationJoinSpec,
  type LateralJoinSpec,
  type RuntimeJoin,
  type AccessSql,
  type AccessRun,
  type ComputeSql,
  type ComputeRun,
  type JoinSqlPlan,
  type JoinRunPlan,
  resolveAccessSql,
  resolveAccessRun,
  resolveComputeSql,
  resolveComputeRun,
  resolveJoinSql,
  resolveJoinRun,
  relationKeyColumns,
  defaultConditionOps,
  resolveDefaultConditionSql,
  resolveDefaultConditionRun,
} from './backing';
export { defaultConditionWithout } from './default-conditions';

// Cost estimation (Phase 4)
export {
  type Cost,
  type CostConstraints,
  ZERO_COST,
  EQ_SELECTIVITY,
  RANGE_SELECTIVITY,
  IN_SELECTIVITY,
  RECURSIVE_CTE_LEVELS,
  SEMANTIC_ROW_PENALTY,
  TEXT_SEARCH_ROW_PENALTY,
  addCost,
  maxCost,
  scaleRows,
  rowsCost,
  bytesOfResolved,
  reportCostProblems,
} from './cost';

// Engine (Phase 3 surface adds run / resolveQuery / validateQuery)
export {
  QueryEngine,
  type Embedder,
  type QueryEngineOptions,
  type ToSqlOptions,
} from './engine';

// Precomputed semantic text→vector embedding cache + pgvector TEXT helpers
export {
  type SemanticTextToVector,
  type SemanticEmbeddings,
  embeddingResolver,
  isVectorText,
  toVectorText,
  parseVectorText,
} from './vector-text';

// Query structure (Phase 3)
export {
  Query,
  type QueryClass,
  type QueryField,
  type QueryResult,
  type QueryResultArray,
  QuerySource,
  QueryJoin,
  type JoinHop,
  type JoinType,
  QueryOrder,
  sortEntries,
  type OrderEntry,
  SelectQuery,
  InsertQuery,
  UpdateQuery,
  DeleteQuery,
  SetOperationQuery,
  CTEStatementQuery,
  ExprQuery,
  BUILTIN_QUERIES,
  syntheticType,
  typeFromFields,
  resolveFields,
  fieldNameOf,
  makeField,
  makeResult,
  toArrayRows,
} from './queries/index';

// Runtime (Phase 3)
export { Value, type ValueCategory, isScalarValue } from './runtime/value';
export {
  type SourceRecord,
  type SourceRow,
  singleRow,
  mergeRows,
  cloneRecord,
} from './runtime/row';
export {
  RuntimeContext,
  type RuntimeOptions,
  type TypeState,
  recordKey,
  DEFAULT_MAX_CTE_ITERATIONS,
} from './runtime/context';
export {
  type TypeExecutor,
  type ExecutorContext,
  type QueryValidator,
  arrayExecutor,
} from './runtime/executor';
export {
  type FunctionRun,
  type NamedArgs,
  type ScalarRun,
  type TabularRun,
  type AggregateRun,
  type WindowRun,
  type MaybePromise,
  WINDOW_ORDER_ARG,
  runScalarFunction,
  runTabularFunction,
  runAggregateFunction,
  runWindowFunction,
} from './runtime/functions';
export { type BuiltinFunction, BUILTIN_LIBRARY } from './runtime/builtins';
export { firstField, recordSignature } from './runtime/record';

// SQL converter (Phase 5)
export {
  SqlText,
  SqlContext,
  type SqlValue,
  // The bindable VALUE of a `toSQL` param: a scalar, or the keyed object a
  // relation identity binds as (see `A8` / `DrillValue`). Exported by name so a
  // caller typing a `params` map need not spell it structurally.
  type SqlParamValue,
  type RenderedSql,
  raw,
  // NOTE: the SQL `param` combinator is intentionally NOT re-exported here — it
  // would collide with the expression builder's `param` leaf (see `./builder`).
  // Import it from `@aeye/query/sql` / `./sql/emit` when authoring dialects.
  concat,
  join,
  Dialect,
  BaseDialect,
  PostgresDialect,
  JoinCtePlanner,
  type JoinRequest,
  type RlsProvider,
  rlsPredicate,
  builtinDialects,
} from './sql/index';

// Utilities
export { inferType, type InferOptions } from './util/infer-type';

// Transforms (Phase 6) — query→query rewrites for reuse / inspection
export * from './transforms/index';

// LLM tooling (Phase 6) — schemas, describe, type-selection, query tool
export * from './llm/index';

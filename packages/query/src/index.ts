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

// Text casing — the case-comparison policy a text field or the engine declares
export {
  TEXT_CASINGS,
  DEFAULT_TEXT_CASING,
  type TextCasing,
  casingRank,
  strictestCasing,
  effectiveCasing,
  foldsInSql,
  foldsAtRuntime,
} from './text-casing';

// Field types
export { FieldType, type FieldTypeClass, type ScalarKind, SCALAR_KINDS } from './field-type';
export * from './field-types/index';

// Field-type refinements — a registered name over a builtin base (`as`)
export {
  FieldTypeRefinement,
  type FieldTypeRefinementDef,
  type FieldTypeRefinementDefFor,
  type FieldTypeOptionsOf,
  type FieldTypeOptionDecl,
  type FieldTypeCompareDecl,
  type CompiledFieldTypeOption,
  COMPARE_ARM_OPERATORS,
  refusedOperators,
  type FieldTypeImpl,
  type RefinableBase,
  REFINABLE_BASES,
  REFINEMENT_NAME_PATTERN,
  refinementKeySchema,
} from './refinement';

// Registered operators — a name whose SQL a DECLARATION supplies, per dialect
// (`&&`, `<->`, `@>`). The declaration is pure JSON, like `FunctionDef`; the
// `run` half is registered separately.
export {
  QueryOperator,
  type OperatorDef,
  type OperatorOperandDef,
  OPERATOR_NAME_PATTERN,
} from './operator';

// The `{slot}` template scanner the refinement `sql`/`cast` and operator `emit`
// declarations share — exported so a dialect author can walk a compiled template
// without re-deriving what a slot is.
export { isSlot, scanTemplate, templateSlotNames, type Template, type TemplatePart } from './sql-template';

// The known-target emit seam a write cell and an operator operand share — and
// the POSITION distinction that decides whether a declared `cast` may resolve
// an option the target never wrote (a column may, a value may not).
export { boundValue, typedValueSql, type TargetPosition } from './exprs/_bound-value';

// Conformance — the property tests the BUILTINS are held to, for a consumer's
// own declaration. Also reachable as `@aeye/query/conformance`, which is the
// name to prefer: it says what the surface is for, and it is where the docs
// point.
//
// THE SUBPATH RESOLVES TO THIS BUNDLE rather than to one of its own, and the
// reason is a measurement on the alternative. A second build entry has to
// either code-split or not, and the not-splitting half is disqualifying:
// `tsup src/index.ts src/conformance.ts --no-splitting` gives each entry its own
// copy of every class, so `instanceof ArrayFieldType` is FALSE across them.
// Measured — a consumer's `array` type met against the harness's own `array`
// TOP answered `undefined`, and `checkLatticeLaws` then reported a spurious
// `top-identity` violation for a perfectly correct type. A harness that fails
// correct input is worse than no harness.
//
// The `exports` map carries NO `source` condition, for the same reason: `src/`
// is not in `files`, so it is dead for an installed consumer, and in-repo it
// diverged from the `import` condition — one specifier resolving to sources and
// the other to `dist` is two copies of this module in one process, which is the
// failure above by another road. `npm run build` ends in `scripts/check-dist.mjs`,
// which reads the map and imports what it names, because the suite runs from
// `src` and cannot see any of this.
//
// Splitting is therefore the only viable second-entry shape, and it puts the
// shared half in a chunk while this package's circular RE-EXPORTS
// (`shape/index.ts` ↔ `shape/shape.ts`, `exprs/index.ts` ↔ `exprs/field-ref.ts`,
// `field-types/index.ts`) sit across the boundary — rollup says so itself, in
// warnings the DTS pass prints verbatim: "will likely lead to broken execution
// order". It BUILT and RAN correctly on tsup 8.5.1 in both import orders, so
// that is a hazard rather than a reproduced failure; it buys nothing, because
// there is one module either way. One bundle, two specifiers.
export {
  DEFAULT_SAMPLES,
  checkFieldType,
  checkOperator,
  checkLatticeLaws,
  topsByKind,
  type FieldTypeCheckImpl,
  type FieldTypeConformanceReport,
  type OperatorCheckOptions,
  type OperatorConformanceReport,
  type LatticeLaw,
  type LatticeLawOptions,
  type LatticeLawReport,
} from './conformance';

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

/**
 * The zod-free structural-parser combinators (`shape/`) — what an Expr / Query
 * class needs to declare its `static SHAPE`, and therefore what a CALLER-defined
 * kind needs to survive `registry.parseCheckedExpr` / `parseCheckedQuery`.
 * Without them a third-party class registered through the public `defineExpr`
 * validated, emitted SQL, costed and described correctly but was refused by the
 * checked parser with `shape.unknown-kind` — the one gate an LLM-authored query
 * goes through.
 *
 * Exported as a NAMESPACE, not flattened: the combinator names are deliberately
 * terse (`lit`, `str`, `num`, `int`, `bool`, `scalar`, `json`, `list`,
 * `record`, `optional`, `obj`, `enumOf`, …) and `lit` would SHADOW the
 * expression builder's `lit` (`./builder`) for every existing consumer — an
 * explicit re-export beats a `export *`, so the breakage would be silent. Spell
 * it `shape.obj({ kind: shape.lit('my-kind'), … })`.
 */
export * as shape from './shape/index';
// The two TYPES carry no such collision, so a class can annotate its
// `static readonly SHAPE: Shape<MyExpr>` without the qualifier.
export type { Shape, CheckCtx } from './shape/index';

// Ergonomic expression builder (Phase 2) — `e.*` factories returning real Exprs
export * from './builder';

// Scope / params / functions (Phase 2)
export { QueryScope } from './scope';
export { ParamSet, type ParamInfo, type ParamUse, type ParamConflict } from './param';
export {
  QueryFunction,
  mergeOfAggregateCall,
  validateNamedCall,
  type CallVocabulary,
  type DeclaredArg,
  type ResolvedParam,
} from './function';

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
  type OperatorRun,
  WINDOW_ORDER_ARG,
  runOperator,
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

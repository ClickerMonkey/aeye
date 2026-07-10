/**
 * Ergonomic expression BUILDER — `e.*`.
 *
 * A thin, fully-typed factory layer over the concrete `Expr` subclasses so devs
 * compose expression trees with terse function calls instead of hand-writing raw
 * `ExprDef` JSON:
 *
 * ```ts
 * import { e } from '@aeye/query';
 * const cond = e.and(
 *   e.eq(e.ref('task', 'done'), e.value(true)),
 *   e.gt(e.ref('task', 'hours'), e.value(0)),
 * );
 * ```
 *
 * Every builder RETURNS A REAL `Expr` INSTANCE (the exact subclass — `e.eq(…)`
 * is a `ComparisonExpr`, `e.and(…)` a `LogicalExpr`, …), constructed via the
 * class's public constructor. Because a built `Expr` is a first-class node it is
 * strictly more capable than a def: `built.toJSON()` yields the wire `ExprDef`
 * (free) to embed into a `QueryDef` (where `SelectDef.where` etc. are
 * `ExprDef`), while `engine.evaluateExpr(built, row)` / `engine.exprToSQL(built,
 * dialect)` run or emit it standalone. `registry.parseExpr(built)` returns it
 * unchanged (pass-through), so built and parsed exprs compose freely.
 *
 * Children are themselves `Expr` instances — the LEAF builders (`value`/`lit`,
 * `ref`, `param`, `output`, `excluded`, `filters`) make them; everything
 * else takes and returns `Expr`. There are NO `any` / `unknown` / casts.
 *
 * The one NON-expr builder is `relJoin` — it returns a plain `JoinDef` (a join
 * clause, not an `Expr`), so callers drop it straight into `joins: [...]` with
 * no `.toJSON()`.
 */
import type { BinaryOp, ScalarValue, QueryDef, JoinDef, TypeFieldRef, SourceFieldRef } from './schema';
import { Expr } from './expr';
import {
  LiteralExpr,
  OutputRefExpr,
  FieldRefExpr,
  ParamExpr,
  BinaryExpr,
  UnaryExpr,
  ComparisonExpr,
  LogicalExpr,
  InExpr,
  BetweenExpr,
  IsNullExpr,
  ExistsExpr,
  ArrayOpExpr,
  CaseExpr,
  AggregateExpr,
  WindowExpr,
  FunctionCallExpr,
  TabularFunctionCallExpr,
  SemanticExpr,
  TextSearchExpr,
  TextScoreExpr,
  FiltersExpr,
  SubqueryExpr,
  ExcludedExpr,
} from './exprs/index';

// ============================================================================
// SHARED HELPERS
// ============================================================================

/** Convert a `Record<name, Expr>` of named args into the insertion-ordered
 *  `ReadonlyMap` the call exprs (`aggregate` / `window` / `function-call` /
 *  `tabular-function-call`) hold. */
function toArgMap(args: Record<string, Expr> = {}): ReadonlyMap<string, Expr> {
  const map = new Map<string, Expr>();
  for (const name of Object.keys(args)) map.set(name, args[name]!);
  return map;
}

/** Coerce a raw scalar to a `LiteralExpr`, leaving an existing `Expr` untouched.
 *  Lets list/element builders accept raw values as a shorthand for `e.value(x)`. */
function asExpr(v: Expr | ScalarValue): Expr {
  return v instanceof Expr ? v : new LiteralExpr(v);
}

/** One `WHEN … THEN …` branch of a CASE (see {@link when} / {@link caseExpr}). */
export interface CaseBranchSpec {
  /** The branch condition (a boolean expr). */
  when: Expr;
  /** The branch result when `when` is true. */
  then: Expr;
}

/** One PARTITION BY / ORDER BY ordering term of a window (see {@link window}). */
export interface WindowOrderSpec {
  /** The ordering expression. */
  expr: Expr;
  /** Ascending or descending. */
  dir: 'asc' | 'desc';
  /** Optional nulls placement. */
  nulls?: 'first' | 'last';
}

// ============================================================================
// LEAVES
// ============================================================================

/** A constant scalar literal — builds a `LiteralExpr`. */
export function value(v: ScalarValue): LiteralExpr {
  return new LiteralExpr(v);
}

/** Alias of {@link value}: a constant scalar literal — builds a `LiteralExpr`. */
export function lit(v: ScalarValue): LiteralExpr {
  return new LiteralExpr(v);
}

/** A named bind parameter — builds a `ParamExpr`. */
export function param(name: string): ParamExpr {
  return new ParamExpr(name);
}

/** A direct field reference `<source>.<field>` — builds a `FieldRefExpr`. */
export function ref(source: string, field: string): FieldRefExpr {
  return new FieldRefExpr(source, field);
}

/** A reference to a SELECT output field by name — builds an `OutputRefExpr`. */
export function output(name: string): OutputRefExpr {
  return new OutputRefExpr(name);
}

/** A reference to the proposed (`EXCLUDED`) row's field inside an INSERT
 *  ON CONFLICT DO UPDATE — builds an `ExcludedExpr`. */
export function excluded(field: string): ExcludedExpr {
  return new ExcludedExpr(field);
}

/** A structured-filter placeholder bound to a `source` (optional field
 *  allowlist) — builds a `FiltersExpr`. */
export function filters(source: string, fields?: string[]): FiltersExpr {
  return new FiltersExpr(source, fields);
}

// ============================================================================
// ARITHMETIC OPERATORS
// ============================================================================

/** Build a binary arithmetic `BinaryExpr` for `op`. */
function binary(op: BinaryOp, left: Expr, right: Expr): BinaryExpr {
  return new BinaryExpr(op, left, right);
}

/** Addition `left + right` — builds a `BinaryExpr`. */
export function add(left: Expr, right: Expr): BinaryExpr {
  return binary('+', left, right);
}

/** Subtraction `left - right` — builds a `BinaryExpr`. */
export function sub(left: Expr, right: Expr): BinaryExpr {
  return binary('-', left, right);
}

/** Multiplication `left * right` — builds a `BinaryExpr`. */
export function mul(left: Expr, right: Expr): BinaryExpr {
  return binary('*', left, right);
}

/** Division `left / right` — builds a `BinaryExpr`. */
export function div(left: Expr, right: Expr): BinaryExpr {
  return binary('/', left, right);
}

/** Modulo `left % right` — builds a `BinaryExpr`. */
export function mod(left: Expr, right: Expr): BinaryExpr {
  return binary('%', left, right);
}

/** Unary negation `-operand` — builds a `UnaryExpr`. */
export function neg(operand: Expr): UnaryExpr {
  return new UnaryExpr('-', operand);
}

/** Unary plus `+operand` — builds a `UnaryExpr`. */
export function pos(operand: Expr): UnaryExpr {
  return new UnaryExpr('+', operand);
}

// ============================================================================
// COMPARISON OPERATORS
// ============================================================================

/** Equality `left = right` — builds a `ComparisonExpr`. */
export function eq(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('=', left, right);
}

/** Inequality `left <> right` — builds a `ComparisonExpr`. */
export function neq(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('<>', left, right);
}

/** Less-than `left < right` — builds a `ComparisonExpr`. */
export function lt(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('<', left, right);
}

/** Less-than-or-equal `left <= right` — builds a `ComparisonExpr`. */
export function lte(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('<=', left, right);
}

/** Greater-than `left > right` — builds a `ComparisonExpr`. */
export function gt(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('>', left, right);
}

/** Greater-than-or-equal `left >= right` — builds a `ComparisonExpr`. */
export function gte(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('>=', left, right);
}

/** Case-sensitive pattern match `left LIKE right` — builds a `ComparisonExpr`. */
export function like(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('like', left, right);
}

/** Negated pattern match `left NOT LIKE right` — builds a `ComparisonExpr`. */
export function notLike(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('notLike', left, right);
}

/** Case-insensitive pattern match `left ILIKE right` — builds a `ComparisonExpr`. */
export function ilike(left: Expr, right: Expr): ComparisonExpr {
  return new ComparisonExpr('ilike', left, right);
}

// ============================================================================
// LOGICAL CONNECTIVES
// ============================================================================

/** Boolean AND over its operands — builds a `LogicalExpr`. */
export function and(...operands: Expr[]): LogicalExpr {
  return new LogicalExpr('and', operands);
}

/** Boolean OR over its operands — builds a `LogicalExpr`. */
export function or(...operands: Expr[]): LogicalExpr {
  return new LogicalExpr('or', operands);
}

/** Boolean NOT of a single operand — builds a `LogicalExpr`. */
export function not(operand: Expr): LogicalExpr {
  return new LogicalExpr('not', [operand]);
}

// ============================================================================
// PREDICATES (null / between / in / exists)
// ============================================================================

/** `value IS NULL` — builds an `IsNullExpr`. */
export function isNull(v: Expr): IsNullExpr {
  return new IsNullExpr(v, false);
}

/** `value IS NOT NULL` — builds an `IsNullExpr`. */
export function notNull(v: Expr): IsNullExpr {
  return new IsNullExpr(v, true);
}

/** `value BETWEEN lower AND upper` — builds a `BetweenExpr`. */
export function between(v: Expr, lower: Expr, upper: Expr): BetweenExpr {
  return new BetweenExpr(v, lower, upper, false);
}

/** `value NOT BETWEEN lower AND upper` — builds a `BetweenExpr`. */
export function notBetween(v: Expr, lower: Expr, upper: Expr): BetweenExpr {
  return new BetweenExpr(v, lower, upper, true);
}

/** `value IN (…list)` — builds an `InExpr`. Items may be `Expr`s or raw
 *  `ScalarValue`s (each raw value is wrapped as a `LiteralExpr`). */
export function inList(v: Expr, items: ReadonlyArray<Expr | ScalarValue>): InExpr {
  return new InExpr(v, items.map(asExpr), undefined, false);
}

/** `value NOT IN (…list)` — builds an `InExpr`. Items may be `Expr`s or raw
 *  `ScalarValue`s (each raw value is wrapped as a `LiteralExpr`). */
export function notInList(v: Expr, items: ReadonlyArray<Expr | ScalarValue>): InExpr {
  return new InExpr(v, items.map(asExpr), undefined, true);
}

/** `value IN (subquery)` — builds an `InExpr` over a `QueryDef`. */
export function inSubquery(v: Expr, query: QueryDef): InExpr {
  return new InExpr(v, undefined, query, false);
}

/** `value NOT IN (subquery)` — builds an `InExpr` over a `QueryDef`. */
export function notInSubquery(v: Expr, query: QueryDef): InExpr {
  return new InExpr(v, undefined, query, true);
}

/** `EXISTS (subquery)` — builds an `ExistsExpr` over a `QueryDef`. */
export function exists(query: QueryDef): ExistsExpr {
  return new ExistsExpr(query, false);
}

/** `NOT EXISTS (subquery)` — builds an `ExistsExpr` over a `QueryDef`. */
export function notExists(query: QueryDef): ExistsExpr {
  return new ExistsExpr(query, true);
}

// ============================================================================
// ARRAY PREDICATES
// ============================================================================

/** `target` array contains the single element `value` — builds an `ArrayOpExpr`. */
export function contains(target: Expr, value: Expr): ArrayOpExpr {
  return new ArrayOpExpr('contains', target, [value]);
}

/** `target` array overlaps ANY of `values` — builds an `ArrayOpExpr`. */
export function containsAny(target: Expr, values: Expr[]): ArrayOpExpr {
  return new ArrayOpExpr('containsAny', target, values);
}

/** `target` array contains ALL of `values` — builds an `ArrayOpExpr`. */
export function containsAll(target: Expr, values: Expr[]): ArrayOpExpr {
  return new ArrayOpExpr('containsAll', target, values);
}

/** `target` array has no elements — builds an `ArrayOpExpr`. */
export function isEmpty(target: Expr): ArrayOpExpr {
  return new ArrayOpExpr('isEmpty', target, []);
}

/** `target` array has at least one element — builds an `ArrayOpExpr`. */
export function notEmpty(target: Expr): ArrayOpExpr {
  return new ArrayOpExpr('notEmpty', target, []);
}

// ============================================================================
// CASE
// ============================================================================

/** One `WHEN cond THEN result` branch (for {@link caseExpr}). */
export function when(cond: Expr, then: Expr): CaseBranchSpec {
  return { when: cond, then };
}

/** `CASE WHEN … THEN … [ELSE …] END` over the given branches — builds a
 *  `CaseExpr`. Exposed on the `e` namespace as `e.case`. */
export function caseExpr(branches: CaseBranchSpec[], els?: Expr): CaseExpr {
  return new CaseExpr(branches, els);
}

// ============================================================================
// CALLS (function / aggregate / window / tabular)
// ============================================================================

/** A scalar function call `name(args)` — builds a `FunctionCallExpr`. `args`
 *  are keyed by declared parameter name. */
export function fn(name: string, args: Record<string, Expr> = {}): FunctionCallExpr {
  return new FunctionCallExpr(name, toArgMap(args));
}

/** An aggregate function call `name(args)` — builds an `AggregateExpr`. `args`
 *  are keyed by declared parameter name; `distinct` defaults to false. */
export function agg(
  name: string,
  args: Record<string, Expr> = {},
  distinct: boolean = false,
): AggregateExpr {
  return new AggregateExpr(name, toArgMap(args), distinct);
}

/** `count(value)` when `value` is given, else `count(*)` — builds an
 *  `AggregateExpr`. */
export function count(value?: Expr): AggregateExpr {
  return new AggregateExpr('count', value ? toArgMap({ value }) : toArgMap(), false);
}

/** `count(*)` over rows — builds an `AggregateExpr` with empty args. */
export function countStar(): AggregateExpr {
  return new AggregateExpr('count', toArgMap(), false);
}

/** `sum(value)` — builds an `AggregateExpr`. */
export function sum(value: Expr): AggregateExpr {
  return new AggregateExpr('sum', toArgMap({ value }), false);
}

/** `avg(value)` — builds an `AggregateExpr`. */
export function avg(value: Expr): AggregateExpr {
  return new AggregateExpr('avg', toArgMap({ value }), false);
}

/** `min(value)` — builds an `AggregateExpr`. */
export function min(value: Expr): AggregateExpr {
  return new AggregateExpr('min', toArgMap({ value }), false);
}

/** `max(value)` — builds an `AggregateExpr`. */
export function max(value: Expr): AggregateExpr {
  return new AggregateExpr('max', toArgMap({ value }), false);
}

/** `stddev(value)` — sample standard deviation — builds an `AggregateExpr`. */
export function stddev(value: Expr): AggregateExpr {
  return new AggregateExpr('stddev', toArgMap({ value }), false);
}

/** `variance(value)` — sample variance — builds an `AggregateExpr`. */
export function variance(value: Expr): AggregateExpr {
  return new AggregateExpr('variance', toArgMap({ value }), false);
}

/** `stringAgg(value, sep)` — join non-null values by `sep` — builds an `AggregateExpr`. */
export function stringAgg(value: Expr, sep: Expr): AggregateExpr {
  return new AggregateExpr('stringAgg', toArgMap({ value, sep }), false);
}

/** `arrayAgg(value)` — collect values into an array — builds an `AggregateExpr`. */
export function arrayAgg(value: Expr): AggregateExpr {
  return new AggregateExpr('arrayAgg', toArgMap({ value }), false);
}

/** `boolAnd(value)` — logical AND over a group — builds an `AggregateExpr`. */
export function boolAnd(value: Expr): AggregateExpr {
  return new AggregateExpr('boolAnd', toArgMap({ value }), false);
}

/** `boolOr(value)` — logical OR over a group — builds an `AggregateExpr`. */
export function boolOr(value: Expr): AggregateExpr {
  return new AggregateExpr('boolOr', toArgMap({ value }), false);
}

/** `countIf(cond)` — count rows where `cond` is true — builds an `AggregateExpr`. */
export function countIf(cond: Expr): AggregateExpr {
  return new AggregateExpr('countIf', toArgMap({ cond }), false);
}

/** A window function `name(args) OVER (PARTITION BY … ORDER BY …)` — builds a
 *  `WindowExpr`. `args` are keyed by declared parameter name. */
export function window(
  name: string,
  opts: {
    args?: Record<string, Expr>;
    partitionBy?: Expr[];
    orderBy?: WindowOrderSpec[];
  } = {},
): WindowExpr {
  return new WindowExpr(name, toArgMap(opts.args), opts.partitionBy ?? [], opts.orderBy ?? []);
}

/** A table-valued function call `name(args)` — builds a `TabularFunctionCallExpr`.
 *  `args` are keyed by declared parameter name. */
export function tableFn(name: string, args: Record<string, Expr> = {}): TabularFunctionCallExpr {
  return new TabularFunctionCallExpr(name, toArgMap(args));
}

// ============================================================================
// DATE / TIME (scalar builtins — Group 2a)
// ============================================================================

/** `currentTime()` — the current time-of-day (`HH:MM:SS`). */
export function currentTime(): FunctionCallExpr {
  return fn('currentTime');
}

/** `currentTimestamp()` — the current timestamp. */
export function currentTimestamp(): FunctionCallExpr {
  return fn('currentTimestamp');
}

/** `datePart(field, d)` — the numeric `field` component of date `d`. `field` is
 *  a literal date token (`'year'`, `'month'`, `'dow'`, …). */
export function datePart(field: string, d: Expr): FunctionCallExpr {
  return fn('datePart', { field: new LiteralExpr(field), d });
}

/** `year(d)` — the year component of date `d`. */
export function year(d: Expr): FunctionCallExpr {
  return fn('year', { d });
}

/** `month(d)` — the month component (1–12) of date `d`. */
export function month(d: Expr): FunctionCallExpr {
  return fn('month', { d });
}

/** `day(d)` — the day-of-month component of date `d`. */
export function day(d: Expr): FunctionCallExpr {
  return fn('day', { d });
}

/** `hour(d)` — the hour component of timestamp `d`. */
export function hour(d: Expr): FunctionCallExpr {
  return fn('hour', { d });
}

/** `minute(d)` — the minute component of timestamp `d`. */
export function minute(d: Expr): FunctionCallExpr {
  return fn('minute', { d });
}

/** `second(d)` — the second component of timestamp `d`. */
export function second(d: Expr): FunctionCallExpr {
  return fn('second', { d });
}

/** `dayOfWeek(d)` — day of week of `d` (0 = Sunday … 6 = Saturday). */
export function dayOfWeek(d: Expr): FunctionCallExpr {
  return fn('dayOfWeek', { d });
}

/** `dayOfYear(d)` — 1-based day of year of `d`. */
export function dayOfYear(d: Expr): FunctionCallExpr {
  return fn('dayOfYear', { d });
}

/** `week(d)` — ISO-8601 week number of `d`. */
export function week(d: Expr): FunctionCallExpr {
  return fn('week', { d });
}

/** `dateAdd(field, n, d)` — `d` plus `n` units of literal `field` (`'day'`, …). */
export function dateAdd(field: string, n: Expr, d: Expr): FunctionCallExpr {
  return fn('dateAdd', { field: new LiteralExpr(field), n, d });
}

/** `dateDiff(field, a, b)` — the difference of the `field` components of `a`
 *  and `b` (`part(b) - part(a)`); `field` is a literal date token. */
export function dateDiff(field: string, a: Expr, b: Expr): FunctionCallExpr {
  return fn('dateDiff', { field: new LiteralExpr(field), a, b });
}

/** `dateTrunc(field, d)` — `d` truncated to literal `field` precision (`'month'`, …). */
export function dateTrunc(field: string, d: Expr): FunctionCallExpr {
  return fn('dateTrunc', { field: new LiteralExpr(field), d });
}

/** `makeDate(year, month, day)` — a date from its numeric parts. */
export function makeDate(y: Expr, m: Expr, d: Expr): FunctionCallExpr {
  return fn('makeDate', { year: y, month: m, day: d });
}

/** `dateFormat(d, format)` — `d` formatted with a `to_char`-style token string. */
export function dateFormat(d: Expr, format: Expr): FunctionCallExpr {
  return fn('dateFormat', { d, format });
}

/** `epoch(ts)` — seconds since the Unix epoch for timestamp `ts`. */
export function epoch(ts: Expr): FunctionCallExpr {
  return fn('epoch', { ts });
}

/** `fromEpoch(value)` — the timestamp `value` seconds after the Unix epoch. */
export function fromEpoch(value: Expr): FunctionCallExpr {
  return fn('fromEpoch', { value });
}

/** `age(a, b)` — the whole-day span `a - b`. */
export function age(a: Expr, b: Expr): FunctionCallExpr {
  return fn('age', { a, b });
}

// ============================================================================
// ARRAY (scalar builtins — Group 2b)
// ============================================================================

/** `arrayContains(arr, value)` — whether `arr` contains `value` (pg `= ANY`). */
export function arrayContains(arr: Expr, value: Expr): FunctionCallExpr {
  return fn('arrayContains', { arr, value });
}

/** `arrayAppend(arr, value)` — `arr` with `value` appended. */
export function arrayAppend(arr: Expr, value: Expr): FunctionCallExpr {
  return fn('arrayAppend', { arr, value });
}

/** `arrayPrepend(arr, value)` — `arr` with `value` prepended. */
export function arrayPrepend(arr: Expr, value: Expr): FunctionCallExpr {
  return fn('arrayPrepend', { arr, value });
}

/** `arrayConcat(a, b)` — the concatenation of arrays `a` and `b`. */
export function arrayConcat(a: Expr, b: Expr): FunctionCallExpr {
  return fn('arrayConcat', { a, b });
}

/** `arrayIndexOf(arr, value)` — 1-based position of `value` (NULL if absent). */
export function arrayIndexOf(arr: Expr, value: Expr): FunctionCallExpr {
  return fn('arrayIndexOf', { arr, value });
}

/** `arraySlice(arr, lo, hi)` — the 1-based inclusive slice `arr[lo:hi]`. */
export function arraySlice(arr: Expr, lo: Expr, hi: Expr): FunctionCallExpr {
  return fn('arraySlice', { arr, lo, hi });
}

/** `arrayRemove(arr, value)` — `arr` with every `value` element removed. */
export function arrayRemove(arr: Expr, value: Expr): FunctionCallExpr {
  return fn('arrayRemove', { arr, value });
}

/** `arrayDistinct(arr)` — `arr` with duplicate elements removed. */
export function arrayDistinct(arr: Expr): FunctionCallExpr {
  return fn('arrayDistinct', { arr });
}

/** `arrayToString(arr, sep)` — `arr`'s non-null elements joined by `sep`. */
export function arrayToString(arr: Expr, sep: Expr): FunctionCallExpr {
  return fn('arrayToString', { arr, sep });
}

/** `stringToArray(str, sep)` — `str` split into an array on `sep`. */
export function stringToArray(str: Expr, sep: Expr): FunctionCallExpr {
  return fn('stringToArray', { str, sep });
}

// ============================================================================
// QUERY EMBEDDING (subquery)
// ============================================================================

/** A subquery in value position — builds a `SubqueryExpr` over a `QueryDef`. */
export function subquery(query: QueryDef): SubqueryExpr {
  return new SubqueryExpr(query);
}

// ============================================================================
// JOINS
// ============================================================================

/**
 * A RELATION join `{ on:{ kind:'relation', source, field, as } }` — cross the
 * belongs-to/has-many relation `field` of the bound `source` into its target,
 * bound under the REQUIRED alias `as`. Reproduces the belongs-to traversal (the
 * key is synthesized from the relation, LEFT by default); pass `opts.joinType`
 * for a different join and `opts.and` for an extra predicate ANDed with the key.
 *
 * Returns a plain `JoinDef` (NOT an `Expr`) — drop it straight into a query's
 * `joins: [...]` with NO `.toJSON()`; child exprs (`opts.and`) still `.toJSON()`.
 */
export function relJoin(
  source: string,
  field: string,
  as: string,
  opts?: { and?: Expr; joinType?: 'inner' | 'left' | 'right' | 'full' },
): JoinDef {
  return {
    on: { kind: 'relation', source, field, as },
    ...(opts?.and ? { and: opts.and.toJSON() } : {}),
    ...(opts?.joinType ? { joinType: opts.joinType } : {}),
  };
}

// ============================================================================
// SEARCH / SEMANTIC
// ============================================================================

/** Full-text search over a bound `source` (optionally one `field`) — builds a
 *  `TextSearchExpr`. `query` is a literal string or a bound `ParamExpr`. */
export function textSearch(
  source: string,
  query: string | ParamExpr,
  field?: string,
): TextSearchExpr {
  const q =
    typeof query === 'string' ? { kind: 'text' as const, text: query } : { kind: 'param' as const, param: query };
  return new TextSearchExpr(source, field, q);
}

/** Numeric full-text RELEVANCE score of a bound `source` (optionally one
 *  `field`) against `query` — builds a `TextScoreExpr` (usable in SELECT /
 *  ORDER BY). `query` is a literal string or a bound `ParamExpr`. */
export function textScore(
  source: string,
  query: string | ParamExpr,
  field?: string,
): TextScoreExpr {
  const q =
    typeof query === 'string' ? { kind: 'text' as const, text: query } : { kind: 'param' as const, param: query };
  return new TextScoreExpr(source, field, q);
}

/** Semantic-similarity score of a bound `source`'s row (optionally one `field`)
 *  against `query` — builds a `SemanticExpr`. `query` is a literal string, a
 *  bound `ParamExpr`, a `SourceFieldRef` (`{ source, field }`) pairing against
 *  ANOTHER bound source's semantic field, or a `TypeFieldRef` (`{ type, field }`)
 *  resolving to the single bound source of that Type — the paired field's
 *  embedding becomes the query vector. */
export function semantic(
  source: string,
  query: string | ParamExpr | SourceFieldRef | TypeFieldRef,
  field?: string,
): SemanticExpr {
  if (typeof query === 'string') {
    return new SemanticExpr(source, field, { kind: 'text', text: query });
  }
  if (query instanceof ParamExpr) {
    return new SemanticExpr(source, field, { kind: 'param', param: query });
  }
  if ('source' in query) {
    return new SemanticExpr(source, field, { kind: 'sourceField', source: query.source, field: query.field });
  }
  return new SemanticExpr(source, field, { kind: 'typeField', type: query.type, field: query.field });
}

// ============================================================================
// `e` NAMESPACE
// ============================================================================

/**
 * The `e` namespace object — every builder under one import, so the common
 * `e.and(e.eq(e.ref('task', 'done'), e.value(true)), …)` style works with a
 * single `import { e } from '@aeye/query'`. Each function is ALSO a named
 * export for tree-shaking / direct import. `e.case` is {@link caseExpr}.
 */
export const e = {
  // leaves
  value,
  lit,
  param,
  ref,
  output,
  excluded,
  filters,
  // arithmetic
  add,
  sub,
  mul,
  div,
  mod,
  neg,
  pos,
  // comparison
  eq,
  neq,
  lt,
  lte,
  gt,
  gte,
  like,
  notLike,
  ilike,
  // logical
  and,
  or,
  not,
  // predicates
  isNull,
  notNull,
  between,
  notBetween,
  inList,
  notInList,
  inSubquery,
  notInSubquery,
  exists,
  notExists,
  // array
  contains,
  containsAny,
  containsAll,
  isEmpty,
  notEmpty,
  // case
  when,
  case: caseExpr,
  // calls
  fn,
  agg,
  count,
  countStar,
  sum,
  avg,
  min,
  max,
  stddev,
  variance,
  stringAgg,
  arrayAgg,
  boolAnd,
  boolOr,
  countIf,
  window,
  tableFn,
  // date / time
  currentTime,
  currentTimestamp,
  datePart,
  year,
  month,
  day,
  hour,
  minute,
  second,
  dayOfWeek,
  dayOfYear,
  week,
  dateAdd,
  dateDiff,
  dateTrunc,
  makeDate,
  dateFormat,
  epoch,
  fromEpoch,
  age,
  // array
  arrayContains,
  arrayAppend,
  arrayPrepend,
  arrayConcat,
  arrayIndexOf,
  arraySlice,
  arrayRemove,
  arrayDistinct,
  arrayToString,
  stringToArray,
  // query-embedding
  subquery,
  // joins
  relJoin,
  // search / semantic
  textSearch,
  textScore,
  semantic,
} as const;

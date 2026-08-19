/**
 * Runtime function dispatch — the shape-tagged `FunctionRun` model.
 *
 * Every registered function (scalar / tabular / aggregate / window) carries a
 * runtime implementation tagged with its SHAPE, so the four function-call
 * expression kinds dispatch UNIFORMLY: collect the call's NAMED arguments, look
 * up the registered run, and invoke the variant matching the function's shape.
 *
 *  - scalar    — `(args) => Value`              one row in, one value out.
 *  - tabular   — `(args) => Value`              one row in, ROWS out (raw array).
 *  - aggregate — `(rows) => Value`              the whole group's per-row args.
 *  - window    — `(partition, index) => Value`  the ordered partition + position.
 *
 * Everything is typed against `Value` and `NamedArgs`; no `any` / casts.
 */
import type { QueryEngine } from '../engine';
import { QueryTypeError } from '../problem';
import type { RuntimeContext } from './context';
import { Value } from './value';

/** A `T` that may be produced synchronously or via a Promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A call's evaluated arguments, keyed by the function's declared parameter
 * name. Absent (optional, omitted) params simply have no entry.
 */
export type NamedArgs = Readonly<Record<string, Value>>;

/** A scalar implementation: named args in, a single `Value` out. */
export type ScalarRun = (args: NamedArgs, ctx: RuntimeContext) => MaybePromise<Value>;

/**
 * A tabular implementation: named args in, a `Value` whose `raw` is the
 * produced rows (a JSON array) out.
 */
export type TabularRun = (args: NamedArgs, ctx: RuntimeContext) => MaybePromise<Value>;

/**
 * An aggregate implementation: the group's rows, each as the per-row evaluated
 * named args, in; the single aggregated `Value` out. (An empty `value` arg —
 * `count(*)` — arrives as rows with no `value` key.)
 */
export type AggregateRun = (
  rows: readonly NamedArgs[],
  ctx: RuntimeContext,
) => MaybePromise<Value>;

/**
 * A window implementation: the ORDERED partition (each row's evaluated named
 * args) plus the CURRENT row's `index` within it, in; the per-row `Value` out.
 *
 * Order-sensitive window functions (`rank` / `denseRank`) read each partition
 * row's ORDER-BY key from a reserved `$order` named arg (a `Value` whose `raw`
 * is the JSON array of that row's order values) which `WindowExpr` injects.
 */
export type WindowRun = (
  partition: readonly NamedArgs[],
  index: number,
  ctx: RuntimeContext,
) => MaybePromise<Value>;

/**
 * A registered OPERATOR's implementation: its named operands in, a single
 * `Value` out — structurally a {@link ScalarRun}, and deliberately a NAME of its
 * own rather than a reuse of that alias.
 *
 * There is no shape TAG here, because an operator has exactly one shape. That is
 * also why `registerOperatorRun` takes the closure directly while
 * `registerFunctionRun` takes a `{ shape, run }` pair: the tag exists on the
 * function side to stop an aggregate def being given a scalar run, and an
 * operator has no second shape to be confused with.
 */
export type OperatorRun = (args: NamedArgs, ctx: RuntimeContext) => MaybePromise<Value>;

/** The reserved named-arg key carrying a window row's ORDER-BY key. */
export const WINDOW_ORDER_ARG = '$order';

/**
 * A registered runtime implementation, tagged by the function SHAPE it serves.
 * `registerFunctionRun` checks this tag against the function's `FunctionDef`.
 */
export type FunctionRun =
  | { shape: 'scalar'; run: ScalarRun }
  | { shape: 'tabular'; run: TabularRun }
  | { shape: 'aggregate'; run: AggregateRun }
  | { shape: 'window'; run: WindowRun };

/** The `shape` discriminant of a `FunctionRun`. */
export type FunctionRunShape = FunctionRun['shape'];

// ─── Shape-checked dispatch helpers ──────────────────────────────────────────
//
// Each looks up the registered run by name and invokes it ONLY when its tag
// matches the expected shape, so the four exprs dispatch without casts. A
// missing / wrong-shape run degrades to NULL (scalar/window) or an empty row
// set (tabular) — resolution-time validation reports the real problem.

/** Run a registered SCALAR function over its named args (NULL if absent). */
export async function runScalarFunction(
  engine: QueryEngine,
  name: string,
  args: NamedArgs,
  ctx: RuntimeContext,
): Promise<Value> {
  const impl = engine.functionRun(name);
  if (impl && impl.shape === 'scalar') return impl.run(args, ctx);
  return Value.null();
}

/**
 * Run a registered OPERATOR over its named operands — REFUSING when no
 * implementation is registered.
 *
 * THIS IS THE ONE PLACE THIS PACKAGE'S "a missing run answers NULL" rule DOES
 * NOT APPLY, and the asymmetry is deliberate rather than an oversight of the
 * function precedent it otherwise copies. The parity argument fails on two
 * measured points:
 *
 *  - **`emit` is REQUIRED and `run` is OPTIONAL**, so an operator is far more
 *    likely to lack a run than a function is. A registered function without a
 *    run is a declaration nobody finished; an operator without one is the
 *    NORMAL, documented shape of a SQL-road operator.
 *  - **an operator is usually a PREDICATE.** A scalar function answering NULL in
 *    a projection puts a visible NULL in the output; a `bool` operator answering
 *    NULL in a `WHERE` is UNKNOWN for every row, so the query returns ZERO ROWS
 *    and looks like it ran. That is precisely the failure `OperatorExpr.toSQL`
 *    refuses an unsupported dialect for — "a wrong answer that looks exactly
 *    like a right one" — and it would be incoherent to refuse it on the SQL road
 *    and produce it on the in-memory one.
 *
 * So the in-memory road refuses with the same `Problems`-grade message the emit
 * road uses. A deployment that genuinely wants a SQL-road-only operator gets an
 * error naming the operator the moment something tries to evaluate it, which is
 * the only honest answer: there is no value this package can compute for it.
 */
export async function runOperator(
  engine: QueryEngine,
  name: string,
  args: NamedArgs,
  ctx: RuntimeContext,
): Promise<Value> {
  const impl = engine.operatorRun(name);
  if (!impl) {
    throw new QueryTypeError({
      path: [],
      code: 'operator.no-run',
      severity: 'error',
      message:
        `Operator '${name}' has no in-memory implementation, so \`engine.run\` cannot evaluate it. ` +
        `Register one with \`registerOperatorRun('${name}', (args, ctx) => …)\`, or run this query ` +
        'through `engine.toSQL` — where its declared `emit` is what executes. It is REFUSED rather ' +
        'than answered with NULL because an operator is usually a PREDICATE: a NULL predicate is ' +
        'UNKNOWN for every row, so the query would return ZERO ROWS and look exactly like one that ran.',
    });
  }
  return impl(args, ctx);
}

/** Run a registered TABULAR function over its named args (empty rows if absent). */
export async function runTabularFunction(
  engine: QueryEngine,
  name: string,
  args: NamedArgs,
  ctx: RuntimeContext,
): Promise<Value> {
  const impl = engine.functionRun(name);
  if (impl && impl.shape === 'tabular') return impl.run(args, ctx);
  return Value.of([]);
}

/** Run a registered AGGREGATE function over a group's per-row args (NULL if absent). */
export async function runAggregateFunction(
  engine: QueryEngine,
  name: string,
  rows: readonly NamedArgs[],
  ctx: RuntimeContext,
): Promise<Value> {
  const impl = engine.functionRun(name);
  if (impl && impl.shape === 'aggregate') return impl.run(rows, ctx);
  return Value.null();
}

/** Run a registered WINDOW function over an ordered partition (NULL if absent). */
export async function runWindowFunction(
  engine: QueryEngine,
  name: string,
  partition: readonly NamedArgs[],
  index: number,
  ctx: RuntimeContext,
): Promise<Value> {
  const impl = engine.functionRun(name);
  if (impl && impl.shape === 'window') return impl.run(partition, index, ctx);
  return Value.null();
}

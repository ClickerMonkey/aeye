/**
 * Shared NAMED-ARGUMENT plumbing for the four function-call expression kinds
 * (`function-call`, `tabular-function-call`, `aggregate`, `window`). Every such
 * expr stores its arguments as an insertion-ordered `Map<string, Expr>` keyed
 * by the declared parameter name; these helpers parse / resolve / validate /
 * evaluate / emit / serialize that map uniformly so each expr file stays small.
 *
 * No `any` / casts.
 */
import { z } from 'zod';
import type { ExprDef } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import type { Expr, ValidateContext } from '../expr';
import type { QueryFunction } from '../function';
import { ParamExpr } from './param';
import { LiteralExpr } from './literal';
import { withAid } from '../aids';
import type { Value } from '../runtime/value';
import type { NamedArgs } from '../runtime/functions';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** Parse a JSON named-arg object into an insertion-ordered `Map<string, Expr>`. */
export function parseNamedArgs(
  json: Record<string, ExprDef>,
  registry: Registry,
): Map<string, Expr> {
  const out = new Map<string, Expr>();
  for (const [name, def] of Object.entries(json)) out.set(name, registry.parseExpr(def));
  return out;
}

/** The Zod schema for a named-arg object: `{ <param>: <childExpr> }`. */
export function namedArgSchema(child: z.ZodTypeAny): z.ZodTypeAny {
  return withAid(z.record(z.string(), child), 'FunctionArgs').describe(
    'Arguments keyed by declared parameter name.',
  );
}

/** Resolve each named arg's type, preserving the argument order. */
export function resolveNamedArgs(
  args: ReadonlyMap<string, Expr>,
  engine: QueryEngine,
  scope: QueryScope,
): Map<string, ResolvedType> {
  const out = new Map<string, ResolvedType>();
  for (const [name, e] of args) out.set(name, e.resolve(engine, scope));
  return out;
}

/**
 * Validate each named arg child at path `['args', name]`, returning the map of
 * resolved argument types (for the caller's `validateCall` / `resolveOutput`).
 * Children are walked with `childCtx` (the same ctx for scalars; an aggregate /
 * window expr passes a restricted context).
 */
export function validateNamedArgs(
  args: ReadonlyMap<string, Expr>,
  engine: QueryEngine,
  scope: QueryScope,
  p: Problems,
  childCtx: ValidateContext,
): Map<string, ResolvedType> {
  const out = new Map<string, ResolvedType>();
  for (const [name, e] of args) {
    out.set(name, p.at(['args', name], () => e.validateWalk(engine, scope, p, childCtx)));
  }
  return out;
}

/** Evaluate each named arg against a row/group, producing runtime `NamedArgs`. */
export async function evaluateNamedArgs(
  args: ReadonlyMap<string, Expr>,
  ctx: RuntimeContext,
  row: SourceRow | null,
  group?: readonly SourceRow[],
): Promise<NamedArgs> {
  const out: Record<string, Value> = {};
  for (const [name, e] of args) out[name] = await e.evaluate(ctx, row, group);
  return out;
}

/** Evaluate each named arg against a SINGLE row (for per-row aggregate collection). */
export async function evaluateNamedArgsRow(
  args: ReadonlyMap<string, Expr>,
  ctx: RuntimeContext,
  row: SourceRow,
): Promise<NamedArgs> {
  const out: Record<string, Value> = {};
  for (const [name, e] of args) out[name] = await e.evaluate(ctx, row);
  return out;
}

/** The string value of a string LITERAL expr, or `undefined` otherwise (used to
 *  read a `rawArgs` inline-literal field token). */
export function rawStringLiteral(e: Expr): string | undefined {
  return e instanceof LiteralExpr && typeof e.value === 'string' ? e.value : undefined;
}

/**
 * The date-field tokens a `rawArgs` field argument may take (the
 * `EXTRACT`/`date_part` field names). Not every token is meaningful for every
 * selector (e.g. `dateAdd('dow', …)` has no interval unit); the set is the
 * union the extractors accept, and callers document per-function semantics.
 */
export const ALLOWED_DATE_FIELDS: ReadonlySet<string> = new Set<string>([
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'hour',
  'minute',
  'second',
  'dow',
  'isodow',
  'doy',
  'epoch',
]);

/**
 * Validate a call's `rawArgs` (inline-literal field) positions: each must be a
 * string LITERAL drawn from {@link ALLOWED_DATE_FIELDS}. Pushes a
 * `function.raw-arg` Problem at `['args', <param>]` otherwise. A position with
 * no supplied arg is skipped (a missing REQUIRED arg is reported separately by
 * `validateCall`).
 */
export function validateRawArgs(
  fn: QueryFunction,
  args: ReadonlyMap<string, Expr>,
  p: Problems,
): void {
  if (!fn.rawArgs) return;
  for (const idx of fn.rawArgs) {
    const param = fn.params[idx];
    const e = args.get(param.name);
    if (!e) continue;
    const token = rawStringLiteral(e);
    if (token === undefined || !ALLOWED_DATE_FIELDS.has(token)) {
      p.at(['args', param.name], () =>
        p.error(
          'function.raw-arg',
          `Argument '${param.name}' of '${fn.name}' must be a literal date field (one of: ${[...ALLOWED_DATE_FIELDS].join(', ')}).`,
        ),
      );
    }
  }
}

/**
 * Render the args as SQL in DECLARED parameter order (falling back to the
 * authored order for unknown functions / extra args), so emission is stable.
 * A declared `rawArgs` position whose arg is a string literal is emitted as an
 * INLINE literal via `dialect.rawArgLiteral` (a spliced field token) rather than
 * a bound parameter; a non-literal there falls back to the normal param path
 * (validation has already flagged it).
 */
export function orderedArgSql(
  fnName: string,
  args: ReadonlyMap<string, Expr>,
  dialect: Dialect,
  ctx: SqlContext,
): SqlText[] {
  const fn = ctx.engine.lookupFunction(fnName);
  const order = fn ? fn.params.map((param) => param.name) : [...args.keys()];
  const rawSet = new Set<number>(fn?.rawArgs ?? []);
  const seen = new Set<string>();
  const out: SqlText[] = [];
  order.forEach((name, i) => {
    const e = args.get(name);
    if (!e) return;
    seen.add(name);
    const token = rawSet.has(i) ? rawStringLiteral(e) : undefined;
    out.push(token !== undefined ? dialect.rawArgLiteral(token) : e.toSQL(dialect, ctx));
  });
  // Any authored args not declared by the function trail in authored order.
  for (const [name, e] of args) {
    if (!seen.has(name)) out.push(e.toSQL(dialect, ctx));
  }
  return out;
}

/**
 * Observe each bind-PARAM argument against the function's declared parameter
 * type, so `:param` usages infer their type from the call site — and RE-RESOLVE
 * those arguments into `argTypes`, so the caller's `validateCall` /
 * `resolveOutput` see the type the observation just produced rather than the
 * `text` placeholder an un-observed `ParamExpr` resolves to.
 *
 * CALL THIS BEFORE `validateCall`. Through 0.6.6 all four call-shaped exprs
 * validated first (and three of them never observed at all), so `abs(:p)` was
 * refused with `function.arg-type: expects number, got text` — unless an
 * EARLIER clause happened to type `:p` first, which made the answer depend on
 * clause ORDER (`t.n = :p AND abs(:p) > 1` passed; the same two clauses swapped
 * did not). A function argument is one of the typing roads `param.untyped`
 * advertises, so the declared parameter type must reach the param before
 * anything judges it.
 *
 * Returns the argument NAMES whose expr is a bare bind param, for
 * {@link QueryFunction.validateCall} to exempt from its arg-type check — the
 * same exemption `ComparisonExpr` applies to a param operand. A param arg can
 * never be "the wrong type" for the parameter that types it; when its uses
 * across the query cannot all hold, that is reported once, as `param.conflict`,
 * and in that case the param falls back to `text` here — which without the
 * exemption would add a second, order-dependent complaint about the same fact.
 */
export function observeNamedParams(
  args: ReadonlyMap<string, Expr>,
  fn: QueryFunction,
  engine: QueryEngine,
  scope: QueryScope,
  here: ReadonlyArray<string | number>,
  argTypes: Map<string, ResolvedType>,
): ReadonlySet<string> {
  const byName = new Map(fn.params.map((param) => [param.name, param]));
  const paramArgs = new Set<string>();
  for (const [name, e] of args) {
    if (!(e instanceof ParamExpr)) continue;
    const param = byName.get(name);
    // An arg naming no declared param is `function.unknown-arg`, and an `'any'`
    // param declares no type to observe (nor to check against): neither is a
    // typing road, so neither is exempt from anything.
    if (!param?.fieldType) continue;
    paramArgs.add(name);
    scope.params.observe(e.name, param.fieldType, [...here, 'args', name]);
    argTypes.set(name, e.resolve(engine, scope));
  }
  return paramArgs;
}

/** Serialize the args map back to its JSON named-arg object. */
export function namedArgsToJSON(args: ReadonlyMap<string, Expr>): Record<string, ExprDef> {
  const out: Record<string, ExprDef> = {};
  for (const [name, e] of args) out[name] = e.toJSON();
  return out;
}

/** A readable `name: code, …` rendering of the args (for `toCode`). */
export function namedArgsToCode(args: ReadonlyMap<string, Expr>): string {
  return [...args].map(([name, e]) => `${name}: ${e.toCode()}`).join(', ');
}

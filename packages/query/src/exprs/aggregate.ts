/**
 * AggregateExpr — an aggregate function call dispatched through the registry.
 * `function` names a registered AGGREGATE-shaped function; `args` carries its
 * arguments BY NAME (the builtins take a single `value`). The `count(*)` form
 * is `count` with EMPTY args. This is the one expr kind that reports
 * `aggregateHere() === true`, driving `containsAggregate`.
 *
 * Result types (builtins): count → number, never null; sum → number (money
 * when summing money), null over an empty group; avg → number, null over empty;
 * min/max → the argument's own type, null over empty.
 *
 * Validation enforces aggregate PLACEMENT (illegal where `ctx.allowAggregate`
 * is false, e.g. WHERE; may not nest) PLUS the function's own named-arg checks
 * (`function.missing-arg` for a bare `sum()`, `function.arg-type` for a
 * non-numeric `value`). The runtime aggregation LOGIC lives in the registered
 * `AggregateRun`, not here.
 */
import { z } from 'zod';
import type { AggregateExprDef, ExprDef, JsonValue } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { functionExprSchema } from '../schema-build';
import { NumberFieldType } from '../field-types/index';
import { computed, childExprSchema, type AppliedAggregate } from './_shared';
import { mergeOfAggregateCall, type QueryFunction } from '../function';
import { withAid, didYouMean } from '../aids';
import { obj, lit, str, bool, record, exprRef } from '../shape';
import {
  parseNamedArgs,
  namedArgSchema,
  resolveNamedArgs,
  validateNamedArgs,
  evaluateNamedArgsRow,
  observeNamedParams,
  namedArgsToJSON,
  namedArgsToCode,
} from './_function-args';
import { type NamedArgs, runAggregateFunction } from '../runtime/functions';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost, CostContext } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** An aggregate function call (e.g. `sum`, `count`), dispatched through the registry. */
export class AggregateExpr extends Expr {
  static readonly KIND = 'aggregate' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "An aggregate function over a group (`count(*)` = empty args); optional `distinct`. A RELATION field-ref is NOT aggregable (`ref.relation-aggregate`) — its value is an IDENTITY: group by it, or aggregate a scalar off a `relation`-joined alias." as const;
  readonly kind = AggregateExpr.KIND;

  /** Wrap a registered aggregate `fn` with its named `args` and a DISTINCT flag. */
  constructor(
    readonly fn: string,
    /** Arguments keyed by declared parameter name (empty for `count(*)`). */
    readonly args: ReadonlyMap<string, Expr>,
    readonly distinct: boolean,
  ) {
    super();
  }

  /** The conventional single `value` argument (absent for `count(*)`). */
  valueArg(): Expr | undefined {
    return this.args.get('value');
  }

  /**
   * The ROW-LEVEL expression this aggregate summarizes — i.e. how it
   * UN-aggregates, recovered from the aggregate's `FunctionDef` un-aggregate
   * TEMPLATE (a serializable `ExprDef` with `{kind:'arg', name}` placeholders)
   * with THIS call's arguments substituted in: `sum(o.total)` → `o.total`,
   * `count(v)` → `CASE WHEN v IS NULL THEN 0 ELSE 1 END`, `count(*)` → `1`. The
   * arg-less form (`count(*)`) uses the function's `unaggregateEmpty` template.
   * Returns `undefined` when the aggregate declares NO template (it cannot be
   * un-aggregated) — a drilled query then drops the containing select / order expr.
   */
  unaggregate(engine: QueryEngine): Expr | undefined {
    const def = engine.registry.function(this.fn);
    if (!def) return undefined;
    // Arg-less (`count(*)`) prefers the `unaggregateEmpty` template; otherwise the
    // normal `unaggregate` template with the call's args substituted.
    const template = this.valueArg() === undefined ? def.unaggregateEmpty ?? def.unaggregate : def.unaggregate;
    if (!template) return undefined;
    const substituted = substituteArgs(template, this.args);
    return substituted ? engine.registry.parseExpr(substituted) : undefined;
  }

  /** Reconstruct an AggregateExpr from its JSON def, parsing named args via the registry. */
  static from(json: ExprDef, registry: Registry): AggregateExpr {
    if (json.kind !== 'aggregate') {
      throw new Error(`AggregateExpr.from: expected 'aggregate', got '${json.kind}'`);
    }
    return new AggregateExpr(json.function, parseNamedArgs(json.args, registry), json.distinct ?? false);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds an
   * `AggregateExpr` equal to `from`'s output on a valid def (`args` is a named
   * record — empty for `count(*)`; `distinct` defaults to `false`). Accumulates
   * every bad arg in one pass (never throws). Semantic checks (arg count / type
   * / aggregate placement) remain in `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('aggregate'),
      function: str('FunctionName'),
      args: record(exprRef(), 'FunctionArgs'),
      distinct: bool('Distinct'),
    },
    (v) => new AggregateExpr(v.function, v.args, v.distinct ?? false),
    { optional: ['distinct'], aid: 'Expr_aggregate' },
  );

  /** Zod schema for this expr kind's JSON shape (named-arg map plus distinct), layered by `functionExprSchema`. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    // The `open` shape (also the bare-call / `functions:'open'` fallback);
    // `names` / `typed` are layered on by `functionExprSchema`.
    const open = withAid(
      z.object({
        kind: z.literal('aggregate'),
        function: z.string().describe('Registered aggregate function name (count for count(*)).'),
        args: namedArgSchema(child),
        distinct: z.boolean().optional(),
      }),
      'Expr_aggregate',
    ).describe('Aggregate function over named args (count with empty args = count(*)).');
    return functionExprSchema('aggregate', open, opts.functions, opts.depth?.functions ?? 'open', child, opts.cache);
  }

  protected override aggregateHere(): boolean {
    return true;
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const a of this.args.values()) visit(a);
  }

  /**
   * The APPLIED-aggregate facts this call stamps onto its resolution: the
   * function name, whether it was DISTINCT, and how two of ITS values merge over
   * a union of groups. `merge` is resolved here — the function's declaration
   * reduced by the DISTINCT rule — rather than left to the consumer, because a
   * consumer reading `QueryField.type` over the wire has neither the engine to
   * look the declaration up nor the call to see the DISTINCT.
   */
  private applied(fn: QueryFunction | undefined): AppliedAggregate {
    return { fn: this.fn, distinct: this.distinct, merge: mergeOfAggregateCall(fn?.merge, this.distinct) };
  }

  /**
   * Resolve to the function's declared output type, marked aggregate and nullable
   * (except `count`), and carrying the APPLIED function's name, DISTINCT-ness and
   * merge semantics.
   *
   * Those three are set on BOTH roads — including the unknown-function fallback,
   * where the written name is still the fact of what was written even though the
   * resolution is a placeholder (an unknown function declares no merge, so that
   * road answers `'none'`). This is the ONE node that can answer "which aggregate
   * is this?": every wrapping expr reports `aggregate: true` from its children
   * without a single applied function, and `Function.resolveOutput` never sets
   * it, so nothing propagates a stale name upward.
   */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const fn = engine.lookupFunction(this.fn);
    if (!fn) {
      // Unknown aggregate: a nullable numeric aggregate keeps downstream
      // resolution total; `validateWalk` reports the real `aggregate.unknown`.
      return computed(new NumberFieldType(), [], true, true, this.applied(undefined));
    }
    const base = fn.resolveOutput(resolveNamedArgs(this.args, engine, scope));
    if (base.kind !== 'computed') return base;
    // Aggregate nullability is structural: every aggregate but `count` can be
    // NULL over an empty group; `count` never is.
    const nullable = this.fn !== 'count';
    const applied = this.applied(fn);
    return {
      ...base,
      nullable,
      aggregate: true,
      aggregateFn: applied.fn,
      aggregateDistinct: applied.distinct,
      aggregateMerge: applied.merge,
    };
  }

  /** Validate aggregate placement (not in WHERE, not nested) and the function's own named-arg checks. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    if (!ctx.allowAggregate) {
      p.error(
        'aggregate.not-allowed',
        `Aggregate '${this.fn}' is not allowed here (e.g. inside WHERE or another aggregate).`,
      );
    }
    if (ctx.inAggregate) {
      p.error('aggregate.nested', `Aggregate '${this.fn}' cannot be nested inside another aggregate.`);
    }
    // DISTINCT de-duplicates the ARGUMENT VALUES, so the arg-less `count(*)` form
    // has nothing to de-duplicate: the runtime already ignores the flag there
    // (`evaluate`) and `count(DISTINCT *)` is not valid SQL on any dialect. Say so
    // rather than emit a statement the database rejects.
    if (this.distinct && this.args.size === 0) {
      p.error(
        'aggregate.distinct-no-args',
        `Aggregate '${this.fn}' is DISTINCT but has no arguments — DISTINCT de-duplicates argument VALUES, and '${this.fn}(*)' has none. Drop 'distinct', or pass the value to de-duplicate.`,
      );
    }

    const here = p.here;
    // Recurse with aggregate context so nested aggregates are caught.
    const childCtx: ValidateContext = { ...ctx, inAggregate: true, allowAggregate: false };
    const argTypes = validateNamedArgs(this.args, engine, scope, p, childCtx);

    const fn = engine.lookupFunction(this.fn);
    if (!fn) {
      p.error('aggregate.unknown', `Unknown aggregate function '${this.fn}'.${didYouMean(this.fn, engine.registry.functionList().filter((f) => f.shape === 'aggregate').map((f) => f.name))}`);
      return this.resolve(engine, scope);
    }
    if (fn.shape !== 'aggregate') {
      p.error(
        'aggregate.wrong-shape',
        `Function '${this.fn}' is '${fn.shape}', not an aggregate function.`,
      );
    } else {
      // A param argument is TYPED BY the declared parameter (`sum(:p)` makes
      // `:p` a number), so observe before validating — see `observeNamedParams`.
      const paramArgs = observeNamedParams(this.args, fn, engine, scope, here, argTypes);
      fn.validateCall(argTypes, p, paramArgs);
    }

    return this.resolve(engine, scope);
  }

  /** Cost is the per-arg byte cost (or zero for the arg-less `count(*)`). */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    // An aggregate reads its argument once per scanned row; its own output is a
    // single value. The per-arg byte cost is the meaningful contribution.
    return this.args.size === 0 ? { rows: 0, bytes: 0 } : this.childCost(ctx, scope);
  }

  /** This expr calls the aggregate function `fn`. */
  override functionRef(): string {
    return this.fn;
  }

  /** Collect each group row's named args (deduped when DISTINCT) and run the registered aggregate. */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    const rows = group ?? (row ? [row] : []);
    let collected: NamedArgs[] = [];
    for (const r of rows) collected.push(await evaluateNamedArgsRow(this.args, ctx, r));
    // DISTINCT collapses rows with identical argument values (only meaningful
    // when there ARE args — `count(*)` must never be deduped to one row).
    if (this.distinct && this.args.size > 0) collected = dedupeArgs(collected);
    return runAggregateFunction(ctx.engine, this.fn, collected, ctx);
  }

  /**
   * Emit the aggregate as the plain `fn([DISTINCT] args)` call — `fn(*)` when
   * there are no args (`count(*)`). Fan-out over a relation is now expressed as
   * an explicit `relation` JOIN in the query's `joins`, so the aggregate simply
   * runs over the (already-joined) rows; there is no hidden pre-aggregation CTE.
   *
   * DISTINCT is dropped for the ARG-LESS form: it de-duplicates argument values
   * and there are none, the runtime ignores it there too (`evaluate`), and
   * `count(DISTINCT *)` is a syntax error on every dialect. `validateWalk`
   * reports it (`aggregate.distinct-no-args`); emission stays TOTAL for a caller
   * that emits without validating first.
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const distinctSql = this.distinct && this.args.size > 0 ? SqlText.raw('DISTINCT ') : SqlText.empty();
    // `count(*)` — the arg-less star form (no builtin override applies).
    if (this.args.size === 0) {
      return SqlText.concat([SqlText.raw(`${this.fn}(`), SqlText.raw('*'), SqlText.raw(')')]);
    }
    const argSql = [...this.args.values()].map((a) => a.toSQL(dialect, ctx.asAggregate(true)));
    // A dialect may emit a builtin aggregate with a special / portable form
    // (e.g. `countIf` → `sum(CASE … END)`, or the base `boolAnd`/`arrayAgg`
    // degrades); otherwise emit the generic `name(args)` call, honoring the
    // function's SQL-name override (`stringAgg` → `string_agg`).
    const override = dialect.emitBuiltinCall(this.fn, argSql);
    if (override) return override;
    const name = ctx.engine.lookupFunction(this.fn)?.sql ?? this.fn;
    return SqlText.concat([
      SqlText.raw(`${name}(`),
      distinctSql,
      SqlText.join(argSql, ', '),
      SqlText.raw(')'),
    ]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): AggregateExprDef {
    const def: AggregateExprDef = {
      kind: 'aggregate',
      function: this.fn,
      args: namedArgsToJSON(this.args),
    };
    if (this.distinct) def.distinct = true;
    return def;
  }

  /** Deep-copy this expr (and its argument children). */
  clone(): AggregateExpr {
    const cloned = new Map<string, Expr>();
    for (const [k, e] of this.args) cloned.set(k, e.clone());
    return new AggregateExpr(this.fn, cloned, this.distinct);
  }

  /** Render a human-readable source form of this aggregate call. */
  override toCode(): string {
    const inner = this.args.size === 0 ? '*' : namedArgsToCode(this.args);
    return `${this.fn}(${this.distinct ? 'DISTINCT ' : ''}${inner})`;
  }
}

/** Deduplicate per-row named args by the JSON signature of their values. */
function dedupeArgs(rows: readonly NamedArgs[]): NamedArgs[] {
  const seen = new Set<string>();
  const out: NamedArgs[] = [];
  for (const r of rows) {
    const sig = JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.raw])));
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(r);
  }
  return out;
}

/**
 * Substitute an un-aggregate TEMPLATE's `{kind:'arg', name}` placeholders with a
 * call's actual argument exprs, yielding a real `ExprDef`. Walks the template JSON
 * structurally (kind-agnostic), replacing every `arg` node with `args.get(name)`.
 * Returns `undefined` when the template references an argument the call did NOT
 * supply (so that form of the aggregate cannot be un-aggregated by this template).
 */
function substituteArgs(template: ExprDef, args: ReadonlyMap<string, Expr>): ExprDef | undefined {
  let missing = false;
  const walk = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const rec = node as { readonly [k: string]: JsonValue };
      if (rec['kind'] === 'arg' && typeof rec['name'] === 'string') {
        const arg = args.get(rec['name']);
        if (!arg) { missing = true; return null; }
        // `ExprDef` is a JSON value; the round-trip cast is the only JSON boundary.
        return arg.toJSON() as unknown as JsonValue;
      }
      const out: { [k: string]: JsonValue } = {};
      for (const k of Object.keys(rec)) out[k] = walk(rec[k]!);
      return out;
    }
    return node;
  };
  const result = walk(template as unknown as JsonValue);
  return missing ? undefined : (result as unknown as ExprDef);
}

const _check: ExprClass = AggregateExpr;
void _check;

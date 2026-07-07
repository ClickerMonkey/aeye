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
import type { AggregateExprDef, ExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { functionExprSchema } from '../schema-build';
import { NumberFieldType } from '../field-types/index';
import { computed, childExprSchema } from './_shared';
import { withAid, didYouMean } from '../aids';
import {
  parseNamedArgs,
  namedArgSchema,
  resolveNamedArgs,
  validateNamedArgs,
  evaluateNamedArgsRow,
  namedArgsToJSON,
  namedArgsToCode,
} from './_function-args';
import { type NamedArgs, runAggregateFunction } from '../runtime/functions';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { fanoutAggregateInfo } from '../sql/relation-walk';
import { RelationPathExpr } from './relation-path';

/** An aggregate function call (e.g. `sum`, `count`), dispatched through the registry. */
export class AggregateExpr extends Expr {
  static readonly KIND = 'aggregate' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "An aggregate function over a group (`count(*)` = empty args); optional `distinct`." as const;
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

  /** Reconstruct an AggregateExpr from its JSON def, parsing named args via the registry. */
  static from(json: ExprDef, registry: Registry): AggregateExpr {
    if (json.kind !== 'aggregate') {
      throw new Error(`AggregateExpr.from: expected 'aggregate', got '${json.kind}'`);
    }
    return new AggregateExpr(json.function, parseNamedArgs(json.args, registry), json.distinct ?? false);
  }

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

  /** Resolve to the function's declared output type, marked aggregate and nullable (except `count`). */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const fn = engine.lookupFunction(this.fn);
    if (!fn) {
      // Unknown aggregate: a nullable numeric aggregate keeps downstream
      // resolution total; `validateWalk` reports the real `aggregate.unknown`.
      return computed(new NumberFieldType(), [], true, true);
    }
    const base = fn.resolveOutput(resolveNamedArgs(this.args, engine, scope));
    if (base.kind !== 'computed') return base;
    // Aggregate nullability is structural: every aggregate but `count` can be
    // NULL over an empty group; `count` never is.
    const nullable = this.fn !== 'count';
    return { ...base, nullable, aggregate: true };
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
      fn.validateCall(argTypes, p);
    }

    return this.resolve(engine, scope);
  }

  /** Cost is the per-arg byte cost (or zero for the arg-less `count(*)`). */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    // An aggregate reads its argument once per scanned row; its own output is a
    // single value. The per-arg byte cost is the meaningful contribution.
    return this.args.size === 0 ? { rows: 0, bytes: 0 } : this.childCost(engine, scope);
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
   * Emit the aggregate. A fan-out (`count > 1`) relation-path `value` argument
   * is pre-aggregated into a `WITH agg_… GROUP BY` CTE (so the outer row set
   * isn't fanned out); otherwise emit the plain `fn([DISTINCT] args)` call —
   * `fn(*)` when there are no args (`count(*)`).
   */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const value = this.valueArg();
    if (value instanceof RelationPathExpr) {
      const info = fanoutAggregateInfo(ctx, value.source, value.path);
      if (info) {
        const res = ctx.planner.requireAggregateCte({
          leftAlias: info.leftAlias,
          localField: info.localField,
          foreignField: info.foreignField,
          targetType: info.targetType,
          relationField: info.relationField,
          aggFn: this.fn,
          distinct: this.distinct,
          argField: info.argField,
        });
        const ref = dialect.field(res.alias, res.valueField);
        // count over an absent group is 0, not NULL.
        return this.fn === 'count' ? SqlText.concat([SqlText.raw('COALESCE('), ref, SqlText.raw(', 0)')]) : ref;
      }
    }
    const distinctSql = this.distinct ? SqlText.raw('DISTINCT ') : SqlText.empty();
    // `count(*)` — the arg-less star form (no builtin override applies).
    if (this.args.size === 0) {
      return SqlText.concat([SqlText.raw(`${this.fn}(`), distinctSql, SqlText.raw('*'), SqlText.raw(')')]);
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

const _check: ExprClass = AggregateExpr;
void _check;

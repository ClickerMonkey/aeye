/**
 * ExistsExpr — `[NOT] EXISTS (subquery)`. A `BoolExpr` (never null). The
 * subquery's shape is inferred via the Phase-2 structural seam; full subquery
 * validation arrives with the query classes in Phase 3.
 */
import { z } from 'zod';
import type { ExistsExprDef, ExprDef, QueryDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, type ExprClass, type ValidateContext } from '../expr';
import { boolResult, childQuerySchema, emitSubquerySQL } from './_shared';
import { inferSubqueryOutput } from './_subquery';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** An `[NOT] EXISTS (subquery)` predicate. A `BoolExpr`. */
export class ExistsExpr extends BoolExpr {
  static readonly KIND = 'exists' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`[NOT] EXISTS (subquery)` → boolean." as const;
  readonly kind = ExistsExpr.KIND;

  /** Wrap `[NOT] EXISTS (query)` as an existence predicate over a subquery. */
  constructor(
    readonly query: QueryDef,
    readonly not: boolean,
  ) {
    super();
  }

  /** Reconstruct an ExistsExpr from its JSON def (validates `kind`; the subquery is carried as-is). */
  static from(json: ExprDef, _registry: Registry): ExistsExpr {
    if (json.kind !== 'exists') {
      throw new Error(`ExistsExpr.from: expected 'exists', got '${json.kind}'`);
    }
    return new ExistsExpr(json.query, json.not ?? false);
  }

  /** Zod schema for this expr kind's JSON shape (uses a child Query slot for the subquery). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z
      .object({
        kind: z.literal('exists'),
        query: childQuerySchema(opts.Query),
        not: z.boolean().optional(),
      })
      .meta({ aid: 'Expr_exists' })
      .describe('Existence predicate over a subquery.');
  }

  /** Resolve to a non-nullable bool (EXISTS yields a definite boolean). */
  override resolve(_engine: QueryEngine, _scope: QueryScope): ComputedResolved {
    // EXISTS yields a definite boolean.
    return boolResult([], false, false);
  }

  /** Exercise the subquery structural seam (so shape errors throw early) and resolve to bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    _p: Problems,
    _ctx: ValidateContext,
  ): ComputedResolved {
    // Exercise the structural seam so subquery shape errors throw early;
    // detailed subquery validation lands with the query classes (Phase 3).
    inferSubqueryOutput(engine, scope, this.query);
    return this.resolve(engine, scope);
  }

  /** Estimated cost: the subquery's scan cost (its own output is a single boolean). */
  override cost(engine: QueryEngine, scope: QueryScope): Cost {
    // EXISTS scans its subquery; its own output is a single boolean.
    return engine.parseQuery(this.query).cost(engine, scope.child());
  }

  /** Execute the correlated subquery and return whether it produced any rows (negated for `NOT EXISTS`). */
  async evaluateBool(ctx: RuntimeContext, row: SourceRow): Promise<boolean> {
    const q = ctx.engine.parseQuery(this.query);
    const result = await ctx.withCorrelation(row, () => q.execute(ctx));
    const exists = result.rows.length > 0;
    return this.not ? !exists : exists;
  }

  /** Emit as a SqlText fragment (`[NOT] EXISTS (subquery)`). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return SqlText.concat([
      SqlText.raw(this.not ? 'NOT EXISTS ' : 'EXISTS '),
      emitSubquerySQL(dialect, ctx, this.query),
    ]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): ExistsExprDef {
    const def: ExistsExprDef = { kind: 'exists', query: structuredClone(this.query) };
    if (this.not) def.not = true;
    return def;
  }

  /** Deep-copy this expr (and its subquery). */
  clone(): ExistsExpr {
    return new ExistsExpr(structuredClone(this.query), this.not);
  }

  /** Render as readable pseudo-code. */
  override toCode(): string {
    return `${this.not ? 'NOT EXISTS' : 'EXISTS'} (subquery)`;
  }
}

const _check: ExprClass = ExistsExpr;
void _check;

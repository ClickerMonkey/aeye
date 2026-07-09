/**
 * SubqueryExpr — a subquery in value position (typically a scalar / single
 * field). Its output type is inferred via the Phase-2 structural seam
 * (`inferSubqueryOutput`); when Phase 3's query classes land, that seam swaps
 * to real query resolution and this class needs no change.
 */
import { z } from 'zod';
import type { ExprDef, QueryDef, SubqueryExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { childQuerySchema, emitSubquerySQL } from './_shared';
import { withAid } from '../aids';
import { obj, lit, queryDefRef } from '../shape';
import { inferSubqueryOutput } from './_subquery';
import type { Dialect } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';
import { Value } from '../runtime/value';
import { firstField } from '../runtime/record';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';

/** A subquery in value position (typically a scalar / single-column result). */
export class SubqueryExpr extends Expr {
  static readonly KIND = 'subquery' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A scalar (single-value) subquery in value position — its inner `query` must project exactly ONE field and yield one row. Use where ONE value is needed (e.g. comparing a field against an aggregate over related rows). For membership use `in`, for existence use `exists`." as const;
  /**
   * Worked example (see `ExprClass.EXAMPLES`) — a scalar subquery in value
   * position: an aggregate over related rows, usable e.g. as one side of a
   * comparison. Projects a SINGLE field (the aggregate), yielding one value.
   */
  static readonly EXAMPLES: readonly string[] = [
    JSON.stringify({
      kind: 'subquery',
      query: {
        kind: 'select',
        fields: [
          {
            expr: {
              kind: 'aggregate',
              function: 'avg',
              args: { value: { kind: 'field-ref', source: 'order', field: 'total' } },
            },
            as: 'avgTotal',
          },
        ],
        from: { kind: 'type', type: 'order' },
      },
    } satisfies SubqueryExprDef),
  ];
  readonly kind = SubqueryExpr.KIND;

  /** Wrap the inner query def evaluated in value position. */
  constructor(readonly query: QueryDef) {
    super();
  }

  /** Reconstruct a SubqueryExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): SubqueryExpr {
    if (json.kind !== 'subquery') {
      throw new Error(`SubqueryExpr.from: expected 'subquery', got '${json.kind}'`);
    }
    return new SubqueryExpr(json.query);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Structurally
   * validates the inner `query` through `parseCheckedQuery` (accumulating its
   * problems) and keeps its normalized def, building a `SubqueryExpr` equal to
   * `from`'s output on a valid def. Never throws. See `shape/`.
   */
  static readonly SHAPE = obj(
    { kind: lit('subquery'), query: queryDefRef() },
    (v) => new SubqueryExpr(v.query),
    { aid: 'Expr_subquery' },
  );

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('subquery'),
        query: childQuerySchema(opts.Query),
      }),
      'Expr_subquery',
    ).describe('A subquery used in value position.');
  }

  /** Infer the subquery's output type via the structural seam. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    return inferSubqueryOutput(engine, scope, this.query);
  }

  /** Infer the output type (full subquery validation is deferred to Phase 3). */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    _p: Problems,
    _ctx: ValidateContext,
  ): ResolvedType {
    // Phase 3 will validate the subquery in full; this phase only infers the
    // output type (surfacing structural errors via the seam).
    return inferSubqueryOutput(engine, scope, this.query);
  }

  /** Cost of running the inner query in a child scope. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return engine.parseQuery(this.query).cost(engine, scope.child());
  }

  /** Execute the subquery (correlated to `row` when present) and return its first field. */
  async evaluate(ctx: RuntimeContext, row: SourceRow | null): Promise<Value> {
    const q = ctx.engine.parseQuery(this.query);
    // A subquery is a NESTED query — run it non-root so a Type's `defaultOrder`
    // with `applyTo: 'result'` does not treat it as the entry query.
    const run = () => ctx.withNonRoot(() => q.execute(ctx));
    const result = row ? await ctx.withCorrelation(row, run) : await run();
    const first = result.rows[0];
    return first ? Value.of(firstField(first)) : Value.null();
  }

  /** Emit the inner query as a parenthesized SQL subquery. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return emitSubquerySQL(dialect, ctx, this.query);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): SubqueryExprDef {
    return { kind: 'subquery', query: structuredClone(this.query) };
  }

  /** Deep-copy this expr. */
  clone(): SubqueryExpr {
    return new SubqueryExpr(structuredClone(this.query));
  }

  /** Render as a `(subquery)` placeholder in the readable DSL form. */
  override toCode(): string {
    return '(subquery)';
  }
}

const _check: ExprClass = SubqueryExpr;
void _check;

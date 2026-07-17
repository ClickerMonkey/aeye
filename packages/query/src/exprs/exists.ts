/**
 * ExistsExpr — `[NOT] EXISTS (subquery)`. A `BoolExpr` (never null). The
 * subquery's shape is inferred via the Phase-2 structural seam; full subquery
 * validation arrives with the query classes in Phase 3.
 */
import { z } from 'zod';
import type { ExistsExprDef, ExprDef, QueryDef, SelectDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, type ExprClass, type ValidateContext } from '../expr';
import { boolResult, childQuerySchema, emitSubquerySQL } from './_shared';
import { withAid } from '../aids';
import { obj, lit, bool, queryDefRef } from '../shape';
import { validateSubqueryOutput } from './_subquery';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost, CostContext } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** An `[NOT] EXISTS (subquery)` predicate. A `BoolExpr`. */
export class ExistsExpr extends BoolExpr {
  static readonly KIND = 'exists' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`[NOT] EXISTS (subquery)` → boolean; test whether related rows exist. To CORRELATE the inner query to the outer row, JOIN the relation in the INNER query (`joins:[{on:{kind:'relation',source,field,as}}]`) and compare the JOINED alias's key to the outer scalar (e.g. `{source:alias,field:'id'} = {outer field-ref}`). Do NOT compare a relation field-ref to an id/scalar — that is rejected." as const;
  /**
   * Worked example (see `ExprClass.EXAMPLES`) — outer `user` rows that HAVE a
   * matching `order`: the inner query joins `order → user` (relation) as `u` and
   * CORRELATES via `u.id = user.id` — the correlation models most often omit.
   */
  static readonly EXAMPLES: readonly string[] = [
    JSON.stringify({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
      where: [
        {
          kind: 'exists',
          query: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
            from: { kind: 'type', type: 'order' },
            joins: [{ on: { kind: 'relation', source: 'order', field: 'user', as: 'u' } }],
            where: [
              {
                kind: 'comparison',
                op: '=',
                left: { kind: 'field-ref', source: 'u', field: 'id' },
                right: { kind: 'field-ref', source: 'user', field: 'id' },
              },
            ],
          },
        },
      ],
    } satisfies SelectDef),
    // ANTI-JOIN: users with NO order over 100. `not:true` NOT EXISTS, correlated
    // the SAME way — join `order → user` as `u` and compare `u.id = user.id`
    // (the joined key to the outer scalar), PLUS an inner filter on `total`.
    JSON.stringify({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
      where: [
        {
          kind: 'exists',
          not: true,
          query: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
            from: { kind: 'type', type: 'order' },
            joins: [{ on: { kind: 'relation', source: 'order', field: 'user', as: 'u' } }],
            where: [
              {
                kind: 'comparison',
                op: '=',
                left: { kind: 'field-ref', source: 'u', field: 'id' },
                right: { kind: 'field-ref', source: 'user', field: 'id' },
              },
              {
                kind: 'comparison',
                op: '>',
                left: { kind: 'field-ref', source: 'order', field: 'total' },
                right: { kind: 'literal', value: 100 },
              },
            ],
          },
        },
      ],
    } satisfies SelectDef),
  ];
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

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Structurally
   * validates the inner `query` (accumulating its problems) and keeps its
   * normalized def, building an `ExistsExpr` equal to `from`'s output on a valid
   * def. Never throws. See `shape/`.
   */
  static readonly SHAPE = obj(
    { kind: lit('exists'), query: queryDefRef(), not: bool('Not') },
    (v) => new ExistsExpr(v.query, v.not ?? false),
    { optional: ['not'], aid: 'Expr_exists' },
  );

  /** Zod schema for this expr kind's JSON shape (uses a child Query slot for the subquery). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('exists'),
        query: childQuerySchema(opts.Query),
        not: z.boolean().optional(),
      }),
      'Expr_exists',
    ).describe('Existence predicate over a subquery.');
  }

  /** Resolve to a non-nullable bool (EXISTS yields a definite boolean). */
  override resolve(_engine: QueryEngine, _scope: QueryScope): ComputedResolved {
    // EXISTS yields a definite boolean.
    return boolResult([], false, false);
  }

  /** FULLY VALIDATE the correlated inner query (problems nested under `query`) and resolve to bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ComputedResolved {
    // Validate the inner query in a correlation-aware child scope so a bad ref
    // (e.g. a relation-vs-scalar correlation) INSIDE it surfaces.
    p.at('query', () => validateSubqueryOutput(engine, scope, p, ctx, this.query));
    return this.resolve(engine, scope);
  }

  /** Estimated cost: the subquery's scan cost (its own output is a single boolean). */
  override cost(ctx: CostContext, scope: QueryScope): Cost {
    // EXISTS scans its subquery; its own output is a single boolean.
    const engine = ctx.engine;
    return engine.parseQuery(this.query).cost(ctx, scope.child());
  }

  /** Execute the correlated subquery and return whether it produced any rows (negated for `NOT EXISTS`). */
  async evaluateBool(ctx: RuntimeContext, row: SourceRow): Promise<boolean> {
    const q = ctx.engine.parseQuery(this.query);
    // A nested subquery — run non-root (see `SubqueryExpr`).
    const result = await ctx.withCorrelation(row, () => ctx.withNonRoot(() => q.execute(ctx)));
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

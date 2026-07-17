/**
 * InExpr — `value IN (...)`, where the right side is either an explicit value
 * list or a single-field subquery. A `BoolExpr`. Each list element (or the
 * subquery's output field) must be comparable with `value`; params on either
 * side are inferred against the other.
 *
 * The subquery form uses the Phase-2 structural seam (`inferSubqueryOutput`)
 * to learn the subquery's output type without query classes (Phase 3).
 */
import { z } from 'zod';
import type { ExprDef, InExprDef, QueryDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import { asFieldType } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import { categoryOf, childExprSchema, childQuerySchema, emitSubquerySQL, relationValueProblem, RELATION_VS_VALUE } from './_shared';
import { withAid } from '../aids';
import { obj, lit, bool, exprRef, list, queryDefRef, isRecord, type Shape } from '../shape';
import { operandCtx } from './_field-guard';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { ParamExpr } from './param';
import { inferSubqueryOutput, validateSubqueryOutput } from './_subquery';
import { Value } from '../runtime/value';
import { not3 } from '../runtime/tri';
import { firstField } from '../runtime/record';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost, CostContext, IndexProbe } from '../cost';
import { addCost, IN_SELECTIVITY } from '../cost';

/** A `value IN (...)` predicate over an explicit list or a subquery. A `BoolExpr`. */
export class InExpr extends BoolExpr {
  static readonly KIND = 'in' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`value IN (list | subquery)` (negatable via `not`): membership test. `in` is EITHER an explicit array of value exprs OR a subquery projecting exactly ONE field (correlated or not). To project a value across a relation, add a `relation` join in the subquery and field-ref the joined alias — do NOT project/compare a relation field-ref as a scalar id. To correlate the subquery, JOIN the relation and compare the joined key to the outer scalar. Set `not:true` for NOT IN." as const;
  /**
   * Worked examples (see `ExprClass.EXAMPLES`) — the two `in` shapes: an explicit
   * value LIST, and a single-field SUBQUERY that crosses a relation via a
   * `relation` join (projecting the joined alias's field).
   */
  static readonly EXAMPLES: readonly string[] = [
    JSON.stringify({
      kind: 'in',
      value: { kind: 'field-ref', source: 'order', field: 'status' },
      in: [
        { kind: 'literal', value: 'paid' },
        { kind: 'literal', value: 'shipped' },
      ],
    } satisfies InExprDef),
    JSON.stringify({
      kind: 'in',
      value: { kind: 'field-ref', source: 'user', field: 'id' },
      in: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'u', field: 'id' } }],
        from: { kind: 'type', type: 'order' },
        joins: [{ on: { kind: 'relation', source: 'order', field: 'user', as: 'u' } }],
      },
    } satisfies InExprDef),
    // A CORRELATED subquery: `order.id IN (ids of orders whose customer is the
    // SAME as the outer order's)`. The subquery joins BOTH sides' `customer`
    // relation and compares the JOINED keys (`c2.id = c.id`) — never a relation
    // field-ref to a scalar. (`c` is the outer query's join alias.)
    JSON.stringify({
      kind: 'in',
      value: { kind: 'field-ref', source: 'order', field: 'id' },
      in: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'o2', field: 'id' } }],
        from: { kind: 'aliased', type: 'order', as: 'o2' },
        joins: [{ on: { kind: 'relation', source: 'o2', field: 'customer', as: 'c2' } }],
        where: [
          {
            kind: 'comparison',
            op: '=',
            left: { kind: 'field-ref', source: 'c2', field: 'id' },
            right: { kind: 'field-ref', source: 'c', field: 'id' },
          },
        ],
      },
    } satisfies InExprDef),
  ];
  readonly kind = InExpr.KIND;

  /** Wrap `value [NOT] IN (list | subquery)` as a membership predicate. */
  constructor(
    readonly value: Expr,
    /** Explicit value list (mutually exclusive with `subquery`). */
    readonly list: Expr[] | undefined,
    /** Subquery form (mutually exclusive with `list`). */
    readonly subquery: QueryDef | undefined,
    readonly not: boolean,
  ) {
    super();
  }

  /** Reconstruct an InExpr from its JSON def (validates `kind`; recurses into the value and any list elements via `registry.parseExpr`). */
  static from(json: ExprDef, registry: Registry): InExpr {
    if (json.kind !== 'in') {
      throw new Error(`InExpr.from: expected 'in', got '${json.kind}'`);
    }
    const value = registry.parseExpr(json.value);
    if (Array.isArray(json.in)) {
      return new InExpr(value, json.in.map((e) => registry.parseExpr(e)), undefined, json.not ?? false);
    }
    return new InExpr(value, undefined, json.in, json.not ?? false);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Dispatches on
   * the `in` field: an ARRAY builds the value-list form; a (non-array) OBJECT is
   * a `QueryDef`, building the SUBQUERY form via `queryDefRef` (structurally
   * validating the sub-query, accumulating its problems, keeping its def). Equal
   * to `from`'s output on a valid def. Never throws; accumulates. See `shape/`.
   */
  static readonly SHAPE: Shape<InExpr> = {
    check(json, ctx) {
      // Subquery form: `in` is a (non-array) object ⇒ a `QueryDef`.
      if (isRecord(json) && isRecord(json['in'])) {
        return InExpr.SHAPE_SUBQUERY.check(json, ctx);
      }
      return InExpr.SHAPE_LIST.check(json, ctx);
    },
  };

  /** The LIST-form object shape dispatched to by {@link SHAPE}. */
  private static readonly SHAPE_LIST = obj(
    {
      kind: lit('in'),
      value: exprRef(),
      in: list(exprRef()),
      not: bool('Not'),
    },
    (v) => new InExpr(v.value, v.in, undefined, v.not ?? false),
    { optional: ['not'], aid: 'Expr_in' },
  );

  /** The SUBQUERY-form object shape dispatched to by {@link SHAPE}. */
  private static readonly SHAPE_SUBQUERY = obj(
    {
      kind: lit('in'),
      value: exprRef(),
      in: queryDefRef(),
      not: bool('Not'),
    },
    (v) => new InExpr(v.value, undefined, v.in, v.not ?? false),
    { optional: ['not'], aid: 'Expr_in' },
  );

  /** Zod schema for this expr kind's JSON shape (`in` is a child Expr list or a child Query slot). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('in'),
        value: childExprSchema(opts.Expr),
        in: z.union([z.array(childExprSchema(opts.Expr)), childQuerySchema(opts.Query)]),
        not: z.boolean().optional(),
      }),
      'Expr_in',
    ).describe('Membership predicate (value IN list / subquery).');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.value);
    if (this.list) for (const e of this.list) visit(e);
  }

  /** Validate that each list element / subquery output field is comparable with the value, infer params on either side, and resolve to bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    const v = p.at('value', () => this.value.validateWalk(engine, scope, p, operandCtx(this.value, 'in', ctx, true)));
    const vft = asFieldType(v);

    if (this.list) {
      p.at('in', () => {
        this.list!.forEach((el, i) => {
          const rt = p.at(i, () => el.validateWalk(engine, scope, p, operandCtx(el, 'in', ctx, true)));
          const eft = asFieldType(rt);
          const skip = el instanceof ParamExpr || this.value instanceof ParamExpr;
          const relProblem = skip ? undefined : relationValueProblem(v, rt);
          if (relProblem) {
            p.at(i, () => p.error(RELATION_VS_VALUE, relProblem));
          } else if (!skip && vft && eft && !vft.comparableWith(eft)) {
            p.at(i, () =>
              p.error(
                'in.type',
                `IN list element ${i} (${eft.resolve()}) is not comparable with the value (${vft.resolve()}).`,
              ),
            );
          }
          // A param element takes the value's type.
          if (el instanceof ParamExpr && vft) {
            scope.params.observe(el.name, vft, [...here, 'in', i]);
          }
        });
      });
    } else if (this.subquery) {
      // FULLY VALIDATE the (correlated) subquery so a bad ref inside it surfaces,
      // AND learn its output type for the value-comparability check.
      const out = p.at('in', () => validateSubqueryOutput(engine, scope, p, ctx, this.subquery!));
      const oft = asFieldType(out);
      if (!(this.value instanceof ParamExpr)) {
        const relProblem = relationValueProblem(v, out);
        if (relProblem) {
          p.at('in', () => p.error(RELATION_VS_VALUE, relProblem));
        } else if (vft && oft && !vft.comparableWith(oft)) {
          p.at('in', () =>
            p.error(
              'in.type',
              `IN subquery field (${oft.resolve()}) is not comparable with the value (${vft.resolve()}).`,
            ),
          );
        }
      }
    }

    // A param VALUE takes the list/subquery element type when uniform.
    if (this.value instanceof ParamExpr) {
      const elFt = this.list?.length
        ? asFieldType(this.list[0]!.resolve(engine, scope))
        : this.subquery
          ? asFieldType(inferSubqueryOutput(engine, scope, this.subquery))
          : undefined;
      if (elFt) scope.params.observe(this.value.name, elFt, [...here, 'value']);
    }

    return this.resolve(engine, scope);
  }

  /** Estimated cost: children plus the inner query's cost when this is the subquery form. */
  override cost(ctx: CostContext, scope: QueryScope): Cost {
    let c = this.childCost(ctx, scope);
    // The subquery form scans its inner query (per outer row at runtime).
    if (this.subquery) c = addCost(c, ctx.engine.parseQuery(this.subquery).cost(ctx, scope.child()));
    return c;
  }

  /** Membership keeps ~half the rows (matches a non-indexed range's breadth). */
  override selectivity(): number {
    return IN_SELECTIVITY;
  }

  /**
   * A `col IN (a, b, c)` value LIST against a column is an index point-probe of
   * arity = the list length (a `NOT IN` / subquery form is not a point-set).
   */
  override indexProbe(): IndexProbe | undefined {
    if (!this.list || this.not) return undefined;
    const ref = this.value.fieldRef();
    return ref ? { ref, arity: this.list.length } : undefined;
  }

  /** Evaluate under 3VL: TRUE if any element equals the value; else UNKNOWN if the value or any element is NULL; else FALSE (negated for `NOT IN`). */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean | undefined> {
    const v = await this.value.evaluate(ctx, row, group);
    // `x IN (...)` is `x = a OR x = b OR …` under 3VL: TRUE if any element is
    // equal; else UNKNOWN if the value or any element is NULL (a NULL makes that
    // disjunct UNKNOWN); else FALSE. `NOT IN` is its 3VL negation, so a NULL in
    // the list makes a non-match UNKNOWN (NOT UNKNOWN = UNKNOWN), never TRUE.
    let matched = false;
    let anyNull = v.isNull();
    if (this.list) {
      for (const el of this.list) {
        const ev = await el.evaluate(ctx, row, group);
        if (ev.isNull()) anyNull = true;
        else if (v.equals(ev)) {
          matched = true;
          break;
        }
      }
    } else if (this.subquery) {
      const q = ctx.engine.parseQuery(this.subquery);
      // A nested subquery — run non-root (see `SubqueryExpr`).
      const result = await ctx.withCorrelation(row, () => ctx.withNonRoot(() => q.execute(ctx)));
      for (const rec of result.rows) {
        const ev = Value.of(firstField(rec));
        if (ev.isNull()) anyNull = true;
        else if (v.equals(ev)) {
          matched = true;
          break;
        }
      }
    }
    const inResult: boolean | undefined = matched ? true : anyNull ? undefined : false;
    return this.not ? not3(inResult) : inResult;
  }

  /** Emit as a SqlText fragment (`value [NOT] IN (...)` over a list or an emitted subquery). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const rhs = this.list
      ? SqlText.join(this.list.map((e) => e.toSQL(dialect, ctx)), ', ').parens()
      : this.subquery
        ? emitSubquerySQL(dialect, ctx, this.subquery)
        : SqlText.raw('()');
    return SqlText.join(
      [this.value.toSQL(dialect, ctx), SqlText.raw(this.not ? 'NOT IN' : 'IN'), rhs],
      ' ',
    );
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): InExprDef {
    const inJson: ExprDef[] | QueryDef = this.list
      ? this.list.map((e) => e.toJSON())
      : this.subquery!;
    const def: InExprDef = { kind: 'in', value: this.value.toJSON(), in: inJson };
    if (this.not) def.not = true;
    return def;
  }

  /** Deep-copy this expr (and its value, list, and subquery). */
  clone(): InExpr {
    return new InExpr(
      this.value.clone(),
      this.list?.map((e) => e.clone()),
      this.subquery ? structuredClone(this.subquery) : undefined,
      this.not,
    );
  }

  /** Render as readable pseudo-code. */
  override toCode(): string {
    const rhs = this.list ? `(${this.list.map((e) => e.toCode()).join(', ')})` : '(subquery)';
    return `${this.value.toCode()} ${this.not ? 'NOT IN' : 'IN'} ${rhs}`;
  }
}

const _check: ExprClass = InExpr;
void _check;

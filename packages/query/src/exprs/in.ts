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
import { categoryOf, childExprSchema, childQuerySchema, emitSubquerySQL } from './_shared';
import { withAid } from '../aids';
import { obj, lit, bool, exprRef, list, queryDefRef, isRecord, type Shape } from '../shape';
import { operandCtx } from './_field-guard';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { ParamExpr } from './param';
import { inferSubqueryOutput } from './_subquery';
import { Value } from '../runtime/value';
import { not3 } from '../runtime/tri';
import { firstField } from '../runtime/record';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import { addCost } from '../cost';

/** A `value IN (...)` predicate over an explicit list or a subquery. A `BoolExpr`. */
export class InExpr extends BoolExpr {
  static readonly KIND = 'in' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`value IN (list | subquery)` (negatable): membership test against an explicit value list OR a single-field subquery." as const;
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
    const v = p.at('value', () => this.value.validateWalk(engine, scope, p, operandCtx(this.value, 'in', ctx)));
    const vft = asFieldType(v);

    if (this.list) {
      p.at('in', () => {
        this.list!.forEach((el, i) => {
          const rt = p.at(i, () => el.validateWalk(engine, scope, p, operandCtx(el, 'in', ctx)));
          const eft = asFieldType(rt);
          const skip = el instanceof ParamExpr || this.value instanceof ParamExpr;
          if (!skip && vft && eft && !vft.comparableWith(eft)) {
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
      const out = inferSubqueryOutput(engine, scope, this.subquery);
      const oft = asFieldType(out);
      if (vft && oft && !(this.value instanceof ParamExpr) && !vft.comparableWith(oft)) {
        p.at('in', () =>
          p.error(
            'in.type',
            `IN subquery field (${oft.resolve()}) is not comparable with the value (${vft.resolve()}).`,
          ),
        );
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
  override cost(engine: QueryEngine, scope: QueryScope): Cost {
    let c = this.childCost(engine, scope);
    // The subquery form scans its inner query (per outer row at runtime).
    if (this.subquery) c = addCost(c, engine.parseQuery(this.subquery).cost(engine, scope.child()));
    return c;
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

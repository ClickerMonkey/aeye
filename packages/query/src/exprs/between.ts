/**
 * BetweenExpr — `value BETWEEN lower AND upper`. A `BoolExpr`. `lower` and
 * `upper` must each be comparable with `value`; params on a bound observe the
 * value's field type.
 */
import { z } from 'zod';
import type { BetweenExprDef, ExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import { asFieldType } from '../resolved-type';
import type { FieldType } from '../field-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import { childExprSchema, relationValueProblem, RELATION_VS_VALUE } from './_shared';
import { withAid } from '../aids';
import { obj, lit, bool, exprRef } from '../shape';
import { operandCtx } from './_field-guard';
import { ParamExpr } from './param';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { and3, not3, type Tri } from '../runtime/tri';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A `value BETWEEN lower AND upper` predicate. A `BoolExpr`. */
export class BetweenExpr extends BoolExpr {
  static readonly KIND = 'between' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`value BETWEEN lower AND upper` (negatable)." as const;
  readonly kind = BetweenExpr.KIND;

  /** Wrap `value [NOT] BETWEEN lower AND upper` as a range predicate. */
  constructor(
    readonly value: Expr,
    readonly lower: Expr,
    readonly upper: Expr,
    readonly not: boolean,
  ) {
    super();
  }

  /** Reconstruct a BetweenExpr from its JSON def (validates `kind`, recurses into value/lower/upper via `registry.parseExpr`). */
  static from(json: ExprDef, registry: Registry): BetweenExpr {
    if (json.kind !== 'between') {
      throw new Error(`BetweenExpr.from: expected 'between', got '${json.kind}'`);
    }
    return new BetweenExpr(
      registry.parseExpr(json.value),
      registry.parseExpr(json.lower),
      registry.parseExpr(json.upper),
      json.not ?? false,
    );
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `BetweenExpr` equal to `from`'s output on a valid def (`not` defaults to
   * `false` when absent); accumulates problems on a bad def (never throws).
   * See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('between'),
      value: exprRef(),
      lower: exprRef(),
      upper: exprRef(),
      not: bool('Not'),
    },
    (v) => new BetweenExpr(v.value, v.lower, v.upper, v.not ?? false),
    { optional: ['not'], aid: 'Expr_between' },
  );

  /** Zod schema for this expr kind's JSON shape (value/lower/upper are child Expr slots). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    return withAid(
      z.object({
        kind: z.literal('between'),
        value: child,
        lower: child,
        upper: child,
        not: z.boolean().optional(),
      }),
      'Expr_between',
    ).describe('Range predicate (value BETWEEN lower AND upper).');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.value);
    visit(this.lower);
    visit(this.upper);
  }

  /** Validate that both bounds are comparable with the value, infer any bound/value param, and resolve to bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    const v = p.at('value', () => this.value.validateWalk(engine, scope, p, operandCtx(this.value, 'between', ctx)));
    const lo = p.at('lower', () => this.lower.validateWalk(engine, scope, p, operandCtx(this.lower, 'between', ctx)));
    const hi = p.at('upper', () => this.upper.validateWalk(engine, scope, p, operandCtx(this.upper, 'between', ctx)));

    const vft = asFieldType(v);
    const check = (operand: Expr, rt: ResolvedType, key: 'lower' | 'upper'): void => {
      const ft = asFieldType(rt);
      if (operand instanceof ParamExpr) {
        if (vft) scope.params.observe(operand.name, vft, [...here, key]);
        return;
      }
      // A RELATION field-ref is not a scalar value — reject a relation vs the
      // value (or a mismatched relation) before the scalar comparability check.
      const relProblem = relationValueProblem(v, rt);
      if (relProblem) {
        p.at(key, () => p.error(RELATION_VS_VALUE, relProblem));
        return;
      }
      if (vft && ft && !vft.comparableWith(ft)) {
        p.at(key, () =>
          p.error(
            'between.type',
            `BETWEEN bound '${key}' (${ft.resolve()}) is not comparable with the value (${vft.resolve()}).`,
          ),
        );
      }
    };
    check(this.lower, lo, 'lower');
    check(this.upper, hi, 'upper');

    // A param value takes a bound's type.
    if (this.value instanceof ParamExpr) {
      const bft: FieldType | undefined = asFieldType(lo) ?? asFieldType(hi);
      if (bft) scope.params.observe(this.value.name, bft, [...here, 'value']);
    }

    return this.resolve(engine, scope);
  }

  /** Evaluate `v >= lo AND v <= hi` under 3VL (a NULL bound makes that side UNKNOWN, but FALSE still dominates); negated for `NOT BETWEEN`. */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean | undefined> {
    const v = await this.value.evaluate(ctx, row, group);
    const lo = await this.lower.evaluate(ctx, row, group);
    const hi = await this.upper.evaluate(ctx, row, group);
    // `v BETWEEN lo AND hi` is `v >= lo AND v <= hi` under 3VL — a NULL bound
    // makes that side UNKNOWN, but FALSE still dominates the AND (e.g. `v > hi`
    // with a NULL `lo` is FALSE, not UNKNOWN). `NOT BETWEEN` is the negation.
    const ge: Tri = v.isNull() || lo.isNull() ? undefined : v.compareTo(lo) >= 0;
    const le: Tri = v.isNull() || hi.isNull() ? undefined : v.compareTo(hi) <= 0;
    const within = and3(ge, le);
    return this.not ? not3(within) : within;
  }

  /** Emit as a SqlText fragment (`value [NOT] BETWEEN lower AND upper`). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return SqlText.join(
      [
        this.value.toSQL(dialect, ctx),
        SqlText.raw(this.not ? 'NOT BETWEEN' : 'BETWEEN'),
        this.lower.toSQL(dialect, ctx),
        SqlText.raw('AND'),
        this.upper.toSQL(dialect, ctx),
      ],
      ' ',
    );
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): BetweenExprDef {
    const def: BetweenExprDef = {
      kind: 'between',
      value: this.value.toJSON(),
      lower: this.lower.toJSON(),
      upper: this.upper.toJSON(),
    };
    if (this.not) def.not = true;
    return def;
  }

  /** Deep-copy this expr (and its value and bounds). */
  clone(): BetweenExpr {
    return new BetweenExpr(
      this.value.clone(),
      this.lower.clone(),
      this.upper.clone(),
      this.not,
    );
  }

  /** Render as readable pseudo-code. */
  override toCode(): string {
    return `${this.value.toCode()} ${this.not ? 'NOT BETWEEN' : 'BETWEEN'} ${this.lower.toCode()} AND ${this.upper.toCode()}`;
  }
}

const _check: ExprClass = BetweenExpr;
void _check;

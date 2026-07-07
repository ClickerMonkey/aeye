/**
 * UnaryExpr — unary arithmetic (`-x` / `+x`). Resolves to a numeric value
 * mirroring the operand's numeric category. Requires a numeric operand
 * (NULL literal / param exempt).
 */
import { z } from 'zod';
import type { ExprDef, UnaryExprDef, UnaryOp } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { MoneyFieldType, NumberFieldType } from '../field-types/index';
import { computed, gatherSources, categoryOf, childExprSchema } from './_shared';
import { withAid } from '../aids';
import { LiteralExpr } from './literal';
import { ParamExpr } from './param';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A unary arithmetic expression (`-x` / `+x`). */
export class UnaryExpr extends Expr {
  static readonly KIND = 'unary' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`<op> operand` (`-` / `+`)." as const;
  readonly kind = UnaryExpr.KIND;

  /** Wrap a unary operation over its operator and operand expr. */
  constructor(
    readonly op: UnaryOp,
    readonly operand: Expr,
  ) {
    super();
  }

  /** Reconstruct a UnaryExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, registry: Registry): UnaryExpr {
    if (json.kind !== 'unary') {
      throw new Error(`UnaryExpr.from: expected 'unary', got '${json.kind}'`);
    }
    return new UnaryExpr(json.op, registry.parseExpr(json.operand));
  }

  /** Zod schema for this expr kind's JSON shape (operand uses the shared child Expr schema). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('unary'),
        op: withAid(z.enum(['-', '+']), 'UnaryOp'),
        operand: childExprSchema(opts.Expr),
      }),
      'Expr_unary',
    ).describe('Unary arithmetic operation.');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.operand);
  }

  /** Resolve to numeric/money mirroring the operand's category, propagating nullability/aggregate. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const o = this.operand.resolve(engine, scope);
    const sources = gatherSources([o]);
    const nullable = o.kind !== 'type' && o.nullable;
    const aggregate = o.kind === 'computed' && o.aggregate;
    const fieldType = categoryOf(o) === 'money' ? new MoneyFieldType() : new NumberFieldType();
    return computed(fieldType, sources, nullable, aggregate);
  }

  /** Validate the operand is numeric (NULL/param exempt), infer param type, then resolve. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const o = p.at('operand', () => this.operand.validateWalk(engine, scope, p, ctx));
    const exempt =
      (this.operand instanceof LiteralExpr && this.operand.isNullLiteral()) ||
      this.operand instanceof ParamExpr;
    if (!exempt) {
      const cat = categoryOf(o);
      if (cat !== 'number' && cat !== 'money') {
        p.at('operand', () => {
          p.error('unary.type', `Unary '${this.op}' requires a numeric operand; got ${cat ?? 'a type'}.`);
        });
      }
    }
    if (this.operand instanceof ParamExpr) {
      scope.params.observe(this.operand.name, new NumberFieldType(), [...p.here, 'operand']);
    }
    return this.resolve(engine, scope);
  }

  /** Cost is the operand's cost. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return this.childCost(engine, scope);
  }

  /** Evaluate the operand and apply the sign (NULL/non-numeric → NULL). */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    const v = await this.operand.evaluate(ctx, row, group);
    if (v.isNull()) return Value.null();
    const n = v.toNumber();
    if (Number.isNaN(n)) return Value.null();
    return Value.of(this.op === '-' ? -n : n);
  }

  /** Emit as a parenthesized `(op operand)` SqlText fragment. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return SqlText.concat([SqlText.raw(`(${this.op}`), this.operand.toSQL(dialect, ctx), SqlText.raw(')')]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): UnaryExprDef {
    return { kind: 'unary', op: this.op, operand: this.operand.toJSON() };
  }

  /** Deep-copy this expr and its operand. */
  clone(): UnaryExpr {
    return new UnaryExpr(this.op, this.operand.clone());
  }

  /** Render as source-like code (`-operand` / `+operand`). */
  override toCode(): string {
    return `${this.op}${this.operand.toCode()}`;
  }
}

const _check: ExprClass = UnaryExpr;
void _check;

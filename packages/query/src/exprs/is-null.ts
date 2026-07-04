/**
 * IsNullExpr — `value IS [NOT] NULL`. A `BoolExpr` whose result is never
 * itself null (the test always yields true/false), so it overrides the
 * default bool resolve to force non-nullable.
 */
import { z } from 'zod';
import type { ExprDef, IsNullExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ComputedResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { BoolExpr, Expr, type ExprClass, type ValidateContext } from '../expr';
import { boolResult, gatherSources, anyAggregate, childExprSchema } from './_shared';
import { operandCtx } from './_field-guard';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A `value IS [NOT] NULL` predicate. A `BoolExpr`. */
export class IsNullExpr extends BoolExpr {
  static readonly KIND = 'is-null' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "`value IS [NOT] NULL`." as const;
  readonly kind = IsNullExpr.KIND;

  /** Wrap `value IS [NOT] NULL` as a null test. */
  constructor(
    readonly value: Expr,
    readonly not: boolean,
  ) {
    super();
  }

  /** Reconstruct an IsNullExpr from its JSON def (validates `kind`, recurses into the value via `registry.parseExpr`). */
  static from(json: ExprDef, registry: Registry): IsNullExpr {
    if (json.kind !== 'is-null') {
      throw new Error(`IsNullExpr.from: expected 'is-null', got '${json.kind}'`);
    }
    return new IsNullExpr(registry.parseExpr(json.value), json.not ?? false);
  }

  /** Zod schema for this expr kind's JSON shape (value is a child Expr slot). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z
      .object({
        kind: z.literal('is-null'),
        value: childExprSchema(opts.Expr),
        not: z.boolean().optional(),
      })
      .meta({ aid: 'Expr_is-null' })
      .describe('Null test (value IS [NOT] NULL).');
  }

  override forEachChild(visit: (child: Expr) => void): void {
    visit(this.value);
  }

  /** Resolve to a non-nullable bool (the test always yields true/false). */
  override resolve(engine: QueryEngine, scope: QueryScope): ComputedResolved {
    const v = this.value.resolve(engine, scope);
    return boolResult(gatherSources([v]), false, anyAggregate([v]));
  }

  /** Validate the operand and resolve to a non-nullable bool. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ComputedResolved {
    p.at('value', () => this.value.validateWalk(engine, scope, p, operandCtx(this.value, 'is-null', ctx)));
    return this.resolve(engine, scope);
  }

  /** Evaluate the operand and return whether it is (not) null. */
  async evaluateBool(
    ctx: RuntimeContext,
    row: SourceRow,
    group?: readonly SourceRow[],
  ): Promise<boolean> {
    const v = await this.value.evaluate(ctx, row, group);
    return this.not ? !v.isNull() : v.isNull();
  }

  /** Emit as a SqlText fragment (`value IS [NOT] NULL`). */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    return SqlText.concat([
      this.value.toSQL(dialect, ctx),
      SqlText.raw(this.not ? ' IS NOT NULL' : ' IS NULL'),
    ]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): IsNullExprDef {
    const def: IsNullExprDef = { kind: 'is-null', value: this.value.toJSON() };
    if (this.not) def.not = true;
    return def;
  }

  /** Deep-copy this expr (and its value). */
  clone(): IsNullExpr {
    return new IsNullExpr(this.value.clone(), this.not);
  }

  /** Render as readable pseudo-code. */
  override toCode(): string {
    return `${this.value.toCode()} IS ${this.not ? 'NOT NULL' : 'NULL'}`;
  }
}

const _check: ExprClass = IsNullExpr;
void _check;

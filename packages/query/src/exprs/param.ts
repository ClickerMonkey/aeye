/**
 * ParamExpr — a named bind parameter. It carries only a name; its type is
 * inferred from the operators that use it (see `ParamSet`). During a validate
 * walk it `reference`s itself into the shared param set (so an unused/untyped
 * param can be reported), and resolves to the unified type discovered for it
 * (falling back to a nullable text placeholder until inference completes).
 */
import { z } from 'zod';
import type { ExprDef, ParamExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import type { ParamSet } from '../param';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { computed } from './_shared';
import { withAid } from '../aids';
import { TextFieldType } from '../field-types/index';
import type { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { Cost } from '../cost';
import { bytesOfResolved } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A named bind parameter; its type is inferred from usage. */
export class ParamExpr extends Expr {
  static readonly KIND = 'param' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A named bind parameter; type inferred from use, bound at run/emit time." as const;
  readonly kind = ParamExpr.KIND;

  /** Wrap a named bind parameter (its type is inferred from usage). */
  constructor(readonly name: string) {
    super();
  }

  /** Reconstruct a ParamExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, _registry: Registry): ParamExpr {
    if (json.kind !== 'param') {
      throw new Error(`ParamExpr.from: expected 'param', got '${json.kind}'`);
    }
    return new ParamExpr(json.name);
  }

  /** Zod schema for this expr kind's JSON shape. */
  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return withAid(
      z.object({
        kind: z.literal('param'),
        name: z.string().describe('Parameter name; its type is inferred from usage.'),
      }),
      'Expr_param',
    ).describe('A named bind parameter (contextually typed).');
  }

  protected override contributeParams(params: ParamSet): void {
    params.reference(this.name);
  }

  /** Resolve to the param's inferred type (nullable; falls back to text until inferred). */
  resolve(_engine: QueryEngine, scope: QueryScope): ResolvedType {
    const ft = scope.params.resolved(this.name);
    // Params are always potentially-null (bound at runtime); the inferred
    // category (when known) drives comparability checks elsewhere.
    return computed(ft ?? new TextFieldType(), [], true, false);
  }

  /** Record this param reference into the shared `ParamSet`, then resolve its type. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    _ctx: ValidateContext,
  ): ResolvedType {
    // Record the reference at the current path so `ParamSet` can report an
    // untyped param precisely if it is never observed against a type.
    scope.params.reference(this.name, p.here);
    return this.resolve(engine, scope);
  }

  /** Zero rows; cost is just the resolved type's byte size. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return { rows: 0, bytes: bytesOfResolved(this.resolve(engine, scope)) };
  }

  /** Evaluate to the runtime-bound value for this param name. */
  async evaluate(ctx: RuntimeContext): Promise<Value> {
    return ctx.param(this.name);
  }

  /** Emit as a bound SqlText param slot (null until a value is supplied). */
  toSQL(_dialect: Dialect, ctx: SqlContext): SqlText {
    // Bind the value supplied for this name (null until provided), as a real
    // parameter slot — never interpolated.
    const value = Object.prototype.hasOwnProperty.call(ctx.params, this.name) ? ctx.params[this.name]! : null;
    return SqlText.param(value);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): ParamExprDef {
    return { kind: 'param', name: this.name };
  }

  /** Deep-copy this expr. */
  clone(): ParamExpr {
    return new ParamExpr(this.name);
  }

  /** Render as source-like code (`:name`). */
  override toCode(): string {
    return `:${this.name}`;
  }
}

const _check: ExprClass = ParamExpr;
void _check;

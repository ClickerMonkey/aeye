import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { SetExprDef } from '../schema';
import { Value, val } from '../value';
import { Path, PropStep } from '../path';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import { baseExprFields, pathStepSchema } from '../schemas';

/**
 * SetExpr — assign to a Path. Returns Value<bool>:
 *   - true  when the write happened
 *   - false when walking hit null/undefined before the tail (safe-nav)
 */
export class SetExpr extends Expr {
  static readonly KIND = 'set';
  readonly kind = SetExpr.KIND;

  constructor(readonly path: Path, readonly value: Expr) {
    super();
  }

  static from(json: SetExprDef, registry: Registry): SetExpr {
    return new SetExpr(Path.from(json.path, registry), registry.parseExpr(json.value))
      .withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('set'),
      ...baseExprFields,
      path: z
        .array(pathStepSchema(opts))
        .describe(
          'Steps walked left-to-right to a writable target. Single-step `[{prop:"x"}]` re-assigns scope variable `x`. Multi-step targets need the type to support set on the final step (a prop with a `set` ExprDef, an indexed slot, or a method whose call has `set:`).',
        ),
      value: opts.Expr.describe(
        'The expression evaluated and assigned to the path target. Its type must be compatible with the target\'s declared type — checked statically as `set.type-mismatch`.',
      ),
    }).meta({ aid: 'Expr_set' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const value = await this.value.evaluate(engine, scope);
    // Single-step {prop} → variable assignment.
    if (this.path.steps.length === 1 && this.path.steps[0] instanceof PropStep) {
      scope.set((this.path.steps[0] as PropStep).prop, value);
      return val(engine.registry.bool(), true);
    }
    return this.path.walk(scope, engine, { mode: 'set', setValue: value });
  }

  typeOf(engine: Engine, _scope: TypeScope): Type {
    return engine.registry.bool();
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    const valueT = p.at('value', () => this.value.validateWalk(engine, scope, p, ctx));
    const targetT = this.path.validateWalk(engine, scope, p, ctx, 'set');
    // The rvalue type must be assignable to the target position's type.
    if (targetT.name !== 'any' && !targetT.compatible(valueT)) {
      p.at('value', () => p.warn('set.type-mismatch',
        `value type '${valueT.name}' not compatible with target '${targetT.name}'`));
    }
    return engine.registry.bool();
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    return this.commentPrefix(options)
      + `${this.path.toCode(registry!)} = ${this.value.toCode(registry, { expectsValue: true })}`;
  }

  toJSON(): SetExprDef {
    return this.withCommentOn({
      kind: 'set',
      path: this.path.toJSON(),
      value: this.value.toJSON(),
    });
  }

  clone(): SetExpr {
    return new SetExpr(this.path.clone(), this.value.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    this.path.forEachExpr((e) => visit(e, 'inherit'));
    visit(this.value, 'inherit');
  }
}

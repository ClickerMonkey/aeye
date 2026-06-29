import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { SetExprDef } from '../schema';
import { Value, val } from '../value';
import { Path, PropStep, CallStep } from '../path';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { Code, code, span } from '../code';
import { z } from 'zod';
import { baseExprFields, pathStepSchema } from '../schemas';
import type { TypeScope } from '../type-scope';
import { Effects, combine } from '../effects';

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

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: SetExprDef, scope: TypeScope): SetExpr {
    return new SetExpr(Path.from(json.path, scope), scope.registry.parseExpr(json.value, scope))
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

  typeOf(engine: Engine, _scope: Locals): Type {
    return engine.registry.bool();
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    const valueT = p.at('value', () => this.value.validateWalk(engine, scope, p, ctx));
    const targetT = this.path.validateWalk(engine, scope, p, ctx, 'set');
    // The rvalue type must be assignable to the target position's type.
    if (targetT.name !== 'any' && !targetT.compatible(valueT)) {
      p.at('value', () => p.warn('set.type-mismatch',
        `value type '${valueT.name}' not compatible with target '${targetT.name}'`));
    }
    return engine.registry.bool();
  }

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const pathCode = this.path.toGinCode(registry!, options, path);
    const value = this.value.toGinCode(registry, { ...options, expectsValue: true }, [...path, 'value']);
    return span(code`${this.commentPrefix(options)}${pathCode} = ${value}`, { path, expr: this });
  }

  toJSON(): SetExprDef {
    return this.withCommentOn({
      kind: 'set',
      path: this.path.toJSON(),
      value: this.value.toJSON(),
    });
  }

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const pathCode = this.path.toJSONCode([...path, 'path'], indent, level + 1);
    const valueCode = this.value.toJSONCode([...path, 'value'], indent, level + 1);
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('set') },
        { key: 'path', value: pathCode },
        { key: 'value', value: valueCode },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
  }

  clone(): SetExpr {
    return new SetExpr(this.path.clone(), this.value.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    this.path.forEachExpr((e) => visit(e, 'inherit'));
    visit(this.value, 'inherit');
  }

  /** Set always mutates state — a scope variable, an indexed slot, or
   *  a prop's setter hook. Plus any inner expressions in the path or
   *  the assigned value, plus any `resolvedEffects` cached on path
   *  CallSteps by the validator (e.g. a setter that ultimately dispatches
   *  to `fns.*` adds EXTERNAL). */
  effects(): Effects {
    let acc: Effects = Effects.STATE | this.value.effects();
    this.path.forEachExpr((e) => { acc |= e.effects(); });
    for (const step of this.path.steps) {
      if (step instanceof CallStep && step.resolvedEffects !== undefined) {
        acc |= step.resolvedEffects;
      }
    }
    return acc;
  }

  complexity(): number {
    return this.path.complexity() + this.value.complexity();
  }
}

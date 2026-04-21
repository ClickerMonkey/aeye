import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { LambdaExprDef } from '../schema';
import { Value } from '../value';
import { ReturnSignal } from '../flow-control';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

/**
 * LambdaExpr — a callable value that closes over the lexical scope.
 */
export class LambdaExpr extends Expr {
  static readonly KIND = 'lambda';
  readonly kind = LambdaExpr.KIND;

  constructor(readonly fnType: Type, readonly body: Expr) {
    super();
  }

  static from(json: LambdaExprDef, registry: Registry): LambdaExpr {
    return new LambdaExpr(registry.parse(json.type), registry.parseExpr(json.body))
      .withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('lambda'),
      ...baseExprFields,
      type: opts.Type,
      body: opts.Expr,
    });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const fnType = this.fnType;
    const body = this.body;
    const lexical = scope;

    const callable = async (args: Value): Promise<Value> => {
      const recurseValue = new Value(fnType, callable);
      const child = lexical.child({ args, recurse: recurseValue });
      try {
        return await body.evaluate(engine, child);
      } catch (sig) {
        if (sig instanceof ReturnSignal) {
          return sig.value ?? new Value(engine.registry.void(), undefined);
        }
        throw sig;
      }
    };

    return new Value(fnType, callable);
  }

  typeOf(_engine: Engine, _scope: TypeScope): Type {
    return this.fnType;
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    const call = this.fnType.call();
    const child: TypeScope = new Map(scope);
    child.set('args', call?.args ?? engine.registry.any());
    const bodyT = p.at('body', () =>
      walkValidate(engine, this.body, child, p, { ...ctx, inLambda: true }));
    // If the lambda declares a returns type, the body's inferred type must
    // be assignable to it.
    if (call?.returns && !call.returns.compatible(bodyT)) {
      p.at('body', () => p.warn('lambda.returns.type',
        `body type '${bodyT.name}' not compatible with declared returns '${call.returns!.name}'`));
    }
    return this.fnType;
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const call = this.fnType.call();
    const argsType = call?.args?.toCode() ?? 'any';
    return this.commentPrefix(options)
      + `(args: ${argsType}) => ${this.body.toCode(registry, { expectsValue: true })}`;
  }

  toJSON(): LambdaExprDef {
    return this.withCommentOn({ kind: 'lambda', type: this.fnType.toJSON(), body: this.body.toJSON() });
  }

  clone(): LambdaExpr {
    return new LambdaExpr(this.fnType.clone(), this.body.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    visit(this.body, 'lambda');
  }
}

import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { GetExprDef } from '../schema';
import type { Value } from '../value';
import { Path } from '../path';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import { pathStepSchema } from '../schemas';
import type { TypeScope } from '../type-scope';

/**
 * GetExpr — read a value through a Path chain.
 *   { kind: 'get', path: [{prop}|{key}|{args}, ...] }
 */
export class GetExpr extends Expr {
  static readonly KIND = 'get';
  readonly kind = GetExpr.KIND;

  constructor(readonly path: Path) {
    super();
  }

  static from(json: GetExprDef, scope: TypeScope): GetExpr {
    return new GetExpr(Path.from(json.path, scope)).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('get'),
      // No `comment` field — see header comment above.
      path: z
        .array(pathStepSchema(opts))
        .describe(
          'Steps walked left-to-right starting from a scope variable. Step shapes: `{prop:"name"}` for prop/method access, `{args:{…}}` to call the previous step, `{key:Expr}` for index access. The first step MUST be a prop step (the scope-var name). Result is the final step\'s value.',
        ),
    }).meta({ aid: 'Expr_get' });
  }

  async evaluate(_engine: Engine, scope: Scope): Promise<Value> {
    return this.path.walk(scope, _engine, { mode: 'get' });
  }

  typeOf(engine: Engine, scope: Locals): Type {
    return this.path.typeOf(engine, scope);
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    return this.path.validateWalk(engine, scope, p, ctx, 'get');
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    return this.commentPrefix(options) + this.path.toCode(registry!, options);
  }

  toJSON(): GetExprDef {
    return this.withCommentOn({ kind: 'get', path: this.path.toJSON() });
  }

  clone(): GetExpr {
    return new GetExpr(this.path.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    this.path.forEachExpr((e) => visit(e, 'inherit'));
  }
}

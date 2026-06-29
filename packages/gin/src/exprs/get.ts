import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { GetExprDef } from '../schema';
import type { Value } from '../value';
import { Path, CallStep } from '../path';
import { Effects, combine } from '../effects';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { Code, code, span } from '../code';
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

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const pathCode = this.path.toGinCode(registry!, options, path);
    return span(code`${this.commentPrefix(options)}${pathCode}`, { path, expr: this });
  }

  toJSON(): GetExprDef {
    return this.withCommentOn({ kind: 'get', path: this.path.toJSON() });
  }

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const pathCode = this.path.toJSONCode([...path, 'path'], indent, level + 1);
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('get') },
        { key: 'path', value: pathCode },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
  }

  clone(): GetExpr {
    return new GetExpr(this.path.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    this.path.forEachExpr((e) => visit(e, 'inherit'));
  }

  /** Combine effects from (a) every inner Expr in the path —
   *  `CallStep.args`, `IndexStep.key`, `catch_` handlers — with
   *  (b) any `resolvedEffects` cached on `CallStep`s by
   *  `Path.validateWalk`. The cache is populated once `engine.validate`
   *  has walked the tree and resolved each call to its `Call`
   *  declaration (whose `effects()` aggregates the parsed
   *  `get`/`set` bodies — typically a `NativeExpr` for `fns.*`
   *  fns). Before validation has run, `resolvedEffects` is
   *  undefined and we contribute only inner-expr effects — same
   *  as a structural-only walk. */
  effects(): Effects {
    const inner: Effects[] = [];
    this.path.forEachExpr((e) => { inner.push(e.effects()); });
    for (const step of this.path.steps) {
      if (step instanceof CallStep && step.resolvedEffects !== undefined) {
        inner.push(step.resolvedEffects);
      }
    }
    return combine(...inner);
  }

  complexity(): number {
    return this.path.complexity();
  }
}

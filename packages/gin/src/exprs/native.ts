import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { NativeExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';

/**
 * NativeExpr — escape hatch calling a registered native impl by id.
 */
export class NativeExpr extends Expr {
  static readonly KIND = 'native';
  readonly kind = NativeExpr.KIND;

  constructor(readonly id: string, readonly type?: Type) {
    super();
  }

  static from(json: NativeExprDef, scope: TypeScope): NativeExpr {
    return new NativeExpr(json.id, json.type ? scope.registry.parse(json.type, scope) : undefined)
      .withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('native'),
      ...baseExprFields,
      id: z.string().describe(
        'Identifier of a native impl registered via `registry.setNative(id, fn)` (e.g. `list.push`, `num.add`). The model should NOT generate `native` expressions directly — methods on built-in types are reached via `get` paths, which gin resolves to natives internally.',
      ),
      type: opts.Type.optional().describe(
        'Optional type to wrap the native\'s raw return value with when the impl returns a non-Value. Defaults to `any` if omitted.',
      ),
    }).meta({ aid: 'Expr_native' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const impl = engine.registry.getNative(this.id);
    if (!impl) throw new Error(`native: no impl registered for '${this.id}'`);
    const out = await impl(scope, engine.registry);
    if (out instanceof Value) return out;
    const type = this.type ?? engine.registry.any();
    return val(type, out);
  }

  typeOf(engine: Engine, _scope: Locals): Type {
    return this.type ?? engine.registry.any();
  }

  validateWalk(engine: Engine, _scope: Locals, p: Problems, _ctx: ValidateContext): Type {
    if (!engine.registry.getNative(this.id)) {
      p.warn('native.unknown', `native impl '${this.id}' is not registered`);
    }
    return this.type ?? engine.registry.any();
  }

  toCode(_registry?: Registry, options: CodeOptions = {}): string {
    return this.commentPrefix(options) + `/* native: ${this.id} */`;
  }

  toJSON(): NativeExprDef {
    const out: NativeExprDef = { kind: 'native', id: this.id };
    if (this.type) out.type = this.type.toJSON();
    return this.withCommentOn(out);
  }

  clone(): NativeExpr {
    return new NativeExpr(this.id, this.type?.clone()).withComment(this.comment);
  }
}

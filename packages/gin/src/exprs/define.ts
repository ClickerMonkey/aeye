import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { DefineExprDef, TypeDef } from '../schema';
import type { Value } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { checkBindingName, typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode } from './code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

/**
 * DefineExpr — introduce local bindings into a child scope, then evaluate body.
 *
 *   { kind: 'define', vars: [{name, type?, value}], body }
 */
export interface DefineVar {
  name: string;
  type?: Type;
  value: Expr;
}

export class DefineExpr extends Expr {
  static readonly KIND = 'define';
  readonly kind = DefineExpr.KIND;

  constructor(readonly vars: ReadonlyArray<DefineVar>, readonly body: Expr) {
    super();
  }

  static from(json: DefineExprDef, registry: Registry): DefineExpr {
    const vars: DefineVar[] = json.vars.map((v) => ({
      name: v.name,
      type: v.type ? registry.parse(v.type) : undefined,
      value: registry.parseExpr(v.value),
    }));
    return new DefineExpr(vars, registry.parseExpr(json.body)).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('define'),
      ...baseExprFields,
      vars: z
        .array(
          z.object({
            name: z.string().describe(
              'Variable name. Must NOT be a reserved name (args, recurse, this, super, key, value, yield, error) and must NOT shadow anything already in scope.',
            ),
            type: opts.Type.optional().describe(
              'Optional declared type. OMIT this field when the value already determines the type — every value Expr (`new`, `get`, `if`, ...) is typed, and the var inherits that type. Set this only when you need to widen / narrow / annotate beyond what the value alone produces; a mismatch with the value\'s inferred type is reported as `define.var.type-mismatch`.',
            ),
            value: opts.Expr.describe(
              "The expression whose result is bound under `name`. May reference any earlier var in this define — each var is added to scope before the next var's value is evaluated.",
            ),
          }),
        )
        .describe('Bindings introduced before `body`. Evaluated sequentially, so `vars[i].value` may reference any of `vars[0..i-1]`.'),
      body: opts.Expr,
    }).meta({ aid: 'Expr_define' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const child = scope.child();
    for (const decl of this.vars) {
      const v = await decl.value.evaluate(engine, child);
      child.vars.set(decl.name, v);
    }
    return this.body.evaluate(engine, child);
  }

  typeOf(engine: Engine, scope: TypeScope): Type {
    const child: TypeScope = new Map(scope);
    for (const v of this.vars) {
      const t = v.type ?? typeOf(engine, v.value, child);
      child.set(v.name, t);
    }
    return typeOf(engine, this.body, child);
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    const child: TypeScope = new Map(scope);
    for (let i = 0; i < this.vars.length; i++) {
      const v = this.vars[i]!;
      // Each var name must not be a reserved name and must not collide
      // with anything already in scope (including earlier vars in this
      // same define — those have been added to `child` by now).
      p.at(['vars', i, 'name'], () => checkBindingName(v.name, child, p));
      // Walk the value against `child` (not the parent `scope`), so
      // `vars[i].value` can read `vars[0..i-1]` by name. This is the
      // "later vars can reference earlier" semantic — runtime
      // (`evaluate`) and inference (`typeOf`) match.
      const valueT = p.at(['vars', i, 'value'], () =>
        walkValidate(engine, v.value, child, p, ctx));
      // When a declared type is present, the value's inferred type must
      // be assignable to it. This is a real bug, not a style note —
      // report as error so the model fixes the mismatch instead of
      // ignoring a warning. (`type` is optional precisely so callers
      // CAN omit it; the only reason to set it is to constrain the
      // value, so a mismatch is always wrong.)
      if (v.type && !v.type.compatible(valueT)) {
        p.at(['vars', i, 'value'], () => p.error('define.var.type-mismatch',
          `var '${v.name}' value type '${valueT.name}' not compatible with declared '${v.type!.name}'`));
      }
      child.set(v.name, v.type ?? valueT);
    }
    return p.at('body', () => walkValidate(engine, this.body, child, p, ctx));
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const expectsValue = options.expectsValue ?? false;
    const lets = this.vars.map((v) => {
      const typeAnno = v.type ? `: ${v.type.toCode()}` : '';
      return `const ${v.name}${typeAnno} = ${v.value.toCode(registry, { expectsValue: true })};`;
    });

    if (expectsValue) {
      const body = this.body.toCode(registry, { expectsValue: true });
      const indented = [...lets.map((l) => `  ${l}`), `  return ${indentCode(body)};`].join('\n');
      return this.commentPrefix(options) + `(() => {\n${indented}\n})()`;
    }

    // Statement form: const decls followed by body as a statement.
    const bodyKind = (this.body as { kind: string }).kind;
    const bodyCode = this.body.toCode(registry, { expectsValue: false });
    const bodyStmt = bodyKind === 'if' || bodyKind === 'switch' || bodyKind === 'loop' || bodyKind === 'block' || bodyKind === 'flow'
      ? (bodyKind === 'flow' ? `${bodyCode};` : bodyCode)
      : `${bodyCode};`;
    return this.commentPrefix(options) + [...lets, bodyStmt].join('\n');
  }

  toJSON(): DefineExprDef {
    return this.withCommentOn({
      kind: 'define',
      vars: this.vars.map((v) => {
        const out: { name: string; type?: TypeDef; value: ReturnType<Expr['toJSON']> } = {
          name: v.name,
          value: v.value.toJSON(),
        };
        if (v.type) out.type = v.type.toJSON();
        return out;
      }),
      body: this.body.toJSON(),
    });
  }

  clone(): DefineExpr {
    return new DefineExpr(
      this.vars.map((v) => ({ name: v.name, type: v.type?.clone(), value: v.value.clone() })),
      this.body.clone(),
    ).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    for (const v of this.vars) visit(v.value, 'inherit');
    visit(this.body, 'inherit');
  }
}

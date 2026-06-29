import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { DefineExprDef, TypeDef } from '../schema';
import type { Value } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { checkBindingName, typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import { Code, code, span, joinLines } from '../code';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode } from './code';
import { z } from 'zod';
import { Effects } from '../effects';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';

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

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: DefineExprDef, scope: TypeScope): DefineExpr {
    const r = scope.registry;
    const vars: DefineVar[] = json.vars.map((v) => ({
      name: v.name,
      type: v.type ? r.parse(v.type, scope) : undefined,
      value: r.parseExpr(v.value, scope),
    }));
    return new DefineExpr(vars, r.parseExpr(json.body, scope)).withComment(json.comment);
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

  typeOf(engine: Engine, scope: Locals): Type {
    const child: Locals = new Map(scope);
    for (const v of this.vars) {
      const t = v.type ?? typeOf(engine, v.value, child);
      child.set(v.name, t);
    }
    return typeOf(engine, this.body, child);
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    const child: Locals = new Map(scope);
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
      // When a declared type is present, the value's inferred type
      // must be assignable to it — UNLESS the inferred type is a
      // universal placeholder (unbound generic alias, `any`, empty
      // iface, etc.). In that case the static type is `we don't
      // know yet`; the runtime decides via the value's actual
      // shape. Erroring here would force the model into impossible
      // hoops — e.g. `fns.fetch<R: any>(...)` returns R; without a
      // call-site `generic: {R: text}` binding, R stays unbound
      // and any declared type would mismatch. Better to skip the
      // static check and let the runtime parse catch real issues.
      if (v.type && !valueT.isUniversal() && !v.type.compatible(valueT)) {
        // Render the full TypeCode so the LLM sees `or<optional<num>, num>`
        // and `num{min:1,max:1000}` instead of just `'or'` and `'num'` —
        // the bare class names give it nothing to act on.
        const declaredCode = safeTypeCode(v.type);
        const valueCode = safeTypeCode(valueT);
        // When the inferred type is an alias name (e.g. `R`), point
        // the model at the fix: bind the generic explicitly, or
        // omit the declared type. The `name === 'alias'` check
        // catches AliasType specifically — `name` is the runtime
        // class name. See AliasType for details.
        const hint = valueT.name === 'alias'
          ? ` (hint: '${valueCode}' is an unbound generic — either bind it via \`generic: {${valueCode}: ...}\` on the call site, pass \`output: typ<...>\`, or omit the declared type so the alias flows through)`
          : '';
        p.at(['vars', i, 'value'], () => p.error('define.var.type-mismatch',
          `var '${v.name}' value type '${valueCode}' not compatible with declared '${declaredCode}'${hint}`));
      }
      child.set(v.name, v.type ?? valueT);
    }
    return p.at('body', () => walkValidate(engine, this.body, child, p, ctx));
  }

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const expectsValue = options.expectsValue ?? false;
    const valueOpts = { ...options, expectsValue: true };
    const stmtOpts = { ...options, expectsValue: false };

    // Each `const <name>: <type> = <value>;` line — the `value` slot
    // gets a child path that lines up with the validator
    // (`vars[i].value`); same for `type` (`vars[i].type`). The `name`
    // is plain text so the validator's `vars[i].name` errors will
    // resolve to the bare-text segment via longest-prefix match.
    //
    // When the assembled `const … = …;` line exceeds the line-width
    // target (80 chars on its FIRST rendered line), wrap right after
    // the `=`. Multi-line values keep their internal layout — the
    // wrap only adds one break + 2-space indent to the value, so a
    // wrapped lambda body stays correctly aligned beneath.
    const lets = this.vars.map((v, i) => {
      const typeAnno = v.type
        ? code`: ${v.type.toGinCode(undefined, options, [...path, 'vars', i, 'type'])}`
        : '';
      const value = v.value.toGinCode(registry, valueOpts, [...path, 'vars', i, 'value']);
      const compact = code`let ${v.name}${typeAnno} = ${value};`;
      const firstLine = compact.text.split('\n', 1)[0]!;
      if (firstLine.length <= 80) return compact;
      return code`let ${v.name}${typeAnno} =\n  ${value.indent('  ')};`;
    });

    if (expectsValue) {
      const body = this.body.toGinCode(registry, valueOpts, [...path, 'body']);
      const indentedLets = lets.map((l) => code`  ${l}`);
      const indentedBody = code`  return ${body.indent('  ')};`;
      const inner = joinLines([...indentedLets, indentedBody]);
      return span(code`${this.commentPrefix(options)}(() => {\n${inner}\n})()`, { path, expr: this });
    }

    // Statement form.
    const bodyKind = (this.body as { kind: string }).kind;
    const bodyCode = this.body.toGinCode(registry, stmtOpts, [...path, 'body']);
    const bodyStmt = (bodyKind === 'if' || bodyKind === 'switch' || bodyKind === 'loop' || bodyKind === 'block')
      ? bodyCode
      : code`${bodyCode};`;
    return span(
      code`${this.commentPrefix(options)}${joinLines([...lets, bodyStmt])}`,
      { path, expr: this },
    );
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

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const varItems = this.vars.map((v, i) => {
      const varPath = [...path, 'vars', i] as const;
      const valueCode = v.value.toJSONCode([...varPath, 'value'], indent, level + 3);
      const typeCode = v.type ? v.type.toJSONCode([...varPath, 'type'], indent, level + 3) : undefined;
      return Code.jsonObject(
        [
          { key: 'name', value: Code.jsonString(v.name) },
          { key: 'value', value: valueCode },
          { key: 'type', value: typeCode },
        ],
        { path: varPath },
        level + 2,
        indent,
      );
    });
    const bodyCode = this.body.toJSONCode([...path, 'body'], indent, level + 1);
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('define') },
        { key: 'vars', value: Code.jsonArray(varItems, { path: [...path, 'vars'] }, level + 1, indent) },
        { key: 'body', value: bodyCode },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
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

  effects(): Effects {
    let acc: Effects = this.body.effects();
    for (const v of this.vars) acc |= v.value.effects();
    return acc;
  }

  complexity(): number {
    let acc = 1 + this.body.complexity();
    for (const v of this.vars) acc += 1 + v.value.complexity();
    return acc;
  }
}

/** Render a Type's `toCode()` for use in error messages. Falls back to
 *  the bare class name if `toCode()` throws (e.g. on a partially-built
 *  AliasType during validation walks). */
function safeTypeCode(t: Type): string {
  try { return t.toCode(); } catch { return t.name; }
}

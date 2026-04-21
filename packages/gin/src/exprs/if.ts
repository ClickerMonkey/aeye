import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { IfExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode, renderStatementBody, findEscapingFlow } from './code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

export interface IfBranch {
  condition: Expr;
  body: Expr;
}

/**
 * IfExpr — conditional branching.
 */
export class IfExpr extends Expr {
  static readonly KIND = 'if';
  readonly kind = IfExpr.KIND;

  constructor(readonly ifs: ReadonlyArray<IfBranch>, readonly otherwise?: Expr) {
    super();
  }

  static from(json: IfExprDef, registry: Registry): IfExpr {
    const ifs = json.ifs.map((b) => ({
      condition: registry.parseExpr(b.condition),
      body: registry.parseExpr(b.body),
    }));
    return new IfExpr(ifs, json.else ? registry.parseExpr(json.else) : undefined)
      .withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('if'),
      ...baseExprFields,
      ifs: z.array(z.object({ condition: opts.Expr, body: opts.Expr })),
      else: opts.Expr.optional(),
    });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    for (const branch of this.ifs) {
      const c = await branch.condition.evaluate(engine, scope);
      if (c.raw) return branch.body.evaluate(engine, scope);
    }
    if (this.otherwise) return this.otherwise.evaluate(engine, scope);
    return val(engine.registry.void(), undefined);
  }

  typeOf(engine: Engine, scope: TypeScope): Type {
    const ts = this.ifs.map((b) => typeOf(engine, b.body, scope));
    if (this.otherwise) ts.push(typeOf(engine, this.otherwise, scope));
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    const bool = engine.registry.bool();
    const ts: Type[] = [];
    for (let i = 0; i < this.ifs.length; i++) {
      const br = this.ifs[i]!;
      const condT = p.at(['ifs', i, 'condition'], () =>
        walkValidate(engine, br.condition, scope, p, ctx));
      if (!bool.compatible(condT)) {
        p.at(['ifs', i, 'condition'], () =>
          p.warn('if.condition.type', `if condition should be bool, got '${condT.name}'`));
      }
      ts.push(p.at(['ifs', i, 'body'], () => walkValidate(engine, br.body, scope, p, ctx)));
    }
    if (this.otherwise) ts.push(p.at('else', () => walkValidate(engine, this.otherwise!, scope, p, ctx)));
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const expectsValue = options.expectsValue ?? false;
    // Any escaping flow in a branch body forbids ternary/IIFE rendering.
    const hasFlow =
      this.ifs.some((b) => !!findEscapingFlow(b.body)) ||
      (this.otherwise ? !!findEscapingFlow(this.otherwise) : false);

    const prefix = this.commentPrefix(options);

    // Expression context with no non-local flow: ternary or IIFE.
    if (expectsValue && !hasFlow) {
      if (this.ifs.length === 1 && this.otherwise) {
        const b = this.ifs[0]!;
        return prefix + `(${b.condition.toCode(registry, { expectsValue: true })} ? ${b.body.toCode(registry, { expectsValue: true })} : ${this.otherwise.toCode(registry, { expectsValue: true })})`;
      }
      const branches = this.ifs.map((b, i) => {
        const kw = i === 0 ? 'if' : 'else if';
        return `  ${kw} (${b.condition.toCode(registry, { expectsValue: true })}) return ${indentCode(b.body.toCode(registry, { expectsValue: true }))};`;
      }).join('\n');
      const elseClause = this.otherwise
        ? `\n  return ${indentCode(this.otherwise.toCode(registry, { expectsValue: true }))};`
        : '';
      return prefix + `(() => {\n${branches}${elseClause}\n})()`;
    }

    // Statement form.
    let out = '';
    for (let i = 0; i < this.ifs.length; i++) {
      const b = this.ifs[i]!;
      const kw = i === 0 ? 'if' : 'else if';
      const leading = i === 0 ? '' : ' ';
      out += `${leading}${kw} (${b.condition.toCode(registry, { expectsValue: true })}) ${renderStatementBody(b.body, registry)}`;
    }
    if (this.otherwise) {
      out += ` else ${renderStatementBody(this.otherwise, registry)}`;
    }
    return prefix + out;
  }

  toJSON(): IfExprDef {
    return this.withCommentOn({
      kind: 'if',
      ifs: this.ifs.map((b) => ({ condition: b.condition.toJSON(), body: b.body.toJSON() })),
      else: this.otherwise?.toJSON(),
    });
  }

  clone(): IfExpr {
    return new IfExpr(
      this.ifs.map((b) => ({ condition: b.condition.clone(), body: b.body.clone() })),
      this.otherwise?.clone(),
    ).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    for (const b of this.ifs) {
      visit(b.condition, 'inherit');
      visit(b.body, 'inherit');
    }
    if (this.otherwise) visit(this.otherwise, 'inherit');
  }
}

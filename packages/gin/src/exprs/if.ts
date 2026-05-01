import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { IfExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode, renderStatementBody, findEscapingFlow } from './code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';

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

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: IfExprDef, scope: TypeScope): IfExpr {
    const r = scope.registry;
    const ifs = json.ifs.map((b) => ({
      condition: r.parseExpr(b.condition, scope),
      body: r.parseExpr(b.body, scope),
    }));
    return new IfExpr(ifs, json.else ? r.parseExpr(json.else, scope) : undefined)
      .withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('if'),
      ...baseExprFields,
      ifs: z
        .array(z.object({
          condition: opts.Expr.describe('Bool-typed expression. First branch whose condition is `true` wins; the rest are skipped.'),
          body: opts.Expr.describe('Evaluated when this branch\'s condition is true. The if-expression\'s value is this body\'s value.'),
        }))
        .describe(
          'Ordered list of `{condition, body}` branches — first true condition wins. Each `condition` must be bool-typed (warned otherwise). With multiple branches this is the gin equivalent of `if / else if / else if`.',
        ),
      else: opts.Expr.optional().describe(
        'Optional fallback evaluated when every `ifs[i].condition` is false. Without an else, a no-match if-expression evaluates to void.',
      ),
    }).meta({ aid: 'Expr_if' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    for (const branch of this.ifs) {
      const c = await branch.condition.evaluate(engine, scope);
      if (c.raw) return branch.body.evaluate(engine, scope);
    }
    if (this.otherwise) return this.otherwise.evaluate(engine, scope);
    return val(engine.registry.void(), undefined);
  }

  typeOf(engine: Engine, scope: Locals): Type {
    const ts = this.ifs.map((b) => typeOf(engine, b.body, scope));
    if (this.otherwise) ts.push(typeOf(engine, this.otherwise, scope));
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
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

    const valueOpts = { ...options, expectsValue: true };
    // Expression context with no non-local flow: ternary or IIFE.
    if (expectsValue && !hasFlow) {
      if (this.ifs.length === 1 && this.otherwise) {
        const b = this.ifs[0]!;
        return prefix + `(${b.condition.toCode(registry, valueOpts)} ? ${b.body.toCode(registry, valueOpts)} : ${this.otherwise.toCode(registry, valueOpts)})`;
      }
      const branches = this.ifs.map((b, i) => {
        const kw = i === 0 ? 'if' : 'else if';
        return `  ${kw} (${b.condition.toCode(registry, valueOpts)}) return ${indentCode(b.body.toCode(registry, valueOpts))};`;
      }).join('\n');
      const elseClause = this.otherwise
        ? `\n  return ${indentCode(this.otherwise.toCode(registry, valueOpts))};`
        : '';
      return prefix + `(() => {\n${branches}${elseClause}\n})()`;
    }

    // Statement form.
    let out = '';
    for (let i = 0; i < this.ifs.length; i++) {
      const b = this.ifs[i]!;
      const kw = i === 0 ? 'if' : 'else if';
      const leading = i === 0 ? '' : ' ';
      out += `${leading}${kw} (${b.condition.toCode(registry, valueOpts)}) ${renderStatementBody(b.body, registry, options)}`;
    }
    if (this.otherwise) {
      out += ` else ${renderStatementBody(this.otherwise, registry, options)}`;
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

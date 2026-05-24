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
import { indentCode, findEscapingFlow } from './code';
import { Effects } from '../effects';
import { Code, code, span } from '../code';
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
        // Render the full TypeCode (e.g. `fn(x: num): bool` or
        // `optional<num>`) so the LLM sees what it's actually
        // looking at — naked `'fn'` / `'optional'` is a class name
        // with no clue to act on. Common mistake: forgetting `()`
        // on a method, leaving the function-value rather than its
        // bool result.
        let condCode: string;
        try { condCode = condT.toCode(); } catch { condCode = condT.name; }
        p.at(['ifs', i, 'condition'], () =>
          p.warn('if.condition.type', `if condition should be bool, got '${condCode}' (did you forget to call a method?)`));
      }
      ts.push(p.at(['ifs', i, 'body'], () => walkValidate(engine, br.body, scope, p, ctx)));
    }
    // Per-branch no-effect: each `if` body's value flows out only when
    // its condition matches AND the if is in value position. When the
    // branch produces no effect AND no value the caller cares about,
    // the branch is dead — warn so the model either makes it do
    // something or removes it. Same idea for the else clause.
    for (let i = 0; i < this.ifs.length; i++) {
      const br = this.ifs[i]!;
      if (br.body.effects() === Effects.NONE) {
        p.at(['ifs', i, 'body'], () => p.warn(
          'if.branch.no-effect',
          `if branch body has no observable effect — when this branch matches, nothing happens. Either give it a \`set\`/\`flow\`/native call, or drop the branch entirely`,
        ));
      }
    }
    if (this.otherwise) {
      ts.push(p.at('else', () => walkValidate(engine, this.otherwise!, scope, p, ctx)));
      if (this.otherwise.effects() === Effects.NONE) {
        p.at('else', () => p.warn(
          'if.else.no-effect',
          `else arm has no observable effect — \`else\` is optional; OMIT it entirely when its only purpose is producing a placeholder value`,
        ));
      }
    }
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const expectsValue = options.expectsValue ?? false;
    const hasFlow =
      this.ifs.some((b) => !!findEscapingFlow(b.body)) ||
      (this.otherwise ? !!findEscapingFlow(this.otherwise) : false);

    const prefix = this.commentPrefix(options);
    const valueOpts = { ...options, expectsValue: true };

    if (expectsValue && !hasFlow) {
      if (this.ifs.length === 1 && this.otherwise) {
        const b = this.ifs[0]!;
        const cond = b.condition.toGinCode(registry, valueOpts, [...path, 'ifs', 0, 'condition']);
        const body = b.body.toGinCode(registry, valueOpts, [...path, 'ifs', 0, 'body']);
        const els = this.otherwise.toGinCode(registry, valueOpts, [...path, 'else']);
        return span(code`${prefix}(${cond} ? ${body} : ${els})`, { path, expr: this });
      }
      let branches = code``;
      for (let i = 0; i < this.ifs.length; i++) {
        const b = this.ifs[i]!;
        const kw = i === 0 ? 'if' : 'else if';
        const cond = b.condition.toGinCode(registry, valueOpts, [...path, 'ifs', i, 'condition']);
        const body = b.body.toGinCode(registry, valueOpts, [...path, 'ifs', i, 'body']);
        const sep = i === 0 ? '' : '\n';
        branches = code`${branches}${sep}  ${kw} (${cond}) return ${body.indent('  ')};`;
      }
      let elseClause: Code | string = '';
      if (this.otherwise) {
        const els = this.otherwise.toGinCode(registry, valueOpts, [...path, 'else']);
        elseClause = code`\n  return ${els.indent('  ')};`;
      }
      return span(code`${prefix}(() => {\n${branches}${elseClause}\n})()`, { path, expr: this });
    }

    // Statement form.
    let out: Code = code``;
    for (let i = 0; i < this.ifs.length; i++) {
      const b = this.ifs[i]!;
      const kw = i === 0 ? 'if' : 'else if';
      const leading = i === 0 ? '' : ' ';
      const cond = b.condition.toGinCode(registry, valueOpts, [...path, 'ifs', i, 'condition']);
      const body = b.body.renderStatementBodyRich(registry, options, [...path, 'ifs', i, 'body']);
      out = code`${out}${leading}${kw} (${cond}) ${body}`;
    }
    if (this.otherwise) {
      // `chainElseIf: true` keeps `else if (...) ...` chains bare —
      // without it, an else whose body is another `if` would render as
      // `else { if (...) ... }`, which is correct but noisier than the
      // chained idiom most readers expect.
      const els = this.otherwise.renderStatementBodyRich(registry, options, [...path, 'else'], true);
      out = code`${out} else ${els}`;
    }
    return span(code`${prefix}${out}`, { path, expr: this });
  }

  toJSON(): IfExprDef {
    return this.withCommentOn({
      kind: 'if',
      ifs: this.ifs.map((b) => ({ condition: b.condition.toJSON(), body: b.body.toJSON() })),
      else: this.otherwise?.toJSON(),
    });
  }

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const branchItems = this.ifs.map((b, i) => {
      const branchPath = [...path, 'ifs', i] as const;
      return Code.jsonObject(
        [
          { key: 'condition', value: b.condition.toJSONCode([...branchPath, 'condition'], indent, level + 3) },
          { key: 'body', value: b.body.toJSONCode([...branchPath, 'body'], indent, level + 3) },
        ],
        { path: branchPath },
        level + 2,
        indent,
      );
    });
    const elseCode = this.otherwise
      ? this.otherwise.toJSONCode([...path, 'else'], indent, level + 1)
      : undefined;
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('if') },
        { key: 'ifs', value: Code.jsonArray(branchItems, { path: [...path, 'ifs'] }, level + 1, indent) },
        { key: 'else', value: elseCode },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
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

  effects(): Effects {
    let acc: Effects = Effects.NONE;
    for (const b of this.ifs) acc |= b.condition.effects() | b.body.effects();
    if (this.otherwise) acc |= this.otherwise.effects();
    return acc;
  }
}

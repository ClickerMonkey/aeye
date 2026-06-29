import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { BlockExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode } from './code';
import { Code, code, span, joinLines } from '../code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';
import { Effects } from '../effects';

/**
 * BlockExpr — sequence of expressions; last one's value is the result.
 */
export class BlockExpr extends Expr {
  static readonly KIND = 'block';
  readonly kind = BlockExpr.KIND;

  constructor(readonly lines: ReadonlyArray<Expr>) {
    super();
  }

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: BlockExprDef, scope: TypeScope): BlockExpr {
    const r = scope.registry;
    return new BlockExpr(json.lines.map((l) => r.parseExpr(l, scope))).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('block'),
      ...baseExprFields,
      lines: z
        .array(opts.Expr)
        .describe(
          'Sequence of expressions evaluated in order. The block\'s value is the LAST line\'s value (an empty block returns void). Earlier lines run for their side effects (set, fns.fetch, etc.).',
        ),
    }).meta({ aid: 'Expr_block' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    let last: Value = val(engine.registry.void(), undefined);
    for (const line of this.lines) {
      last = await line.evaluate(engine, scope);
    }
    return last;
  }

  typeOf(engine: Engine, scope: Locals): Type {
    if (this.lines.length === 0) return engine.registry.void();
    return typeOf(engine, this.lines[this.lines.length - 1]!, scope);
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    let last: Type = engine.registry.void();
    for (let i = 0; i < this.lines.length; i++) {
      last = p.at(i, () => walkValidate(engine, this.lines[i]!, scope, p, ctx));
    }
    return last;
  }

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const expectsValue = options.expectsValue ?? false;
    if (this.lines.length === 0) {
      return span(expectsValue ? 'undefined' : '', { path, expr: this });
    }
    if (this.lines.length === 1) {
      return span(
        this.lines[0]!.toGinCode(registry, options, [...path, 0]),
        { path, expr: this },
      );
    }

    const prefix = this.commentPrefix(options);

    if (expectsValue) {
      // Value-form: IIFE wrapper. Each line becomes `  return X;` or
      // `  X;` depending on position. Each child renders with its own
      // path-suffixed span so the validator's per-line `i` maps back
      // to the right rendered range.
      const lineBodies = this.lines.map((line, i) => {
        const isLast = i === this.lines.length - 1;
        const c = line.toGinCode(registry, { ...options, expectsValue: isLast }, [...path, i]).indent('  ');
        return isLast ? code`  return ${c};` : code`  ${c};`;
      });
      const body = joinLines(lineBodies);
      return span(code`${prefix}(() => {\n${body}\n})()`, { path, expr: this });
    }

    // Statement-form: lines joined by newlines, no surrounding braces.
    const parts = this.lines.map((line, i) => {
      const kind = (line as { kind: string }).kind;
      const c = line.toGinCode(registry, { ...options, expectsValue: false }, [...path, i]);
      // Trailing `;` only for plain expressions / sets / defines —
      // control-flow statements self-terminate.
      if (kind === 'if' || kind === 'switch' || kind === 'loop' || kind === 'block') return c;
      return code`${c};`;
    });
    return span(code`${prefix}${joinLines(parts)}`, { path, expr: this });
  }

  toJSON(): BlockExprDef {
    return this.withCommentOn({ kind: 'block', lines: this.lines.map((l) => l.toJSON()) });
  }

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const childItems = this.lines.map((line, i) =>
      line.toJSONCode([...path, i], indent, level + 2));
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('block') },
        { key: 'lines', value: Code.jsonArray(childItems, { path: [...path, 'lines'] }, level + 1, indent) },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
  }

  clone(): BlockExpr {
    return new BlockExpr(this.lines.map((l) => l.clone())).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    for (const line of this.lines) visit(line, 'inherit');
  }

  effects(): Effects {
    let acc: Effects = Effects.NONE;
    for (const line of this.lines) acc |= line.effects();
    return acc;
  }

  complexity(): number {
    let acc = 1;
    for (const line of this.lines) acc += line.complexity();
    return acc;
  }
}


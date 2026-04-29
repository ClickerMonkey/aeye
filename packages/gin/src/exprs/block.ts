import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { BlockExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode } from './code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

/**
 * BlockExpr — sequence of expressions; last one's value is the result.
 */
export class BlockExpr extends Expr {
  static readonly KIND = 'block';
  readonly kind = BlockExpr.KIND;

  constructor(readonly lines: ReadonlyArray<Expr>) {
    super();
  }

  static from(json: BlockExprDef, registry: Registry): BlockExpr {
    return new BlockExpr(json.lines.map((l) => registry.parseExpr(l))).withComment(json.comment);
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

  typeOf(engine: Engine, scope: TypeScope): Type {
    if (this.lines.length === 0) return engine.registry.void();
    return typeOf(engine, this.lines[this.lines.length - 1]!, scope);
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    let last: Type = engine.registry.void();
    for (let i = 0; i < this.lines.length; i++) {
      last = p.at(i, () => walkValidate(engine, this.lines[i]!, scope, p, ctx));
    }
    return last;
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const expectsValue = options.expectsValue ?? false;
    if (this.lines.length === 0) return expectsValue ? 'undefined' : '';
    if (this.lines.length === 1) {
      return this.lines[0]!.toCode(registry, options);
    }

    const prefix = this.commentPrefix(options);

    if (expectsValue) {
      const body = this.lines.map((line, i) => {
        const isLast = i === this.lines.length - 1;
        const code = line.toCode(registry, { expectsValue: isLast });
        return isLast ? `  return ${indentCode(code)};` : `  ${indentCode(code)};`;
      }).join('\n');
      return prefix + `(() => {\n${body}\n})()`;
    }

    const body = this.lines.map((line) => {
      const kind = (line as { kind: string }).kind;
      const code = line.toCode(registry, { expectsValue: false });
      if (kind === 'if' || kind === 'switch' || kind === 'loop' || kind === 'block') {
        return `  ${indentCode(code)}`;
      }
      return `  ${indentCode(code)};`;
    }).join('\n');
    return prefix + `{\n${body}\n}`;
  }

  toJSON(): BlockExprDef {
    return this.withCommentOn({ kind: 'block', lines: this.lines.map((l) => l.toJSON()) });
  }

  clone(): BlockExpr {
    return new BlockExpr(this.lines.map((l) => l.clone())).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    for (const line of this.lines) visit(line, 'inherit');
  }
}

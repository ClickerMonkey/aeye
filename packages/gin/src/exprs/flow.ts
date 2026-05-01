import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { FlowExprDef } from '../schema';
import type { Value } from '../value';
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal, ThrowSignal } from '../flow-control';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import type { TypeScope } from '../type-scope';

export type FlowAction = 'break' | 'return' | 'continue' | 'exit' | 'throw';

/**
 * FlowExpr — non-local control flow: break, continue, return, exit, throw.
 */
export class FlowExpr extends Expr {
  static readonly KIND = 'flow';
  readonly kind = FlowExpr.KIND;

  constructor(
    readonly action: FlowAction,
    readonly value?: Expr,
    readonly error?: Expr,
  ) {
    super();
  }

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: FlowExprDef, scope: TypeScope): FlowExpr {
    const r = scope.registry;
    return new FlowExpr(
      json.action,
      json.value ? r.parseExpr(json.value, scope) : undefined,
      json.error ? r.parseExpr(json.error, scope) : undefined,
    ).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('flow'),
      // No `comment` field — keywords (return/break/continue/throw/exit)
      // already say what they do; comments are pure noise. Strict-mode
      // schema rejects them. Comments belong on statement-shaped Exprs
      // (if/switch/define/block/lambda) only.
      action: z.enum(['break', 'continue', 'return', 'exit', 'throw']).describe(
        'Which control-flow signal to raise. ' +
        '`break`/`continue` only valid inside a loop. ' +
        '`return` only valid inside a fn body / lambda; unwinds to the enclosing call with `value`. ' +
        '`exit` unwinds all the way to `engine.run`, returning `value` as the program result. ' +
        '`throw` raises `error` (caught by a path step\'s `catch:` handler).',
      ),
      value: opts.Expr.optional().describe(
        'Required for `return` and `exit` (the value being returned). Ignored by `break` / `continue` / `throw`.',
      ),
      error: opts.Expr.optional().describe(
        'Required for `throw` — the value to raise. Ignored otherwise.',
      ),
    }).meta({ aid: 'Expr_flow' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    switch (this.action) {
      case 'break':    throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
      case 'return': {
        const v = this.value ? await this.value.evaluate(engine, scope) : undefined;
        throw new ReturnSignal(v);
      }
      case 'exit': {
        const v = this.value ? await this.value.evaluate(engine, scope) : undefined;
        throw new ExitSignal(v);
      }
      case 'throw': {
        if (!this.error) throw new Error('flow.throw requires `error`');
        const e = await this.error.evaluate(engine, scope);
        throw new ThrowSignal(e);
      }
    }
  }

  typeOf(engine: Engine, _scope: Locals): Type {
    return engine.registry.void();
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    if ((this.action === 'break' || this.action === 'continue') && !ctx.inLoop) {
      p.error('flow.outside-loop', `${this.action} used outside a loop`);
    }
    if (this.action === 'return' && !ctx.inLambda) {
      p.warn('flow.outside-lambda', 'return used outside a lambda');
    }
    if (this.action === 'throw' && !this.error) {
      p.error('flow.throw.no-error', 'throw requires an `error` expression');
    }
    if (this.value) p.at('value', () => walkValidate(engine, this.value!, scope, p, ctx));
    if (this.error) p.at('error', () => walkValidate(engine, this.error!, scope, p, ctx));
    return engine.registry.void();
  }

  /**
   * Flow always renders as a statement — return/break/continue/throw/exit
   * have non-local control flow that can't be faithfully represented in a
   * ternary or IIFE. Callers that asked for a value-producing form should
   * treat this as "never returns" semantically.
   */
  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const prefix = this.commentPrefix(options);
    const valueOpts = { ...options, expectsValue: true };
    let code: string;
    switch (this.action) {
      case 'break':    code = 'break'; break;
      case 'continue': code = 'continue'; break;
      case 'return':   code = this.value ? `return ${this.value.toCode(registry, valueOpts)}` : 'return'; break;
      case 'throw':    code = this.error ? `throw ${this.error.toCode(registry, valueOpts)}` : 'throw'; break;
      case 'exit':     code = this.value
        ? `/* exit */ return ${this.value.toCode(registry, valueOpts)}`
        : '/* exit */ return'; break;
      default: code = '';
    }
    return prefix + code;
  }

  toJSON(): FlowExprDef {
    const out: FlowExprDef = { kind: 'flow', action: this.action };
    if (this.value) out.value = this.value.toJSON();
    if (this.error) out.error = this.error.toJSON();
    return this.withCommentOn(out);
  }

  clone(): FlowExpr {
    return new FlowExpr(this.action, this.value?.clone(), this.error?.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    if (this.value) visit(this.value, 'inherit');
    if (this.error) visit(this.error, 'inherit');
  }
}

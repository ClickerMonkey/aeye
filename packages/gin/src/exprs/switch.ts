import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { SwitchExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode, renderStatementBody, findEscapingFlow } from './code';
import { FlowExpr } from './flow';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';

export interface SwitchCase {
  equals: ReadonlyArray<Expr>;
  body: Expr;
}

/**
 * SwitchExpr — value-based branching.
 */
export class SwitchExpr extends Expr {
  static readonly KIND = 'switch';
  readonly kind = SwitchExpr.KIND;

  constructor(
    readonly value: Expr,
    readonly cases: ReadonlyArray<SwitchCase>,
    readonly otherwise?: Expr,
  ) {
    super();
  }

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: SwitchExprDef, scope: TypeScope): SwitchExpr {
    const r = scope.registry;
    return new SwitchExpr(
      r.parseExpr(json.value, scope),
      json.cases.map((c) => ({
        equals: c.equals.map((e) => r.parseExpr(e, scope)),
        body: r.parseExpr(c.body, scope),
      })),
      json.else ? r.parseExpr(json.else, scope) : undefined,
    ).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('switch'),
      ...baseExprFields,
      value: opts.Expr.describe(
        'Expression whose result is compared against each case\'s `equals` candidates. Evaluated once.',
      ),
      cases: z
        .array(z.object({
          equals: z.array(opts.Expr).describe(
            'Candidate values for this case. The case wins if `value` equals ANY one of them (logical OR). Each candidate\'s type must be compatible with `value`\'s type — checked as `switch.case.type`.',
          ),
          body: opts.Expr.describe('Evaluated when this case wins. The switch expression\'s value is this body\'s value.'),
        }))
        .describe('Ordered list of cases — first match wins. Cases are NOT fall-through; only the matching case\'s body runs.'),
      else: opts.Expr.optional().describe(
        'Optional fallback evaluated when no case matches. Without an else, a no-match switch evaluates to void.',
      ),
    }).meta({ aid: 'Expr_switch' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const target = await this.value.evaluate(engine, scope);
    for (const c of this.cases) {
      for (const match of c.equals) {
        const m = await match.evaluate(engine, scope);
        if (m.raw === target.raw) return c.body.evaluate(engine, scope);
      }
    }
    if (this.otherwise) return this.otherwise.evaluate(engine, scope);
    return val(engine.registry.void(), undefined);
  }

  typeOf(engine: Engine, scope: Locals): Type {
    const ts = this.cases.map((c) => typeOf(engine, c.body, scope));
    if (this.otherwise) ts.push(typeOf(engine, this.otherwise, scope));
    if (ts.length === 0) return engine.registry.void();
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    const valueT = p.at('value', () => walkValidate(engine, this.value, scope, p, ctx));
    const ts: Type[] = [];
    for (let i = 0; i < this.cases.length; i++) {
      const c = this.cases[i]!;
      for (let j = 0; j < c.equals.length; j++) {
        const eqT = p.at(['cases', i, 'equals', j], () =>
          walkValidate(engine, c.equals[j]!, scope, p, ctx));
        // Each case value must be comparable against the switch value —
        // its type should be assignable to the switch's.
        if (!valueT.compatible(eqT)) {
          p.at(['cases', i, 'equals', j], () =>
            p.warn('switch.case.type',
              `case value type '${eqT.name}' not compatible with switch value '${valueT.name}'`));
        }
      }
      ts.push(p.at(['cases', i, 'body'], () => walkValidate(engine, c.body, scope, p, ctx)));
    }
    if (this.otherwise) ts.push(p.at('else', () => walkValidate(engine, this.otherwise!, scope, p, ctx)));
    if (ts.length === 0) return engine.registry.void();
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const expectsValue = options.expectsValue ?? false;
    const hasFlow =
      this.cases.some((c) => !!findEscapingFlow(c.body)) ||
      (this.otherwise ? !!findEscapingFlow(this.otherwise) : false);

    const valueOpts = { ...options, expectsValue: true };
    const head = this.value.toCode(registry, valueOpts);
    const prefix = this.commentPrefix(options);

    if (expectsValue && !hasFlow) {
      const cases = this.cases.map((c) => {
        const labels = c.equals.map((e) => `    case ${e.toCode(registry, valueOpts)}:`).join('\n');
        return `${labels}\n      return ${indentCode(c.body.toCode(registry, valueOpts))};`;
      }).join('\n');
      const def = this.otherwise
        ? `\n    default:\n      return ${indentCode(this.otherwise.toCode(registry, valueOpts))};`
        : '';
      return prefix + `(() => {\n  switch (${head}) {\n${cases}${def}\n  }\n})()`;
    }

    const cases = this.cases.map((c) => {
      const labels = c.equals.map((e) => `  case ${e.toCode(registry, valueOpts)}:`).join('\n');
      const bodyCode = renderStatementBody(c.body, registry, options);
      const tail = c.body instanceof FlowExpr ? '' : '\n    break;';
      return `${labels}\n    ${indentCode(bodyCode)}${tail}`;
    }).join('\n');
    const def = this.otherwise
      ? `\n  default:\n    ${indentCode(renderStatementBody(this.otherwise, registry, options))}`
      : '';
    return prefix + `switch (${head}) {\n${cases}${def}\n}`;
  }

  toJSON(): SwitchExprDef {
    return this.withCommentOn({
      kind: 'switch',
      value: this.value.toJSON(),
      cases: this.cases.map((c) => ({
        equals: c.equals.map((e) => e.toJSON()),
        body: c.body.toJSON(),
      })),
      else: this.otherwise?.toJSON(),
    });
  }

  clone(): SwitchExpr {
    return new SwitchExpr(
      this.value.clone(),
      this.cases.map((c) => ({ equals: c.equals.map((e) => e.clone()), body: c.body.clone() })),
      this.otherwise?.clone(),
    ).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    visit(this.value, 'inherit');
    for (const c of this.cases) {
      for (const e of c.equals) visit(e, 'inherit');
      visit(c.body, 'inherit');
    }
    if (this.otherwise) visit(this.otherwise, 'inherit');
  }
}

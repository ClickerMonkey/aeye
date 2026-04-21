import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { SwitchExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { typeOf, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode, renderStatementBody, findEscapingFlow } from './code';
import { FlowExpr } from './flow';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

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

  static from(json: SwitchExprDef, registry: Registry): SwitchExpr {
    return new SwitchExpr(
      registry.parseExpr(json.value),
      json.cases.map((c) => ({
        equals: c.equals.map((e) => registry.parseExpr(e)),
        body: registry.parseExpr(c.body),
      })),
      json.else ? registry.parseExpr(json.else) : undefined,
    ).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('switch'),
      ...baseExprFields,
      value: opts.Expr,
      cases: z.array(z.object({
        equals: z.array(opts.Expr),
        body: opts.Expr,
      })),
      else: opts.Expr.optional(),
    });
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

  typeOf(engine: Engine, scope: TypeScope): Type {
    const ts = this.cases.map((c) => typeOf(engine, c.body, scope));
    if (this.otherwise) ts.push(typeOf(engine, this.otherwise, scope));
    if (ts.length === 0) return engine.registry.void();
    return ts.length === 1 ? ts[0]! : engine.registry.or(ts);
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
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

    const head = this.value.toCode(registry, { expectsValue: true });
    const prefix = this.commentPrefix(options);

    if (expectsValue && !hasFlow) {
      const cases = this.cases.map((c) => {
        const labels = c.equals.map((e) => `    case ${e.toCode(registry, { expectsValue: true })}:`).join('\n');
        return `${labels}\n      return ${indentCode(c.body.toCode(registry, { expectsValue: true }))};`;
      }).join('\n');
      const def = this.otherwise
        ? `\n    default:\n      return ${indentCode(this.otherwise.toCode(registry, { expectsValue: true }))};`
        : '';
      return prefix + `(() => {\n  switch (${head}) {\n${cases}${def}\n  }\n})()`;
    }

    const cases = this.cases.map((c) => {
      const labels = c.equals.map((e) => `  case ${e.toCode(registry, { expectsValue: true })}:`).join('\n');
      const bodyCode = renderStatementBody(c.body, registry);
      const tail = c.body instanceof FlowExpr ? '' : '\n    break;';
      return `${labels}\n    ${indentCode(bodyCode)}${tail}`;
    }).join('\n');
    const def = this.otherwise
      ? `\n  default:\n    ${indentCode(renderStatementBody(this.otherwise, registry))}`
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

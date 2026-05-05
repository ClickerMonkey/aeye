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
import { indentCode, findEscapingFlow } from './code';
import { FlowExpr } from './flow';
import { Code, code, span, joinLines, jsonObject, jsonArray, jsonString } from '../code';
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

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const expectsValue = options.expectsValue ?? false;
    const hasFlow =
      this.cases.some((c) => !!findEscapingFlow(c.body)) ||
      (this.otherwise ? !!findEscapingFlow(this.otherwise) : false);

    const valueOpts = { ...options, expectsValue: true };
    const head = this.value.toGinCode(registry, valueOpts, [...path, 'value']);
    const prefix = this.commentPrefix(options);

    if (expectsValue && !hasFlow) {
      const caseBlocks = this.cases.map((c, i) => {
        const labels = joinLines(c.equals.map((e, j) =>
          code`    case ${e.toGinCode(registry, valueOpts, [...path, 'cases', i, 'equals', j])}:`,
        ));
        const body = c.body.toGinCode(registry, valueOpts, [...path, 'cases', i, 'body']);
        return code`${labels}\n      return ${body.indent('      ')};`;
      });
      const cases = joinLines(caseBlocks);
      let def: Code | string = '';
      if (this.otherwise) {
        const els = this.otherwise.toGinCode(registry, valueOpts, [...path, 'else']);
        def = code`\n    default:\n      return ${els.indent('      ')};`;
      }
      return span(
        code`${prefix}(() => {\n  switch (${head}) {\n${cases}${def}\n  }\n})()`,
        { path, expr: this },
      );
    }

    // Statement form — bare indented bodies, no brace wrapping. See
    // the long comment in the prior impl for the rationale.
    const renderBody = (expr: Expr, bodyPath: ReadonlyArray<string | number>): Code => {
      const kind = (expr as { kind: string }).kind;
      if (expr instanceof FlowExpr) {
        return code`${expr.toGinCode(registry, { ...options, expectsValue: false }, bodyPath)};`;
      }
      if (kind === 'block' || kind === 'if' || kind === 'switch' || kind === 'loop') {
        return expr.toGinCode(registry, { ...options, expectsValue: false }, bodyPath);
      }
      return code`${expr.toGinCode(registry, { ...options, expectsValue: true }, bodyPath)};`;
    };

    const caseBlocks = this.cases.map((c, i) => {
      const labels = joinLines(c.equals.map((e, j) =>
        code`  case ${e.toGinCode(registry, valueOpts, [...path, 'cases', i, 'equals', j])}:`,
      ));
      const bodyPath = [...path, 'cases', i, 'body'] as const;
      const body = renderBody(c.body, bodyPath).indent('    ');
      const tail = c.body instanceof FlowExpr ? '' : '\n    break;';
      return code`${labels}\n    ${body}${tail}`;
    });
    const cases = joinLines(caseBlocks);
    let def: Code | string = '';
    if (this.otherwise) {
      const elsBody = renderBody(this.otherwise, [...path, 'else']).indent('    ');
      def = code`\n  default:\n    ${elsBody}`;
    }
    return span(
      code`${prefix}switch (${head}) {\n${cases}${def}\n}`,
      { path, expr: this },
    );
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

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const valueCode = this.value.toJSONCode([...path, 'value'], indent, level + 1);
    const caseItems = this.cases.map((c, i) => {
      const casePath = [...path, 'cases', i] as const;
      const equalsItems = c.equals.map((e, j) =>
        e.toJSONCode([...casePath, 'equals', j], indent, level + 4));
      return jsonObject(
        [
          { key: 'equals', value: jsonArray(equalsItems, { path: [...casePath, 'equals'] }, level + 3, indent) },
          { key: 'body', value: c.body.toJSONCode([...casePath, 'body'], indent, level + 3) },
        ],
        { path: casePath },
        level + 2,
        indent,
      );
    });
    const elseCode = this.otherwise
      ? this.otherwise.toJSONCode([...path, 'else'], indent, level + 1)
      : undefined;
    return jsonObject(
      [
        { key: 'kind', value: jsonString('switch') },
        { key: 'value', value: valueCode },
        { key: 'cases', value: jsonArray(caseItems, { path: [...path, 'cases'] }, level + 1, indent) },
        { key: 'else', value: elseCode },
        ...(this.comment ? [{ key: 'comment', value: jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
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

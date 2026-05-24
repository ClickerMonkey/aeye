import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { LambdaExprDef } from '../schema';
import { Value } from '../value';
import { ReturnSignal } from '../flow-control';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { Code, code, span } from '../code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import { LocalScope, type TypeScope } from '../type-scope';
import { Effects } from '../effects';

/**
 * LambdaExpr — a callable value that closes over the lexical scope.
 *
 * Optional `constraint` is evaluated BEFORE the body on every call, with
 * `args` in scope; must return bool. Violations throw a typed Error so
 * the calling path unwinds cleanly.
 */
export class LambdaExpr extends Expr {
  static readonly KIND = 'lambda';
  readonly kind = LambdaExpr.KIND;

  constructor(
    readonly fnType: Type,
    readonly body: Expr,
    readonly constraint?: Expr,
  ) {
    super();
  }

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: LambdaExprDef, scope: TypeScope): LambdaExpr {
    const registry = scope.registry;
    // Parse the fn type first (FnType.from layers its own LocalScope
    // for declared generics). Then build a body scope on top so bare
    // alias / generic references inside the body / constraint resolve
    // through AliasType.
    const fnType = registry.parse(json.type, scope);
    const bodyScope = buildBodyScope(scope, fnType);
    const body = registry.parseExpr(json.body, bodyScope);
    const constraint = json.constraint
      ? registry.parseExpr(json.constraint, bodyScope)
      : undefined;
    return new LambdaExpr(fnType, body, constraint).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('lambda'),
      ...baseExprFields,
      type: opts.Type.describe(
        'The lambda\'s function type — `{ name: "fn", call: { args, returns } }` (or a registered named fn type). The `args` obj defines what the body sees under the `args` scope variable; `returns` is what the body must produce.',
      ),
      body: opts.Expr.describe(
        'The lambda body. At runtime, scope contains the lexical scope at definition site PLUS `args` (the call arguments) and `recurse` (this same lambda, for self-calls). Read params via `[{prop:"args"},{prop:"<name>"}]`.',
      ),
      constraint: opts.Expr.optional().describe(
        'Optional bool-typed precondition evaluated before the body on every call (with `args` in scope). If it returns false, the call throws. Use for input invariants you want enforced regardless of caller.',
      ),
    }).meta({ aid: 'Expr_lambda' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const fnType = this.fnType;
    const body = this.body;
    const lexical = scope;
    const constraint = this.constraint;

    const callable = async (args: Value): Promise<Value> => {
      const recurseValue = new Value(fnType, callable);
      const child = lexical.child({ args, recurse: recurseValue });
      if (constraint) {
        const ok = await constraint.evaluate(engine, child);
        if (ok.raw !== true) {
          throw new Error(
            `lambda constraint failed: ${constraint.toCode(engine.registry, { expectsValue: true })}`,
          );
        }
      }
      try {
        return await body.evaluate(engine, child);
      } catch (sig) {
        if (sig instanceof ReturnSignal) {
          return sig.value ?? new Value(engine.registry.void(), undefined);
        }
        throw sig;
      }
    };

    return new Value(fnType, callable);
  }

  typeOf(_engine: Engine, _scope: Locals): Type {
    return this.fnType;
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    const call = this.fnType.call();
    const child: Locals = new Map(scope);
    child.set('args', call?.args ?? engine.registry.any());
    const bodyT = p.at('body', () =>
      walkValidate(engine, this.body, child, p, { ...ctx, inLambda: true }));
    // If the lambda declares a returns type, the body's inferred type must
    // be assignable to it.
    if (call?.returns && !call.returns.compatible(bodyT)) {
      p.at('body', () => p.warn('lambda.returns.type',
        `body type '${bodyT.name}' not compatible with declared returns '${call.returns!.name}'`));
    }
    // The constraint must also type-check against the same args-bound scope.
    if (this.constraint) {
      const boolT = engine.registry.bool();
      const cT = p.at('constraint', () =>
        walkValidate(engine, this.constraint!, child, p, { ...ctx, inLambda: true }));
      if (!boolT.compatible(cT)) {
        p.at('constraint', () => p.warn('lambda.constraint.type',
          `constraint must return bool, got '${cT.name}'`));
      }
    }
    return this.fnType;
  }

  toGinCode(
    registry?: Registry,
    options: CodeOptions = {},
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const call = this.fnType.call();
    const valueOpts = { ...options, expectsValue: true };
    const prefix = this.commentPrefix(options);

    // Param list — flatten the obj-typed `args` into individual params so
    // the signature reads as plain TS (`(x: num, y: text)` instead of
    // `(args: obj{x: num, y: text})`). Non-obj arg types fall back to
    // `args: T` so unusual shapes still render.
    const params = renderLambdaParams(call?.args, options);
    const ret = call?.returns
      ? `: ${call.returns.toCode(undefined, options)}`
      : '';
    const sig = `(${params})${ret}`;

    const bodyCode = this.body.toGinCode(registry, valueOpts, [...path, 'body']);
    const bodyText = bodyCode.text;

    let inner: Code;
    if (this.constraint) {
      // With a constraint: always block-form so the precondition + body
      // are on separate lines.
      const consCode = this.constraint.toGinCode(registry, valueOpts, [...path, 'constraint']);
      const consInline = inlineSingleLine(consCode);
      const indentedBody = bodyCode.indent('  ');
      inner = code`${sig} => {\n  if (!(${consInline})) throw new Error('constraint');\n  return ${indentedBody};\n}`;
    } else if (bodyText.includes('\n')) {
      // Multi-line body — wrap in a block.
      const indentedBody = bodyCode.indent('  ');
      inner = code`${sig} => {\n  ${indentedBody}\n}`;
    } else {
      // Compact one-liner.
      inner = code`${sig} => ${bodyCode}`;
    }
    return span(prefix ? code`${prefix}${inner}` : inner, { path, expr: this });
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    return this.toGinCode(registry, options).toString();
  }

  toJSON(): LambdaExprDef {
    return this.withCommentOn({
      kind: 'lambda',
      type: this.fnType.toJSON(),
      body: this.body.toJSON(),
      constraint: this.constraint?.toJSON(),
    });
  }

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const typeCode = this.fnType.toJSONCode([...path, 'type'], indent, level + 1);
    const bodyCode = this.body.toJSONCode([...path, 'body'], indent, level + 1);
    const constraintCode = this.constraint
      ? this.constraint.toJSONCode([...path, 'constraint'], indent, level + 1)
      : undefined;
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('lambda') },
        { key: 'type', value: typeCode },
        { key: 'body', value: bodyCode },
        { key: 'constraint', value: constraintCode },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
  }

  clone(): LambdaExpr {
    return new LambdaExpr(
      this.fnType.clone(),
      this.body.clone(),
      this.constraint?.clone(),
    ).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    visit(this.body, 'lambda');
    if (this.constraint) visit(this.constraint, 'lambda');
  }

  /** Constructing a lambda VALUE is pure — the body's effects fire
   *  only when the lambda is invoked, not at the construction site. */
  effects(): Effects { return Effects.NONE; }
}

/** Render a lambda's param list. When `args` is an obj-typed param bag
 *  (the common case), each field becomes its own `name: type` entry —
 *  the rendered signature drops the `args: obj{...}` wrapper for a
 *  TS-pseudocode-style flat list. Non-obj arg types keep the `args: T`
 *  fallback so e.g. opaque generic arg types still render. void/any
 *  arg types render as an empty list. */
function renderLambdaParams(args: Type | undefined, options: CodeOptions): string {
  if (!args) return '';
  if (args.name === 'void' || args.name === 'any') return '';
  const fields = (args as unknown as { fields?: Record<string, { type: Type; docs?: string }> }).fields;
  if (!fields) return `args: ${args.toCode(undefined, options)}`;
  const entries = Object.entries(fields);
  if (entries.length === 0) return '';
  const parts = entries.map(([name, prop]) => {
    const optional = prop.type.isOptional?.() ?? false;
    const t = optional && typeof prop.type.required === 'function' ? prop.type.required() : prop.type;
    const docs = prop.docs && options.includeComments !== false ? `/* ${prop.docs} */ ` : '';
    return `${docs}${name}${optional ? '?' : ''}: ${t.toCode(undefined, options)}`;
  });
  return parts.join(', ');
}

/** Squash a Code value to a single line for inline-guard rendering. The
 *  constraint is always one expression but its rendered form may span
 *  lines (e.g. a chained get with wrap-form args). For the inline
 *  `if (!(...))` guard we collapse those line breaks; spans still
 *  resolve to the parent path. */
function inlineSingleLine(c: Code): Code {
  if (!c.text.includes('\n')) return c;
  return new Code(c.text.replace(/\n\s*/g, ' '), c.spans);
}

/** Build a body scope that exposes the fnType's `call.types` aliases
 *  by name, so bare `{name: 'X'}` references inside the body /
 *  constraint resolve via AliasType.
 *
 *  Generics are NOT bound here — their declared types are constraints,
 *  not active resolutions. Bare `{name: 'R'}` inside the body remains
 *  an unresolved AliasType placeholder; concrete resolution comes
 *  from call-site bindings layered into the scope at invocation
 *  time. (Aliases ARE bound, since `call.types` declarations are
 *  type-aliases — substitution targets, not parameters.) */
function buildBodyScope(parent: TypeScope, fnType: Type): TypeScope {
  const local = new LocalScope(parent);
  const call = fnType.call();
  if (call?.types) {
    for (const [name, t] of Object.entries(call.types)) local.bind(name, t);
  }
  return local;
}

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
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import { LocalScope, type TypeScope } from '../type-scope';

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
        'The lambda\'s function type — `{ name: "function", call: { args, returns } }` (or a registered named fn type). The `args` obj defines what the body sees under the `args` scope variable; `returns` is what the body must produce.',
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

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const call = this.fnType.call();
    const argsType = call?.args?.toCode(undefined, options) ?? 'any';
    const valueOpts = { ...options, expectsValue: true };
    const prefix = this.commentPrefix(options);
    if (!this.constraint) {
      return prefix + `(args: ${argsType}) => ${this.body.toCode(registry, valueOpts)}`;
    }
    const c = this.constraint.toCode(registry, valueOpts);
    // Render the constraint as an inline guard so readers see both the
    // precondition and the body.
    return prefix
      + `(args: ${argsType}) => { if (!(${c})) throw new Error('constraint'); return ${this.body.toCode(registry, valueOpts)}; }`;
  }

  toJSON(): LambdaExprDef {
    return this.withCommentOn({
      kind: 'lambda',
      type: this.fnType.toJSON(),
      body: this.body.toJSON(),
      constraint: this.constraint?.toJSON(),
    });
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
}

/** Build a body scope that exposes the fnType's generics and
 *  `call.types` aliases by name, so bare `{name: 'X'}` references
 *  inside the body / constraint resolve via AliasType. */
function buildBodyScope(parent: TypeScope, fnType: Type): TypeScope {
  const local = new LocalScope(parent);
  for (const [name, t] of Object.entries(fnType.generic)) local.bind(name, t);
  const call = fnType.call();
  if (call?.types) {
    for (const [name, t] of Object.entries(call.types)) local.bind(name, t);
  }
  return local;
}

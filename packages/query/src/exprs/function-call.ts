/**
 * FunctionCallExpr — a scalar function call `fn(name: arg, …)` with NAMED
 * arguments (keyed by the declared parameter name). Output type comes from the
 * registered `QueryFunction.resolveOutput`; validation defers missing / unknown
 * / typed-arg checks to `QueryFunction.validateCall` and observes any bind-param
 * argument against the function's declared parameter type. Aggregates / windows
 * / tabular calls have their own expr kinds; a non-scalar function here is a
 * `function.wrong-shape` problem.
 */
import { z } from 'zod';
import type { ExprDef, FunctionCallExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { functionExprSchema } from '../schema-build';
import { textResult, childExprSchema } from './_shared';
import { withAid } from '../aids';
import { ParamExpr } from './param';
import type { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { type NamedArgs, runScalarFunction } from '../runtime/functions';
import {
  parseNamedArgs,
  namedArgSchema,
  resolveNamedArgs,
  validateNamedArgs,
  evaluateNamedArgs,
  orderedArgSql,
  observeNamedParams,
  validateRawArgs,
  namedArgsToJSON,
  namedArgsToCode,
} from './_function-args';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A scalar function call `fn(name: arg, …)` with named arguments. */
export class FunctionCallExpr extends Expr {
  static readonly KIND = 'function-call' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A scalar function call by name with named args." as const;
  readonly kind = FunctionCallExpr.KIND;

  /** Wrap a registered scalar `fn` with its named `args`. */
  constructor(
    readonly fn: string,
    /** Arguments keyed by declared parameter name (insertion order preserved). */
    readonly args: ReadonlyMap<string, Expr>,
  ) {
    super();
  }

  /** Reconstruct a FunctionCallExpr from its JSON def, parsing named args via the registry. */
  static from(json: ExprDef, registry: Registry): FunctionCallExpr {
    if (json.kind !== 'function-call') {
      throw new Error(`FunctionCallExpr.from: expected 'function-call', got '${json.kind}'`);
    }
    return new FunctionCallExpr(json.function, parseNamedArgs(json.args, registry));
  }

  /** Zod schema for this expr kind's JSON shape (named-arg map), layered by `functionExprSchema`. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    // The `open` shape (also the bare-call / `functions:'open'` fallback);
    // `names` / `typed` are layered on by `functionExprSchema`.
    const open = withAid(
      z.object({
        kind: z.literal('function-call'),
        function: z.string().describe('Registered scalar function name.'),
        args: namedArgSchema(child),
      }),
      'Expr_function-call',
    ).describe('A scalar function call with named arguments.');
    return functionExprSchema('function-call', open, opts.functions, opts.depth?.functions ?? 'open', child);
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const a of this.args.values()) visit(a);
  }

  protected override aggregateHere(): boolean {
    return false;
  }

  /** Resolve to the function's declared output type (text fallback when unknown). */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const fn = engine.lookupFunction(this.fn);
    if (!fn) return textResult([], true);
    return fn.resolveOutput(resolveNamedArgs(this.args, engine, scope));
  }

  /** Validate the function is scalar, defer arg checks to `validateCall`, and observe bind-param args. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const here = p.here;
    const argTypes = validateNamedArgs(this.args, engine, scope, p, ctx);

    const fn = engine.lookupFunction(this.fn);
    if (!fn) {
      p.error('function.unknown', `Unknown function '${this.fn}'.`);
      return textResult([], true);
    }
    if (fn.shape !== 'scalar') {
      p.error(
        'function.wrong-shape',
        `Function '${this.fn}' is '${fn.shape}', not a scalar function (use the matching expression kind).`,
      );
    }

    fn.validateCall(argTypes, p);
    validateRawArgs(fn, this.args, p);
    observeNamedParams(this.args, fn, scope, here);

    return fn.resolveOutput(argTypes);
  }

  /** Cost is the sum of the argument child costs. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return this.childCost(engine, scope);
  }

  /** Evaluate the named args and run the registered scalar function. */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    const args: NamedArgs = await evaluateNamedArgs(this.args, ctx, row, group);
    return runScalarFunction(ctx.engine, this.fn, args, ctx);
  }

  /** Emit the dialect's builtin override if any, else the generic `name(args)` call. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const argSql = orderedArgSql(this.fn, this.args, dialect, ctx);
    // A dialect may emit a builtin (e.g. `arrayLength` → `cardinality(...)`)
    // with its own SQL; otherwise fall back to the generic `name(args)` form.
    const override = dialect.emitBuiltinCall(this.fn, argSql);
    if (override) return override;
    const name = ctx.engine.lookupFunction(this.fn)?.sql ?? this.fn;
    return SqlText.concat([
      SqlText.raw(`${name}(`),
      SqlText.join(argSql, ', '),
      SqlText.raw(')'),
    ]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): FunctionCallExprDef {
    return {
      kind: 'function-call',
      function: this.fn,
      args: namedArgsToJSON(this.args),
    };
  }

  /** Deep-copy this expr (and its argument children). */
  clone(): FunctionCallExpr {
    const cloned = new Map<string, Expr>();
    for (const [k, e] of this.args) cloned.set(k, e.clone());
    return new FunctionCallExpr(this.fn, cloned);
  }

  /** Render a human-readable source form of this function call. */
  override toCode(): string {
    return `${this.fn}(${namedArgsToCode(this.args)})`;
  }
}

const _check: ExprClass = FunctionCallExpr;
void _check;

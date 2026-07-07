/**
 * TabularFunctionCallExpr — a type-valued function call usable as a source.
 * STUBBED this phase: resolves to a type (the function's declared output
 * Type when tabular, else a synthetic empty type) and does light arg
 * validation. Row production + SQL emission land in Phase 4/5.
 */
import { z } from 'zod';
import type { ExprDef, TabularFunctionCallExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, TypeResolved } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { functionExprSchema } from '../schema-build';
import { Type } from '../type';
import { childExprSchema } from './_shared';
import { withAid } from '../aids';
import type { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { type NamedArgs, runTabularFunction } from '../runtime/functions';
import {
  parseNamedArgs,
  namedArgSchema,
  resolveNamedArgs,
  validateNamedArgs,
  evaluateNamedArgs,
  orderedArgSql,
  namedArgsToJSON,
  namedArgsToCode,
} from './_function-args';
import type { Cost } from '../cost';
import { addCost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A type-valued (table-returning) function call usable as a source. */
export class TabularFunctionCallExpr extends Expr {
  static readonly KIND = 'tabular-function-call' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A row-producing (table-valued) function call, usable as a source." as const;
  readonly kind = TabularFunctionCallExpr.KIND;

  /** Wrap a registered tabular `fn` with its named `args`. */
  constructor(
    readonly fn: string,
    /** Arguments keyed by declared parameter name (insertion order preserved). */
    readonly args: ReadonlyMap<string, Expr>,
  ) {
    super();
  }

  /** Reconstruct a TabularFunctionCallExpr from its JSON def, parsing named args via the registry. */
  static from(json: ExprDef, registry: Registry): TabularFunctionCallExpr {
    if (json.kind !== 'tabular-function-call') {
      throw new Error(`TabularFunctionCallExpr.from: expected 'tabular-function-call', got '${json.kind}'`);
    }
    return new TabularFunctionCallExpr(json.function, parseNamedArgs(json.args, registry));
  }

  /** Zod schema for this expr kind's JSON shape (named-arg map), layered by `functionExprSchema`. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    // The `open` shape (also the bare-call / `functions:'open'` fallback);
    // `names` / `typed` are layered on by `functionExprSchema`.
    const open = withAid(
      z.object({
        kind: z.literal('tabular-function-call'),
        function: z.string().describe('Registered tabular function name.'),
        args: namedArgSchema(child),
      }),
      'Expr_tabular-function-call',
    ).describe('A type-valued function call (produces rows).');
    return functionExprSchema('tabular-function-call', open, opts.functions, opts.depth?.functions ?? 'open', child, opts.cache);
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const a of this.args.values()) visit(a);
  }

  /** Resolve to the function's declared output Type, or a synthetic field-less type when unavailable. */
  resolve(engine: QueryEngine, _scope: QueryScope): ResolvedType {
    const fn = engine.lookupFunction(this.fn);
    if (fn) {
      const out = fn.resolveOutput(resolveNamedArgs(this.args, engine, _scope));
      if (out.kind === 'type') return out;
    }
    // Fallback: a synthetic, field-less type.
    const synthetic: TypeResolved = {
      kind: 'type',
      type: new Type({ name: `<typefn:${this.fn}>`, fields: [], indexes: [], count: 0, bytes: 0 }),
      source: this.fn,
      synthetic: true,
    };
    return synthetic;
  }

  /** Validate the function exists and is tabular, then defer arg checks to `validateCall`. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    const argTypes = validateNamedArgs(this.args, engine, scope, p, ctx);
    const fn = engine.lookupFunction(this.fn);
    if (!fn) {
      p.error('tabular-function.unknown', `Unknown tabular function '${this.fn}'.`);
    } else if (fn.shape !== 'tabular') {
      p.error(
        'tabular-function.not-tabular',
        `Function '${this.fn}' is '${fn.shape}', not a tabular function.`,
      );
    } else {
      fn.validateCall(argTypes, p);
    }
    return this.resolve(engine, scope);
  }

  /** Cost is the output type's row cardinality plus the argument child costs. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    // The produced rows are the resolved output type's cardinality; the args
    // contribute their own (usually zero-row) cost.
    const out = this.resolve(engine, scope);
    /* v8 ignore start -- the `: { rows:0,bytes:0 }` alternate is unreachable: resolve() always returns a type-kind (declared or synthetic) */
    const base = out.kind === 'type'
      ? { rows: out.type.count, bytes: out.type.count * out.type.bytes }
      : { rows: 0, bytes: 0 };
    /* v8 ignore stop */
    return addCost(base, this.childCost(engine, scope));
  }

  /**
   * Invoke the function's registered runtime implementation to produce rows.
   * The user-supplied `run` returns a `Value` whose `raw` is the produced rows
   * (a JSON array). With no implementation registered the result is an empty
   * array — full tabular-function row production / SQL emission is Phase 4/5.
   */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    const args: NamedArgs = await evaluateNamedArgs(this.args, ctx, row, group);
    return runTabularFunction(ctx.engine, this.fn, args, ctx);
  }

  /** Emit the FROM-position `fn(args)` form. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    // A type-valued function appears in FROM position as `fn(args)`.
    const name = ctx.engine.lookupFunction(this.fn)?.sql ?? this.fn;
    return SqlText.concat([
      SqlText.raw(`${name}(`),
      SqlText.join(orderedArgSql(this.fn, this.args, dialect, ctx), ', '),
      SqlText.raw(')'),
    ]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): TabularFunctionCallExprDef {
    return {
      kind: 'tabular-function-call',
      function: this.fn,
      args: namedArgsToJSON(this.args),
    };
  }

  /** Deep-copy this expr (and its argument children). */
  clone(): TabularFunctionCallExpr {
    const cloned = new Map<string, Expr>();
    for (const [k, e] of this.args) cloned.set(k, e.clone());
    return new TabularFunctionCallExpr(this.fn, cloned);
  }

  /** Render a human-readable source form of this tabular call. */
  override toCode(): string {
    return `${this.fn}(${namedArgsToCode(this.args)})`;
  }
}

const _check: ExprClass = TabularFunctionCallExpr;
void _check;

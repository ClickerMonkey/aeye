/**
 * WindowExpr — a window function `fn(args) OVER (PARTITION BY … ORDER BY …)`,
 * dispatched through the registry. `function` names a registered WINDOW-shaped
 * function (`rowNumber`, `rank`, `lag`, …) OR an AGGREGATE-shaped function used
 * as a windowed aggregate (`sum(value) OVER (…)`); `args` carries its arguments
 * BY NAME. Unlike an aggregate it does NOT collapse rows, so its result is NOT
 * flagged `aggregate` (one value per row) and is nullable.
 *
 * Placement: a window may not appear inside an aggregate (`window.in-aggregate`).
 * Its clauses are validated with `inWindow: true`. The per-row LOGIC lives in
 * the registered `WindowRun` (window-shaped) / `AggregateRun` (windowed
 * aggregate), not here — this expr only builds the partition, ordering, and the
 * per-row named args (injecting the reserved `$order` key the rank functions
 * read).
 */
import { z } from 'zod';
import type { ExprDef, OrderDef, WindowExprDef } from '../schema';
import type { SchemaOptions } from '../node';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { functionExprSchema } from '../schema-build';
import { NumberFieldType } from '../field-types/index';
import { computed, childExprSchema } from './_shared';
import { withAid, didYouMean } from '../aids';
import { obj, lit, str, list, record, enumOf, exprRef } from '../shape';
import {
  parseNamedArgs,
  namedArgSchema,
  resolveNamedArgs,
  validateNamedArgs,
  evaluateNamedArgsRow,
  namedArgsToJSON,
  namedArgsToCode,
} from './_function-args';
import {
  type NamedArgs,
  runAggregateFunction,
  runWindowFunction,
  WINDOW_ORDER_ARG,
} from '../runtime/functions';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { JsonValue } from '../schema';
import type { Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

interface WindowOrder {
  expr: Expr;
  dir: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

/** Structural shape for one `{ expr, dir, nulls? }` ORDER BY term (drives the owned SHAPE's `list`). */
const ORDER_SHAPE = obj(
  {
    expr: exprRef(),
    dir: enumOf(['asc', 'desc'], 'OrderDir'),
    nulls: enumOf(['first', 'last'], 'OrderNulls'),
  },
  (v): WindowOrder => ({ expr: v.expr, dir: v.dir, nulls: v.nulls }),
  { optional: ['nulls'], aid: 'Order' },
);

/** A window function `fn(args) OVER (PARTITION BY … ORDER BY …)`. */
export class WindowExpr extends Expr {
  static readonly KIND = 'window' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A window (or windowed-aggregate) function over `partitionBy` / `orderBy`." as const;
  readonly kind = WindowExpr.KIND;

  /** Wrap a registered window/aggregate `fn` with its named args and PARTITION BY / ORDER BY clauses. */
  constructor(
    readonly fn: string,
    /** Arguments keyed by declared parameter name (insertion order preserved). */
    readonly args: ReadonlyMap<string, Expr>,
    readonly partitionBy: Expr[],
    readonly orderBy: WindowOrder[],
  ) {
    super();
  }

  /** Reconstruct a WindowExpr from its JSON def, recursing into args/partition/order via the registry. */
  static from(json: ExprDef, registry: Registry): WindowExpr {
    if (json.kind !== 'window') {
      throw new Error(`WindowExpr.from: expected 'window', got '${json.kind}'`);
    }
    const partitionBy = (json.partitionBy ?? []).map((e) => registry.parseExpr(e));
    const orderBy = (json.orderBy ?? []).map((o) => ({
      expr: registry.parseExpr(o.expr),
      dir: o.dir,
      nulls: o.nulls,
    }));
    return new WindowExpr(json.function, parseNamedArgs(json.args, registry), partitionBy, orderBy);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `WindowExpr` equal to `from`'s output on a valid def (`args` a named record;
   * `partitionBy` / `orderBy` default to empty when absent). Accumulates every
   * bad arg / partition / order term in one pass (never throws). Semantic checks
   * remain in `validateWalk`. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('window'),
      function: str('FunctionName'),
      args: record(exprRef(), 'FunctionArgs'),
      partitionBy: list(exprRef()),
      orderBy: list(ORDER_SHAPE),
    },
    (v) => new WindowExpr(v.function, v.args, v.partitionBy ?? [], v.orderBy ?? []),
    { optional: ['partitionBy', 'orderBy'], aid: 'Expr_window' },
  );

  /** Zod schema for this expr kind's JSON shape (named args plus partitionBy/orderBy slots), layered by `functionExprSchema`. */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    const child = childExprSchema(opts.Expr);
    // The `open` shape (also the bare-call / `functions:'open'` fallback);
    // `names` / `typed` are layered on by `functionExprSchema`.
    const open = withAid(
      z.object({
        kind: z.literal('window'),
        function: z.string().describe('Registered window (or aggregate) function name.'),
        args: namedArgSchema(child),
        partitionBy: z.array(child).optional(),
        orderBy: z
          .array(
            z.object({
              expr: child,
              dir: withAid(z.enum(['asc', 'desc']), 'OrderDir'),
              nulls: withAid(z.enum(['first', 'last']), 'OrderNulls').optional(),
            }),
          )
          .optional(),
      }),
      'Expr_window',
    ).describe('Window function over a partition / ordering, with named args.');
    return functionExprSchema('window', open, opts.functions, opts.depth?.functions ?? 'open', child, opts.cache);
  }

  protected override windowHere(): boolean {
    return true;
  }

  override forEachChild(visit: (child: Expr) => void): void {
    for (const a of this.args.values()) visit(a);
    for (const e of this.partitionBy) visit(e);
    for (const o of this.orderBy) visit(o.expr);
  }

  /** Resolve to the function's declared output type, per-row (never aggregate) and nullable. */
  resolve(engine: QueryEngine, scope: QueryScope): ResolvedType {
    const fn = engine.lookupFunction(this.fn);
    if (!fn) return computed(new NumberFieldType(), [], true, false);
    const base = fn.resolveOutput(resolveNamedArgs(this.args, engine, scope));
    if (base.kind !== 'computed') return base;
    // Windows are per-row (never an aggregate collapse) and may yield null.
    return { ...base, nullable: true, aggregate: false };
  }

  /** Validate the window isn't inside an aggregate and check its args/clauses and named-arg call. */
  validateWalk(
    engine: QueryEngine,
    scope: QueryScope,
    p: Problems,
    ctx: ValidateContext,
  ): ResolvedType {
    if (ctx.inAggregate) {
      p.error('window.in-aggregate', `Window function '${this.fn}' cannot appear inside an aggregate.`);
    }
    const childCtx: ValidateContext = {
      ...ctx,
      inWindow: true,
      inAggregate: false,
      allowAggregate: false,
    };
    const argTypes = validateNamedArgs(this.args, engine, scope, p, childCtx);
    p.at('partitionBy', () => {
      this.partitionBy.forEach((e, i) => p.at(i, () => e.validateWalk(engine, scope, p, childCtx)));
    });
    p.at('orderBy', () => {
      this.orderBy.forEach((o, i) =>
        p.at([i, 'expr'], () => o.expr.validateWalk(engine, scope, p, childCtx)),
      );
    });

    const fn = engine.lookupFunction(this.fn);
    if (!fn) {
      p.error('window.unknown', `Unknown window function '${this.fn}'.${didYouMean(this.fn, engine.registry.functionList().filter((f) => f.shape === 'window' || f.shape === 'aggregate').map((f) => f.name))}`);
    } else if (fn.shape !== 'window' && fn.shape !== 'aggregate') {
      p.error(
        'window.not-window',
        `Function '${this.fn}' is '${fn.shape}', not usable as a window function.`,
      );
    } else {
      fn.validateCall(argTypes, p);
    }
    return this.resolve(engine, scope);
  }

  /** Cost is the sum of the child (args/partition/order) costs. */
  cost(engine: QueryEngine, scope: QueryScope): Cost {
    return this.childCost(engine, scope);
  }

  /** Stable string key of the partition-by values for a row. */
  private async partitionKey(ctx: RuntimeContext, row: SourceRow): Promise<string> {
    const vals: JsonValue[] = [];
    for (const e of this.partitionBy) vals.push((await e.evaluate(ctx, row)).raw);
    return JSON.stringify(vals);
  }

  /** Evaluate the order-by values for a row (as `Value`s). */
  private async orderValues(ctx: RuntimeContext, row: SourceRow): Promise<Value[]> {
    const out: Value[] = [];
    for (const o of this.orderBy) out.push(await o.expr.evaluate(ctx, row));
    return out;
  }

  /** Compare two rows by the ORDER BY clause. */
  private compareByOrder(a: Value[], b: Value[]): number {
    for (let i = 0; i < this.orderBy.length; i++) {
      const cmp = a[i]!.compareTo(b[i]!);
      if (cmp !== 0) return this.orderBy[i]!.dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  }

  /** Partition and order the group, then dispatch the windowed-aggregate or per-row window run for this row. */
  async evaluate(
    ctx: RuntimeContext,
    row: SourceRow | null,
    group?: readonly SourceRow[],
  ): Promise<Value> {
    if (!row) return Value.null();
    const all = group ?? [row];

    // PARTITION BY: keep rows sharing this row's partition key.
    let partition: SourceRow[] = [...all];
    if (this.partitionBy.length) {
      const key = await this.partitionKey(ctx, row);
      const filtered: SourceRow[] = [];
      for (const r of all) {
        if ((await this.partitionKey(ctx, r)) === key) filtered.push(r);
      }
      partition = filtered;
    }

    // ORDER BY: sort the partition; keep each row's order key aligned.
    let orderKeys: Value[][] = partition.map(() => []);
    if (this.orderBy.length) {
      const decorated = await Promise.all(
        partition.map(async (r) => ({ r, k: await this.orderValues(ctx, r) })),
      );
      decorated.sort((x, y) => this.compareByOrder(x.k, y.k));
      partition = decorated.map((d) => d.r);
      orderKeys = decorated.map((d) => d.k);
    }

    const idx = partition.indexOf(row);
    const index = idx < 0 ? 0 : idx;

    // Build per-partition-row named args, injecting the reserved `$order` key
    // (the row's ORDER BY values) the rank functions read.
    const partitionArgs: NamedArgs[] = [];
    for (let j = 0; j < partition.length; j++) {
      const base = await evaluateNamedArgsRow(this.args, ctx, partition[j]!);
      /* v8 ignore next -- orderKeys is always aligned 1:1 with partition, so orderKeys[j] is never nullish */
      const order: JsonValue = (orderKeys[j] ?? []).map((v) => v.raw);
      partitionArgs.push({ ...base, [WINDOW_ORDER_ARG]: Value.of(order) });
    }

    // An aggregate-shaped function used here is a windowed aggregate (one value
    // for the whole partition); otherwise dispatch the per-row window run.
    const fn = ctx.engine.lookupFunction(this.fn);
    if (fn?.shape === 'aggregate') {
      return runAggregateFunction(ctx.engine, this.fn, partitionArgs, ctx);
    }
    return runWindowFunction(ctx.engine, this.fn, partitionArgs, index, ctx);
  }

  /** Emit `fn(args) OVER (PARTITION BY … ORDER BY …)`. */
  toSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    const argSql = [...this.args.values()].map((a) => a.toSQL(dialect, ctx));
    // A dialect may emit a builtin window with a special form (e.g. `nth_value`);
    // otherwise emit the generic `name(args)` call, using the function's SQL
    // NAME override (`rowNumber` → `row_number`) when it differs from the name.
    const name = ctx.engine.lookupFunction(this.fn)?.sql ?? this.fn;
    const call =
      dialect.emitBuiltinCall(this.fn, argSql) ??
      SqlText.concat([SqlText.raw(`${name}(`), SqlText.join(argSql, ', '), SqlText.raw(')')]);
    const over: SqlText[] = [];
    if (this.partitionBy.length) {
      over.push(
        SqlText.concat([
          SqlText.raw('PARTITION BY '),
          SqlText.join(this.partitionBy.map((e) => e.toSQL(dialect, ctx)), ', '),
        ]),
      );
    }
    if (this.orderBy.length) {
      const terms = this.orderBy.map((o) =>
        SqlText.concat([
          o.expr.toSQL(dialect, ctx),
          SqlText.raw(` ${o.dir.toUpperCase()}`),
          o.nulls ? SqlText.raw(` NULLS ${o.nulls.toUpperCase()}`) : SqlText.empty(),
        ]),
      );
      over.push(SqlText.concat([SqlText.raw('ORDER BY '), SqlText.join(terms, ', ')]));
    }
    return SqlText.concat([
      call,
      SqlText.raw(' OVER ('),
      SqlText.join(over, ' '),
      SqlText.raw(')'),
    ]);
  }

  /** Serialize back to its JSON ExprDef. */
  toJSON(): WindowExprDef {
    const def: WindowExprDef = { kind: 'window', function: this.fn, args: namedArgsToJSON(this.args) };
    if (this.partitionBy.length > 0) def.partitionBy = this.partitionBy.map((e) => e.toJSON());
    if (this.orderBy.length > 0) {
      def.orderBy = this.orderBy.map((o): OrderDef => {
        const od: OrderDef = { expr: o.expr.toJSON(), dir: o.dir };
        if (o.nulls) od.nulls = o.nulls;
        return od;
      });
    }
    return def;
  }

  /** Deep-copy this expr (and its arg/partition/order children). */
  clone(): WindowExpr {
    const cloned = new Map<string, Expr>();
    for (const [k, e] of this.args) cloned.set(k, e.clone());
    return new WindowExpr(
      this.fn,
      cloned,
      this.partitionBy.map((e) => e.clone()),
      this.orderBy.map((o) => ({ expr: o.expr.clone(), dir: o.dir, nulls: o.nulls })),
    );
  }

  /** Render a human-readable source form of this window call. */
  override toCode(): string {
    const inner = namedArgsToCode(this.args);
    const parts: string[] = [];
    if (this.partitionBy.length) parts.push(`PARTITION BY ${this.partitionBy.map((e) => e.toCode()).join(', ')}`);
    if (this.orderBy.length) parts.push(`ORDER BY ${this.orderBy.map((o) => `${o.expr.toCode()} ${o.dir}`).join(', ')}`);
    return `${this.fn}(${inner}) OVER (${parts.join(' ')})`;
  }
}

const _check: ExprClass = WindowExpr;
void _check;

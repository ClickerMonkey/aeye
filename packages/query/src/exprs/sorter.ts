/**
 * SorterExpr — a DYNAMIC-SORT catalog PLACEHOLDER, valid ONLY inside a SELECT's
 * `order` list. It is the ORDER BY analogue of {@link FiltersExpr}: the query
 * author (or LLM) declares a CATALOG of named sortable expressions (`sorts`) plus
 * an optional `defaultSort`; the CALLER supplies the actual sort SELECTION at
 * execution time (`RuntimeOptions.sort` / `engine.toSQL({ sort })`), so an
 * end-user can re-sort a live result. The LLM never authors the selection.
 *
 * Unlike `FiltersExpr` (a boolean value dropped into a slot), a sorter is NOT a
 * value — in order-by it EXPANDS into concrete ORDER BY terms. {@link expand}
 * turns the runtime sort spec into `QueryOrder[]`, which then flow through the
 * SAME order-by machinery (comparator / SQL emission) an explicit `order` uses:
 *  - each `{ sort, dir }` in the spec (in order) looks up `sorts[sort]` → an
 *    order term `(that expr, dir)`; a selected name absent from `sorts` is a loud
 *    `sort.unknown-name` runtime error (never silently dropped);
 *  - with NO spec it falls back to `defaultSort` (each `{ sort, dir }` →
 *    `sorts[sort]`); with neither it contributes zero terms.
 *
 * A `sorts` value may be any `Expr`, including an `output` reference (sort by a
 * select item without restating its expr). It is a registered `Expr` purely so a
 * MISPLACED sorter (anywhere but a select's `order`) is caught loudly by
 * `validateWalk` (`sorter.misplaced`); the SELECT validates a well-placed sorter
 * through {@link validateInOrder} instead.
 */
import { z } from 'zod';
import type { ExprDef, SorterDef, SortEntryDef, SortSelectionDef } from '../schema';
import type { SchemaOptions } from '../node';
import { sorterSchema } from '../schema-build';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { Expr, type ExprClass, type ValidateContext } from '../expr';
import { textResult, childExprSchema } from './_shared';
import { didYouMean } from '../aids';
import { obj, lit, str, list, record, exprRef, enumOf, type Shape } from '../shape';
import { QueryOrder } from '../queries/order';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { ZERO_COST, type Cost } from '../cost';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** The structural shape for one `defaultSort` entry (`{ sort, dir }`). */
const sortEntryShape: Shape<SortEntryDef> = obj(
  {
    sort: str('SortName'),
    dir: enumOf(['asc', 'desc'] as const, 'OrderDir'),
  },
  (v) => ({ sort: v.sort, dir: v.dir }),
  { aid: 'SortEntry' },
);

/** A dynamic-sort catalog placeholder (valid only in a SELECT `order`); the selection is supplied at run time. */
export class SorterExpr extends Expr {
  static readonly KIND = 'sorter' as const;
  /** Concise LLM-facing summary of this expr kind (see `ExprClass.INSTRUCTIONS`). */
  static readonly INSTRUCTIONS = "A dynamic-sort catalog for a SELECT `order`: declare named `sorts` (+ optional `defaultSort`); the caller picks the sort at execution time." as const;
  readonly kind = SorterExpr.KIND;

  /** Wrap the catalog (`sorts`) and its optional multi-key `defaultSort`. */
  constructor(
    /** The catalog of named sortable expressions (sort name → expr), in declared order. */
    readonly sorts: ReadonlyMap<string, Expr>,
    /** The default multi-key sort applied when the caller selects none. */
    readonly defaultSort: readonly SortEntryDef[] | undefined,
  ) {
    super();
  }

  /** Reconstruct a SorterExpr from its JSON def (validates the `kind` discriminant). */
  static from(json: ExprDef, registry: Registry): SorterExpr {
    if (json.kind !== 'sorter') {
      throw new Error(`SorterExpr.from: expected 'sorter', got '${json.kind}'`);
    }
    const sorts = new Map<string, Expr>();
    for (const name of Object.keys(json.sorts)) {
      sorts.set(name, registry.parseExpr(json.sorts[name]!));
    }
    const defaultSort = json.defaultSort ? json.defaultSort.map((d) => ({ ...d })) : undefined;
    return new SorterExpr(sorts, defaultSort);
  }

  /**
   * Owned structural {@link Shape} — the zod-free parallel parser. Builds a
   * `SorterExpr` equal to `from`'s output on a valid def (`{ sorts, defaultSort? }`);
   * accumulates on a bad def (never throws). The SELECTION is supplied at
   * execution time — never authored here. See `shape/`.
   */
  static readonly SHAPE = obj(
    {
      kind: lit('sorter'),
      sorts: record(exprRef(), 'Sorts'),
      defaultSort: list(sortEntryShape),
    },
    (v) => new SorterExpr(v.sorts, v.defaultSort),
    { optional: ['defaultSort'], aid: 'Expr_sorter' },
  );

  /** Zod schema for this expr kind's JSON shape (its `sorts` values are child exprs). */
  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return sorterSchema(childExprSchema(opts.Expr));
  }

  // ─── Resolution / validation ─────────────────────────────────────────────

  /**
   * A sorter is never a VALUE, so this is only reached when one is (invalidly)
   * nested in a value position — already rejected by {@link validateWalk}. It
   * resolves to a nullable text placeholder so a surrounding resolve never throws.
   */
  resolve(_engine: QueryEngine, _scope: QueryScope): ResolvedType {
    return textResult([], true);
  }

  /**
   * A sorter reached as a general expression is MISPLACED — it is valid only in a
   * select's `order` list (where the SELECT validates it via {@link validateInOrder}).
   * Anywhere else (WHERE, a select field, a function arg, a `sorts` value, …) is
   * a `sorter.misplaced` error.
   */
  validateWalk(_engine: QueryEngine, _scope: QueryScope, p: Problems, _ctx: ValidateContext): ResolvedType {
    p.error('sorter.misplaced', "A `sorter` is only valid inside a SELECT's `order` list; it cannot be used here.");
    return textResult([], true);
  }

  /**
   * Validate a WELL-PLACED sorter (called by the SELECT for each `order` sorter):
   *  - `sorts` must be NON-EMPTY (`sorter.empty`);
   *  - each `sorts` value is validated EXACTLY like an order-by term's expr —
   *    against the SELECT's order scope + the same `ValidateContext` — so an
   *    `output` ref resolves and any non-orderable / relation-as-value expr is
   *    rejected there;
   *  - each `defaultSort[*].sort` must name a declared sort (`sorter.unknown-default`).
   * The SQL-92 GROUP BY rule is applied to the `sorts` exprs by the SELECT itself
   * (it owns the group-key set), mirroring how it treats an ordinary order term.
   */
  validateInOrder(engine: QueryEngine, scope: QueryScope, p: Problems, ctx: ValidateContext): void {
    if (this.sorts.size === 0) {
      p.error('sorter.empty', 'A `sorter` must declare at least one entry in `sorts`.');
    }
    p.at('sorts', () => {
      for (const [name, expr] of this.sorts) {
        p.at(name, () => expr.validateWalk(engine, scope, p, ctx));
      }
    });
    if (this.defaultSort) {
      p.at('defaultSort', () => {
        this.defaultSort!.forEach((d, i) => {
          if (!this.sorts.has(d.sort)) {
            p.at([i, 'sort'], () =>
              p.error(
                'sorter.unknown-default',
                `defaultSort references '${d.sort}', which is not a declared sort.${didYouMean(d.sort, [...this.sorts.keys()])}`,
              ),
            );
          }
        });
      });
    }
  }

  // ─── Expansion (the order-by consumer's entry point) ──────────────────────

  /**
   * Expand this sorter against the runtime sort `spec` into concrete
   * {@link QueryOrder} terms. A non-empty `spec` drives the terms (each `dir`
   * defaults to `'asc'`); an empty / absent `spec` falls back to `defaultSort`;
   * neither yields no terms. A selected `sort` name absent from `sorts` throws a
   * loud `sort.unknown-name` runtime error (never silently dropped).
   */
  expand(spec: readonly SortSelectionDef[] | undefined): QueryOrder[] {
    const chosen: readonly SortEntryDef[] =
      spec && spec.length > 0
        ? spec.map((s) => ({ sort: s.sort, dir: s.dir ?? 'asc' }))
        : this.defaultSort ?? [];
    return chosen.map(({ sort, dir }) => {
      const expr = this.sorts.get(sort);
      if (!expr) {
        throw new Error(
          `sort.unknown-name: unknown sort '${sort}'. Declared sorts: ${[...this.sorts.keys()].join(', ')}.`,
        );
      }
      return new QueryOrder(expr, dir, undefined);
    });
  }

  // ─── Evaluation / cost / SQL (never reached for a well-placed sorter) ──────

  /** A sorter is never a value; a misplaced one evaluates to NULL (validation rejects it). */
  async evaluate(_ctx: RuntimeContext, _row: SourceRow | null, _group?: readonly SourceRow[]): Promise<Value> {
    return Value.null();
  }

  /** A sorter carries no intrinsic value cost. */
  cost(_engine: QueryEngine, _scope: QueryScope): Cost {
    return ZERO_COST;
  }

  /** A sorter is never emitted as a value; a misplaced one emits NULL (validation rejects it). */
  toSQL(_dialect: Dialect, _ctx: SqlContext): SqlText {
    return SqlText.raw('NULL');
  }

  // ─── Traversal ─────────────────────────────────────────────────────────────

  /** Visit each catalog (`sorts`) value expr. */
  override forEachChild(visit: (child: Expr) => void): void {
    for (const expr of this.sorts.values()) visit(expr);
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /** Serialize back to its JSON ExprDef. */
  toJSON(): SorterDef {
    const sorts: Record<string, ExprDef> = {};
    for (const [name, expr] of this.sorts) sorts[name] = expr.toJSON();
    const def: SorterDef = { kind: 'sorter', sorts };
    if (this.defaultSort) def.defaultSort = this.defaultSort.map((d) => ({ ...d }));
    return def;
  }

  /** Deep-copy this expr (cloning each catalog expr). */
  clone(): SorterExpr {
    const sorts = new Map<string, Expr>();
    for (const [name, expr] of this.sorts) sorts.set(name, expr.clone());
    return new SorterExpr(sorts, this.defaultSort ? this.defaultSort.map((d) => ({ ...d })) : undefined);
  }

  /** Render as the readable `sorter(name1, name2, …)` DSL form. */
  override toCode(): string {
    return `sorter(${[...this.sorts.keys()].join(', ')})`;
  }
}

const _check: ExprClass = SorterExpr;
void _check;

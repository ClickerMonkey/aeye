/**
 * QueryOrder — one ORDER BY term (expr + direction + nulls placement) plus a
 * generic stable sort over rows carrying their originating evaluation row +
 * group (so an ORDER BY may reference aggregates of the group).
 */
import type { ExprDef, OrderDef, SortSelectionDef } from '../schema';
import type { Registry } from '../registry';
import type { Expr } from '../expr';
import type { Cost, CostContext } from '../cost';
import type { QueryScope } from '../scope';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { Value } from '../runtime/value';
import { obj, enumOf, exprRef, type Shape } from '../shape';
import { relationKeyRefsRun } from '../exprs/_relation-value';

/** One ORDER BY term (expr + direction + nulls placement) plus a stable sort over grouped rows. */
export class QueryOrder {
  /** Construct an ORDER BY term from its expr, direction, and optional nulls placement. */
  constructor(
    /** The expression sorted on. */
    readonly expr: Expr,
    /** Sort direction. */
    readonly dir: 'asc' | 'desc',
    /** Explicit NULLs placement, or `undefined` for the direction-based default. */
    readonly nulls: 'first' | 'last' | undefined,
  ) {}

  /** Build a `QueryOrder` from its authored `OrderDef`. */
  static from(def: OrderDef, registry: Registry): QueryOrder {
    return new QueryOrder(registry.parseExpr(def.expr), def.dir, def.nulls);
  }

  /**
   * Owned structural {@link Shape} for an `OrderDef` (`{ expr, dir, nulls? }`) —
   * the zod-free parallel to {@link from}. Never throws; accumulates. See
   * `shape/`.
   */
  static readonly SHAPE: Shape<QueryOrder> = obj(
    {
      expr: exprRef(),
      dir: enumOf(['asc', 'desc'] as const, 'OrderDir'),
      nulls: enumOf(['first', 'last'] as const, 'OrderNulls'),
    },
    (v) => new QueryOrder(v.expr, v.dir, v.nulls),
    { optional: ['nulls'], aid: 'Order' },
  );

  /**
   * The per-row cost of this ORDER BY term — just its sort expression's cost.
   * Mirrors {@link SorterExpr.cost} so a SELECT can cost every `order` entry
   * uniformly (concrete term or dynamic sorter) without a type check.
   */
  cost(ctx: CostContext, scope: QueryScope): Cost {
    return this.expr.cost(ctx, scope);
  }

  /** The exprs this term reads for `references` — a concrete term is just its own expr. */
  referenceExprs(_spec: readonly SortSelectionDef[] | undefined): Expr[] {
    return [this.expr];
  }

  /** Serialize back to an `OrderDef`, omitting `nulls` when unset. */
  toJSON(): OrderDef {
    const def: OrderDef = { expr: this.expr.toJSON(), dir: this.dir };
    if (this.nulls) def.nulls = this.nulls;
    return def;
  }

  /** Deep-clone this term (cloning its expr). */
  clone(): QueryOrder {
    return new QueryOrder(this.expr.clone(), this.dir, this.nulls);
  }
}

/** An entry to sort, exposing the row + group its ORDER BY exprs evaluate over. */
export interface OrderEntry<T> {
  item: T;
  row: SourceRow;
  group: readonly SourceRow[];
}

/**
 * The direction + NULLs placement a sort term contributes — the minimal shape
 * the comparator needs. A `QueryOrder` (which adds `expr`) and a backing's
 * resolved default-order term both satisfy it structurally, so `sortByKeys`
 * serves ORDER BY and a Type's `defaultOrder` with ONE comparator.
 */
export interface ResolvedOrderTerm {
  /** Sort direction. */
  readonly dir: 'asc' | 'desc';
  /** Explicit NULLs placement, or `undefined` for the direction-based default. */
  readonly nulls: 'first' | 'last' | undefined;
}

/**
 * Stable-sort `entries` (each carrying its PRE-EVALUATED sort keys, aligned to
 * `terms`) by direction + NULLs placement. The comparator is shared with
 * `sortEntries`; keys may come from ORDER BY exprs or a Type's `defaultOrder`.
 */
export function sortByKeys<T>(
  entries: readonly { readonly item: T; readonly keys: readonly Value[] }[],
  terms: readonly ResolvedOrderTerm[],
): T[] {
  const decorated = [...entries];
  decorated.sort((a, b) => {
    for (let i = 0; i < terms.length; i++) {
      const cmp = compareWithNulls(a.keys[i]!, b.keys[i]!, terms[i]!);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  return decorated.map((d) => d.item);
}

/** A sort term reduced to what the comparator needs: one key READER + its direction. */
interface SortKeyTerm extends ResolvedOrderTerm {
  /** Produce this term's sort key for one row (+ its group). */
  read(ctx: RuntimeContext, row: SourceRow, group: readonly SourceRow[]): Promise<Value>;
}

/**
 * Expand each term into the keys actually sorted on. A RELATION term sorts by
 * its ORDERED KEY COLUMNS — lexicographic over the declared key order, which is
 * what ordering an identity means — rather than by the assembled identity
 * OBJECT, whose comparison would run over its JSON encoding (so `{id:10}` would
 * sort before `{id:9}`). Each expanded column inherits the term's direction and
 * NULLs placement; every other term expands to itself.
 *
 * The columns are read via `columnValue`, since a belongs-to's key column shares
 * the relation FIELD's name and a plain `evaluate` would hand back the identity.
 */
function expandSortTerms(terms: readonly QueryOrder[], ctx: RuntimeContext): SortKeyTerm[] {
  const out: SortKeyTerm[] = [];
  for (const t of terms) {
    const keys = relationKeyRefsRun(t.expr, ctx);
    if (keys) {
      for (const k of keys) out.push({ read: (c, row) => k.columnValue(c, row), dir: t.dir, nulls: t.nulls });
    } else {
      const expr = t.expr;
      out.push({ read: (c, row, group) => expr.evaluate(c, row, group), dir: t.dir, nulls: t.nulls });
    }
  }
  return out;
}

/**
 * Stable-sort `entries` by `terms`. Each term's value is pre-evaluated per
 * entry, then a comparator applies direction + nulls placement. NULLs default
 * to sorting first on `asc` (last on `desc`), overridable via `nulls`.
 */
export async function sortEntries<T>(
  entries: OrderEntry<T>[],
  terms: readonly QueryOrder[],
  ctx: RuntimeContext,
): Promise<T[]> {
  const expanded = expandSortTerms(terms, ctx);
  const decorated = await Promise.all(
    entries.map(async (e) => {
      const keys: Value[] = [];
      for (const t of expanded) keys.push(await t.read(ctx, e.row, e.group));
      return { item: e.item, keys };
    }),
  );
  return sortByKeys(decorated, expanded);
}

/** Compare two values for one term, honoring direction + nulls placement. */
function compareWithNulls(a: Value, b: Value, term: ResolvedOrderTerm): number {
  const aNull = a.isNull();
  const bNull = b.isNull();
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    // Resolve where nulls go: explicit `nulls`, else asc⇒first / desc⇒last.
    const nullsFirst = term.nulls ? term.nulls === 'first' : term.dir === 'asc';
    const nullIsA = aNull ? -1 : 1;
    return nullsFirst ? nullIsA : -nullIsA;
  }
  const cmp = a.compareTo(b);
  return term.dir === 'desc' ? -cmp : cmp;
}

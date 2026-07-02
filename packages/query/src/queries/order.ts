/**
 * QueryOrder — one ORDER BY term (expr + direction + nulls placement) plus a
 * generic stable sort over rows carrying their originating evaluation row +
 * group (so an ORDER BY may reference aggregates of the group).
 */
import type { ExprDef, OrderDef } from '../schema';
import type { Registry } from '../registry';
import type { Expr } from '../expr';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import { Value } from '../runtime/value';

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
 * Stable-sort `entries` by `terms`. Each term's value is pre-evaluated per
 * entry, then a comparator applies direction + nulls placement. NULLs default
 * to sorting first on `asc` (last on `desc`), overridable via `nulls`.
 */
export async function sortEntries<T>(
  entries: OrderEntry<T>[],
  terms: readonly QueryOrder[],
  ctx: RuntimeContext,
): Promise<T[]> {
  const decorated = await Promise.all(
    entries.map(async (e) => {
      const keys: Value[] = [];
      for (const t of terms) keys.push(await t.expr.evaluate(ctx, e.row, e.group));
      return { e, keys };
    }),
  );

  decorated.sort((a, b) => {
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]!;
      const av = a.keys[i]!;
      const bv = b.keys[i]!;
      const cmp = compareWithNulls(av, bv, term);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  return decorated.map((d) => d.e.item);
}

/** Compare two values for one term, honoring direction + nulls placement. */
function compareWithNulls(a: Value, b: Value, term: QueryOrder): number {
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

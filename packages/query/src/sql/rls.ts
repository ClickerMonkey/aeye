/**
 * Row-Level-Security injection.
 *
 * A caller supplies an `RlsProvider` mapping a Type NAME (and the concrete
 * alias the Type is bound under in a given occurrence) to an additional
 * boolean predicate (`ExprDef`). The SQL converter ANDs that predicate into
 * the WHERE / ON of EVERY occurrence of the Type:
 *  - the top-level FROM type (added to WHERE),
 *  - every planned relation join (added to the join's ON),
 *  - every aggregate CTE's inner type (added to the CTE's WHERE),
 *  - and — because each subquery emits through the same path — every nested
 *    occurrence too.
 *
 * The provider receives the alias so it can build correctly-qualified
 * `field-ref`s; it is the caller's job to reference fields via that alias.
 */
import type { ExprDef } from '../schema';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Dialect } from './dialect';
import { SqlText } from './emit';
import { SqlContext } from './emit';
import type { JoinCtePlanner } from './planner';
import { QueryScope as Scope } from '../scope';
import { resolveAccessSql } from '../backing';

/**
 * Supplies an extra RLS predicate for a Type occurrence. Return `undefined`
 * for Types with no policy.
 */
export interface RlsProvider {
  /**
   * The additional boolean predicate for an occurrence of `typeName` bound
   * under `alias`, or `undefined` when the Type is unrestricted. Field
   * references in the returned def MUST use `alias` as their source.
   */
  predicateFor(typeName: string, alias: string): ExprDef | undefined;
}

/**
 * Build the combined RLS predicate fragment for a Type occurrence, ready to AND
 * into a WHERE / ON. Folds together TWO sources, ANDed:
 *  - the `RlsProvider`'s per-occurrence predicate (when a provider is supplied);
 *  - the Type's dev-side `TypeBacking.access` (row-level security).
 * A backing access that resolves to a static DENY (`false`) collapses the whole
 * occurrence to `FALSE` (no rows). Returns `undefined` when nothing applies.
 *
 * Each predicate is parsed/emitted against a private scope binding only `alias`,
 * so its own `field-ref`s resolve; parameters (if any) flow into the surrounding
 * fragment in document order.
 */
export function rlsPredicate(
  rls: RlsProvider | undefined,
  dialect: Dialect,
  engine: QueryEngine,
  planner: JoinCtePlanner,
  typeName: string,
  alias: string,
): SqlText | undefined {
  const ctx = aliasContext(dialect, engine, planner, rls, typeName, alias);
  const parts: SqlText[] = [];

  // 1. Provider predicate.
  const def = rls?.predicateFor(typeName, alias);
  if (def) parts.push(engine.registry.parseExpr(def).toSQL(dialect, ctx));

  // 2. Backing row-level-security access.
  const access = engine.typeBacking(typeName)?.access;
  if (access) {
    const acc = resolveAccessSql(access, alias, ctx);
    switch (acc.kind) {
      case 'deny':
        // No rows for this occurrence, regardless of any provider predicate.
        return SqlText.raw('FALSE');
      case 'predicate':
        parts.push(acc.sql);
        break;
      case 'allow':
      case 'noop':
        break;
      /* v8 ignore next 2 -- defensive: `acc.kind` exhaustively covers AccessSql */
      default:
        return assertNeverAccessSql(acc);
    }
  }

  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0]! : SqlText.join(parts, ' AND ');
}

/** A SqlContext whose scope binds only `alias → typeName`, for RLS emission. */
function aliasContext(
  dialect: Dialect,
  engine: QueryEngine,
  planner: JoinCtePlanner,
  rls: RlsProvider | undefined,
  typeName: string,
  alias: string,
): SqlContext {
  const type = engine.type(typeName);
  const scope: QueryScope = new Scope();
  if (type) scope.bind(alias, { kind: 'type', type, source: alias, synthetic: false });
  return new SqlContext(dialect, engine, scope, planner, rls, false, planner.params);
}

/* v8 ignore start -- defensive exhaustiveness guard; unreachable for valid AccessSql */
/** Compile-time exhaustiveness guard over the resolved access kinds handled here. */
function assertNeverAccessSql(value: never): never {
  throw new Error(`rlsPredicate: unhandled access kind ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

/**
 * `SqlText` — a structured SQL fragment that carries the SQL string AS A LIST
 * OF SEGMENTS (raw text + bound parameters) so parameter values are NEVER
 * string-interpolated. Placeholder formatting (`?` vs `$n`) is dialect-specific
 * and the document ORDER of params is only known once everything is assembled,
 * so segments defer placeholder numbering to a final `render(dialect)` pass.
 *
 * Also defines `SqlValue` (the bindable scalar) and `SqlContext` (the per-emit
 * state threaded through every `Expr.toSQL` / `Query.toSQL`).
 *
 * This module has NO runtime imports — every collaborator (`Dialect`,
 * `JoinCtePlanner`, `RlsProvider`, `QueryEngine`, `QueryScope`) is referenced
 * `type`-only, so it sits cleanly at the bottom of the SQL module graph.
 */
import type { Dialect } from './dialect';
import type { JoinCtePlanner } from './planner';
import type { RlsProvider } from './rls';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Expr } from '../expr';
import type { JsonValue, SortSelectionDef } from '../schema';
import type { SemanticTextToVector } from '../vector-text';

/** A value that may be bound as a SQL parameter. */
export type SqlValue = string | number | boolean | null;

/**
 * A supplied param value:
 *  - a bindable SCALAR, bound directly;
 *  - a RELATION KEY object (`{ pk }`, keyed by the target's PK field names) on
 *    the RHS of a relation comparison (`assignedUser = { id: 5 }`), which the
 *    comparison decomposes into per-column binds;
 *  - or a whole JSON DOCUMENT for a `json` / `array` cell, bound as ONE
 *    parameter through `Dialect.jsonValue` (0.6.1's A9 — such a value used to
 *    bind SQL `NULL`, so the write succeeded and the data was dropped).
 *
 * `JsonValue` subsumes the relation-key object; the three cases are spelled out
 * because they are read very differently at the point of use.
 */
export type SqlParamValue = JsonValue;

/** A rendered SQL string plus its ordered bind parameters. */
export interface RenderedSql {
  /** The flat SQL string with dialect-numbered placeholders. */
  readonly sql: string;
  /** The bind parameters, in document order. */
  readonly params: ReadonlyArray<SqlValue>;
}

/** A literal chunk of SQL text. */
interface RawSegment {
  readonly kind: 'raw';
  readonly text: string;
}
/** A bound parameter occupying one placeholder slot. */
interface ParamSegment {
  readonly kind: 'param';
  readonly value: SqlValue;
}
type Segment = RawSegment | ParamSegment;

/**
 * An ordered list of raw-text / parameter segments. Immutable; combinators
 * return new instances. Placeholder text is produced only at `render` time so
 * the dialect can number parameters in final document order.
 */
export class SqlText {
  private constructor(readonly segments: ReadonlyArray<Segment>) {}

  /** A fragment of literal SQL text (no parameters). */
  static raw(text: string): SqlText {
    return new SqlText([{ kind: 'raw', text }]);
  }

  /** A single bound parameter. */
  static param(value: SqlValue): SqlText {
    return new SqlText([{ kind: 'param', value }]);
  }

  /** The empty fragment. */
  static empty(): SqlText {
    return new SqlText([]);
  }

  /** Concatenate fragments end-to-end (no separator). */
  static concat(parts: ReadonlyArray<SqlText>): SqlText {
    const segs: Segment[] = [];
    for (const p of parts) segs.push(...p.segments);
    return new SqlText(segs);
  }

  /** Concatenate fragments with a raw `sep` between each (empty parts kept). */
  static join(parts: ReadonlyArray<SqlText>, sep: string): SqlText {
    const segs: Segment[] = [];
    parts.forEach((p, i) => {
      if (i > 0 && sep.length > 0) segs.push({ kind: 'raw', text: sep });
      segs.push(...p.segments);
    });
    return new SqlText(segs);
  }

  /** Whether this fragment produced no segments. */
  isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** Append raw text after this fragment. */
  appendRaw(text: string): SqlText {
    return SqlText.concat([this, SqlText.raw(text)]);
  }

  /** Wrap this fragment in `(` … `)`. */
  parens(): SqlText {
    return SqlText.concat([SqlText.raw('('), this, SqlText.raw(')')]);
  }

  /**
   * Render to a flat SQL string + ordered params. Parameters are numbered
   * left-to-right in final document order via `dialect.bindPlaceholder`.
   */
  render(dialect: Dialect): RenderedSql {
    let sql = '';
    const params: SqlValue[] = [];
    for (const seg of this.segments) {
      if (seg.kind === 'raw') {
        sql += seg.text;
      } else {
        sql += dialect.bindPlaceholder(params.length);
        params.push(seg.value);
      }
    }
    return { sql, params };
  }
}

// ─── free-function combinators (ergonomic re-exports of the statics) ──────────

/** A fragment of literal SQL text. */
export const raw = (text: string): SqlText => SqlText.raw(text);
/** A single bound parameter. */
export const param = (value: SqlValue): SqlText => SqlText.param(value);
/** Concatenate fragments end-to-end. */
export const concat = (parts: ReadonlyArray<SqlText>): SqlText => SqlText.concat(parts);
/** Concatenate fragments with a separator between each. */
export const join = (parts: ReadonlyArray<SqlText>, sep: string): SqlText => SqlText.join(parts, sep);

/**
 * Per-emit state threaded through every `toSQL`. Immutable; the `with*`
 * helpers derive a fresh context for a nested scope / subquery / aggregate
 * argument without mutating the parent.
 */
export class SqlContext {
  constructor(
    /** The active dialect (identical to the `dialect` argument of `toSQL`). */
    readonly dialect: Dialect,
    /** The engine (Type / function lookup, registry for RLS parsing). */
    readonly engine: QueryEngine,
    /** The scope binding source names → resolved types at this level. */
    readonly scope: QueryScope,
    /** The shared join/CTE planner collecting hidden joins for this level. */
    readonly planner: JoinCtePlanner,
    /** The RLS predicate provider, if any. */
    readonly rls: RlsProvider | undefined,
    /** True while emitting inside an aggregate's argument (fan-out routing). */
    readonly inAggregate: boolean = false,
    /** Bound parameter VALUES (param name → scalar, or a relation `{ pk }` object), for `param` emission. */
    readonly params: Readonly<Record<string, SqlParamValue>> = {},
    /**
     * Execution-time filter EXPRS (already parsed), keyed by source name — read
     * by a `filters` placeholder's `toSQL`. Propagates to nested levels (a
     * subquery may carry its own `filters` placeholder). A source with no entry
     * yields a vacuous `TRUE`.
     */
    readonly filters: Readonly<Record<string, Expr>> = {},
    /**
     * Whether the ENTRY (root) SELECT should emit `COUNT(*) OVER () AS "$total"`.
     * Cleared at EVERY nesting boundary — `withPlanner` for a subquery / FROM
     * subquery, `nonRoot()` for a CTE body / set-op branch — so `$total` is only
     * ever a column of the query the caller actually asked to count.
     *
     * That is not an optimization. `$total` is a PROJECTED column, so inside a
     * set-operation arm it participates in the set comparison and silently
     * corrupts the ROWS: UNION stops de-duplicating, and INTERSECT / EXCEPT
     * compare per-arm counts they were never meant to see. A CTE body would
     * additionally pay a window aggregate nothing selects.
     */
    readonly includeTotal: boolean = false,
    /**
     * Whether the query emitted with THIS context is the ROOT (entry) query
     * `engine.toSQL` was called with. Set `true` only on that entry context;
     * `withPlanner` clears it for every nested SELECT body (so a subquery / FROM
     * subquery is non-root), and `nonRoot()` clears it at the CTE-body /
     * set-op-branch boundaries. A SELECT reads it to decide whether a Type's
     * `defaultOrder` with `applyTo: 'result'` applies (see `SelectQuery`).
     */
    readonly isRoot: boolean = false,
    /**
     * Execution-time dynamic-sort selection (ordered; possibly empty), keyed by a
     * `sorter` placeholder's declared sort names — read by a SELECT `order` when
     * it EXPANDS a sorter into concrete terms. Propagates to nested levels (a
     * subquery may carry its own sorter), mirroring `filters`.
     */
    readonly sortSpec: readonly SortSelectionDef[] = [],
    /**
     * INTERNAL SYNC converter turning a plain-text semantic term (a `semantic(...)`
     * literal, or a text-param value) into its pgvector TEXT literal (`[…]`) so it
     * can be bound + cast `::vector`. Built by `engine.toSQL` from its precomputed
     * `opts.embeddings` cache (looking each term up + formatting the vector);
     * throws when the cache lacks the term. Undefined when the caller supplied no
     * embeddings — a `SemanticExpr` that hits a plain-text term then throws
     * (rather than emitting the invalid `'<text>'::vector`). Propagated to every
     * nested level so a subquery's semantic terms resolve too.
     */
    readonly semanticText: SemanticTextToVector | undefined = undefined,
  ) {}

  /** The execution-supplied filter expr bound to `source`, or `undefined`. */
  filtersFor(source: string): Expr | undefined {
    return this.filters[source];
  }

  /** Same context with a different scope (same planner / level / root status). */
  withScope(scope: QueryScope): SqlContext {
    return new SqlContext(this.dialect, this.engine, scope, this.planner, this.rls, this.inAggregate, this.params, this.filters, this.includeTotal, this.isRoot, this.sortSpec, this.semanticText);
  }

  /** A nested level (subquery): fresh scope + fresh planner, not in-aggregate.
   *  Neither the outer `$total` flag NOR root status propagates into a nested
   *  level, so a subquery / FROM subquery emits as non-root. */
  withPlanner(scope: QueryScope, planner: JoinCtePlanner): SqlContext {
    return new SqlContext(this.dialect, this.engine, scope, planner, this.rls, false, this.params, this.filters, false, false, this.sortSpec, this.semanticText);
  }

  /** Toggle the in-aggregate flag (set when emitting an aggregate argument). */
  asAggregate(on: boolean): SqlContext {
    return new SqlContext(this.dialect, this.engine, this.scope, this.planner, this.rls, on, this.params, this.filters, this.includeTotal, this.isRoot, this.sortSpec, this.semanticText);
  }

  /**
   * Mark the NEXT emitted query as NON-root (same level otherwise). Used at the
   * boundaries `withPlanner` does not cover — a CTE body and a set-operation
   * branch — so those nested SELECTs never inherit the entry's root status.
   * It clears `includeTotal` for the same reason `withPlanner` does: `$total` is
   * a PROJECTED column, and a nested SELECT that projects it changes what the
   * enclosing statement sees (see the `includeTotal` field docs).
   */
  nonRoot(): SqlContext {
    return new SqlContext(this.dialect, this.engine, this.scope, this.planner, this.rls, this.inAggregate, this.params, this.filters, false, false, this.sortSpec, this.semanticText);
  }
}

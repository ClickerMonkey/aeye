/**
 * `Dialect` — the abstract SQL-dialect contract. Concrete dialects
 * (`BaseDialect` = ANSI, `PostgresDialect`) override the handful of points
 * where real SQL engines differ: identifier quoting, parameter placeholders,
 * LIMIT/OFFSET syntax, full-text search, vector similarity, and the per-kind
 * field-type mapping.
 *
 * Implements the registry's structural `DialectEntry` (which requires a
 * `NAME`); instances expose both `name` (the canonical field) and a `NAME`
 * getter so a dialect INSTANCE can be registered directly.
 */
import type { FieldType } from '../field-type';
import { SqlText } from './emit';
import type { DialectEntry } from '../registry';

/** The abstract SQL-dialect contract; concrete dialects override the engine-specific points. */
export abstract class Dialect implements DialectEntry {
  /** The dialect's canonical name (e.g. `'base'`, `'postgres'`). */
  abstract readonly name: string;

  /** Registry key (mirrors `name`) so an instance satisfies `DialectEntry`. */
  get NAME(): string {
    return this.name;
  }

  // ─── Identifiers / parameters ──────────────────────────────────────────────

  /** Quote an identifier (type / field / alias). ANSI double-quoting. */
  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** The bind placeholder for the zero-based parameter `index`. */
  abstract bindPlaceholder(index: number): string;

  /**
   * Whether this dialect can express a JOINED `UPDATE` / `DELETE` — i.e. the
   * `UPDATE t SET … FROM <sources> WHERE …` and `DELETE FROM t USING <sources>
   * WHERE …` forms. Modern engines (Postgres, SQLite ≥ 3.33, SQL Server) and the
   * portable base dialect all support it, so the default is `true`. A dialect
   * targeting an engine WITHOUT this form should override to `false`; joined
   * DML then raises a clear `QueryTypeError` at emit time rather than producing
   * SQL with a dangling join alias.
   */
  get supportsDmlJoins(): boolean {
    return true;
  }

  // ─── Convenience builders (shared) ─────────────────────────────────────────

  /** A quoted identifier as a `SqlText` fragment. */
  ident(name: string): SqlText {
    return SqlText.raw(this.quoteIdent(name));
  }

  /** A quoted `alias.field` reference. */
  field(alias: string, name: string): SqlText {
    return SqlText.raw(`${this.quoteIdent(alias)}.${this.quoteIdent(name)}`);
  }

  // ─── Clauses that differ by dialect ─────────────────────────────────────────

  /**
   * The LIMIT / OFFSET clause for the (already-emitted) limit / offset
   * fragments. Returns empty when both are absent. ANSI `LIMIT n OFFSET m`.
   */
  limitOffset(limit: SqlText | undefined, offset: SqlText | undefined): SqlText {
    const parts: SqlText[] = [];
    if (limit) parts.push(SqlText.concat([SqlText.raw('LIMIT '), limit]));
    if (offset) parts.push(SqlText.concat([SqlText.raw('OFFSET '), offset]));
    return SqlText.join(parts, ' ');
  }

  /**
   * Case-insensitive LIKE. ANSI has no `ILIKE`, so lower both sides; Postgres
   * overrides with the native operator.
   */
  ilike(left: SqlText, right: SqlText): SqlText {
    return SqlText.join(
      [SqlText.concat([SqlText.raw('LOWER('), left, SqlText.raw(')')]), SqlText.raw('LIKE'), SqlText.concat([SqlText.raw('LOWER('), right, SqlText.raw(')')])],
      ' ',
    );
  }

  /**
   * Full-text search of `col` against the literal `query`. ANSI fallback: a
   * substring `LIKE` (case-insensitive via `LOWER` unless `sensitive`).
   * Postgres overrides with `to_tsvector`.
   */
  abstract textSearch(col: SqlText, query: string, sensitive?: boolean): SqlText;

  /**
   * Vector similarity (≈1 = most similar) of two fragments. The base dialect
   * degrades gracefully to the constant `0` (no vector support); Postgres uses
   * cosine distance `1 - (a <=> b)`.
   */
  abstract similarity(a: SqlText, b: SqlText): SqlText;

  /**
   * A LATERAL join attaching the (already-emitted) correlated `subquery` under
   * `alias`.
   *
   * CONTRACT: the base class emits the PORTABLE ANSI/SQL:1999 LATERAL form
   * `LEFT|<inner> JOIN LATERAL (<subquery>) AS <alias> ON 1 = 1` (the `1 = 1`
   * keeps engines without a `TRUE` literal happy) — i.e. the base dialect
   * SUPPORTS lateral joins (it does NOT throw). Postgres overrides only the ON
   * literal to the native `ON true`.
   *
   * A dialect TARGETING AN ENGINE WITH NO LATERAL SUPPORT should override this
   * to throw a clear `QueryTypeError` (as `BaseDialect`'s array-containment ops
   * do for engines without native arrays) so callers never emit silently-wrong
   * SQL — but the portable base form above is the default, not a throw.
   */
  lateralJoin(subquery: SqlText, alias: string, joinType: 'left' | 'inner'): SqlText {
    return this.lateralJoinWith(subquery, alias, joinType, '1 = 1');
  }

  /** Shared lateral-join assembly; `on` is the raw ON-condition literal. */
  protected lateralJoinWith(
    subquery: SqlText,
    alias: string,
    joinType: 'left' | 'inner',
    on: string,
  ): SqlText {
    const keyword = joinType === 'inner' ? 'JOIN LATERAL (' : 'LEFT JOIN LATERAL (';
    return SqlText.concat([
      SqlText.raw(keyword),
      subquery,
      SqlText.raw(') AS '),
      this.ident(alias),
      SqlText.raw(` ON ${on}`),
    ]);
  }

  /** The SQL field type for a field type in this dialect. */
  abstract sqlTypeFor(fieldType: FieldType): string;

  // ─── Array operators ────────────────────────────────────────────────────────
  //
  // These power `ArrayOpExpr` and the `arrayLength` builtin scalar function.
  // Postgres has native array operators; the ANSI base dialect has none, so its
  // containment methods degrade to a documented `QueryTypeError` while
  // `arrayLength` (which only needs the element count) still works.

  /**
   * Length (element count) of array expression `arg`. Postgres `cardinality`;
   * the base dialect degrades to `COALESCE(json_array_length(arg), 0)`.
   */
  abstract arrayLength(arg: SqlText): SqlText;

  /** Membership: scalar `value` is an element of array `col`. Postgres `= ANY`. */
  abstract arrayHas(col: SqlText, value: SqlText): SqlText;

  /** Containment: array `col` contains EVERY element of `elements`. Postgres `@>`. */
  abstract arrayContains(col: SqlText, elements: readonly SqlText[]): SqlText;

  /** Overlap: array `col` shares ANY element with `elements`. Postgres `&&`. */
  abstract arrayOverlaps(col: SqlText, elements: readonly SqlText[]): SqlText;

  /**
   * Dialect-specific SQL for a recognized builtin scalar function (currently
   * `arrayLength`), or `undefined` to fall back to the generic `name(args)`
   * form. Mirrors how `textSearch` / `similarity` route engine-neutral
   * operations to the dialect; consumed by `FunctionCallExpr.toSQL`.
   */
  emitBuiltinCall(name: string, args: readonly SqlText[]): SqlText | undefined {
    if (name === 'arrayLength' && args.length === 1) return this.arrayLength(args[0]!);
    return undefined;
  }
}

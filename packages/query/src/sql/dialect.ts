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
   * Full-text search where `tsv` is a field that ALREADY HOLDS A TSVECTOR (a
   * precomputed, hidden physical field), against the (already-emitted) `query`
   * param — NOT wrapped in `to_tsvector`. Postgres emits
   * `<tsv> @@ plainto_tsquery(<language>, <query>)` (default `language`
   * `'english'`); the base dialect has no tsvector type and DEGRADES to a
   * case-insensitive substring `LIKE` (ignoring `language`).
   */
  abstract tsvectorSearch(tsv: SqlText, query: SqlText, language?: string): SqlText;

  /**
   * Wrap an (already-emitted) query `param` as this dialect's QUERY-VECTOR form
   * for `similarity` over a hidden `pgvector` field. Postgres casts it to the
   * vector type (`<param>::vector`); the base dialect (whose `similarity`
   * degrades to `0`) passes it through unchanged.
   */
  abstract queryVectorParam(param: SqlText): SqlText;

  /**
   * NUMERIC full-text RELEVANCE of `col` against the literal `query` — the
   * ranking counterpart of `textSearch`. Postgres emits
   * `ts_rank(to_tsvector(col), plainto_tsquery(query))`; the base (ANSI) dialect
   * has no ranking, so it DEGRADES to a numeric match
   * `CASE WHEN <textSearch predicate> THEN 1 ELSE 0 END` (never throws).
   */
  abstract textRank(col: SqlText, query: string, sensitive?: boolean): SqlText;

  /**
   * NUMERIC full-text RELEVANCE where `tsv` is a field that ALREADY HOLDS A
   * TSVECTOR (a precomputed, hidden physical field), against the (already-emitted)
   * `query` param — the ranking counterpart of `tsvectorSearch`. Postgres emits
   * `ts_rank(<tsv>, plainto_tsquery(<language>, <query>))` (default `language`
   * `'english'`); the base dialect DEGRADES to a numeric match over its
   * `tsvectorSearch` degrade (ignoring `language`).
   */
  abstract tsvectorRank(tsv: SqlText, query: SqlText, language?: string): SqlText;

  /**
   * Wrap an (already-emitted) BOOLEAN predicate as a NUMERIC 0/1 match score —
   * `CASE WHEN <pred> THEN 1 ELSE 0 END`. Portable ANSI SQL, shared by every
   * dialect; used to lift a `SearchBacking.sql` boolean override into a numeric
   * `text-score`, and by the base dialect's ranking degrade.
   */
  matchScore(pred: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('CASE WHEN '), pred, SqlText.raw(' THEN 1 ELSE 0 END')]);
  }

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
   * Render a builtin's INLINE-LITERAL argument (a `rawArgs` position — see
   * {@link import('../schema').FunctionDef.rawArgs}) as a dialect-appropriate SQL
   * fragment, so it is spliced literally rather than bound as a parameter. The
   * only current use is the date-field selectors: the base dialect emits the
   * token as a BARE SQL word (an `EXTRACT(<field> FROM …)` keyword like `day`
   * or `dow`); Postgres overrides to a QUOTED STRING (`date_part('day', …)`).
   * The token is validated (allowed date-field set) by `FunctionCallExpr`.
   */
  rawArgLiteral(token: string): SqlText {
    return SqlText.raw(token);
  }

  /**
   * Dialect-specific SQL for a recognized builtin scalar function, or
   * `undefined` to fall back to the generic `name(args)` form. Mirrors how
   * `textSearch` / `similarity` route engine-neutral operations to the dialect;
   * consumed by `FunctionCallExpr.toSQL`. Handles array length, the bare
   * date/time keywords, the `EXTRACT`-expressible date-part functions, and the
   * PORTABLE (base) forms of the date-field selectors; Postgres overrides the
   * selectors with its native `date_part` / `date_trunc` / interval forms.
   */
  emitBuiltinCall(name: string, args: readonly SqlText[]): SqlText | undefined {
    if (name === 'arrayLength' && args.length === 1) return this.arrayLength(args[0]!);
    // `CURRENT_DATE` / `CURRENT_TIME` / `CURRENT_TIMESTAMP` are bare special
    // forms (no parentheses); the generic `name(args)` path would wrongly emit
    // `current_date()`.
    if (args.length === 0) {
      if (name === 'currentDate') return SqlText.raw('CURRENT_DATE');
      if (name === 'currentTime') return SqlText.raw('CURRENT_TIME');
      if (name === 'currentTimestamp') return SqlText.raw('CURRENT_TIMESTAMP');
    }
    // Single-arg date-part extractors: `EXTRACT(<PART> FROM d)` (portable on
    // both dialects). `dayOfWeek`/`dayOfYear`/`week`/`epoch` use the pg field
    // names (`DOW`/`DOY`/`WEEK`/`EPOCH`) — a documented base degrade.
    if (args.length === 1) {
      const part = EXTRACT_PART[name];
      if (part) return extract(SqlText.raw(part), args[0]!);
    }
    // `datePart(field, d)` — the field arrives as an inline keyword (rawArg), so
    // the portable form is `EXTRACT(<field> FROM d)`.
    if (name === 'datePart' && args.length === 2) return extract(args[0]!, args[1]!);
    // `dateDiff(field, a, b)` — the difference of the two extracted field
    // components (NOT a true calendar span); portable via `EXTRACT`.
    if (name === 'dateDiff' && args.length === 3) {
      return SqlText.concat([
        SqlText.raw('('),
        extract(args[0]!, args[2]!),
        SqlText.raw(' - '),
        extract(args[0]!, args[1]!),
        SqlText.raw(')'),
      ]);
    }
    // `dateAdd` / `dateTrunc` have no portable ANSI form: the base dialect
    // DEGRADES to the input date unchanged (documented; never throws). Postgres
    // overrides both with native forms.
    if (name === 'dateAdd' && args.length === 3) return args[2]!;
    if (name === 'dateTrunc' && args.length === 2) return args[1]!;
    // Array builtins: the base (ANSI) dialect has no native array type, so these
    // DEGRADE gracefully (never throw). Scalar-returning ops yield a neutral
    // constant; array/string-returning ops emit the first argument unchanged.
    if (name === 'arrayContains' && args.length === 2) return SqlText.raw('(1 = 0)');
    if (name === 'arrayIndexOf' && args.length === 2) return SqlText.raw('0');
    if (name === 'arrayToString' && args.length === 2) return SqlText.raw("''");
    if (name === 'arrayAppend' && args.length === 2) return args[0]!;
    if (name === 'arrayPrepend' && args.length === 2) return args[0]!;
    if (name === 'arrayConcat' && args.length === 2) return args[0]!;
    if (name === 'arrayRemove' && args.length === 2) return args[0]!;
    if (name === 'arraySlice' && args.length === 3) return args[0]!;
    if (name === 'arrayDistinct' && args.length === 1) return args[0]!;
    if (name === 'stringToArray' && args.length === 2) return args[0]!;
    // Aggregate builtins. `countIf` has no native SQL form, so BOTH dialects emit
    // the portable `sum(CASE WHEN cond THEN 1 ELSE 0 END)`. `boolAnd`/`boolOr`/
    // `arrayAgg` are postgres-native; the base dialect DEGRADES here — the bool
    // aggregates to a portable MIN/MAX-over-CASE, and `arrayAgg` (no portable
    // array construction) to `NULL` (never throws).
    if (name === 'countIf' && args.length === 1) return caseCount('sum', args[0]!);
    if (name === 'boolAnd' && args.length === 1) {
      return SqlText.concat([SqlText.raw('('), caseCount('MIN', args[0]!), SqlText.raw(' = 1)')]);
    }
    if (name === 'boolOr' && args.length === 1) {
      return SqlText.concat([SqlText.raw('('), caseCount('MAX', args[0]!), SqlText.raw(' = 1)')]);
    }
    if (name === 'arrayAgg' && args.length === 1) return SqlText.raw('NULL');
    // `iif(cond, then, else)` has no portable function form, so both dialects
    // emit the equivalent searched CASE expression.
    if (name === 'iif' && args.length === 3) {
      return SqlText.concat([
        SqlText.raw('(CASE WHEN '),
        args[0]!,
        SqlText.raw(' THEN '),
        args[1]!,
        SqlText.raw(' ELSE '),
        args[2]!,
        SqlText.raw(' END)'),
      ]);
    }
    return undefined;
  }
}

/** Single-arg date-part builtins → their `EXTRACT(<PART> FROM …)` field. */
const EXTRACT_PART: Readonly<Record<string, string>> = {
  year: 'YEAR',
  month: 'MONTH',
  day: 'DAY',
  hour: 'HOUR',
  minute: 'MINUTE',
  second: 'SECOND',
  dayOfWeek: 'DOW',
  dayOfYear: 'DOY',
  week: 'WEEK',
  epoch: 'EPOCH',
};

/** `EXTRACT(<part> FROM <arg>)` over already-emitted fragments. */
function extract(part: SqlText, arg: SqlText): SqlText {
  return SqlText.concat([SqlText.raw('EXTRACT('), part, SqlText.raw(' FROM '), arg, SqlText.raw(')')]);
}

/** `<agg>(CASE WHEN <pred> THEN 1 ELSE 0 END)` — a portable count/bool aggregate. */
function caseCount(agg: string, pred: SqlText): SqlText {
  return SqlText.concat([
    SqlText.raw(`${agg}(CASE WHEN `),
    pred,
    SqlText.raw(' THEN 1 ELSE 0 END)'),
  ]);
}

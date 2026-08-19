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
import { QueryTypeError } from '../problem';
import type { JsonValue } from '../schema';
import { SqlText } from './emit';
import type { DialectEntry } from '../registry';

/** The abstract SQL-dialect contract; concrete dialects override the engine-specific points. */
/**
 * The alternating `'key', value` argument list of a JSON-object constructor.
 *
 * The KEY is emitted as a quoted SQL string LITERAL, never a bind param: it is
 * part of the query's STRUCTURE (a target identity field name off the schema),
 * not data, and binding it would push a stray parameter into every query that
 * projects a relation — shifting the positions of the real ones. Quotes are
 * doubled defensively even though these names come from the meta-model.
 */
export function jsonObjectArgs(entries: readonly { key: string; value: SqlText }[]): SqlText[] {
  const args: SqlText[] = [];
  for (const e of entries) {
    args.push(SqlText.raw(`'${e.key.replace(/'/g, "''")}'`));
    args.push(e.value);
  }
  return args;
}

/**
 * WHO a value being bound belongs to — supplied by a VALUE position, absent for
 * a COLUMN, and the distinction is what decides whether a declared `cast` may
 * fill an option the target did not write.
 *
 *  - **a COLUMN** (`site` absent) — a real column. Its refinement's option
 *    DEFAULTS are facts about it, so a cast may resolve them; that is what makes
 *    a write cell emit `ST_GeomFromGeoJSON($1)::geometry(Polygon,4326)`.
 *  - **a VALUE** (`site` present) — a declared type standing in for "any value
 *    of this type", which is what an operator OPERAND is. Filling a slot from
 *    the refinement's default PINS a constraint the value was never required to
 *    satisfy: measured on the flagship predicate, an operand declaring
 *    `{kind:'json', as:'Geometry'}` with no `with` cast a Polygon document to
 *    `::geometry(Point,4326)` — a PostGIS TYPMOD — and the server refused it
 *    (`Geometry type (Polygon) does not match column type (Point)`).
 *
 * It is the same rule the model-facing renderer already follows: an operand's
 * tag shows only what its declaration WROTE. One rule, two surfaces.
 *
 * IT CARRIES THE OPERATOR AS WELL AS THE OPERAND, because the refusal is a
 * message to a DECLARER and the operand name alone does not identify a
 * declaration: two registered operators both having a `right` gave `… at
 * args.right` twice and named neither. The precedent is one screen away in
 * `OperatorExpr.toSQL` — *"Operator '&&' is missing required operand 'right'"*.
 */
export interface ValueSite {
  /** The registered operator this value is an operand of. */
  readonly operator: string;
  /** The declared operand name — the `args` key, and the emit template's slot. */
  readonly operand: string;
}

/**
 * Refuse a VALUE-position cast that could only be resolved by asserting an
 * option the target never wrote.
 *
 * A REFUSAL rather than either alternative, and both alternatives were
 * considered. Filling from the refinement's DEFAULTS is what shipped first and
 * it emits confidently wrong SQL — a typmod the value need not satisfy, rejected
 * by the server on the NORMAL case (`&&` is a bounding-box pre-filter, so a
 * Polygon argument is the ordinary one). Falling back to the BASE cast is worse
 * still: that is `CAST($1 AS jsonb)`, which is how this whole road was broken to
 * begin with (`operator does not exist: geometry && jsonb`) — silently emitting
 * SQL the database rejects for a different reason is not an improvement.
 *
 * So the declarer is told, at the one point the ambiguity is real, with the two
 * things that actually resolve it: move the per-column part out of `cast` (a
 * cast that interpolates NO option is position-independent and is used here
 * unchanged), or have the operand WRITE the options in its own `with` — which
 * makes the typmod a constraint the operand genuinely declares.
 */
function refuseUnwrittenCast(target: FieldType, dialect: string, site: ValueSite): void {
  const unwritten = target.uncastableOptions(dialect);
  if (unwritten.length === 0) return;
  throw new QueryTypeError({
    path: ['args', site.operand],
    code: 'cast.unwritten-option',
    severity: 'error',
    message:
      `Operand '${site.operand}' of operator '${site.operator}' binds a document typed \`${target.as}\`, ` +
      `whose \`${dialect}\` cast interpolates ${unwritten.map((o) => `\`{${o}}\``).join(', ')} — and that ` +
      `operand declared no value for ${unwritten.length === 1 ? 'it' : 'them'}. Resolving from the type's ` +
      'DEFAULTS would pin a constraint on the value that nothing required it to satisfy (a default ' +
      'belongs to the TYPE, not to this value), which is how a PostGIS `::geometry(Point,4326)` came to ' +
      `be applied to a Polygon. Either declare a \`cast\` that interpolates no option — one that says ` +
      `only "this IS a ${target.as}", which is what a value position can honestly assert — or write the ` +
      `options in this operand's own \`with\` bag, so the cast expresses a constraint you actually made.`,
  });
}

/**
 * A refinement's declared cast, with the bound `value` spliced back into its
 * `{value}` slot(s). `segments` are the literal parts around those slots,
 * already split and validated at registration — so nothing here interpolates a
 * value into raw SQL, and a template with no slot at all was refused there.
 *
 * A template naming `{value}` more than once binds the value once PER SLOT
 * (`SqlText.param` is a segment, and reusing the fragment emits the segment
 * again). That is the correct reading of a template that needs the value twice,
 * and it keeps every placeholder numbered in document order.
 */
function renderCast(segments: readonly string[], value: SqlText): SqlText {
  const parts: SqlText[] = [];
  segments.forEach((segment, i) => {
    if (i > 0) parts.push(value);
    if (segment !== '') parts.push(SqlText.raw(segment));
  });
  return SqlText.concat(parts);
}

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
   *
   * NO `sensitive` / casing parameter, deliberately. A stored tsvector has
   * ALREADY been folded and stemmed, so an `'exact'` casing is not
   * expressible over one at any price, and `@@` ignores case unconditionally.
   * The base dialect's `LOWER(...)` degrade therefore matches what Postgres
   * does for the same query — honouring a casing here would make the two
   * dialects disagree about one predicate, which is worse than not offering
   * the knob. Narrow the search to a plain text FIELD when case must matter.
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
  /**
   * Build a JSON OBJECT from ordered `key → value` pairs — how a relation's
   * IDENTITY reaches the result boundary (`{ id: 5 }`, `{ tenantId: 3, userId: 1 }`).
   *
   * `json_build_object` is not ANSI, but neither is `json_array_length` which
   * this base dialect already emits for `arrayLength`: the portable dialect is
   * portable-ISH, and degrading a structured value to a concatenated string
   * would be worse than depending on the same JSON support that is already
   * assumed. Dialects with a richer JSON type override this.
   */
  jsonObject(entries: readonly { key: string; value: SqlText }[]): SqlText {
    return SqlText.concat([
      SqlText.raw('json_build_object('),
      SqlText.join(jsonObjectArgs(entries), ', '),
      SqlText.raw(')'),
    ]);
  }

  /**
   * The SQL type for `fieldType` in this dialect — a REFINEMENT's declared `sql`
   * for this dialect when it has one, else the builtin's own mapping.
   *
   * A refinement with no entry for this dialect falls through to the base kind's
   * answer, which is a real answer for a value of the base type — a fallback,
   * not a degrade. That is why this never throws for an unmapped dialect.
   *
   * Asked of the FIELD TYPE rather than of its refinement, because a declared
   * `sql` template may interpolate options the COLUMN carries
   * (`geometry({subtype},{srid})`) — so the answer is per column, and the column
   * is the only thing that has both halves.
   */
  sqlTypeFor(fieldType: FieldType): string {
    return fieldType.refinedSqlType(this.name) ?? this.builtinSqlTypeFor(fieldType);
  }

  /** The BUILTIN per-kind SQL type mapping, before any refinement overrides it. */
  protected abstract builtinSqlTypeFor(fieldType: FieldType): string;

  /**
   * Bind a whole JSON DOCUMENT (an object / array) as ONE parameter, cast to the
   * column type it is destined for. The single binding path for a non-scalar
   * VALUE — a `json` cell, an `array` cell, a document literal in a predicate.
   *
   * WHY A CAST, AND WHY THE FIELD TYPE. The document travels as its JSON TEXT in
   * a normal parameter slot (so `SqlValue` stays scalar and nothing is ever
   * string-interpolated), which means the server must be told what to parse it
   * AS. Left to inference, the same text is a `jsonb` in one column and a syntax
   * error in another. `fieldType` — supplied by the WRITE path, which knows the
   * column — makes that explicit; without it (a bare literal in a `where`, which
   * knows only its own shape) the dialect's own JSON type is the default.
   *
   * The base dialect casts to whatever `sqlTypeFor` names, which is the portable
   * answer for a JSON-typed column. A dialect with a NATIVE array type (Postgres
   * `text[]`) must override — an array literal there is not JSON text.
   *
   * `site` says this is a VALUE position rather than a column, and names who to
   * blame when the target's declared cast cannot honestly be resolved there —
   * see {@link ValueSite} and {@link refuseUnwrittenCast}. Absent ⇒ a COLUMN,
   * which is what the write path is and what every dialect caller predating the
   * rule remains.
   */
  jsonValue(value: JsonValue, fieldType?: FieldType, site?: ValueSite): SqlText {
    const cast = fieldType?.refinedCast(this.name);
    if (cast) {
      if (site && fieldType) refuseUnwrittenCast(fieldType, this.name, site);
      return renderCast(cast, SqlText.param(JSON.stringify(value)));
    }
    return this.builtinJsonValue(value, fieldType, site);
  }

  /**
   * Bind a JSON document the way this dialect does it, before any refinement's
   * declared `cast` template replaces the wrapper. A dialect overrides THIS
   * (Postgres does, for native array columns); {@link jsonValue} stays final so
   * a `cast` declaration is honoured on every dialect rather than on the ones
   * that happened not to override.
   *
   * AN OVERRIDE THAT RECURSES MUST CARRY `site` THROUGH, and that is the whole
   * reason it is a parameter here rather than a flag the caller checks once.
   * Postgres constructs a native array ELEMENT-WISE (`ARRAY[…]::geometry[]`),
   * re-entering `jsonValue` per element with the ITEM's type — so a value
   * position that was refused correctly one level up bound its elements through
   * the item's defaults one level down, which is the same defect reached by the
   * one road the first cut could not see. Measured before the fix: an
   * `array<json as Geometry>` OPERAND with no `with`, handed a Polygon document,
   * emitted `ARRAY[ST_GeomFromGeoJSON($1)::geometry(Point)]::geometry(Point)[]`.
   *
   * THAT REQUIREMENT RESTS ON THIS COMMENT, AND THE ALTERNATIVE WAS WEIGHED.
   * There is no LOUD spelling available: TypeScript lets an override declare
   * FEWER parameters, so making `site` required would not break an existing
   * 2-argument override, and `jsonValue`'s own third argument is optional so a
   * recursing call that drops it still compiles. The genuinely loud shape is to
   * stop depending on override discipline at all — hoist the refusal in
   * {@link jsonValue} to walk `castTargetsOf(fieldType)` (the type, then an
   * array's item, recursively — the walk `checkOperandCastsAreWritable` already
   * owns) BEFORE dispatching, so no dialect can route around it. It is not what
   * ships, because it refuses strictly MORE: an `array<json as …>` whose
   * elements are all scalars binds every element as a bare parameter and reaches
   * no element cast, and hoisting would refuse that emit for a cast that was
   * never going to fire. Refusing a legal statement is worse than a documented
   * requirement on the two dialects in this package, so the requirement is
   * documented — and if a third dialect ever binds containers element-wise, the
   * hoist is the change to make rather than a third copy of this note.
   */
  protected builtinJsonValue(value: JsonValue, fieldType?: FieldType, _site?: ValueSite): SqlText {
    const target = fieldType ? this.sqlTypeFor(fieldType) : this.jsonSqlType();
    return SqlText.concat([
      SqlText.raw('CAST('),
      SqlText.param(JSON.stringify(value)),
      SqlText.raw(` AS ${target})`),
    ]);
  }

  /** This dialect's JSON column type — the default cast target for a document. */
  jsonSqlType(): string {
    return 'json';
  }

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

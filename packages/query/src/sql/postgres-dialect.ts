/**
 * `PostgresDialect` — extends `BaseDialect` with PostgreSQL specifics:
 *  - `$1`, `$2`, … positional placeholders;
 *  - native `ILIKE`;
 *  - `to_tsvector(col) @@ plainto_tsquery(query)` full-text search;
 *  - cosine similarity `1 - (a <=> b)` over a `pgvector` embedding field;
 *  - richer field types (`text`, `jsonb`, `timestamptz`, `numeric`).
 */
import { BaseDialect } from './base-dialect';
import { jsonObjectArgs } from './dialect';
import { SqlText } from './emit';
import type { FieldType } from '../field-type';
import type { JsonValue } from '../schema';
import {
  NumberFieldType,
  TextFieldType,
  TimestampFieldType,
  ArrayFieldType,
} from '../field-types/index';

/** The PostgreSQL dialect: numbered placeholders, `ILIKE`, tsvector search, pgvector similarity, richer types. */
export class PostgresDialect extends BaseDialect {
  /** This dialect's name (`'postgres'`). */
  override readonly name: string = 'postgres';

  /** Postgres numbered placeholders are 1-based. */
  override bindPlaceholder(index: number): string {
    return `$${index + 1}`;
  }

  /** Native case-insensitive pattern match. */
  override ilike(left: SqlText, right: SqlText): SqlText {
    return SqlText.join([left, SqlText.raw('ILIKE'), right], ' ');
  }

  /**
   * Full-text search via the text-search operators (inherently case-folded).
   * A `sensitive` field falls back to an exact-case substring `LIKE`.
   */
  override textSearch(col: SqlText, query: string, sensitive: boolean = false): SqlText {
    if (sensitive) {
      return SqlText.join([col, SqlText.raw('LIKE'), SqlText.param(`%${query}%`)], ' ');
    }
    return SqlText.join(
      [
        SqlText.concat([SqlText.raw('to_tsvector('), col, SqlText.raw(')')]),
        SqlText.raw('@@'),
        SqlText.concat([SqlText.raw('plainto_tsquery('), SqlText.param(query), SqlText.raw(')')]),
      ],
      ' ',
    );
  }

  /** Cosine similarity over a pgvector embedding field (`<=>` = distance). */
  override similarity(a: SqlText, b: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('(1 - ('), a, SqlText.raw(' <=> '), b, SqlText.raw('))')]);
  }

  /**
   * A precomputed-tsvector field matched directly (NOT re-wrapped in
   * `to_tsvector`): `<tsv> @@ plainto_tsquery(<language>, <query>)`, the
   * text-search config defaulting to `'english'`.
   */
  override tsvectorSearch(tsv: SqlText, query: SqlText, language: string = 'english'): SqlText {
    return SqlText.join(
      [
        tsv,
        SqlText.raw('@@'),
        SqlText.concat([SqlText.raw('plainto_tsquery('), tsConfig(language), SqlText.raw(', '), query, SqlText.raw(')')]),
      ],
      ' ',
    );
  }

  /**
   * `jsonb_build_object` rather than the base `json_build_object`: `jsonb` has
   * equality and ordering operators, so a projected identity can also be
   * DISTINCTed or compared, where a `json` value cannot be (Postgres has no
   * equality operator for `json` at all).
   */
  override jsonObject(entries: readonly { key: string; value: SqlText }[]): SqlText {
    return SqlText.concat([
      SqlText.raw('jsonb_build_object('),
      SqlText.join(jsonObjectArgs(entries), ', '),
      SqlText.raw(')'),
    ]);
  }

  /** Postgres stores JSON as `jsonb` (it has the equality / ordering operators `json` lacks). */
  override jsonSqlType(): string {
    return 'jsonb';
  }

  /**
   * Bind a JSON DOCUMENT — with the one Postgres wrinkle that makes the base
   * implementation wrong here: a NATIVE array column (`text[]`, `integer[]`, …)
   * does NOT accept JSON text. `CAST('["a","b"]' AS text[])` is a syntax error,
   * because a Postgres array literal is `{a,b}`.
   *
   * So a document destined for a native array is CONSTRUCTED instead —
   * `ARRAY[$1, $2]::text[]` — with each element bound in its own slot. That
   * reuses the element-binding pattern the array containment operators already
   * use, needs no array-literal encoder (whose quoting / escaping / NULL rules
   * would be their own defect surface), and handles the empty array
   * (`ARRAY[]::text[]`, which Postgres accepts precisely because the cast names
   * the type). Elements recurse, so a `jsonb[]` column takes documents.
   *
   * Everything else — a `json` / `jsonb` column, a heterogeneous array (which
   * `sqlTypeFor` already stores as `jsonb`), or a bare document with no declared
   * target — casts the JSON text to `jsonb`.
   */
  override jsonValue(value: JsonValue, fieldType?: FieldType): SqlText {
    const array = fieldType instanceof ArrayFieldType ? fieldType : undefined;
    const item = array?.item;
    if (array !== undefined && item !== undefined && Array.isArray(value)) {
      const elements = value.map((v) =>
        v !== null && typeof v === 'object' ? this.jsonValue(v, item) : SqlText.param(v),
      );
      return SqlText.concat([
        SqlText.raw('ARRAY['),
        SqlText.join(elements, ', '),
        SqlText.raw(`]::${this.sqlTypeFor(array)}`),
      ]);
    }
    return SqlText.concat([
      SqlText.raw('CAST('),
      SqlText.param(JSON.stringify(value)),
      SqlText.raw(` AS ${this.jsonSqlType()})`),
    ]);
  }

  /** Cast the query param to the pgvector type so `similarity` type-checks (`<param>::vector`). */
  override queryVectorParam(param: SqlText): SqlText {
    return SqlText.concat([param, SqlText.raw('::vector')]);
  }

  /**
   * `ts_rank(to_tsvector(col), plainto_tsquery(query))` — a numeric relevance.
   * A `sensitive` field has no case-folded ranking, so it degrades to a numeric
   * match over the exact-case substring `LIKE` (mirrors `textSearch`).
   */
  override textRank(col: SqlText, query: string, sensitive: boolean = false): SqlText {
    if (sensitive) return this.matchScore(this.textSearch(col, query, true));
    return SqlText.concat([
      SqlText.raw('ts_rank(to_tsvector('),
      col,
      SqlText.raw('), plainto_tsquery('),
      SqlText.param(query),
      SqlText.raw('))'),
    ]);
  }

  /**
   * `ts_rank(<tsv>, plainto_tsquery(<language>, <query>))` over a precomputed
   * tsvector field (NOT re-wrapped in `to_tsvector`), the config defaulting to
   * `'english'`.
   */
  override tsvectorRank(tsv: SqlText, query: SqlText, language: string = 'english'): SqlText {
    return SqlText.concat([
      SqlText.raw('ts_rank('),
      tsv,
      SqlText.raw(', plainto_tsquery('),
      tsConfig(language),
      SqlText.raw(', '),
      query,
      SqlText.raw('))'),
    ]);
  }

  /** Native `LEFT JOIN LATERAL (…) AS alias ON true` (Postgres lateral support). */
  override lateralJoin(subquery: SqlText, alias: string, joinType: 'left' | 'inner'): SqlText {
    return this.lateralJoinWith(subquery, alias, joinType, 'true');
  }

  /** Postgres field types (text / jsonb / timestamptz / numeric). */
  override sqlTypeFor(fieldType: FieldType): string {
    const kind = fieldType.resolve();
    switch (kind) {
      case 'number':
        return fieldType instanceof NumberFieldType && fieldType.options.whole ? 'integer' : 'numeric';
      case 'money':
        return 'numeric(19,4)';
      case 'text':
        return fieldType instanceof TextFieldType && fieldType.options.maxLength !== undefined
          ? `varchar(${fieldType.options.maxLength})`
          : 'text';
      case 'bool':
        return 'boolean';
      case 'date':
        return 'date';
      case 'timestamp':
        return fieldType instanceof TimestampFieldType && fieldType.timezone === false
          ? 'timestamp'
          : 'timestamptz';
      case 'relation':
        return 'text';
      case 'json':
        return 'jsonb';
      case 'array':
        // Native typed array (`text[]`, `integer[]`, …) when the element type
        // is known; `jsonb` for a heterogeneous / unknown-element array.
        return fieldType instanceof ArrayFieldType && fieldType.item
          ? `${this.sqlTypeFor(fieldType.item)}[]`
          : 'jsonb';
      /* v8 ignore next 2 -- defensive: `kind` exhaustively covers ScalarKind */
      default:
        return assertNever(kind);
    }
  }

  // ─── Date-field selectors (native) ───────────────────────────────────────────

  /** Render an inline date-field token as a QUOTED STRING (`date_part('day', …)`). */
  override rawArgLiteral(token: string): SqlText {
    return SqlText.raw(`'${token.replace(/'/g, "''")}'`);
  }

  /**
   * Native Postgres forms of the date-field selectors (the base dialect emits
   * `EXTRACT`-based / degraded forms); everything else defers to the shared
   * `emitBuiltinCall` (bare keywords, `EXTRACT` extractors, `iif`, arrays).
   * The `field` argument arrives pre-quoted via `rawArgLiteral`.
   */
  override emitBuiltinCall(name: string, args: readonly SqlText[]): SqlText | undefined {
    // `date_part('field', d)`.
    if (name === 'datePart' && args.length === 2) {
      return SqlText.concat([SqlText.raw('date_part('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // `(d + (n || ' ' || 'field')::interval)` — n units of field added to d.
    if (name === 'dateAdd' && args.length === 3) {
      return SqlText.concat([
        SqlText.raw('('),
        args[2]!,
        SqlText.raw(' + ('),
        args[1]!,
        SqlText.raw(" || ' ' || "),
        args[0]!,
        SqlText.raw(')::interval)'),
      ]);
    }
    // `(date_part('field', b) - date_part('field', a))` — component difference.
    if (name === 'dateDiff' && args.length === 3) {
      return SqlText.concat([
        SqlText.raw('(date_part('),
        args[0]!,
        SqlText.raw(', '),
        args[2]!,
        SqlText.raw(') - date_part('),
        args[0]!,
        SqlText.raw(', '),
        args[1]!,
        SqlText.raw('))'),
      ]);
    }
    // `date_trunc('field', d)`.
    if (name === 'dateTrunc' && args.length === 2) {
      return SqlText.concat([SqlText.raw('date_trunc('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // ─── Array builtins (native) ──────────────────────────────────────────────
    // `(value = ANY(arr))`.
    if (name === 'arrayContains' && args.length === 2) {
      return SqlText.concat([SqlText.raw('('), args[1]!, SqlText.raw(' = ANY('), args[0]!, SqlText.raw('))')]);
    }
    // `array_append(arr, value)`.
    if (name === 'arrayAppend' && args.length === 2) {
      return SqlText.concat([SqlText.raw('array_append('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // `array_prepend(value, arr)` — pg takes the element FIRST.
    if (name === 'arrayPrepend' && args.length === 2) {
      return SqlText.concat([SqlText.raw('array_prepend('), args[1]!, SqlText.raw(', '), args[0]!, SqlText.raw(')')]);
    }
    // `(a || b)`.
    if (name === 'arrayConcat' && args.length === 2) {
      return SqlText.concat([SqlText.raw('('), args[0]!, SqlText.raw(' || '), args[1]!, SqlText.raw(')')]);
    }
    // `array_position(arr, value)`.
    if (name === 'arrayIndexOf' && args.length === 2) {
      return SqlText.concat([SqlText.raw('array_position('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // `arr[lo:hi]` — 1-based inclusive slice.
    if (name === 'arraySlice' && args.length === 3) {
      return SqlText.concat([args[0]!, SqlText.raw('['), args[1]!, SqlText.raw(':'), args[2]!, SqlText.raw(']')]);
    }
    // `array_remove(arr, value)`.
    if (name === 'arrayRemove' && args.length === 2) {
      return SqlText.concat([SqlText.raw('array_remove('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // `ARRAY(SELECT DISTINCT unnest(arr))`.
    if (name === 'arrayDistinct' && args.length === 1) {
      return SqlText.concat([SqlText.raw('ARRAY(SELECT DISTINCT unnest('), args[0]!, SqlText.raw('))')]);
    }
    // `array_to_string(arr, sep)`.
    if (name === 'arrayToString' && args.length === 2) {
      return SqlText.concat([SqlText.raw('array_to_string('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // `string_to_array(str, sep)`.
    if (name === 'stringToArray' && args.length === 2) {
      return SqlText.concat([SqlText.raw('string_to_array('), args[0]!, SqlText.raw(', '), args[1]!, SqlText.raw(')')]);
    }
    // ─── Aggregate builtins (native) — base degrades these; pg is native. ─────
    if (name === 'boolAnd' && args.length === 1) {
      return SqlText.concat([SqlText.raw('bool_and('), args[0]!, SqlText.raw(')')]);
    }
    if (name === 'boolOr' && args.length === 1) {
      return SqlText.concat([SqlText.raw('bool_or('), args[0]!, SqlText.raw(')')]);
    }
    if (name === 'arrayAgg' && args.length === 1) {
      return SqlText.concat([SqlText.raw('array_agg('), args[0]!, SqlText.raw(')')]);
    }
    return super.emitBuiltinCall(name, args);
  }

  // ─── Array operators (native) ────────────────────────────────────────────────

  /** Postgres `cardinality(arg)`. */
  override arrayLength(arg: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('cardinality('), arg, SqlText.raw(')')]);
  }

  /** `value = ANY(col)`. */
  override arrayHas(col: SqlText, value: SqlText): SqlText {
    return SqlText.concat([value, SqlText.raw(' = ANY('), col, SqlText.raw(')')]);
  }

  /** `col @> ARRAY[e1, e2, …]`. */
  override arrayContains(col: SqlText, elements: readonly SqlText[]): SqlText {
    return SqlText.concat([col, SqlText.raw(' @> '), arrayLiteral(elements)]);
  }

  /** `col && ARRAY[e1, e2, …]`. */
  override arrayOverlaps(col: SqlText, elements: readonly SqlText[]): SqlText {
    return SqlText.concat([col, SqlText.raw(' && '), arrayLiteral(elements)]);
  }
}

/** A Postgres `ARRAY[...]` constructor over already-emitted element fragments. */
function arrayLiteral(elements: readonly SqlText[]): SqlText {
  return SqlText.concat([SqlText.raw('ARRAY['), SqlText.join(elements, ', '), SqlText.raw(']')]);
}

/** A text-search config as a quoted SQL literal (single-quotes doubled). */
function tsConfig(language: string): SqlText {
  return SqlText.raw(`'${language.replace(/'/g, "''")}'`);
}

/* v8 ignore start -- defensive exhaustiveness guard; unreachable for valid ScalarKind */
/** Exhaustiveness guard over `ScalarKind`. */
function assertNever(value: never): never {
  throw new Error(`PostgresDialect.sqlTypeFor: unhandled scalar kind ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

/**
 * `BaseDialect` — a portable ANSI-SQL dialect: `?` placeholders, double-quoted
 * identifiers, `LIKE '%…%'` text search, degraded (constant-0) similarity, and
 * a conservative per-kind field-type mapping. It is the default dialect and
 * the base every other dialect extends.
 */
import { Dialect } from './dialect';
import { SqlText } from './emit';
import { QueryTypeError } from '../problem';
import type { FieldType } from '../field-type';
import {
  NumberFieldType,
  TextFieldType,
  TimestampFieldType,
} from '../field-types/index';

/** The default, portable ANSI-SQL dialect; base class for all other dialects. */
export class BaseDialect extends Dialect {
  /** The canonical dialect name (`'base'`). */
  static readonly NAME = 'base' as const;
  /** This dialect's name (mirrors `BaseDialect.NAME`). */
  readonly name: string = BaseDialect.NAME;

  /** ANSI positional parameter marker. */
  bindPlaceholder(_index: number): string {
    return '?';
  }

  /**
   * ANSI fallback: substring match via `LIKE`. Case-insensitive by default
   * (both sides wrapped in `LOWER`); plain `LIKE` when the field's casing is `'exact'`.
   */
  textSearch(col: SqlText, query: string, sensitive: boolean = false): SqlText {
    if (sensitive) {
      return SqlText.join([col, SqlText.raw('LIKE'), SqlText.param(`%${query}%`)], ' ');
    }
    return SqlText.join(
      [
        SqlText.concat([SqlText.raw('LOWER('), col, SqlText.raw(')')]),
        SqlText.raw('LIKE'),
        SqlText.concat([SqlText.raw('LOWER('), SqlText.param(`%${query}%`), SqlText.raw(')')]),
      ],
      ' ',
    );
  }

  /** No vector support in portable SQL: similarity degrades to a literal 0. */
  similarity(_a: SqlText, _b: SqlText): SqlText {
    return SqlText.raw('0');
  }

  /**
   * No tsvector type in portable SQL: a precomputed-tsvector field degrades to a
   * case-insensitive substring `LIKE` over the field's text (`language` ignored).
   */
  tsvectorSearch(tsv: SqlText, query: SqlText, _language?: string): SqlText {
    return SqlText.join(
      [
        SqlText.concat([SqlText.raw('LOWER('), tsv, SqlText.raw(')')]),
        SqlText.raw('LIKE'),
        SqlText.concat([SqlText.raw("('%' || LOWER("), query, SqlText.raw(") || '%')")]),
      ],
      ' ',
    );
  }

  /** No vector type in portable SQL: the query param passes through unchanged. */
  queryVectorParam(param: SqlText): SqlText {
    return param;
  }

  /** No ranking in portable SQL: degrade to a numeric match over the `LIKE` predicate. */
  textRank(col: SqlText, query: string, sensitive: boolean = false): SqlText {
    return this.matchScore(this.textSearch(col, query, sensitive));
  }

  /** No ranking in portable SQL: degrade to a numeric match over the tsvector degrade (`LIKE`). */
  tsvectorRank(tsv: SqlText, query: SqlText, _language?: string): SqlText {
    return this.matchScore(this.tsvectorSearch(tsv, query));
  }

  /**
   * Map a field type to a portable ANSI field type. Dispatches on the
   * scalar category, refining with concrete-class options where it matters
   * (integer vs decimal, bounded varchar). No casts: each branch narrows via
   * `instanceof`.
   */
  sqlTypeFor(fieldType: FieldType): string {
    const kind = fieldType.resolve();
    switch (kind) {
      case 'number':
        return fieldType instanceof NumberFieldType && fieldType.options.whole ? 'integer' : 'numeric';
      case 'money':
        return 'numeric';
      case 'text':
        return fieldType instanceof TextFieldType && fieldType.options.maxLength !== undefined
          ? `varchar(${fieldType.options.maxLength})`
          : 'varchar';
      case 'bool':
        return 'boolean';
      case 'date':
        return 'date';
      case 'timestamp':
        return fieldType instanceof TimestampFieldType && fieldType.timezone === false
          ? 'timestamp'
          : 'timestamp with time zone';
      case 'relation':
        return 'varchar';
      case 'json':
        return 'json';
      case 'array':
        // ANSI SQL has no portable array type; arrays degrade to a JSON column.
        return 'json';
      /* v8 ignore next 2 -- defensive: `kind` exhaustively covers ScalarKind */
      default:
        return assertNever(kind);
    }
  }

  // ─── Array operators (ANSI degrade) ──────────────────────────────────────────

  /** Element count via `json_array_length` (NULL-safe to 0). */
  arrayLength(arg: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('COALESCE(json_array_length('), arg, SqlText.raw('), 0)')]);
  }

  /** ANSI has no array containment — fail loudly rather than emit wrong SQL. */
  arrayHas(_col: SqlText, _value: SqlText): SqlText {
    throw unsupported('contains');
  }

  /** ANSI has no array containment — fail loudly rather than emit wrong SQL. */
  arrayContains(_col: SqlText, _elements: readonly SqlText[]): SqlText {
    throw unsupported('containsAll');
  }

  /** ANSI has no array overlap — fail loudly rather than emit wrong SQL. */
  arrayOverlaps(_col: SqlText, _elements: readonly SqlText[]): SqlText {
    throw unsupported('containsAny');
  }
}

/** A clear error for an array-containment op the base (ANSI) dialect can't emit. */
function unsupported(op: string): QueryTypeError {
  return new QueryTypeError({
    path: [],
    code: 'array-op.unsupported-dialect',
    severity: 'error',
    message: `Array containment ('${op}') is unsupported in the base (ANSI) dialect; use the postgres dialect (native array operators).`,
  });
}

/* v8 ignore start -- defensive exhaustiveness guard; unreachable for valid ScalarKind */
/** Exhaustiveness guard over `ScalarKind`. */
function assertNever(value: never): never {
  throw new Error(`BaseDialect.sqlTypeFor: unhandled scalar kind ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

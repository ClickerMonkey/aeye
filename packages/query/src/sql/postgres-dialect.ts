/**
 * `PostgresDialect` — extends `BaseDialect` with PostgreSQL specifics:
 *  - `$1`, `$2`, … positional placeholders;
 *  - native `ILIKE`;
 *  - `to_tsvector(col) @@ plainto_tsquery(query)` full-text search;
 *  - cosine similarity `1 - (a <=> b)` over a `pgvector` embedding field;
 *  - richer field types (`text`, `jsonb`, `timestamptz`, `numeric`).
 */
import { BaseDialect } from './base-dialect';
import { SqlText } from './emit';
import type { FieldType } from '../field-type';
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

/* v8 ignore start -- defensive exhaustiveness guard; unreachable for valid ScalarKind */
/** Exhaustiveness guard over `ScalarKind`. */
function assertNever(value: never): never {
  throw new Error(`PostgresDialect.sqlTypeFor: unhandled scalar kind ${JSON.stringify(value)}`);
}
/* v8 ignore stop */

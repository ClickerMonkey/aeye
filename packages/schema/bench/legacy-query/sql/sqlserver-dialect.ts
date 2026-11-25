// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * `SqlServerDialect` — Microsoft SQL Server (2022 and later): `[bracketed]`
 * identifiers, `@p1` placeholders, `OFFSET … ROWS FETCH NEXT … ROWS ONLY`
 * paging (with a neutral `ORDER BY (SELECT NULL)` when the statement has no
 * order), `LOWER … LIKE` for `ILIKE`, `(1 = 1)` / `(1 = 0)` for the boolean
 * constants, emulated `NULLS FIRST|LAST`, JSON through `JSON_OBJECT` and
 * `OPENJSON`, dates through `DATEPART` / `DATEADD` / `DATETRUNC`, and
 * `OUTER|CROSS APPLY` for lateral joins.
 *
 * T-SQL has no boolean value type: a comparison is a predicate, not a value,
 * so a query that projects a predicate as a column (`select a > 1 as big`)
 * emits SQL the server refuses. Filters, joins and `CASE` work as usual.
 */
import { BaseDialect } from './base-dialect';
import { SqlText } from './emit';
import type { FieldType } from '../field-type';
import { NumberFieldType, TextFieldType, TimestampFieldType } from '../field-types/index';
import type { DdlWriter } from '../ddl/writer';
import { SqlServerDdl } from '../ddl/dialects';

/** The `DATEPART` name of each date-field token (`ALLOWED_DATE_FIELDS`). */
const DATEPART: Readonly<Record<string, string>> = {
  year: 'year',
  quarter: 'quarter',
  month: 'month',
  week: 'week',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  second: 'second',
  dow: 'weekday',
  isodow: 'weekday',
  doy: 'dayofyear',
  epoch: 'second',
};

/** The `DATEPART` of each single-argument extractor builtin (`epoch` is handled apart). */
const EXTRACTOR: Readonly<Record<string, string>> = {
  year: 'year',
  month: 'month',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  second: 'second',
  dayOfWeek: 'weekday',
  dayOfYear: 'dayofyear',
  week: 'week',
};

/** Builtins SQL Server spells differently, by name. */
const RENAMED: Readonly<Record<string, string>> = {
  length: 'LEN',
  ceil: 'CEILING',
  ln: 'LOG',
  trimLeft: 'LTRIM',
  trimRight: 'RTRIM',
  stddev: 'STDEV',
  variance: 'VAR',
  stringAgg: 'STRING_AGG',
};

/** The SQL Server dialect. */
export class SqlServerDialect extends BaseDialect {
  /** This dialect's name (`'sqlserver'`). */
  override readonly name: string = 'sqlserver';

  override quoteIdent(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  /** Named placeholders, 1-based, as the `mssql` driver binds them (`request.input('p1', …)`). */
  override bindPlaceholder(index: number): string {
    return `@p${index + 1}`;
  }

  override limitOffset(limit: SqlText | undefined, offset: SqlText | undefined, ordered: boolean = true): SqlText {
    if (!limit && !offset) return SqlText.empty();
    return SqlText.concat([
      SqlText.raw(ordered ? '' : 'ORDER BY (SELECT NULL) '),
      SqlText.raw('OFFSET '),
      offset ?? SqlText.raw('0'),
      SqlText.raw(' ROWS'),
      limit ? SqlText.concat([SqlText.raw(' FETCH NEXT '), limit, SqlText.raw(' ROWS ONLY')]) : SqlText.empty(),
    ]);
  }

  /** No `NULLS FIRST|LAST`: order by a null flag first, then the key. */
  override orderTerm(key: SqlText, dir: 'asc' | 'desc', nulls: 'first' | 'last' | undefined): SqlText {
    const plain = SqlText.concat([key, SqlText.raw(` ${dir.toUpperCase()}`)]);
    if (!nulls) return plain;
    const [isNull, notNull] = nulls === 'first' ? ['0', '1'] : ['1', '0'];
    return SqlText.concat([SqlText.raw('CASE WHEN '), key, SqlText.raw(` IS NULL THEN ${isNull} ELSE ${notNull} END, `), plain]);
  }

  override trueSql(): SqlText {
    return SqlText.raw('(1 = 1)');
  }

  override falseSql(): SqlText {
    return SqlText.raw('(1 = 0)');
  }

  override jsonObject(entries: readonly { key: string; value: SqlText }[]): SqlText {
    const pairs = entries.map((e) => SqlText.concat([SqlText.raw(`'${e.key.replace(/'/g, "''")}': `), e.value]));
    return SqlText.concat([SqlText.raw('JSON_OBJECT('), SqlText.join(pairs, ', '), SqlText.raw(')')]);
  }

  override jsonSqlType(): string {
    return 'nvarchar(max)';
  }

  /** A precomputed text field matched by substring (`+` concatenation, not `||`). */
  override tsvectorSearch(tsv: SqlText, query: SqlText, _language?: string): SqlText {
    return SqlText.concat([SqlText.raw('LOWER('), tsv, SqlText.raw(") LIKE CONCAT('%', LOWER("), query, SqlText.raw("), '%')")]);
  }

  protected override builtinSqlTypeFor(fieldType: FieldType): string {
    switch (fieldType.resolve()) {
      case 'number':
        return fieldType instanceof NumberFieldType && fieldType.options.whole ? 'int' : 'float';
      case 'money':
        return 'decimal(19,4)';
      case 'text':
        return fieldType instanceof TextFieldType && fieldType.options.maxLength !== undefined && fieldType.options.maxLength <= 4000
          ? `nvarchar(${fieldType.options.maxLength})`
          : 'nvarchar(max)';
      case 'bool':
        return 'bit';
      case 'date':
        return 'date';
      case 'timestamp':
        return fieldType instanceof TimestampFieldType && fieldType.timezone === false ? 'datetime2' : 'datetimeoffset';
      default:
        return 'nvarchar(max)';
    }
  }

  override arrayLength(arg: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('(SELECT COUNT(*) FROM OPENJSON('), arg, SqlText.raw('))')]);
  }

  override arrayHas(col: SqlText, value: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('EXISTS (SELECT 1 FROM OPENJSON('), col, SqlText.raw(') WHERE [value] = '), value, SqlText.raw(')')]);
  }

  override arrayContains(col: SqlText, elements: readonly SqlText[]): SqlText {
    if (elements.length === 0) return this.trueSql();
    return SqlText.join(elements.map((e) => this.arrayHas(col, e)), ' AND ').parens();
  }

  override arrayOverlaps(col: SqlText, elements: readonly SqlText[]): SqlText {
    if (elements.length === 0) return this.falseSql();
    return SqlText.concat([SqlText.raw('EXISTS (SELECT 1 FROM OPENJSON('), col, SqlText.raw(') WHERE [value] IN ('), SqlText.join(elements, ', '), SqlText.raw('))')]);
  }

  /** `OUTER APPLY` / `CROSS APPLY`, SQL Server's lateral join. */
  override lateralJoin(subquery: SqlText, alias: string, joinType: 'left' | 'inner'): SqlText {
    return SqlText.concat([SqlText.raw(joinType === 'inner' ? 'CROSS APPLY (' : 'OUTER APPLY ('), subquery, SqlText.raw(') AS '), this.ident(alias)]);
  }

  /** A date-field token as its bare `DATEPART` name. */
  override rawArgLiteral(token: string): SqlText {
    return SqlText.raw(DATEPART[token] ?? 'year');
  }

  override emitBuiltinCall(name: string, args: readonly SqlText[]): SqlText | undefined {
    const call = (fn: string, xs: readonly SqlText[]): SqlText => SqlText.concat([SqlText.raw(`${fn}(`), SqlText.join(xs, ', '), SqlText.raw(')')]);
    if (args.length === 0) {
      if (name === 'currentDate') return SqlText.raw('CAST(GETDATE() AS date)');
      if (name === 'currentTime') return SqlText.raw('CAST(GETDATE() AS time)');
    }
    const part = EXTRACTOR[name];
    if (part && args.length === 1) return call('DATEPART', [SqlText.raw(part), args[0]!]);
    if (name === 'epoch' && args.length === 1) return call('DATEDIFF_BIG', [SqlText.raw("second, '1970-01-01'"), args[0]!]);
    if (name === 'datePart' && args.length === 2) return call('DATEPART', args);
    if (name === 'dateAdd' && args.length === 3) return call('DATEADD', args);
    if (name === 'dateTrunc' && args.length === 2) return call('DATETRUNC', args);
    if (name === 'dateDiff' && args.length === 3) {
      return SqlText.concat([SqlText.raw('('), call('DATEPART', [args[0]!, args[2]!]), SqlText.raw(' - '), call('DATEPART', [args[0]!, args[1]!]), SqlText.raw(')')]);
    }
    if (name === 'mod' && args.length === 2) return SqlText.concat([SqlText.raw('('), args[0]!, SqlText.raw(' % '), args[1]!, SqlText.raw(')')]);
    const renamed = RENAMED[name];
    if (renamed) return call(renamed, args);
    return super.emitBuiltinCall(name, args);
  }

  protected override makeDdl(): DdlWriter {
    return new SqlServerDdl(this);
  }
}

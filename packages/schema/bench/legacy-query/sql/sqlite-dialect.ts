// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * `SqliteDialect` — SQLite: `?` placeholders, double-quoted identifiers,
 * `LIMIT … OFFSET` (with `LIMIT -1` for an offset alone), `LOWER … LIKE` for
 * `ILIKE`, booleans bound as `1` / `0`, JSON through the JSON1 functions
 * (`json_object`, `json_array_length`, `json_each`), dates through `strftime`,
 * and no LATERAL joins.
 */
import { BaseDialect } from './base-dialect';
import { SqlText, type SqlValue } from './emit';
import { QueryTypeError } from '../problem';
import type { FieldType } from '../field-type';
import type { JsonValue } from '../schema';
import type { ValueSite } from './dialect';
import { jsonObjectArgs } from './dialect';
import { NumberFieldType, TextFieldType } from '../field-types/index';
import type { DdlWriter } from '../ddl/writer';
import { SqliteDdl } from '../ddl/dialects';

/** The `strftime` format of each date-field token (`ALLOWED_DATE_FIELDS`). */
const STRFTIME: Readonly<Record<string, string>> = {
  year: '%Y',
  month: '%m',
  week: '%W',
  day: '%d',
  hour: '%H',
  minute: '%M',
  second: '%S',
  dow: '%w',
  isodow: '%u',
  doy: '%j',
  epoch: '%s',
};

/** The date-field token of each single-argument extractor builtin. */
const EXTRACTOR: Readonly<Record<string, string>> = {
  year: 'year',
  month: 'month',
  day: 'day',
  hour: 'hour',
  minute: 'minute',
  second: 'second',
  dayOfWeek: 'dow',
  dayOfYear: 'doy',
  week: 'week',
  epoch: 'epoch',
};

/** Builtins SQLite spells differently, by name. */
const RENAMED: Readonly<Record<string, string>> = {
  substring: 'substr',
  trimLeft: 'ltrim',
  trimRight: 'rtrim',
  stringAgg: 'group_concat',
  power: 'pow',
  indexOf: 'instr',
};

/** The SQLite dialect. */
export class SqliteDialect extends BaseDialect {
  /** This dialect's name (`'sqlite'`). */
  override readonly name: string = 'sqlite';

  /** An offset with no limit needs `LIMIT -1` in SQLite. */
  override limitOffset(limit: SqlText | undefined, offset: SqlText | undefined, ordered: boolean = true): SqlText {
    if (!limit && offset) return super.limitOffset(SqlText.raw('-1'), offset, ordered);
    return super.limitOffset(limit, offset, ordered);
  }

  /** SQLite's driver binds no booleans: `true` / `false` become `1` / `0`. */
  override encodeParam(value: SqlValue): SqlValue {
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }

  override jsonObject(entries: readonly { key: string; value: SqlText }[]): SqlText {
    return SqlText.concat([SqlText.raw('json_object('), SqlText.join(jsonObjectArgs(entries), ', '), SqlText.raw(')')]);
  }

  override jsonSqlType(): string {
    return 'text';
  }

  /** A JSON document is bound as its text and parsed by `json(…)`. */
  protected override builtinJsonValue(value: JsonValue, _fieldType?: FieldType, _site?: ValueSite): SqlText {
    return SqlText.concat([SqlText.raw('json('), SqlText.param(JSON.stringify(value)), SqlText.raw(')')]);
  }

  protected override builtinSqlTypeFor(fieldType: FieldType): string {
    switch (fieldType.resolve()) {
      case 'number':
        return fieldType instanceof NumberFieldType && fieldType.options.whole ? 'integer' : 'real';
      case 'money':
        return 'numeric';
      case 'text':
        return fieldType instanceof TextFieldType && fieldType.options.maxLength !== undefined ? `varchar(${fieldType.options.maxLength})` : 'text';
      case 'bool':
        return 'integer';
      default:
        return 'text';
    }
  }

  override arrayLength(arg: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('COALESCE(json_array_length('), arg, SqlText.raw('), 0)')]);
  }

  /** Membership over a JSON array column through `json_each`. */
  override arrayHas(col: SqlText, value: SqlText): SqlText {
    return SqlText.concat([SqlText.raw('EXISTS (SELECT 1 FROM json_each('), col, SqlText.raw(') WHERE value = '), value, SqlText.raw(')')]);
  }

  override arrayContains(col: SqlText, elements: readonly SqlText[]): SqlText {
    if (elements.length === 0) return this.trueSql();
    return SqlText.join(elements.map((e) => this.arrayHas(col, e)), ' AND ').parens();
  }

  override arrayOverlaps(col: SqlText, elements: readonly SqlText[]): SqlText {
    if (elements.length === 0) return this.falseSql();
    return SqlText.concat([SqlText.raw('EXISTS (SELECT 1 FROM json_each('), col, SqlText.raw(') WHERE value IN ('), SqlText.join(elements, ', '), SqlText.raw('))')]);
  }

  override lateralJoin(_subquery: SqlText, _alias: string, _joinType: 'left' | 'inner'): SqlText {
    throw new QueryTypeError({
      path: [],
      code: 'lateral.unsupported-dialect',
      severity: 'error',
      message: 'SQLite has no LATERAL joins; rewrite the correlated source as a subquery or a join.',
    });
  }

  /** A date-field token as its `strftime` format string. */
  override rawArgLiteral(token: string): SqlText {
    return SqlText.raw(`'${STRFTIME[token] ?? '%Y'}'`);
  }

  override emitBuiltinCall(name: string, args: readonly SqlText[]): SqlText | undefined {
    const part = EXTRACTOR[name];
    if (part && args.length === 1) return strftimeInt(SqlText.raw(`'${STRFTIME[part] ?? '%Y'}'`), args[0]!);
    if (name === 'datePart' && args.length === 2) return strftimeInt(args[0]!, args[1]!);
    if (name === 'dateDiff' && args.length === 3) {
      return SqlText.concat([SqlText.raw('('), strftimeInt(args[0]!, args[2]!), SqlText.raw(' - '), strftimeInt(args[0]!, args[1]!), SqlText.raw(')')]);
    }
    if (name === 'dateTrunc' && args.length === 2) {
      const truncated = dateTrunc(args[0]!, args[1]!);
      if (truncated) return truncated;
    }
    if (name === 'boolAnd' && args.length === 1) return SqlText.concat([SqlText.raw('(MIN(CASE WHEN '), args[0]!, SqlText.raw(' THEN 1 ELSE 0 END) = 1)')]);
    if (name === 'boolOr' && args.length === 1) return SqlText.concat([SqlText.raw('(MAX(CASE WHEN '), args[0]!, SqlText.raw(' THEN 1 ELSE 0 END) = 1)')]);
    if (name === 'arrayAgg' && args.length === 1) return SqlText.concat([SqlText.raw('json_group_array('), args[0]!, SqlText.raw(')')]);
    if (name === 'mod' && args.length === 2) return SqlText.concat([SqlText.raw('('), args[0]!, SqlText.raw(' % '), args[1]!, SqlText.raw(')')]);
    const renamed = RENAMED[name];
    if (renamed) return SqlText.concat([SqlText.raw(`${renamed}(`), SqlText.join(args, ', '), SqlText.raw(')')]);
    return super.emitBuiltinCall(name, args);
  }

  protected override makeDdl(): DdlWriter {
    return new SqliteDdl(this);
  }
}

/**
 * `dateTrunc(field, d)` through SQLite's date modifiers: the start of the year,
 * month, ISO week (Monday) or day, or the hour or minute as a timestamp text.
 * `field` arrives as its `strftime` format (`rawArgLiteral`); undefined for a
 * field it can't truncate to (the base dialect's degrade then applies).
 */
function dateTrunc(field: SqlText, date: SqlText): SqlText | undefined {
  const token = field.segments.length === 1 && field.segments[0]!.kind === 'raw' ? field.segments[0]!.text : '';
  const wrap = (open: string, close: string): SqlText => SqlText.concat([SqlText.raw(open), date, SqlText.raw(close)]);
  switch (token) {
    case "'%Y'":
      return wrap('date(', ", 'start of year')");
    case "'%m'":
      return wrap('date(', ", 'start of month')");
    case "'%W'":
      return wrap('date(', ", '-6 days', 'weekday 1')");
    case "'%d'":
      return wrap('date(', ')');
    case "'%H'":
      return wrap("strftime('%Y-%m-%d %H:00:00', ", ')');
    case "'%M'":
      return wrap("strftime('%Y-%m-%d %H:%M:00', ", ')');
    default:
      return undefined;
  }
}

/** `CAST(strftime(<format>, <date>) AS INTEGER)`. */
function strftimeInt(format: SqlText, date: SqlText): SqlText {
  return SqlText.concat([SqlText.raw('CAST(strftime('), format, SqlText.raw(', '), date, SqlText.raw(') AS INTEGER)')]);
}

/**
 * Coverage: group 2a date/time builtins — runtime (via the uniform scalar
 * dispatch), both-dialect SQL emission (base + postgres), the base degrades
 * (dateAdd/dateTrunc → the date unchanged), and the raw inline-literal FIELD
 * mechanism (emission + validation of the date-field token).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, fixture, typeScope } from './_utils';
import { RuntimeContext } from '../runtime/context';
import { runScalarFunction } from '../runtime/functions';
import type { NamedArgs } from '../runtime/functions';
import { Value } from '../runtime/value';
import type { JsonValue } from '../schema';
import { e } from '../builder';
import type { Expr } from '../expr';

const fx = runtimeFixture();
const ctx = new RuntimeContext(fx.engine);

const call = async (name: string, args: NamedArgs): Promise<JsonValue> =>
  (await runScalarFunction(fx.engine, name, args, ctx)).raw;
const V = (x: JsonValue): Value => Value.of(x);
const baseSql = (expr: Expr): string => fx.engine.exprToSQL(expr, 'base').sql;
const pgSql = (expr: Expr): string => fx.engine.exprToSQL(expr, 'postgres').sql;

// A Sunday afternoon (dow = 0, isodow = 7) with a nonzero time-of-day.
const TS = '2021-03-14T15:26:53Z';
const D = () => e.value('2020-01-01');

describe('2a date/time — runtime datePart + component extractors', () => {
  it('datePart over every supported field token', async () => {
    expect(await call('datePart', { field: V('year'), d: V(TS) })).toBe(2021);
    expect(await call('datePart', { field: V('quarter'), d: V(TS) })).toBe(1);
    expect(await call('datePart', { field: V('month'), d: V(TS) })).toBe(3);
    expect(await call('datePart', { field: V('day'), d: V(TS) })).toBe(14);
    expect(await call('datePart', { field: V('hour'), d: V(TS) })).toBe(15);
    expect(await call('datePart', { field: V('minute'), d: V(TS) })).toBe(26);
    expect(await call('datePart', { field: V('second'), d: V(TS) })).toBe(53);
    expect(await call('datePart', { field: V('dow'), d: V(TS) })).toBe(0); // Sunday
    expect(await call('datePart', { field: V('isodow'), d: V(TS) })).toBe(7); // Sunday → 7
    expect(await call('datePart', { field: V('isodow'), d: V('2021-03-15') })).toBe(1); // Monday → 1
    expect(await call('datePart', { field: V('doy'), d: V(TS) })).toBe(73); // 31+28+14
    expect(await call('datePart', { field: V('week'), d: V('2021-01-04') })).toBe(1); // ISO week 1
    expect(await call('datePart', { field: V('epoch'), d: V(TS) })).toBe(
      Math.floor(Date.parse(TS) / 1000),
    );
  });

  it('datePart null / unparseable date / unknown token → null', async () => {
    expect(await call('datePart', { field: V('year'), d: Value.null() })).toBe(null); // !d
    expect(await call('datePart', { field: V('year'), d: V('not-a-date') })).toBe(null); // toDate NaN
    expect(await call('datePart', { field: V('millennium'), d: V(TS) })).toBe(null); // unknown token
  });

  it('year/month/day/hour/minute/second/dayOfWeek/dayOfYear/week', async () => {
    expect(await call('year', { d: V(TS) })).toBe(2021);
    expect(await call('month', { d: V(TS) })).toBe(3);
    expect(await call('day', { d: V(TS) })).toBe(14);
    expect(await call('hour', { d: V(TS) })).toBe(15);
    expect(await call('minute', { d: V(TS) })).toBe(26);
    expect(await call('second', { d: V(TS) })).toBe(53);
    expect(await call('dayOfWeek', { d: V(TS) })).toBe(0);
    expect(await call('dayOfYear', { d: V(TS) })).toBe(73);
    expect(await call('week', { d: V('2021-01-04') })).toBe(1);
    expect(await call('year', { d: Value.null() })).toBe(null); // dateComponent null path
  });

  it('currentTime / currentTimestamp are well-formed strings', async () => {
    expect(await call('currentTime', {})).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(await call('currentTimestamp', {})).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('2a date/time — runtime arithmetic', () => {
  it('dateAdd over every unit', async () => {
    const at = (field: string, n: number) =>
      call('dateAdd', { field: V(field), n: V(n), d: V('2021-03-14T00:00:00Z') });
    expect(await at('year', 1)).toBe('2022-03-14T00:00:00.000Z');
    expect(await at('quarter', 1)).toBe('2021-06-14T00:00:00.000Z');
    expect(await at('month', 2)).toBe('2021-05-14T00:00:00.000Z');
    expect(await at('week', 1)).toBe('2021-03-21T00:00:00.000Z');
    expect(await at('day', 5)).toBe('2021-03-19T00:00:00.000Z');
    expect(await at('hour', 6)).toBe('2021-03-14T06:00:00.000Z');
    expect(await at('minute', 30)).toBe('2021-03-14T00:30:00.000Z');
    expect(await at('second', 15)).toBe('2021-03-14T00:00:15.000Z');
  });

  it('dateAdd null date / non-interval field → null', async () => {
    expect(await call('dateAdd', { field: V('day'), n: V(1), d: Value.null() })).toBe(null); // !d
    expect(await call('dateAdd', { field: V('dow'), n: V(1), d: V('2021-03-14') })).toBe(null); // addToDate null
  });

  it('dateDiff = component(b) - component(a)', async () => {
    expect(await call('dateDiff', { field: V('year'), a: V('2020-01-01'), b: V('2023-01-01') })).toBe(3);
    expect(await call('dateDiff', { field: V('day'), a: V('2021-03-10'), b: V('2021-03-14') })).toBe(4);
  });

  it('dateDiff null a / null b / unknown token → null', async () => {
    expect(await call('dateDiff', { field: V('year'), a: Value.null(), b: V('2023-01-01') })).toBe(null); // !da
    expect(await call('dateDiff', { field: V('year'), a: V('2020-01-01'), b: Value.null() })).toBe(null); // !db
    expect(await call('dateDiff', { field: V('nope'), a: V('2020-01-01'), b: V('2023-01-01') })).toBe(null); // token
  });

  it('dateTrunc over every unit', async () => {
    const tr = (field: string) => call('dateTrunc', { field: V(field), d: V(TS) });
    expect(await tr('year')).toBe('2021-01-01T00:00:00.000Z');
    expect(await tr('quarter')).toBe('2021-01-01T00:00:00.000Z');
    expect(await tr('month')).toBe('2021-03-01T00:00:00.000Z');
    expect(await tr('week')).toBe('2021-03-08T00:00:00.000Z'); // Monday of the ISO week
    expect(await tr('day')).toBe('2021-03-14T00:00:00.000Z');
    expect(await tr('hour')).toBe('2021-03-14T15:00:00.000Z');
    expect(await tr('minute')).toBe('2021-03-14T15:26:00.000Z');
    expect(await tr('second')).toBe('2021-03-14T15:26:53.000Z');
  });

  it('dateTrunc null date / unknown token → null', async () => {
    expect(await call('dateTrunc', { field: V('month'), d: Value.null() })).toBe(null); // !d
    expect(await call('dateTrunc', { field: V('nope'), d: V(TS) })).toBe(null); // truncToDate null
  });
});

describe('2a date/time — runtime construction / conversion', () => {
  it('makeDate zero-pads its parts', async () => {
    expect(await call('makeDate', { year: V(2021), month: V(3), day: V(7) })).toBe('2021-03-07');
    expect(await call('makeDate', { year: V(5), month: V(12), day: V(31) })).toBe('0005-12-31');
  });

  it('dateFormat tokens (24h, 12h, and null date)', async () => {
    expect(await call('dateFormat', { d: V(TS), format: V('YYYY-MM-DD HH24:MI:SS') })).toBe(
      '2021-03-14 15:26:53',
    );
    expect(await call('dateFormat', { d: V(TS), format: V('HH') })).toBe('03'); // 15h → 12h clock
    expect(await call('dateFormat', { d: V('2021-03-14T00:00:00Z'), format: V('HH') })).toBe('12'); // midnight → 12
    expect(await call('dateFormat', { d: Value.null(), format: V('YYYY') })).toBe(null);
  });

  it('epoch / fromEpoch round-trip and null / NaN', async () => {
    expect(await call('epoch', { ts: V(TS) })).toBe(Math.floor(Date.parse(TS) / 1000));
    expect(await call('epoch', { ts: Value.null() })).toBe(null);
    expect(await call('fromEpoch', { value: V(0) })).toBe('1970-01-01T00:00:00.000Z');
    expect(await call('fromEpoch', { value: Value.null() })).toBe(null); // null
    expect(await call('fromEpoch', { value: V('x') })).toBe(null); // NaN
  });

  it('age = whole-day span a - b', async () => {
    expect(await call('age', { a: V('2021-03-20'), b: V('2021-03-10') })).toBe(10);
    expect(await call('age', { a: Value.null(), b: V('2021-03-10') })).toBe(null); // !da
    expect(await call('age', { a: V('2021-03-20'), b: Value.null() })).toBe(null); // !db
  });
});

describe('2a date/time — SQL (both dialects)', () => {
  it('bare CURRENT_* forms and EXTRACT extractors', () => {
    for (const sql of [baseSql, pgSql]) {
      expect(sql(e.currentTime())).toBe('CURRENT_TIME');
      expect(sql(e.currentTimestamp())).toBe('CURRENT_TIMESTAMP');
      expect(sql(e.year(D()))).toContain('EXTRACT(YEAR FROM ');
      expect(sql(e.month(D()))).toContain('EXTRACT(MONTH FROM ');
      expect(sql(e.day(D()))).toContain('EXTRACT(DAY FROM ');
      expect(sql(e.hour(D()))).toContain('EXTRACT(HOUR FROM ');
      expect(sql(e.minute(D()))).toContain('EXTRACT(MINUTE FROM ');
      expect(sql(e.second(D()))).toContain('EXTRACT(SECOND FROM ');
      expect(sql(e.dayOfWeek(D()))).toContain('EXTRACT(DOW FROM ');
      expect(sql(e.dayOfYear(D()))).toContain('EXTRACT(DOY FROM ');
      expect(sql(e.week(D()))).toContain('EXTRACT(WEEK FROM ');
      expect(sql(e.epoch(D()))).toContain('EXTRACT(EPOCH FROM ');
    }
  });

  it('field selectors: base EXTRACT / degrade vs pg native', () => {
    // datePart — base EXTRACT(<bare field> …), pg date_part('field', …).
    expect(baseSql(e.datePart('day', D()))).toContain('EXTRACT(day FROM ');
    expect(pgSql(e.datePart('day', D()))).toContain("date_part('day', ");
    // dateDiff — base EXTRACT difference, pg date_part difference.
    expect(baseSql(e.dateDiff('day', D(), D()))).toContain('EXTRACT(day FROM ');
    expect(baseSql(e.dateDiff('day', D(), D()))).toContain(' - EXTRACT(day FROM ');
    expect(pgSql(e.dateDiff('day', D(), D()))).toContain("(date_part('day', ");
    // dateTrunc — base DEGRADES to the date unchanged (just the bound param).
    expect(baseSql(e.dateTrunc('day', D()))).toBe('?');
    expect(pgSql(e.dateTrunc('day', D()))).toContain("date_trunc('day', ");
    // dateAdd — base DEGRADES to the date unchanged; pg interval arithmetic.
    expect(baseSql(e.dateAdd('day', e.value(1), D()))).toBe('?');
    expect(pgSql(e.dateAdd('day', e.value(1), D()))).toContain("|| ' ' || 'day')::interval)");
  });

  it('sql-name overrides and generic forms', () => {
    for (const sql of [baseSql, pgSql]) {
      expect(sql(e.makeDate(e.value(2020), e.value(1), e.value(1)))).toContain('make_date(');
      expect(sql(e.dateFormat(D(), e.value('YYYY')))).toContain('to_char(');
      expect(sql(e.fromEpoch(e.value(0)))).toContain('to_timestamp(');
      expect(sql(e.age(D(), D()))).toContain('age(');
    }
  });

  it('placeholders differ by dialect (base ? vs postgres $1)', () => {
    expect(baseSql(e.datePart('day', D()))).toBe('EXTRACT(day FROM ?)');
    expect(pgSql(e.datePart('day', D()))).toBe("date_part('day', $1)");
  });

  it('a non-literal raw field falls back to the param path (no throw)', () => {
    // field is a bound param, not a literal ⇒ orderedArgSql cannot inline it.
    const expr = e.fn('datePart', { field: e.param('f'), d: e.value('2020-01-01') });
    expect(baseSql(expr)).toContain('EXTRACT(');
    expect(pgSql(expr)).toContain('date_part(');
  });

  it('every e.* date builder constructs an emittable call', () => {
    const builders: Expr[] = [
      e.currentTime(),
      e.currentTimestamp(),
      e.datePart('year', D()),
      e.year(D()),
      e.month(D()),
      e.day(D()),
      e.hour(D()),
      e.minute(D()),
      e.second(D()),
      e.dayOfWeek(D()),
      e.dayOfYear(D()),
      e.week(D()),
      e.dateAdd('day', e.value(1), D()),
      e.dateDiff('day', D(), D()),
      e.dateTrunc('day', D()),
      e.makeDate(e.value(2020), e.value(1), e.value(1)),
      e.dateFormat(D(), e.value('YYYY')),
      e.epoch(D()),
      e.fromEpoch(e.value(0)),
      e.age(D(), D()),
    ];
    for (const b of builders) expect(baseSql(b).length).toBeGreaterThan(0);
  });
});

describe('2a date/time — raw field-literal validation', () => {
  const vfx = fixture();

  it('a valid date-field literal validates cleanly', () => {
    const p = vfx.engine.validateExpr(e.datePart('year', e.ref('o', 'id')), typeScope(vfx));
    expect(p.list.some((x) => x.code === 'function.raw-arg')).toBe(false);
  });

  it('an unknown field token is a function.raw-arg problem', () => {
    const expr = e.fn('datePart', { field: e.value('bogus'), d: e.ref('o', 'id') });
    const p = vfx.engine.validateExpr(expr, typeScope(vfx));
    expect(p.list.some((x) => x.code === 'function.raw-arg')).toBe(true);
  });

  it('a non-literal field is a function.raw-arg problem', () => {
    const expr = e.fn('datePart', { field: e.ref('o', 'id'), d: e.ref('o', 'id') });
    const p = vfx.engine.validateExpr(expr, typeScope(vfx));
    expect(p.list.some((x) => x.code === 'function.raw-arg')).toBe(true);
  });

  it('a missing field arg is reported as missing (raw-arg check is skipped)', () => {
    const expr = e.fn('datePart', { d: e.ref('o', 'id') });
    const p = vfx.engine.validateExpr(expr, typeScope(vfx));
    expect(p.list.some((x) => x.code === 'function.missing-arg')).toBe(true);
  });
});

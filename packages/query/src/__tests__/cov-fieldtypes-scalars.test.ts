/**
 * Coverage: scalar field types (number, text, money, bool, date, timestamp,
 * json) — every method + every option branch, accept/reject, kind-mismatch
 * throw, and toJSON/clone round-trips with each optional present/absent.
 */
import { describe, it, expect } from 'vitest';
import {
  NumberFieldType,
  TextFieldType,
  MoneyFieldType,
  BoolFieldType,
  DateFieldType,
  TimestampFieldType,
  JsonFieldType,
  RelationFieldType,
} from '../field-types/index';
import { timezoneSchema } from '../field-types/timestamp';
import { jsonValueSchema } from '../field-types/json';
import {
  numberOptionsSchema,
  compactNumberOptions,
  numberValueSchema,
} from '../field-types/number';

describe('cov number field type', () => {
  it('from valid + kind mismatch throw', () => {
    const ft = NumberFieldType.from({ kind: 'number', min: 0, max: 9, whole: true, minPlaces: 1, maxPlaces: 2 });
    expect(ft.options).toEqual({ min: 0, max: 9, whole: true, minPlaces: 1, maxPlaces: 2 });
    expect(() => NumberFieldType.from({ kind: 'text' })).toThrow(/expected kind 'number'/);
  });

  it('toSchema safeParse accept/reject', () => {
    const s = NumberFieldType.toSchema();
    expect(s.safeParse({ kind: 'number', min: 1 }).success).toBe(true);
    expect(s.safeParse({ kind: 'text' }).success).toBe(false);
  });

  it('resolve / avgBytes', () => {
    const ft = new NumberFieldType();
    expect(ft.resolve()).toBe('number');
    expect(ft.avgBytes()).toBe(8);
  });

  it('toSQLType integer when whole else numeric', () => {
    expect(new NumberFieldType({ whole: true }).toSQLType()).toBe('integer');
    expect(new NumberFieldType({}).toSQLType()).toBe('numeric');
  });

  it('toValueSchema honors whole/min/max', () => {
    const whole = new NumberFieldType({ whole: true, min: 0, max: 10 });
    expect(whole.toValueSchema().safeParse(5).success).toBe(true);
    expect(whole.toValueSchema().safeParse(1.5).success).toBe(false);
    expect(whole.toValueSchema().safeParse(-1).success).toBe(false);
    expect(whole.toValueSchema().safeParse(11).success).toBe(false);
    const plain = new NumberFieldType();
    expect(plain.toValueSchema().safeParse(3.14).success).toBe(true);
    expect(plain.validValue(3)).toBe(true);
    expect(plain.validValue('3')).toBe(false);
  });

  it('comparableWith number/money compatible, text incompatible', () => {
    const n = new NumberFieldType();
    expect(n.comparableWith(new MoneyFieldType())).toBe(true);
    expect(n.comparableWith(new NumberFieldType())).toBe(true);
    expect(n.comparableWith(new TextFieldType())).toBe(false);
  });

  it('toJSON / clone round-trip empty + full', () => {
    expect(new NumberFieldType().toJSON()).toEqual({ kind: 'number' });
    const full = new NumberFieldType({ min: 1, max: 5, whole: false, minPlaces: 0, maxPlaces: 4 });
    expect(full.toJSON()).toEqual({ kind: 'number', min: 1, max: 5, whole: false, minPlaces: 0, maxPlaces: 4 });
    expect(full.clone().toJSON()).toEqual(full.toJSON());
  });

  it('toCode base default returns kind', () => {
    expect(new NumberFieldType().toCode()).toBe('number');
  });

  it('helpers: numberOptionsSchema / compact / numberValueSchema', () => {
    expect(numberOptionsSchema().safeParse({ min: 1 }).success).toBe(true);
    expect(compactNumberOptions({ min: undefined, max: 2, whole: undefined, minPlaces: undefined, maxPlaces: undefined })).toEqual({ max: 2 });
    expect(numberValueSchema({}).safeParse(1.2).success).toBe(true);
    expect(numberValueSchema({ whole: true }).safeParse(1.2).success).toBe(false);
  });
});

describe('cov text field type', () => {
  it('from valid + kind mismatch throw', () => {
    const ft = TextFieldType.from({ kind: 'text', minLength: 1, maxLength: 9, pattern: '^a', semantic: true, search: true, casing: 'exact' });
    expect(ft.options).toEqual({ minLength: 1, maxLength: 9, pattern: '^a', semantic: true, search: true, casing: 'exact' });
    expect(() => TextFieldType.from({ kind: 'bool' })).toThrow(/expected kind 'text'/);
  });

  it('toSchema safeParse', () => {
    expect(TextFieldType.toSchema().safeParse({ kind: 'text', maxLength: 4 }).success).toBe(true);
    expect(TextFieldType.toSchema().safeParse({ kind: 'number' }).success).toBe(false);
  });

  it('textCasing reports the DECLARED casing, and undefined when none is declared', () => {
    expect(new TextFieldType({ casing: 'exact' }).textCasing()).toBe('exact');
    expect(new TextFieldType({ casing: 'collated' }).textCasing()).toBe('collated');
    expect(new TextFieldType({ casing: 'fold' }).textCasing()).toBe('fold');
    // Undeclared is NOT `'fold'`: it means "inherit the engine default", which
    // is what lets a deployment set `'exact'` without every field opting in.
    expect(new TextFieldType({}).textCasing()).toBeUndefined();
  });

  it('resolve / avgBytes bounded + unbounded', () => {
    expect(new TextFieldType().resolve()).toBe('text');
    expect(new TextFieldType().avgBytes()).toBe(32);
    expect(new TextFieldType({ maxLength: 10 }).avgBytes()).toBe(5);
    expect(new TextFieldType({ maxLength: 1 }).avgBytes()).toBe(1);
  });

  it('toSQLType varchar(n) bounded else text', () => {
    expect(new TextFieldType({ maxLength: 20 }).toSQLType()).toBe('varchar(20)');
    expect(new TextFieldType().toSQLType()).toBe('text');
  });

  it('toValueSchema length + pattern', () => {
    const ft = new TextFieldType({ minLength: 2, maxLength: 4, pattern: '^[a-z]+$' });
    expect(ft.toValueSchema().safeParse('abc').success).toBe(true);
    expect(ft.toValueSchema().safeParse('a').success).toBe(false);
    expect(ft.toValueSchema().safeParse('abcde').success).toBe(false);
    expect(ft.toValueSchema().safeParse('AB').success).toBe(false);
  });

  it('toJSON / clone empty + full', () => {
    expect(new TextFieldType().toJSON()).toEqual({ kind: 'text' });
    const full = new TextFieldType({ minLength: 1, maxLength: 2, pattern: 'x', semantic: false, search: false, casing: 'fold' });
    expect(full.toJSON()).toEqual({ kind: 'text', minLength: 1, maxLength: 2, pattern: 'x', semantic: false, search: false, casing: 'fold' });
    expect(full.clone().toJSON()).toEqual(full.toJSON());
  });
});

describe('cov money field type', () => {
  it('from valid (with/without number) + kind mismatch throw', () => {
    expect(MoneyFieldType.from({ kind: 'money' }).options).toEqual({});
    const ft = MoneyFieldType.from({ kind: 'money', number: { min: 0 }, currency: 'USD' });
    expect(ft.options).toEqual({ number: { min: 0 }, currency: 'USD' });
    // a number bag that compacts to empty is dropped
    expect(MoneyFieldType.from({ kind: 'money', number: {} }).options).toEqual({});
    expect(() => MoneyFieldType.from({ kind: 'date' })).toThrow(/expected kind 'money'/);
  });

  it('toSchema safeParse', () => {
    expect(MoneyFieldType.toSchema().safeParse({ kind: 'money', currency: 'EUR' }).success).toBe(true);
    expect(MoneyFieldType.toSchema().safeParse({ kind: 'text' }).success).toBe(false);
  });

  it('resolve / avgBytes / toSQLType', () => {
    const ft = new MoneyFieldType();
    expect(ft.resolve()).toBe('money');
    expect(ft.avgBytes()).toBe(8);
    expect(ft.toSQLType()).toBe('numeric');
  });

  it('toValueSchema with and without number options', () => {
    expect(new MoneyFieldType({ number: { min: 0 } }).toValueSchema().safeParse(-1).success).toBe(false);
    expect(new MoneyFieldType().toValueSchema().safeParse(5).success).toBe(true);
  });

  it('comparableWith number/money', () => {
    expect(new MoneyFieldType().comparableWith(new NumberFieldType())).toBe(true);
    expect(new MoneyFieldType().comparableWith(new BoolFieldType())).toBe(false);
  });

  it('toJSON / clone empty + full (clone keeps + drops number)', () => {
    expect(new MoneyFieldType().toJSON()).toEqual({ kind: 'money' });
    const full = new MoneyFieldType({ number: { min: 0, max: 9 }, currency: 'USD' });
    expect(full.toJSON()).toEqual({ kind: 'money', number: { min: 0, max: 9 }, currency: 'USD' });
    expect(full.clone().toJSON()).toEqual(full.toJSON());
    // clone of a money with no number still round-trips
    const cur = new MoneyFieldType({ currency: 'GBP' });
    expect(cur.clone().toJSON()).toEqual({ kind: 'money', currency: 'GBP' });
  });
});

describe('cov bool field type', () => {
  it('from valid + kind mismatch throw', () => {
    expect(BoolFieldType.from({ kind: 'bool' }).kind).toBe('bool');
    expect(() => BoolFieldType.from({ kind: 'json' })).toThrow(/expected kind 'bool'/);
  });

  it('toSchema / resolve / avgBytes / toSQLType', () => {
    expect(BoolFieldType.toSchema().safeParse({ kind: 'bool' }).success).toBe(true);
    expect(BoolFieldType.toSchema().safeParse({ kind: 'text' }).success).toBe(false);
    const ft = new BoolFieldType();
    expect(ft.resolve()).toBe('bool');
    expect(ft.avgBytes()).toBe(1);
    expect(ft.toSQLType()).toBe('boolean');
  });

  it('toValueSchema accept/reject + validValue', () => {
    const ft = new BoolFieldType();
    expect(ft.toValueSchema().safeParse(true).success).toBe(true);
    expect(ft.toValueSchema().safeParse('x').success).toBe(false);
    expect(ft.validValue(false)).toBe(true);
    expect(ft.validValue(1)).toBe(false);
  });

  it('toJSON / clone', () => {
    expect(new BoolFieldType().toJSON()).toEqual({ kind: 'bool' });
    expect(new BoolFieldType().clone().toJSON()).toEqual({ kind: 'bool' });
    expect(new BoolFieldType().comparableWith(new BoolFieldType())).toBe(true);
  });
});

describe('cov date field type', () => {
  it('from valid + kind mismatch throw', () => {
    expect(DateFieldType.from({ kind: 'date' }).timezone).toBeUndefined();
    expect(DateFieldType.from({ kind: 'date', timezone: 'UTC' }).timezone).toBe('UTC');
    expect(() => DateFieldType.from({ kind: 'timestamp' })).toThrow(/expected kind 'date'/);
  });

  it('toSchema / resolve / avgBytes / toSQLType', () => {
    expect(DateFieldType.toSchema().safeParse({ kind: 'date', timezone: true }).success).toBe(true);
    expect(DateFieldType.toSchema().safeParse({ kind: 'bool' }).success).toBe(false);
    const ft = new DateFieldType();
    expect(ft.resolve()).toBe('date');
    expect(ft.avgBytes()).toBe(4);
    expect(ft.toSQLType()).toBe('date');
  });

  it('toValueSchema accept ISO date / reject junk', () => {
    const ft = new DateFieldType();
    expect(ft.toValueSchema().safeParse('2020-01-01').success).toBe(true);
    expect(ft.toValueSchema().safeParse('nope').success).toBe(false);
  });

  it('comparableWith date/timestamp temporal family', () => {
    expect(new DateFieldType().comparableWith(new TimestampFieldType())).toBe(true);
    expect(new DateFieldType().comparableWith(new NumberFieldType())).toBe(false);
  });

  it('toJSON omits/keeps timezone + clone', () => {
    expect(new DateFieldType().toJSON()).toEqual({ kind: 'date' });
    expect(new DateFieldType(false).toJSON()).toEqual({ kind: 'date', timezone: false });
    expect(new DateFieldType('UTC').clone().toJSON()).toEqual({ kind: 'date', timezone: 'UTC' });
  });
});

describe('cov timestamp field type', () => {
  it('from valid + kind mismatch throw', () => {
    expect(TimestampFieldType.from({ kind: 'timestamp', timezone: false }).timezone).toBe(false);
    expect(() => TimestampFieldType.from({ kind: 'date' })).toThrow(/expected kind 'timestamp'/);
  });

  it('toSchema / resolve / avgBytes', () => {
    expect(TimestampFieldType.toSchema().safeParse({ kind: 'timestamp' }).success).toBe(true);
    expect(TimestampFieldType.toSchema().safeParse({ kind: 'date' }).success).toBe(false);
    const ft = new TimestampFieldType();
    expect(ft.resolve()).toBe('timestamp');
    expect(ft.avgBytes()).toBe(8);
  });

  it('toSQLType timestamp when naive else timestamptz', () => {
    expect(new TimestampFieldType(false).toSQLType()).toBe('timestamp');
    expect(new TimestampFieldType(true).toSQLType()).toBe('timestamptz');
    expect(new TimestampFieldType().toSQLType()).toBe('timestamptz');
  });

  it('toValueSchema accept ISO timestamp / reject date-only', () => {
    const ft = new TimestampFieldType();
    expect(ft.toValueSchema().safeParse('2020-01-01T10:30').success).toBe(true);
    expect(ft.toValueSchema().safeParse('2020-01-01').success).toBe(false);
  });

  it('toJSON omits/keeps timezone + clone', () => {
    expect(new TimestampFieldType().toJSON()).toEqual({ kind: 'timestamp' });
    expect(new TimestampFieldType(true).toJSON()).toEqual({ kind: 'timestamp', timezone: true });
    expect(new TimestampFieldType('UTC').clone().toJSON()).toEqual({ kind: 'timestamp', timezone: 'UTC' });
  });

  it('timezoneSchema accepts string + boolean', () => {
    expect(timezoneSchema().safeParse('UTC').success).toBe(true);
    expect(timezoneSchema().safeParse(true).success).toBe(true);
    expect(timezoneSchema().safeParse(5).success).toBe(false);
  });
});

describe('cov json field type', () => {
  it('from valid + kind mismatch throw', () => {
    expect(JsonFieldType.from({ kind: 'json' }).schema).toBeUndefined();
    expect(JsonFieldType.from({ kind: 'json', schema: { type: 'object' } }).schema).toEqual({ type: 'object' });
    expect(() => JsonFieldType.from({ kind: 'number' })).toThrow(/expected kind 'json'/);
  });

  it('toSchema / resolve / avgBytes / toSQLType', () => {
    expect(JsonFieldType.toSchema().safeParse({ kind: 'json' }).success).toBe(true);
    expect(JsonFieldType.toSchema().safeParse({ kind: 'bool' }).success).toBe(false);
    const ft = new JsonFieldType();
    expect(ft.resolve()).toBe('json');
    expect(ft.avgBytes()).toBe(128);
    expect(ft.toSQLType()).toBe('jsonb');
  });

  it('comparableWith only other json', () => {
    expect(new JsonFieldType().comparableWith(new JsonFieldType())).toBe(true);
    expect(new JsonFieldType().comparableWith(new NumberFieldType())).toBe(false);
  });

  it('toValueSchema accepts arbitrary json', () => {
    const ft = new JsonFieldType();
    expect(ft.toValueSchema().safeParse({ a: [1, 'x', false, null] }).success).toBe(true);
    expect(ft.validValue('plain string')).toBe(true);
  });

  it('toJSON omits/keeps schema + clone is independent deep copy', () => {
    expect(new JsonFieldType().toJSON()).toEqual({ kind: 'json' });
    const full = new JsonFieldType({ nested: { a: 1 } });
    expect(full.toJSON()).toEqual({ kind: 'json', schema: { nested: { a: 1 } } });
    const clone = full.clone();
    expect(clone.toJSON()).toEqual(full.toJSON());
    // cloned schema is a deep copy, not the same reference
    expect(clone.schema).not.toBe(full.schema);
    // a clone of an undefined-schema json stays undefined
    expect(new JsonFieldType().clone().schema).toBeUndefined();
  });

  it('jsonValueSchema standalone', () => {
    expect(jsonValueSchema().safeParse([1, { a: 'b' }]).success).toBe(true);
    expect(jsonValueSchema().safeParse(undefined).success).toBe(false);
  });
});

describe('cov relation field type', () => {
  it('from valid + kind mismatch throw', () => {
    const ft = RelationFieldType.from({ kind: 'relation', to: 'User', count: 1, inverseRelation: 'orders' });
    expect(ft.to).toBe('User');
    expect(ft.count).toBe(1);
    expect(ft.inverseRelation).toBe('orders');
    expect(() => RelationFieldType.from({ kind: 'bool' })).toThrow(/expected kind 'relation'/);
  });

  it('toSchema / resolve / avgBytes / toSQLType', () => {
    expect(RelationFieldType.toSchema().safeParse({ kind: 'relation', to: 'X', count: 1 }).success).toBe(true);
    expect(RelationFieldType.toSchema().safeParse({ kind: 'relation' }).success).toBe(false);
    const ft = new RelationFieldType('X', 1);
    expect(ft.resolve()).toBe('relation');
    expect(ft.avgBytes()).toBe(16);
    expect(ft.toSQLType()).toBe('text');
  });

  it('comparableWith same target only', () => {
    const a = new RelationFieldType('A', 1);
    expect(a.comparableWith(new RelationFieldType('A', 5))).toBe(true);
    expect(a.comparableWith(new RelationFieldType('B', 1))).toBe(false);
    expect(a.comparableWith(new NumberFieldType())).toBe(false);
  });

  it('toValueSchema is a string id', () => {
    expect(new RelationFieldType('X', 1).toValueSchema().safeParse('id-1').success).toBe(true);
    expect(new RelationFieldType('X', 1).toValueSchema().safeParse(5).success).toBe(false);
  });

  it('toJSON omits inverseVia, keeps inverseRelation; clone preserves inverseVia', () => {
    expect(new RelationFieldType('X', 1).toJSON()).toEqual({ kind: 'relation', to: 'X', count: 1 });
    const withInv = new RelationFieldType('X', 5, 'children', 'parentId');
    expect(withInv.toJSON()).toEqual({ kind: 'relation', to: 'X', count: 5, inverseRelation: 'children' });
    const clone = withInv.clone();
    expect(clone.inverseVia).toBe('parentId');
    expect(clone.toJSON()).toEqual(withInv.toJSON());
  });
});

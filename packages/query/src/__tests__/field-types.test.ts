import { describe, it, expect } from 'vitest';
import { createRegistry, Registry } from '../registry';
import { QueryTypeError } from '../problem';
import type { FieldTypeDef } from '../schema';
import {
  BUILTIN_FIELD_TYPES,
  NumberFieldType,
  RelationFieldType,
} from '../field-types/index';

const registry = createRegistry();

describe('field-types: from → toJSON round-trip', () => {
  const cases: FieldTypeDef[] = [
    { kind: 'number' },
    { kind: 'number', min: 0, max: 100, whole: true },
    { kind: 'text' },
    { kind: 'text', minLength: 1, maxLength: 64, pattern: '^[a-z]+$', semantic: true, search: true, casing: 'exact' },
    { kind: 'money' },
    { kind: 'money', number: { min: 0, whole: false }, currency: 'USD' },
    { kind: 'bool' },
    { kind: 'relation', to: 'User', count: 5 },
    { kind: 'date' },
    { kind: 'date', timezone: 'America/New_York' },
    { kind: 'timestamp' },
    { kind: 'timestamp', timezone: true },
    { kind: 'json' },
    { kind: 'json', schema: { type: 'object' } },
  ];

  for (const def of cases) {
    it(`round-trips ${JSON.stringify(def)}`, () => {
      const ft = registry.parseFieldType(def);
      expect(ft.toJSON()).toEqual(def);
      // clone is deep-equal and independent
      expect(ft.clone().toJSON()).toEqual(def);
    });
  }
});

describe('field-types: registry wiring', () => {
  it('registers all 9 built-ins', () => {
    expect(registry.fieldTypeClassList()).toHaveLength(9);
    expect(BUILTIN_FIELD_TYPES).toHaveLength(9);
  });

  it('throws when a kind is not registered', () => {
    // A fresh registry has no field types registered, so even a valid def
    // dispatches to nothing — exercising the unknown-kind throw path
    // without any type-assertion cast.
    const empty = new Registry();
    expect(() => empty.parseFieldType({ kind: 'number' })).toThrow();
  });
});

describe('field-types: toValueSchema accept / reject', () => {
  it('number honors whole + bounds', () => {
    const ft = registry.parseFieldType({ kind: 'number', min: 0, whole: true });
    const s = ft.toValueSchema();
    expect(s.safeParse(5).success).toBe(true);
    expect(s.safeParse(-1).success).toBe(false);
    expect(s.safeParse(1.5).success).toBe(false);
    expect(ft.validValue(3)).toBe(true);
    expect(ft.validValue('3')).toBe(false);
  });

  it('text honors length + pattern', () => {
    const ft = registry.parseFieldType({ kind: 'text', minLength: 2, pattern: '^[a-z]+$' });
    const s = ft.toValueSchema();
    expect(s.safeParse('abc').success).toBe(true);
    expect(s.safeParse('a').success).toBe(false);
    expect(s.safeParse('AB').success).toBe(false);
  });

  it('money validates the underlying amount', () => {
    const ft = registry.parseFieldType({ kind: 'money', number: { min: 0 } });
    expect(ft.toValueSchema().safeParse(10).success).toBe(true);
    expect(ft.toValueSchema().safeParse(-1).success).toBe(false);
  });

  it('bool', () => {
    const ft = registry.parseFieldType({ kind: 'bool' });
    expect(ft.toValueSchema().safeParse(true).success).toBe(true);
    expect(ft.toValueSchema().safeParse('x').success).toBe(false);
  });

  it('date vs timestamp', () => {
    const date = registry.parseFieldType({ kind: 'date' });
    const ts = registry.parseFieldType({ kind: 'timestamp' });
    expect(date.toValueSchema().safeParse('2020-01-01').success).toBe(true);
    expect(date.toValueSchema().safeParse('nope').success).toBe(false);
    expect(ts.toValueSchema().safeParse('2020-01-01T10:30').success).toBe(true);
    expect(ts.toValueSchema().safeParse('2020-01-01').success).toBe(false);
  });

  it('json accepts arbitrary JSON', () => {
    const ft = registry.parseFieldType({ kind: 'json' });
    expect(ft.toValueSchema().safeParse({ a: 1, b: [1, 2, 3] }).success).toBe(true);
    expect(ft.toValueSchema().safeParse([1, 'two', false]).success).toBe(true);
  });
});

describe('field-types: avgBytes / resolve', () => {
  it('avgBytes positive for every kind', () => {
    const defs: FieldTypeDef[] = [
      { kind: 'number' },
      { kind: 'text' },
      { kind: 'money' },
      { kind: 'bool' },
      { kind: 'relation', to: 'X', count: 1 },
      { kind: 'date' },
      { kind: 'timestamp' },
      { kind: 'json' },
    ];
    for (const def of defs) {
      expect(registry.parseFieldType(def).avgBytes()).toBeGreaterThan(0);
    }
  });

  it('resolve categories + numeric comparability', () => {
    const num = new NumberFieldType();
    const money = registry.parseFieldType({ kind: 'money' });
    expect(num.resolve()).toBe('number');
    expect(money.resolve()).toBe('money');
    // number and money are mutually comparable (numeric family)
    expect(num.comparableWith(money)).toBe(true);
    // relation only comparable to same target
    const rA = new RelationFieldType('A', 1);
    const rB = new RelationFieldType('B', 1);
    expect(rA.comparableWith(new RelationFieldType('A', 5))).toBe(true);
    expect(rA.comparableWith(rB)).toBe(false);
  });
});

/**
 * An uncompilable `pattern` is a defect in the DECLARATION, so it is refused
 * where the declaration is read — not at whichever use happens to compile it
 * first.
 *
 * It used to be accepted and INERT: `toValueSchema()` compiles the regex only
 * when no closed set is declared, so a column declaring BOTH carried `'(['` with
 * nothing ever noticing. The param MEET then compiles it (it narrows a merged
 * set by the merged constraints), which turned a def `parseType` had accepted
 * into a raw `SyntaxError` thrown out of `validateQuery` / `params()` — from a
 * package whose entire contract is that diagnostics come back as `Problems`.
 * Two param uses on such a column was the whole reproduction.
 */
describe('field-types: a text `pattern` must be a compilable regex', () => {
  const bad: FieldTypeDef = { kind: 'text', pattern: '([', values: [{ value: 'a' }] };

  it('is refused when the field type is parsed, as a coded QueryTypeError', () => {
    try {
      registry.parseFieldType(bad);
      expect.unreachable('parseFieldType should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryTypeError);
      if (err instanceof QueryTypeError) {
        expect(err.problem.code).toBe('field-type.bad-pattern');
        expect(err.problem.path).toEqual(['pattern']);
        expect(err.problem.message).toContain('not a valid regular expression');
      }
    }
  });

  it('is refused at parseType, so no query path can reach the uncompilable regex', () => {
    const r = createRegistry();
    expect(() =>
      r.parseType({
        name: 'doc',
        fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'code', type: bad }],
        count: 1,
        bytes: 8,
      }),
    ).toThrow(/not a valid regular expression/);
  });

  it('still accepts every VALID pattern, closed set or not', () => {
    expect(registry.parseFieldType({ kind: 'text', pattern: '^[a-z]+$' }).toJSON()).toEqual({
      kind: 'text',
      pattern: '^[a-z]+$',
    });
    expect(
      registry.parseFieldType({ kind: 'text', pattern: '^a', values: [{ value: 'ab' }] }).validValue('ab'),
    ).toBe(true);
  });
});

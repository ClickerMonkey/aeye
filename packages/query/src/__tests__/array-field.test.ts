/**
 * ArrayFieldType — JSON round-trip (incl. nested `item`), value-schema
 * accept/reject on min/max + element type, byte estimate, comparability, and
 * `inferType` over an array column.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import type { FieldTypeDef } from '../schema';
import {
  ArrayFieldType,
  TextFieldType,
  NumberFieldType,
} from '../field-types/index';
import { inferType } from '../util/infer-type';

const registry = createRegistry();

describe('array field type: from → toJSON round-trip', () => {
  const cases: FieldTypeDef[] = [
    { kind: 'array' },
    { kind: 'array', minItems: 1 },
    { kind: 'array', maxItems: 5 },
    { kind: 'array', minItems: 1, maxItems: 3, item: { kind: 'text', maxLength: 10 } },
    { kind: 'array', item: { kind: 'number', whole: true } },
    // Nested array-of-array.
    { kind: 'array', item: { kind: 'array', item: { kind: 'number' } } },
  ];

  for (const def of cases) {
    it(`round-trips ${JSON.stringify(def)}`, () => {
      const ft = registry.parseFieldType(def);
      expect(ft.toJSON()).toEqual(def);
      // clone is deep-equal and independent.
      expect(ft.clone().toJSON()).toEqual(def);
    });
  }

  it('parses a typed item into a FieldType instance', () => {
    const ft = registry.parseFieldType({ kind: 'array', item: { kind: 'text' } });
    expect(ft).toBeInstanceOf(ArrayFieldType);
    if (ft instanceof ArrayFieldType) {
      expect(ft.item).toBeInstanceOf(TextFieldType);
      expect(ft.resolve()).toBe('array');
    }
  });
});

describe('array field type: toValueSchema accept / reject', () => {
  it('honors min/max item counts', () => {
    const ft = registry.parseFieldType({ kind: 'array', minItems: 1, maxItems: 3, item: { kind: 'text' } });
    const s = ft.toValueSchema();
    expect(s.safeParse(['a']).success).toBe(true);
    expect(s.safeParse(['a', 'b', 'c']).success).toBe(true);
    expect(s.safeParse([]).success).toBe(false); // below minItems
    expect(s.safeParse(['a', 'b', 'c', 'd']).success).toBe(false); // above maxItems
  });

  it('validates each element against the item type', () => {
    const ft = registry.parseFieldType({ kind: 'array', item: { kind: 'number' } });
    expect(ft.validValue([1, 2, 3])).toBe(true);
    expect(ft.validValue([1, 'two'])).toBe(false);
    expect(ft.validValue('not-an-array')).toBe(false);
  });

  it('accepts heterogeneous elements when item is absent', () => {
    const ft = registry.parseFieldType({ kind: 'array' });
    expect(ft.validValue([1, 'two', true, null, { a: 1 }])).toBe(true);
    expect(ft.validValue([])).toBe(true);
    expect(ft.validValue(5)).toBe(false);
  });
});

describe('array field type: comparability + bytes', () => {
  it('compares only with other arrays (and compatible items)', () => {
    const textArr = new ArrayFieldType(new TextFieldType());
    const textArr2 = new ArrayFieldType(new TextFieldType());
    const numArr = new ArrayFieldType(new NumberFieldType());
    const untyped = new ArrayFieldType();
    expect(textArr.comparableWith(textArr2)).toBe(true);
    expect(textArr.comparableWith(numArr)).toBe(false);
    expect(textArr.comparableWith(untyped)).toBe(true); // unknown item is permissive
    expect(textArr.comparableWith(new TextFieldType())).toBe(false);
  });

  it('estimates a positive average byte size', () => {
    const ft = new ArrayFieldType(new TextFieldType({ maxLength: 8 }), 2, 4);
    expect(ft.avgBytes()).toBeGreaterThan(0);
    expect(new ArrayFieldType().avgBytes()).toBeGreaterThan(0);
  });
});

describe('array field type: inferType over an array column', () => {
  it('infers an array<text> field from string-array samples', () => {
    const def = inferType('post', [
      { id: 1, tags: ['a', 'b'] },
      { id: 2, tags: ['c'] },
      { id: 3, tags: [] },
    ]);
    const tags = def.fields.find((f) => f.name === 'tags');
    expect(tags?.type).toEqual({ kind: 'array', item: { kind: 'text', maxLength: 1 } });
  });

  it('infers array<number> and omits item for empty-only arrays', () => {
    const nums = inferType('n', [{ xs: [1, 2] }, { xs: [3] }]);
    expect(nums.fields[0]?.type).toEqual({ kind: 'array', item: { kind: 'number', whole: true } });

    const empties = inferType('e', [{ xs: [] }, { xs: [] }]);
    expect(empties.fields[0]?.type).toEqual({ kind: 'array' });
  });

  it('falls back to json when a column mixes arrays with scalars', () => {
    const mixed = inferType('m', [{ v: [1, 2] }, { v: 'scalar' }]);
    expect(mixed.fields[0]?.type).toEqual({ kind: 'json' });
  });
});

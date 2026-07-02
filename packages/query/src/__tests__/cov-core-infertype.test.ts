/**
 * Coverage: inferType — every inference rule + nullability + count/bytes edges.
 */
import { describe, it, expect } from 'vitest';
import { inferType } from '../util/infer-type';

const typeOf = (rows: Record<string, unknown>[], field = 'v') =>
  inferType('t', rows as never).fields.find((f) => f.name === field)!;

describe('inferType field-type inference', () => {
  it('bool / whole / fractional number', () => {
    expect(typeOf([{ v: true }, { v: false }]).type).toEqual({ kind: 'bool' });
    expect(typeOf([{ v: 1 }, { v: 2 }]).type).toEqual({ kind: 'number', whole: true });
    expect(typeOf([{ v: 1 }, { v: 2.5 }]).type).toEqual({ kind: 'number' });
  });

  it('date / timestamp / date+timestamp mix', () => {
    expect(typeOf([{ v: '2020-01-02' }]).type).toEqual({ kind: 'date' });
    expect(typeOf([{ v: '2020-01-02T03:04:05' }]).type).toEqual({ kind: 'timestamp' });
    expect(typeOf([{ v: '2020-01-02' }, { v: '2020-01-02T03:04:05' }]).type).toEqual({ kind: 'timestamp' });
  });

  it('text with + without maxLength', () => {
    expect(typeOf([{ v: 'hello' }]).type).toEqual({ kind: 'text', maxLength: 5 });
    expect(typeOf([{ v: '' }]).type).toEqual({ kind: 'text' }); // empty → no maxLength
  });

  it('arrays: with element type + empty', () => {
    expect(typeOf([{ v: ['a', 'b'] }]).type).toEqual({ kind: 'array', item: { kind: 'text', maxLength: 1 } });
    expect(typeOf([{ v: [] }]).type).toEqual({ kind: 'array' });
  });

  it('json object; mixed containing json/array → json', () => {
    expect(typeOf([{ v: { a: 1 } }]).type).toEqual({ kind: 'json' });
    expect(typeOf([{ v: 1 }, { v: { a: 1 } }]).type).toEqual({ kind: 'json' }); // int + json
    expect(typeOf([{ v: 1 }, { v: [1] }]).type).toEqual({ kind: 'json' }); // int + array
  });

  it('mixed scalar kinds fall back to text (length or bare)', () => {
    expect(typeOf([{ v: 1 }, { v: 'abc' }]).type).toEqual({ kind: 'text', maxLength: 3 });
    expect(typeOf([{ v: 1 }, { v: '' }]).type).toEqual({ kind: 'text' }); // no positive length
  });

  it('all-null / missing field → nullable text', () => {
    const def = typeOf([{ v: null }, {}]);
    expect(def.type).toEqual({ kind: 'text' });
    expect(def.nullable).toBe(true);
  });
});

describe('inferType Type-level metadata', () => {
  it('empty input yields 0 bytes; sampleSize caps the scan', () => {
    const empty = inferType('t', []);
    expect(empty.bytes).toBe(0);
    expect(empty.count).toBe(0);
    const capped = inferType('t', [{ a: 1 }, { a: 2 }, { a: 3 }] as never, { sampleSize: 1, label: 'L', description: 'D' });
    expect(capped.label).toBe('L');
    expect(capped.description).toBe('D');
    expect(capped.count).toBe(3); // count is over ALL rows
    expect(capped.bytes).toBeGreaterThan(0);
  });
});

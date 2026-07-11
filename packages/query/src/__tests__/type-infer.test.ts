import { describe, it, expect } from 'vitest';
import { inferType } from '../util/infer-type';
import { createRegistry } from '../registry';
import type { FieldTypeDef, JsonValue } from '../schema';

const registry = createRegistry();

/** Find a field's inferred type def by name. */
function fieldType(rows: ReadonlyArray<Record<string, JsonValue>>, name: string): FieldTypeDef {
  const def = inferType('Sample', rows);
  const field = def.fields.find((f) => f.name === name);
  if (!field) throw new Error(`no field ${name}`);
  return field.type;
}

describe('inferType', () => {
  const rows: Array<Record<string, JsonValue>> = [
    { id: 1, name: 'Ann', active: true, joined: '2020-01-02', seen: '2020-01-02T08:30:00', score: 9.5, meta: { a: 1 } },
    { id: 2, name: 'Bob', active: false, joined: '2021-05-06', seen: '2021-05-06T12:00:00', score: 3, meta: { b: 2 } },
    { id: 3, name: 'Cy', active: true, joined: '2022-09-10', seen: '2022-09-10T23:59:00', score: 7.1, meta: { c: 3 } },
  ];

  it('infers integer vs float number', () => {
    expect(fieldType(rows, 'id')).toEqual({ kind: 'number', whole: true });
    expect(fieldType(rows, 'score')).toEqual({ kind: 'number' });
  });

  it('infers bool', () => {
    expect(fieldType(rows, 'active')).toEqual({ kind: 'bool' });
  });

  it('infers date vs timestamp from ISO strings', () => {
    expect(fieldType(rows, 'joined')).toEqual({ kind: 'date' });
    expect(fieldType(rows, 'seen')).toEqual({ kind: 'timestamp' });
  });

  it('infers text with maxLength', () => {
    const t = fieldType(rows, 'name');
    expect(t.kind).toBe('text');
    if (t.kind === 'text') expect(t.maxLength).toBe(3); // 'Ann'/'Bob'/'Cy' → longest 3
  });

  it('infers json for objects', () => {
    expect(fieldType(rows, 'meta')).toEqual({ kind: 'json' });
  });

  it('marks fields nullable when null or missing', () => {
    const nullableRows: Array<Record<string, JsonValue>> = [
      { a: 1, b: 'x' },
      { a: null, b: 'y' }, // a explicitly null
      { b: 'z' },          // a missing
    ];
    const def = inferType('N', nullableRows);
    const a = def.fields.find((f) => f.name === 'a');
    const b = def.fields.find((f) => f.name === 'b');
    expect(a?.nullable).toBe(true);
    expect(b?.nullable).toBeUndefined(); // never null/missing
    expect(a?.type).toEqual({ kind: 'number', whole: true });
  });

  it('estimates count and bytes', () => {
    const def = inferType('Sample', rows);
    expect(def.count).toBe(3);
    expect(def.bytes).toBeGreaterThan(0);
  });

  it('produces a TypeDef the registry can parse', () => {
    const def = inferType('Sample', rows, { label: 'Samples' });
    const type = registry.parseType(def);
    expect(type.name).toBe('Sample');
    expect(type.label).toBe('Samples');
    expect(type.field('id')?.fieldType.resolve()).toBe('number');
    // Round-trips back to an equivalent def.
    expect(type.toJSON()).toEqual(def);
  });
});

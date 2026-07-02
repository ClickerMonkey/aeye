/**
 * Self-describing results (Feature 1): every `QueryResult.fields` entry carries
 * the JSON-friendly summary metadata (`name` + `fieldType` + `nullable`) derived
 * from its full `ResolvedType`, and `run(q, ctx, { rows: 'array' })` returns
 * positional arrays aligned to `fields`. Also covers the `toArrayRows` helper.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { toArrayRows } from '../queries/index';
import type { SelectDef } from '../schema';

describe('result fields metadata', () => {
  it('carries name + fieldType + nullable for plain, computed, and aggregate fields', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        // A plain non-nullable field.
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        // A plain nullable field (`age` is declared nullable in the fixture).
        { expr: { kind: 'field-ref', source: 'user', field: 'age' }, as: 'age' },
        // A computed expr over a non-nullable field → non-nullable number.
        {
          expr: {
            kind: 'binary',
            op: '*',
            left: { kind: 'field-ref', source: 'user', field: 'id' },
            right: { kind: 'literal', value: 2 },
          },
          as: 'doubled',
        },
      ],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);

    expect(result.fields.map((f) => f.name)).toEqual(['name', 'age', 'doubled']);
    // Summary metadata derived from each field's ResolvedType.
    expect(result.fields.map((f) => f.fieldType)).toEqual(['text', 'number', 'number']);
    expect(result.fields.map((f) => f.nullable)).toEqual([false, true, false]);
    // The full ResolvedType is still present alongside the summary.
    expect(result.fields[0]!.type.kind).toBe('field');
    expect(result.fields[2]!.type.kind).toBe('computed');
  });

  it('reports an aggregate field as a non-nullable number', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'orders' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    const orders = result.fields.find((f) => f.name === 'orders')!;
    expect(orders.fieldType).toBe('number');
    expect(orders.nullable).toBe(false);
    expect(orders.type.kind).toBe('computed');
  });

  it('run with { rows: "array" } returns positional arrays aligned to fields', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
      ],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
    };

    const objResult = await fx.engine.run(def);
    const arrResult = await fx.engine.run(def, undefined, { rows: 'array' });

    // Same fields, rows transposed to positional arrays in `fields` order.
    expect(arrResult.fields.map((f) => f.name)).toEqual(['id', 'name']);
    expect(arrResult.rows).toEqual([
      [1, 'Ada'],
      [2, 'Bob'],
      [3, 'Cleo'],
    ]);
    // The array form is just the object form, transposed.
    expect(arrResult.rows).toEqual(toArrayRows(objResult.fields, objResult.rows));
  });

  it('toArrayRows round-trips and substitutes null for absent fields', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
      ],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);

    // Round-trip: the helper produces the same positional arrays as the result.
    expect(toArrayRows(result.fields, result.rows)).toEqual([
      [1, 'Ada'],
      [2, 'Bob'],
      [3, 'Cleo'],
    ]);
    // A field present in `fields` but absent from a row becomes null, and every
    // inner array has exactly `fields.length` entries.
    expect(toArrayRows(result.fields, [{ id: 9 }])).toEqual([[9, null]]);
  });
});

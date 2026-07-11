import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { inferType } from '../util/infer-type';
import { Field } from '../field';
import { NumberFieldType } from '../field-types/index';
import type { JsonValue } from '../schema';
import {
  asFieldType,
  isScalar,
  isType,
  sourcesOf,
  widenNullable,
  type ComputedResolved,
  type FieldResolved,
  type ResolvedType,
  type TypeResolved,
} from '../resolved-type';

const registry = createRegistry();

const rows: Array<Record<string, JsonValue>> = [
  { id: 1, total: 9.5 },
  { id: 2, total: 3.0 },
];
const userType = registry.parseType(inferType('User', rows));

const typeR: TypeResolved = { kind: 'type', type: userType, source: 'u', synthetic: false };
const fieldR: FieldResolved = {
  kind: 'field',
  field: userType.field('total')!,
  type: userType,
  source: 'u',
  nullable: false,
};
const computedR: ComputedResolved = {
  kind: 'computed',
  fieldType: new NumberFieldType(),
  sources: [fieldR],
  nullable: false,
  aggregate: true,
};

describe('resolved-type helpers', () => {
  it('asFieldType is total across variants', () => {
    expect(asFieldType(typeR)).toBeUndefined();
    expect(asFieldType(fieldR)?.resolve()).toBe('number');
    expect(asFieldType(computedR)?.resolve()).toBe('number');
  });

  it('sourcesOf returns the right backing fields', () => {
    expect(sourcesOf(typeR)).toEqual([]);
    expect(sourcesOf(fieldR)).toEqual([fieldR]);
    expect(sourcesOf(computedR)).toEqual([fieldR]);
  });

  it('widenNullable forces nullability for scalars, leaves types alone', () => {
    expect(widenNullable(typeR)).toBe(typeR); // unchanged identity
    const wf = widenNullable(fieldR);
    expect(wf.kind).toBe('field');
    if (wf.kind === 'field') expect(wf.nullable).toBe(true);
    const wc = widenNullable(computedR);
    if (wc.kind === 'computed') expect(wc.nullable).toBe(true);
    // idempotent: already-nullable returns the same reference
    expect(widenNullable(wf)).toBe(wf);
  });

  it('isType / isScalar guards', () => {
    expect(isType(typeR)).toBe(true);
    expect(isType(fieldR)).toBe(false);
    expect(isScalar(fieldR)).toBe(true);
    expect(isScalar(computedR)).toBe(true);
    expect(isScalar(typeR)).toBe(false);
  });

  it('exhaustive switch compiles + narrows', () => {
    const describe = (rt: ResolvedType): string => {
      switch (rt.kind) {
        case 'type':
          return `type:${rt.type.name}`;
        case 'field':
          return `field:${rt.field.name}`;
        case 'computed':
          return `computed:${rt.fieldType.resolve()}`;
      }
    };
    expect(describe(typeR)).toBe('type:User');
    expect(describe(fieldR)).toBe('field:total');
    expect(describe(computedR)).toBe('computed:number');
  });
});

describe('Field', () => {
  it('round-trips through JSON', () => {
    const f = new Field({ name: 'price', fieldType: new NumberFieldType({ min: 0 }), nullable: true });
    const json = f.toJSON();
    expect(json).toEqual({ name: 'price', type: { kind: 'number', min: 0 }, nullable: true });
    const back = Field.from(json, registry);
    expect(back.toJSON()).toEqual(json);
  });
});

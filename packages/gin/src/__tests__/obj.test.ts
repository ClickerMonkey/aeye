import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry } from '../registry';
import { ObjType } from '../types/obj';
import { OrType } from '../types/or';
import { LiteralType } from '../types/literal';

describe('ObjType', () => {
  const r = createRegistry();

  test('builder with props', () => {
    const t = r.obj({
      name: { type: r.text() },
      age: { type: r.num() },
    }) as ObjType;
    expect(t).toBeInstanceOf(ObjType);
    expect(Object.keys(t.fields)).toEqual(['name', 'age']);
  });

  test('valid checks each field (raw must be Value-wrapped)', () => {
    const t = r.obj({ name: { type: r.text() }, age: { type: r.num() } }) as ObjType;
    const good = t.parse({ name: 'Alice', age: 30 }).raw;
    expect(t.valid(good)).toBe(true);
    expect(t.valid({ name: 'Alice' })).toBe(false);
    expect(t.valid(null)).toBe(false);
    expect(t.valid([])).toBe(false);
  });

  test('parse builds raw with Value-wrapped fields', () => {
    const t = r.obj({ x: { type: r.num() } }) as ObjType;
    const v = t.parse({ x: 5 });
    const raw = v.raw as unknown as Record<string, { type: { name: string }; raw: unknown }>;
    expect(raw.x!.raw).toBe(5);
    expect(raw.x!.type.name).toBe('num');
    expect(primitives(v)).toEqual({ x: 5 });
  });

  test('parse rejects non-object', () => {
    expect(() => (r.obj({}) as ObjType).parse([])).toThrow();
    expect(() => (r.obj({}) as ObjType).parse(null)).toThrow();
  });

  test('encode wraps each field as a JSONValue envelope', () => {
    const t = r.obj({ x: { type: r.num() } }) as ObjType;
    const v = t.parse({ x: 5 });
    expect(t.encode(v.raw)).toEqual({
      x: { type: { name: 'num', options: undefined }, value: 5 },
    });
  });

  test('create produces per-field Value-wrapped defaults', () => {
    const t = r.obj({ s: { type: r.text() }, n: { type: r.num() } }) as ObjType;
    const raw = t.create() as unknown as Record<string, { type: { name: string }; raw: unknown }>;
    expect(raw.s!.raw).toBe('');
    expect(raw.n!.raw).toBe(0);
    expect(t.encode(raw as any)).toEqual({
      s: { type: { name: 'text', options: undefined }, value: '' },
      n: { type: { name: 'num', options: undefined }, value: 0 },
    });
  });

  test('compatible is structural (subset match)', () => {
    const a = r.obj({ x: { type: r.num() } }) as ObjType;
    const b = r.obj({ x: { type: r.num() }, y: { type: r.text() } }) as ObjType;
    expect(a.compatible(b)).toBe(true);
    expect(b.compatible(a)).toBe(false);
  });

  test('exact requires same field set', () => {
    const a = r.obj({ x: { type: r.num() } }) as ObjType;
    const b = r.obj({ x: { type: r.num() }, y: { type: r.text() } }) as ObjType;
    expect(a.exact(b)).toBe(false);
    expect(a.exact(a)).toBe(true);
  });

  test('or narrows to common fields', () => {
    const a = r.obj({ x: { type: r.num() }, y: { type: r.text() } }) as ObjType;
    const b = r.obj({ x: { type: r.num() }, z: { type: r.bool() } }) as ObjType;
    const m = a.or(b) as ObjType;
    expect(Object.keys(m.fields)).toEqual(['x']);
  });

  test('props() exposes the fields directly', () => {
    const t = r.obj({ x: { type: r.num() } }) as ObjType;
    expect(t.props().x).toBeDefined();
  });

  test('get key is or(literals) of field names, value is union', () => {
    const t = r.obj({ name: { type: r.text() }, age: { type: r.num() } }) as ObjType;
    const g = t.get();
    expect(g).toBeDefined();
    // key should be or(literal("name"), literal("age"))
    expect(g!.key).toBeInstanceOf(OrType);
    const variants = (g!.key as OrType).variants;
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v instanceof LiteralType)).toBe(true);
    // value is the union of field types
    expect(g!.value).toBeInstanceOf(OrType);
    expect(g!.loop).toBeDefined();
  });

  test('empty obj has no get', () => {
    const t = r.obj({}) as ObjType;
    expect(t.get()).toBeUndefined();
  });

  test('single-field obj has literal key (not or)', () => {
    const t = r.obj({ only: { type: r.text() } }) as ObjType;
    const g = t.get();
    expect(g!.key).toBeInstanceOf(LiteralType);
    expect(g!.value.name).toBe('text');
  });

  test('encode + parse roundtrip', () => {
    const t = r.obj({ name: { type: r.text() }, age: { type: r.num() } }) as ObjType;
    const back = r.parse(t.toJSON()) as ObjType;
    expect(Object.keys(back.fields)).toEqual(['name', 'age']);
  });
});

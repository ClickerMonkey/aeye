import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { AndType } from '../types/and';
import { Value } from '../value';
import type { Type } from '../type';
import { primitives } from './_utils';
import { ObjType } from '../types/obj';

describe('AndType', () => {
  const r = createRegistry();

  test('builder holds parts', () => {
    const t = r.and([r.num(), r.text()]) as AndType;
    expect(t).toBeInstanceOf(AndType);
    expect(t.parts).toHaveLength(2);
  });

  test('valid requires ALL parts to accept', () => {
    // No value satisfies both num and text → And over num+text is uninhabited.
    const t = r.and([r.num(), r.text()]);
    expect(t.valid(5)).toBe(false);
    expect(t.valid('x')).toBe(false);
  });

  test('valid when types overlap (both pass)', () => {
    // And<num, num> is just num — everything a num passes.
    const t = r.and([r.num(), r.num()]);
    expect(t.valid(5)).toBe(true);
  });

  test('simplify: single-part collapses', () => {
    const t = r.and([r.num()]) as AndType;
    expect(t.simplify().name).toBe('num');
  });

  test('props unions names across parts', () => {
    const a = r.obj({ x: { type: r.num() } });
    const b = r.obj({ y: { type: r.text() } });
    const t = r.and([a, b]);
    const p = t.props();
    expect(p.x).toBeDefined();
    expect(p.y).toBeDefined();
  });

  test('compatible requires every part accepts other', () => {
    const t = r.and([r.obj({ x: { type: r.num() } }), r.obj({ y: { type: r.text() } })]);
    // A type that has both x and y satisfies both parts
    const both = r.obj({ x: { type: r.num() }, y: { type: r.text() } });
    expect(t.compatible(both)).toBe(true);
    // A type with only x fails the y part
    const onlyX = r.obj({ x: { type: r.num() } });
    expect(t.compatible(onlyX)).toBe(false);
  });

  test('encode + parse roundtrip', () => {
    const t = r.and([r.num(), r.text()]);
    const back = r.parse(t.toJSON()) as AndType;
    expect(back).toBeInstanceOf(AndType);
    expect(back.parts).toHaveLength(2);
  });
});

/**
 * `and` over OBJECT or CONTAINER parts admitted NO value at all.
 *
 * `parse` takes the AUTHORED (JSON) form, but `valid` is a predicate over the
 * RUNTIME form — an obj's props are `Value`s, a list's items are `Value`s. The
 * old `parse` checked `valid(json)` on each part, which every object / container
 * part rejects by construction, so `and<obj{a: text}, obj{b: num}>.parse(...)`
 * threw for EVERY input including `{a:'x', b:1}` — the one value it means.
 *
 * The fix parses through the intersection's EFFECTIVE type (all-object parts
 * merge; otherwise the first part) and only then checks each part against the
 * resulting RUNTIME value.
 */
describe('AndType — parse over object / container parts', () => {
  const r = createRegistry();
  const objAnd = (): Type => r.and([r.obj({ a: { type: r.text() } }), r.obj({ b: { type: r.num() } })]);

  test('accepts the value that satisfies every part', () => {
    const v = objAnd().parse({ a: 'x', b: 1 });
    expect(primitives(v)).toEqual({ a: 'x', b: 1 });
  });

  test('the parsed runtime value carries EVERY part`s fields, not just the first', () => {
    const raw = objAnd().parse({ a: 'x', b: 1 }).raw as Record<string, Value>;
    expect(Object.keys(raw).sort()).toEqual(['a', 'b']);
    expect(raw['a']).toBeInstanceOf(Value);
    expect(raw['b']).toBeInstanceOf(Value);
  });

  test('encodes back losslessly (a first-part dump would drop `b`)', () => {
    const t = objAnd();
    const encoded = t.encode(t.parse({ a: 'x', b: 1 }).raw);
    expect(Object.keys(encoded as object).sort()).toEqual(['a', 'b']);
    expect(primitives(t.parse({ a: 'x', b: 1 }))).toEqual({ a: 'x', b: 1 });
  });

  test('extra keys are ignored, exactly as a plain obj ignores them', () => {
    expect(primitives(objAnd().parse({ a: 'x', b: 1, extra: true }))).toEqual({ a: 'x', b: 1 });
  });

  test('a value missing another part`s field is still refused', () => {
    expect(() => objAnd().parse({ a: 'x' })).toThrow();
  });

  test('the merged obj and the And accept the same values', () => {
    const merged = r.obj({ a: { type: r.text() }, b: { type: r.num() } });
    expect(primitives(objAnd().parse({ a: 'x', b: 1 }))).toEqual(primitives(merged.parse({ a: 'x', b: 1 })));
  });

  test('CONTAINER parts: each part accepts it individually, so the And must too', () => {
    const t = r.and([r.list(r.text()), r.list(r.text(), { maxLength: 2 })]);
    expect(primitives(t.parse(['a', 'b']))).toEqual(['a', 'b']);
    // ...and the narrower part is still enforced.
    expect(() => t.parse(['a', 'b', 'c'])).toThrow(/and\.constraint/);
  });

  test('CONSTRAINT parts over a scalar are unchanged', () => {
    const t = r.and([r.num(), r.num({ min: 3 })]);
    expect(primitives(t.parse(5))).toBe(5);
    expect(() => t.parse(1)).toThrow(/and\.constraint/);
  });

  test('an uninhabitable And still refuses every value', () => {
    const t = r.and([r.num(), r.text()]);
    expect(() => t.parse(5)).toThrow();
    expect(() => t.parse('x')).toThrow();
  });

  test('an EMPTY And is universal — it parses anything', () => {
    const t = r.and([]);
    expect(primitives(t.parse('anything'))).toBe('anything');
  });

  test('simplify collapses an all-object And to the merged obj', () => {
    const s = objAnd().simplify();
    expect(s.name).toBe('obj');
    expect(Object.keys((s as ObjType).fields).sort()).toEqual(['a', 'b']);
    // A constraint intersection has no single-type equivalent and stays an And.
    expect(r.and([r.num(), r.num({ min: 3 })]).simplify().name).toBe('and');
  });
});

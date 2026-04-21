import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { AndType } from '../types/and';

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

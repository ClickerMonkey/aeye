import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

describe('evalNew', () => {
  const e = new Engine(createRegistry());

  test('creates value of the given type with no value (defaults)', async () => {
    const v = await e.run({ kind: 'new', type: { name: 'num' } });
    expect(v.raw).toBe(0);
    expect(v.type.name).toBe('num');
  });

  test('parses value when provided', async () => {
    const v = await e.run({ kind: 'new', type: { name: 'text' }, value: 'hi' });
    expect(v.raw).toBe('hi');
  });

  test('invokes init when type has one (duration)', async () => {
    const v = await e.run({
      kind: 'new',
      type: { name: 'duration' },
      value: { days: 1, hours: 2 },
    });
    expect(v.raw).toBe(1 * 86_400_000 + 2 * 3_600_000);
  });

  test('invokes init for color', async () => {
    const v = await e.run({
      kind: 'new',
      type: { name: 'color' },
      value: { r: 255, g: 0, b: 0, a: 1 },
    });
    expect(v.raw).toBe(0xff0000ff);
  });

  test('throws when value fails type validation', async () => {
    await expect(e.run({ kind: 'new', type: { name: 'num', options: { min: 0 } }, value: -1 })).rejects.toThrow();
  });

  test('creates empty list', async () => {
    const v = await e.run({ kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } } });
    expect(primitives(v)).toEqual([]);
  });
});

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

  test('validate: warns on `new obj` with required fields and no value', () => {
    // The actual case from the user's exchange: a template's params
    // built as `new obj{radius: num, area: num}` with NO value. At
    // runtime each field defaults to 0; `${radius}` and `${area}`
    // silently substitute zero, masking the missing computation.
    // The warning gives the model a chance to fix this before the
    // test() call swallows the bug.
    const probs = e.validate({
      kind: 'new',
      type: {
        name: 'obj',
        props: { radius: { type: { name: 'num' } }, area: { type: { name: 'num' } } },
      },
    });
    const warn = probs.list.find((p) => p.code === 'new.value.missing');
    expect(warn).toBeDefined();
  });

  test('validate: no warning when `new obj` has only optional fields', () => {
    // Optional fields default to undefined/null which IS a meaningful
    // value (not a silent zero), so a missing value is acceptable.
    const probs = e.validate({
      kind: 'new',
      type: {
        name: 'obj',
        props: {
          opt: { type: { name: 'optional', generic: { T: { name: 'num' } } } },
        },
      },
    });
    expect(probs.list.some((p) => p.code === 'new.value.missing')).toBe(false);
  });

  test('validate: no warning when `new obj` provides a value', () => {
    const probs = e.validate({
      kind: 'new',
      type: { name: 'obj', props: { x: { type: { name: 'num' } } } },
      value: { x: 5 },
    });
    expect(probs.list.some((p) => p.code === 'new.value.missing')).toBe(false);
  });

  test('validate: no warning for `new list<num>` (empty list is fine)', () => {
    const probs = e.validate({
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'num' } } },
    });
    expect(probs.list.some((p) => p.code === 'new.value.missing')).toBe(false);
  });
});

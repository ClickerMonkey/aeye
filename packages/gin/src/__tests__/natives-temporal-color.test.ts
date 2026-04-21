import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

const e = new Engine(createRegistry());

describe('date natives', () => {
  test('year/month/day', async () => {
    const program = {
      kind: 'define',
      vars: [{ name: 'd', value: { kind: 'new', type: { name: 'date' }, value: '2025-06-15' } }],
      body: { kind: 'get', path: [{ prop: 'd' }, { prop: 'year' }] },
    } as const;
    expect((await e.run(program)).raw).toBe(2025);

    const dayProgram = { ...program, body: { kind: 'get', path: [{ prop: 'd' }, { prop: 'day' }] } } as const;
    expect((await e.run(dayProgram)).raw).toBe(15);
  });

  test('addDays yields a new date', async () => {
    const program = {
      kind: 'define',
      vars: [{ name: 'd', value: { kind: 'new', type: { name: 'date' }, value: '2025-01-01' } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'd' }, { prop: 'addDays' },
          { args: { days: { kind: 'new', type: { name: 'num' }, value: 10 } } },
          { prop: 'day' },
        ],
      },
    } as const;
    expect((await e.run(program)).raw).toBe(11);
  });

  test('diffDays', async () => {
    const program = {
      kind: 'define',
      vars: [
        { name: 'a', value: { kind: 'new', type: { name: 'date' }, value: '2025-01-10' } },
        { name: 'b', value: { kind: 'new', type: { name: 'date' }, value: '2025-01-01' } },
      ],
      body: {
        kind: 'get',
        path: [
          { prop: 'a' }, { prop: 'diffDays' },
          { args: { other: { kind: 'get', path: [{ prop: 'b' }] } } },
        ],
      },
    } as const;
    expect((await e.run(program)).raw).toBe(9);
  });
});

describe('duration natives', () => {
  test('init from components', async () => {
    const v = await e.run({ kind: 'new', type: { name: 'duration' }, value: { hours: 2, minutes: 30 } });
    expect(v.raw).toBe(2 * 3_600_000 + 30 * 60_000);
  });

  test('total/component accessors', async () => {
    const program = (p: string) => ({
      kind: 'define',
      vars: [{ name: 'd', value: { kind: 'new', type: { name: 'duration' }, value: { days: 1, hours: 2 } } }],
      body: { kind: 'get', path: [{ prop: 'd' }, { prop: p }] },
    }) as const;
    expect((await e.run(program('days'))).raw).toBe(1);
    expect((await e.run(program('hours'))).raw).toBe(2);
    expect((await e.run(program('totalHours'))).raw).toBe(26);
  });
});

describe('color natives', () => {
  test('init + components', async () => {
    const v = await e.run({ kind: 'new', type: { name: 'color' }, value: { r: 255, g: 128, b: 0, a: 1 } });
    expect(v.raw).toBe(0xff8000ff);
  });

  test('toHex', async () => {
    const program = {
      kind: 'define',
      vars: [{ name: 'c', value: { kind: 'new', type: { name: 'color' }, value: { r: 255, g: 0, b: 0, a: 1 } } }],
      body: { kind: 'get', path: [{ prop: 'c' }, { prop: 'toHex' }, { args: {} }] },
    } as const;
    expect((await e.run(program)).raw).toBe('#ff0000ff');
  });

  test('invert', async () => {
    const program = {
      kind: 'define',
      vars: [{ name: 'c', value: { kind: 'new', type: { name: 'color' }, value: { r: 255, g: 128, b: 0, a: 1 } } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'c' }, { prop: 'invert' }, { args: {} },
          { prop: 'r' },
        ],
      },
    } as const;
    expect((await e.run(program)).raw).toBe(0);
  });
});

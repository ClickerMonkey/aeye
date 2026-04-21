import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

describe('evalDefine', () => {
  const e = new Engine(createRegistry());

  test('binds a variable visible in body', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 42 } }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(v.raw).toBe(42);
  });

  test('later vars can reference earlier', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [
        { name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } },
        { name: 'y', value: { kind: 'get', path: [{ prop: 'x' }] } },
      ],
      body: { kind: 'get', path: [{ prop: 'y' }] },
    });
    expect(v.raw).toBe(10);
  });
});

describe('evalGet', () => {
  const e = new Engine(createRegistry());

  test('reads a scope variable', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 7 } }],
      body: { kind: 'get', path: [{ prop: 'x' }] },
    });
    expect(v.raw).toBe(7);
  });

  test('invokes a method via path', async () => {
    // x.add({other: 5})
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' },
          { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    });
    expect(v.raw).toBe(15);
  });

  test('chains method calls', async () => {
    // x.add({other: 5}).mul({other: 2})
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' },
          { prop: 'add' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 5 } } },
          { prop: 'mul' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
        ],
      },
    });
    expect(v.raw).toBe(30);
  });

  test('reads a field prop (length)', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 's', value: { kind: 'new', type: { name: 'text' }, value: 'hello' } }],
      body: { kind: 'get', path: [{ prop: 's' }, { prop: 'length' }] },
    });
    expect(v.raw).toBe(5);
  });

  test('indexed access via [key]', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [10, 20, 30] } }],
      body: {
        kind: 'get',
        path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      },
    });
    expect(v.raw).toBe(20);
  });

  test('catch handles a thrown error inline', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'arr' },
          { prop: 'at' },
          { args: { index: { kind: 'new', type: { name: 'num' }, value: 99 } } },
        ],
      },
    });
    // list.at returns optional — undefined on out-of-range.
    expect(v.raw).toBe(undefined);
  });
});

describe('evalSet', () => {
  const e = new Engine(createRegistry());

  test('assigns a scope variable (single-step prop path)', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      body: {
        kind: 'block',
        lines: [
          { kind: 'set', path: [{ prop: 'x' }], value: { kind: 'new', type: { name: 'num' }, value: 99 } },
          { kind: 'get', path: [{ prop: 'x' }] },
        ],
      },
    });
    expect(v.raw).toBe(99);
  });

  test('assigns a list index via [key] set', async () => {
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] } }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 1 } }],
            value: { kind: 'new', type: { name: 'num' }, value: 99 },
          },
          { kind: 'get', path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 1 } }] },
        ],
      },
    });
    expect(v.raw).toBe(99);
  });
});

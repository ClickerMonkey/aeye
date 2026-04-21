import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

describe('evalLoop', () => {
  const e = new Engine(createRegistry());

  test('loops over a list summing values', async () => {
    const program = {
      kind: 'define',
      vars: [
        { name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] } },
        { name: 'total', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'arr' }] },
            key: 'i',
            value: 'x',
            body: {
              kind: 'set',
              path: [{ prop: 'total' }],
              value: {
                kind: 'get',
                path: [
                  { prop: 'total' },
                  { prop: 'add' },
                  { args: { other: { kind: 'get', path: [{ prop: 'x' }] } } },
                ],
              },
            },
          },
          { kind: 'get', path: [{ prop: 'total' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(10);
  });

  test('loops over a num: yields 0..n-1 as (key,value)', async () => {
    const program = {
      kind: 'define',
      vars: [
        { name: 'n', value: { kind: 'new', type: { name: 'num' }, value: 5 } },
        { name: 'sum', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'n' }] },
            body: {
              kind: 'set',
              path: [{ prop: 'sum' }],
              value: {
                kind: 'get',
                path: [
                  { prop: 'sum' },
                  { prop: 'add' },
                  { args: { other: { kind: 'get', path: [{ prop: 'value' }] } } },
                ],
              },
            },
          },
          { kind: 'get', path: [{ prop: 'sum' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(0 + 1 + 2 + 3 + 4);
  });

  test('loops over negative num yields 0..-n', async () => {
    const program = {
      kind: 'define',
      vars: [
        { name: 'n', value: { kind: 'new', type: { name: 'num' }, value: -3 } },
        { name: 'collected', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'n' }] },
            body: {
              kind: 'get',
              path: [
                { prop: 'collected' },
                { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'collected' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(primitives(v)).toEqual([0, -1, -2]);
  });

  test('break exits loop early', async () => {
    const program = {
      kind: 'define',
      vars: [
        { name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4, 5] } },
        { name: 'count', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'arr' }] },
            body: {
              kind: 'if',
              ifs: [
                {
                  condition: {
                    kind: 'get',
                    path: [
                      { prop: 'value' }, { prop: 'gt' },
                      { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
                    ],
                  },
                  body: { kind: 'flow', action: 'break' },
                },
              ],
              else: {
                kind: 'set',
                path: [{ prop: 'count' }],
                value: {
                  kind: 'get',
                  path: [
                    { prop: 'count' }, { prop: 'add' },
                    { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                  ],
                },
              },
            },
          },
          { kind: 'get', path: [{ prop: 'count' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(2);
  });

  test('continue skips the current iteration', async () => {
    // Count only items > 2 in [1,2,3,4]: should be 2.
    const program = {
      kind: 'define',
      vars: [
        { name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] } },
        { name: 'count', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'arr' }] },
            body: {
              kind: 'block',
              lines: [
                {
                  kind: 'if',
                  ifs: [{
                    condition: {
                      kind: 'get',
                      path: [{ prop: 'value' }, { prop: 'lte' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } }],
                    },
                    body: { kind: 'flow', action: 'continue' },
                  }],
                },
                {
                  kind: 'set',
                  path: [{ prop: 'count' }],
                  value: {
                    kind: 'get',
                    path: [{ prop: 'count' }, { prop: 'add' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } }],
                  },
                },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'count' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(2);
  });
});

describe('evalFlow', () => {
  const e = new Engine(createRegistry());

  test('exit short-circuits run with a value', async () => {
    const v = await e.run({
      kind: 'block',
      lines: [
        { kind: 'flow', action: 'exit', value: { kind: 'new', type: { name: 'text' }, value: 'done' } },
        { kind: 'new', type: { name: 'text' }, value: 'unreached' },
      ],
    });
    expect(v.raw).toBe('done');
  });

  test('throw uncaught propagates from run', async () => {
    await expect(e.run({
      kind: 'flow',
      action: 'throw',
      error: { kind: 'new', type: { name: 'text' }, value: 'oops' },
    })).rejects.toBeDefined();
  });
});

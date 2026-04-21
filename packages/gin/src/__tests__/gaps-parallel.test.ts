import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

describe('Loop.parallel — concurrency + rate', () => {
  test('parallel concurrent=1 iterates every element', async () => {
    // concurrent=1 exercises the parallel path but serializes execution,
    // so we can safely sum via `total = total + x` without races.
    const r = createRegistry();
    const e = new Engine(r);
    const program = {
      kind: 'define',
      vars: [
        { name: 'arr',   value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4] } },
        { name: 'total', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'arr' }] },
            value: 'x',
            parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 1 } },
            body: {
              kind: 'set',
              path: [{ prop: 'total' }],
              value: {
                kind: 'get',
                path: [
                  { prop: 'total' }, { prop: 'add' },
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

  test('parallel with rate: all iterations land via list.push', async () => {
    // list.push is an atomic native mutation — pushes from concurrent
    // iterations don't race; length is deterministic.
    const r = createRegistry();
    const e = new Engine(r);
    const program = {
      kind: 'define',
      vars: [
        { name: 'src', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [10, 20, 30] } },
        { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'src' }] },
            parallel: { rate: { kind: 'new', type: { name: 'duration' }, value: { ms: 1 } } },
            body: {
              kind: 'get',
              path: [
                { prop: 'out' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'out' }, { prop: 'length' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(3);
  });

  test('parallel concurrent=3 still launches all tasks', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const program = {
      kind: 'define',
      vars: [
        { name: 'src', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3, 4, 5] } },
        { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'src' }] },
            parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 3 } },
            body: {
              kind: 'get',
              path: [
                { prop: 'out' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          },
          { kind: 'get', path: [{ prop: 'out' }, { prop: 'length' }] },
        ],
      },
    } as const;
    const v = await e.run(program);
    expect(v.raw).toBe(5);
  });
});

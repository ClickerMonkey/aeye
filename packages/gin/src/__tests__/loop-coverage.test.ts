import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

/**
 * Loop coverage for every type that exposes `get().loop` (or
 * `get().loopDynamic`). Each type gets:
 *
 *   - a sequential test verifying iteration ORDER and the per-step
 *     `key` / `value` bindings
 *   - a parallel test verifying every iteration executes when the
 *     parallel options are set (where parallel is meaningful)
 *
 * `list` and `num` are covered in `exprs-loop-flow.test.ts` /
 * `gaps-parallel.test.ts`; `bool` (while-loop semantics) lives in
 * `loop-while-bool.test.ts`. This file fills the gaps for `map`,
 * `obj`, and `text`.
 */
describe('LoopExpr — coverage for map / obj / text', () => {
  describe('map', () => {
    test('sequential iteration yields every entry', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          {
            name: 'm',
            value: {
              kind: 'new',
              type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } },
              value: [
                { key: 'a', value: 1 },
                { key: 'b', value: 2 },
                { key: 'c', value: 3 },
              ],
            },
          },
          { name: 'sum', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 'm' }] },
              body: {
                kind: 'set',
                path: [{ prop: 'sum' }],
                value: {
                  kind: 'get',
                  path: [
                    { prop: 'sum' }, { prop: 'add' },
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
      expect(v.raw).toBe(1 + 2 + 3);
    });

    test('keys come through as the map key type', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          {
            name: 'm',
            value: {
              kind: 'new',
              type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } },
              value: [
                { key: 'x', value: 10 },
                { key: 'y', value: 20 },
              ],
            },
          },
          { name: 'collected', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'text' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 'm' }] },
              body: {
                kind: 'get',
                path: [
                  { prop: 'collected' }, { prop: 'push' },
                  { args: { value: { kind: 'get', path: [{ prop: 'key' }] } } },
                ],
              },
            },
            { kind: 'get', path: [{ prop: 'collected' }] },
          ],
        },
      } as const;
      const v = await e.run(program);
      expect(primitives(v).sort()).toEqual(['x', 'y']);
    });

    test('parallel concurrent=2 still iterates every entry', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          {
            name: 'm',
            value: {
              kind: 'new',
              type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } },
              value: [
                { key: 'a', value: 1 },
                { key: 'b', value: 2 },
                { key: 'c', value: 3 },
                { key: 'd', value: 4 },
              ],
            },
          },
          { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 'm' }] },
              parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 2 } },
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
      expect(v.raw).toBe(4);
    });
  });

  describe('obj', () => {
    test('sequential iteration walks every field as (name, value)', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          {
            name: 'o',
            value: {
              kind: 'new',
              type: {
                name: 'obj',
                props: {
                  a: { type: { name: 'num' } },
                  b: { type: { name: 'num' } },
                  c: { type: { name: 'num' } },
                },
              },
              value: { a: 10, b: 20, c: 30 },
            },
          },
          { name: 'sum', value: { kind: 'new', type: { name: 'num' }, value: 0 } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 'o' }] },
              body: {
                kind: 'set',
                path: [{ prop: 'sum' }],
                value: {
                  kind: 'get',
                  path: [
                    { prop: 'sum' }, { prop: 'add' },
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
      expect(v.raw).toBe(60);
    });

    test('iteration keys are the field names', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          {
            name: 'o',
            value: {
              kind: 'new',
              type: {
                name: 'obj',
                props: {
                  alpha: { type: { name: 'num' } },
                  beta: { type: { name: 'num' } },
                },
              },
              value: { alpha: 1, beta: 2 },
            },
          },
          { name: 'names', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'text' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 'o' }] },
              body: {
                kind: 'get',
                path: [
                  { prop: 'names' }, { prop: 'push' },
                  { args: { value: { kind: 'get', path: [{ prop: 'key' }] } } },
                ],
              },
            },
            { kind: 'get', path: [{ prop: 'names' }] },
          ],
        },
      } as const;
      const v = await e.run(program);
      expect(primitives(v).sort()).toEqual(['alpha', 'beta']);
    });

    test('parallel concurrent=2 over an obj still hits every field', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          {
            name: 'o',
            value: {
              kind: 'new',
              type: {
                name: 'obj',
                props: {
                  a: { type: { name: 'num' } },
                  b: { type: { name: 'num' } },
                  c: { type: { name: 'num' } },
                },
              },
              value: { a: 1, b: 2, c: 3 },
            },
          },
          { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 'o' }] },
              parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 2 } },
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
  });

  describe('text', () => {
    test('sequential iteration yields each character in order', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          { name: 's', value: { kind: 'new', type: { name: 'text' }, value: 'abc' } },
          { name: 'collected', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'text' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 's' }] },
              body: {
                kind: 'get',
                path: [
                  { prop: 'collected' }, { prop: 'push' },
                  { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
                ],
              },
            },
            { kind: 'get', path: [{ prop: 'collected' }] },
          ],
        },
      } as const;
      const v = await e.run(program);
      expect(primitives(v)).toEqual(['a', 'b', 'c']);
    });

    test('iteration keys are 0-based indices', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          { name: 's', value: { kind: 'new', type: { name: 'text' }, value: 'xy' } },
          { name: 'indices', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 's' }] },
              body: {
                kind: 'get',
                path: [
                  { prop: 'indices' }, { prop: 'push' },
                  { args: { value: { kind: 'get', path: [{ prop: 'key' }] } } },
                ],
              },
            },
            { kind: 'get', path: [{ prop: 'indices' }] },
          ],
        },
      } as const;
      const v = await e.run(program);
      expect(primitives(v)).toEqual([0, 1]);
    });

    test('parallel concurrent=2 over text still iterates every character', async () => {
      const r = createRegistry();
      const e = new Engine(r);
      const program = {
        kind: 'define',
        vars: [
          { name: 's', value: { kind: 'new', type: { name: 'text' }, value: 'abcde' } },
          { name: 'out', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'text' } } }, value: [] } },
        ],
        body: {
          kind: 'block',
          lines: [
            {
              kind: 'loop',
              over: { kind: 'get', path: [{ prop: 's' }] },
              parallel: { concurrent: { kind: 'new', type: { name: 'num' }, value: 2 } },
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
});

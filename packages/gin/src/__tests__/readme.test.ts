import { describe, test, expect } from 'vitest';
import { createRegistry, createEngine } from '../index';
import { val } from '../value';

/**
 * Sanity check: each ExprDef shown in README.md round-trips through
 * `engine.run` and produces the documented output. Keeps the docs from
 * bit-rotting silently.
 */
describe('README examples', () => {
  test('example 1 — define + method call on num', async () => {
    const r = createRegistry();
    const engine = createEngine(r);

    const program = {
      kind: 'define',
      vars: [
        { name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 2 } },
      ],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' },
          { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
        ],
      },
    } as const;

    const result = await engine.run(program);
    expect(result.raw).toBe(5);
    expect(result.type.name).toBe('num');
  });

  test('example 2 — Task extension + filter + length', async () => {
    const r = createRegistry();

    const Task = r.extend(r.obj({
      title: { type: r.text({ minLength: 1 }) },
      done:  { type: r.bool() },
    }), { name: 'Task', docs: 'An action item in a to-do list' });
    r.register(Task);

    const engine = createEngine(r);

    const program = {
      kind: 'define',
      vars: [{
        name: 'tasks',
        value: {
          kind: 'new',
          type: { name: 'list', generic: { V: { name: 'Task' } } },
          value: [
            { title: 'ship it',    done: true  },
            { title: 'write docs', done: false },
            { title: 'deploy',     done: true  },
          ],
        },
      }],
      body: {
        kind: 'get',
        path: [
          { prop: 'tasks' },
          { prop: 'filter' },
          {
            args: {
              fn: {
                kind: 'lambda',
                type: {
                  name: 'fn',
                  call: { args: { name: 'obj' }, returns: { name: 'bool' } },
                },
                body: {
                  kind: 'get',
                  path: [{ prop: 'args' }, { prop: 'value' }, { prop: 'done' }],
                },
              },
            },
          },
          { prop: 'length' },
        ],
      },
    } as const;

    const result = await engine.run(program);
    expect(result.raw).toBe(2);
  });

  test('example 3 — native override for num.sqrt', async () => {
    const r = createRegistry();
    r.setNative('num.sqrt', (scope, registry) =>
      val(registry.num(), Math.sqrt((scope.get('this')!.raw as number))),
    );
    const engine = createEngine(r);

    const sqrt16 = {
      kind: 'get',
      path: [
        { prop: 'n' },
        { prop: 'sqrt' },
        { args: {} },
      ],
    } as const;

    const result = await engine.run(sqrt16, { n: val(r.num(), 16) });
    expect(result.raw).toBe(4);
  });
});

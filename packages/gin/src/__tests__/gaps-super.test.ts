import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Super binding: a LOCAL prop override on an Extension receives `super`
 * in scope, callable as a Fn Value that delegates to the base's impl.
 */
describe('super in Extension overrides', () => {
  test('local override can call super to reach base behavior', async () => {
    const r = createRegistry();
    const e = new Engine(r);

    // Extension of num: override `add` so it returns super(add) + 100.
    const myNum = r.extend('num', {
      name: 'myNum',
      props: {
        add: {
          type: r.fn(r.obj({ other: { type: r.num() } }), r.num()),
          get: {
            kind: 'get',
            path: [
              { prop: 'super' },
              { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'other' }] } } },
              { prop: 'add' },
              { args: { other: { kind: 'new', type: { name: 'num' }, value: 100 } } },
            ],
          },
        },
      },
    });
    r.register(myNum);

    const program = {
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'myNum' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    } as const;

    const v = await e.run(program);
    // super(add)(5) = 10+5 = 15; then +100 = 115
    expect(v.raw).toBe(115);
  });

  test('non-override props do not receive super', async () => {
    const r = createRegistry();
    const e = new Engine(r);

    // Extension adds a new prop that references `super` — super should NOT
    // be bound because this is an addition, not an override. Evaluation
    // should surface the undefined var.
    const myNum = r.extend('num', {
      name: 'myNum',
      props: {
        brand: {
          type: r.fn(r.obj({}), r.text()),
          get: { kind: 'get', path: [{ prop: 'super' }] },
        },
      },
    });
    r.register(myNum);

    const program = {
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'myNum' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [{ prop: 'x' }, { prop: 'brand' }, { args: {} }],
      },
    } as const;

    await expect(e.run(program)).rejects.toThrow(/unknown variable 'super'/);
  });
});

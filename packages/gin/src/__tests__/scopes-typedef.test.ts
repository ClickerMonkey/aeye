import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

/**
 * Each place in TypeDef where an ExprDef runs with a prescribed scope
 * (PropDef.get/set, GetSetDef.get/set/loop, TypeDef.init.run, PathCall.catch).
 * Every test installs a user-defined Expr body that reads the expected scope
 * variables directly — so the test fails if the engine stops binding them.
 *
 * gaps-super.test.ts already covers `super` on PropDef.get, so the `super`
 * channel isn't retested here. CallDef.get / CallDef.set and PropDef.default
 * aren't wired into the engine yet — not covered.
 */

describe('PropDef.get (field) scope', () => {
  test('`this` is the receiver Value', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'dblNum',
      props: {
        doubled: {
          type: r.num(),
          get: {
            kind: 'get',
            path: [
              { prop: 'this' }, { prop: 'add' },
              { args: { other: { kind: 'get', path: [{ prop: 'this' }] } } },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'dblNum' }, value: 7 } }],
      body: { kind: 'get', path: [{ prop: 'x' }, { prop: 'doubled' }] },
    });
    expect(v.raw).toBe(14);
  });
});

describe('PropDef.get (method) scope', () => {
  test('`this` and `args` are bound during method invocation', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'methodNum',
      props: {
        plus: {
          type: r.fn(r.obj({ n: { type: r.num() } }), r.num()),
          get: {
            kind: 'get',
            path: [
              { prop: 'this' }, { prop: 'add' },
              { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] } } },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'methodNum' }, value: 10 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'plus' },
          { args: { n: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    });
    expect(v.raw).toBe(15);
  });
});

describe('PropDef.set scope', () => {
  test('`this` and `value` are bound during a prop set', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'loggedNum',
      props: {
        shadow: {
          type: r.num(),
          get: { kind: 'get', path: [{ prop: 'this' }] },
          set: {
            kind: 'block',
            lines: [
              {
                kind: 'get',
                path: [
                  { prop: 'log' }, { prop: 'push' },
                  { args: { value: { kind: 'get', path: [{ prop: 'this' }] } } },
                ],
              },
              {
                kind: 'get',
                path: [
                  { prop: 'log' }, { prop: 'push' },
                  { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
                ],
              },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'loggedNum' }, value: 42 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'x' }, { prop: 'shadow' }],
            value: { kind: 'new', type: { name: 'num' }, value: 99 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(result)).toEqual([42, 99]);
  });
});

describe('GetSetDef.get scope', () => {
  test('`this` and `key` are bound during indexed read', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'indexNum',
      get: {
        key: r.num(),
        value: r.num(),
        get: {
          kind: 'get',
          path: [
            { prop: 'this' }, { prop: 'add' },
            { args: { other: { kind: 'get', path: [{ prop: 'key' }] } } },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'indexNum' }, value: 100 } }],
      body: {
        kind: 'get',
        path: [{ prop: 'x' }, { key: { kind: 'new', type: { name: 'num' }, value: 7 } }],
      },
    });
    expect(v.raw).toBe(107);
  });
});

describe('GetSetDef.set scope', () => {
  test('`this`, `key`, and `value` are bound during indexed write', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'indexSetNum',
      get: {
        key: r.num(),
        value: r.num(),
        get: { kind: 'get', path: [{ prop: 'this' }] },
        set: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'this' }] } } },
              ],
            },
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'key' }] } } },
              ],
            },
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'indexSetNum' }, value: 50 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'x' }, { key: { kind: 'new', type: { name: 'num' }, value: 3 } }],
            value: { kind: 'new', type: { name: 'num' }, value: 77 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(result)).toEqual([50, 3, 77]);
  });
});

describe('GetSetDef.loop scope', () => {
  test('`this` and `yield` are bound when the loop expression runs', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'loopNum',
      get: {
        key: r.num(),
        value: r.num(),
        loop: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'this' }] } } },
              ],
            },
            // Reading `yield` verifies it's in scope; would throw otherwise.
            { kind: 'get', path: [{ prop: 'yield' }] },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'loopNum' }, value: 88 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'loop',
            over: { kind: 'get', path: [{ prop: 'x' }] },
            body: { kind: 'new', type: { name: 'num' }, value: 0 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(result)).toEqual([88]);
  });
});

describe('TypeDef.init.run scope — `this`', () => {
  test('`this` is a default-constructed value of the target type', async () => {
    const r = createRegistry();
    // num extension with min:42 — base.create() returns 42.
    r.register(r.extend('num', {
      name: 'startsAt42',
      options: { min: 42 },
      init: {
        args: r.obj({}),
        run: {
          kind: 'get',
          path: [
            { prop: 'this' }, { prop: 'add' },
            { args: { other: { kind: 'new', type: { name: 'num' }, value: 8 } } },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({ kind: 'new', type: { name: 'startsAt42' }, value: {} });
    // `this` default is 42; init returns this.add(8) = 50.
    expect(v.raw).toBe(50);
    expect(v.type.name).toBe('startsAt42');
  });

  test('a void-returning init falls back to `this`', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'alwaysZero',
      init: {
        args: r.obj({}),
        // Returns a void Value — evalNew should return `this` (default num = 0).
        run: { kind: 'new', type: { name: 'void' } },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({ kind: 'new', type: { name: 'alwaysZero' }, value: {} });
    expect(v.raw).toBe(0);
    expect(v.type.name).toBe('alwaysZero');
  });
});

describe('TypeDef.init.run scope — `args`', () => {
  test('`args` is bound while constructing a value', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'initNum',
      init: {
        args: r.obj({ base: { type: r.num() }, bonus: { type: r.num() } }),
        run: {
          kind: 'get',
          path: [
            { prop: 'args' }, { prop: 'base' }, { prop: 'add' },
            { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'bonus' }] } } },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'new',
      type: { name: 'initNum' },
      value: { base: 30, bonus: 7 },
    });
    expect(v.raw).toBe(37);
    expect(v.type.name).toBe('initNum');
  });
});

describe('GetSetDef.get scope — `super`', () => {
  test('super({key}) delegates to base index get', async () => {
    const r = createRegistry();
    r.register(r.extend(r.list(r.num()), {
      name: 'offsetList',
      get: {
        key: r.num(),
        value: r.num(),
        // offsetList[k] = base[k] + 1000
        get: {
          kind: 'get',
          path: [
            { prop: 'super' },
            { args: { key: { kind: 'get', path: [{ prop: 'key' }] } } },
            { prop: 'add' },
            { args: { other: { kind: 'new', type: { name: 'num' }, value: 1000 } } },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'offsetList' }, value: [1, 2, 3] } }],
      body: {
        kind: 'get',
        path: [{ prop: 'x' }, { key: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      },
    });
    expect(v.raw).toBe(1002);
  });
});

describe('GetSetDef.set scope — `super`', () => {
  test('super({key, value}) delegates to base index set', async () => {
    const r = createRegistry();
    r.register(r.extend(r.list(r.num()), {
      name: 'loggedList',
      get: {
        key: r.num(),
        value: r.num(),
        get: {
          kind: 'get',
          path: [
            { prop: 'super' },
            { args: { key: { kind: 'get', path: [{ prop: 'key' }] } } },
          ],
        },
        set: {
          kind: 'block',
          lines: [
            // log the set
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
            // delegate to base via super
            {
              kind: 'get',
              path: [
                { prop: 'super' },
                {
                  args: {
                    key: { kind: 'get', path: [{ prop: 'key' }] },
                    value: { kind: 'get', path: [{ prop: 'value' }] },
                  },
                },
              ],
            },
          ],
        },
      },
    }));
    const e = new Engine(r);
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'loggedList' }, value: [1, 2, 3] } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'x' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
            value: { kind: 'new', type: { name: 'num' }, value: 99 },
          },
          { kind: 'get', path: [{ prop: 'x' }] },
        ],
      },
    });
    expect(primitives(result)).toEqual([99, 2, 3]);
  });
});

describe('CallDef.get body', () => {
  test('call.get runs when Fn raw is not a JS function', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const fnType = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { x: { type: { name: 'num' } } } },
        returns: { name: 'num' },
        get: {
          kind: 'get',
          path: [
            { prop: 'args' }, { prop: 'x' }, { prop: 'mul' },
            { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
          ],
        },
      },
    });
    e.registerGlobal('doubler', { type: fnType, value: null });
    const v = await e.run({
      kind: 'get',
      path: [
        { prop: 'doubler' },
        { args: { x: { kind: 'new', type: { name: 'num' }, value: 21 } } },
      ],
    });
    expect(v.raw).toBe(42);
  });
});

describe('PropDef.default', () => {
  test('evaluates default Expr for missing obj fields', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const v = await e.run({
      kind: 'new',
      type: {
        name: 'obj',
        props: {
          name:     { type: { name: 'text' } },
          greeting: {
            type: { name: 'text' },
            default: { kind: 'new', type: { name: 'text' }, value: 'hello!' },
          },
        },
      },
      value: { name: 'Alice' },
    });
    expect(primitives(v)).toEqual({ name: 'Alice', greeting: 'hello!' });
  });

  test('explicit value wins over default', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const v = await e.run({
      kind: 'new',
      type: {
        name: 'obj',
        props: {
          mode: {
            type: { name: 'text' },
            default: { kind: 'new', type: { name: 'text' }, value: 'auto' },
          },
        },
      },
      value: { mode: 'manual' },
    });
    expect((primitives(v) as { mode: string }).mode).toBe('manual');
  });
});

describe('PathCall.catch scope', () => {
  test('`error` is bound inside a catch Expr', async () => {
    const e = new Engine(createRegistry());
    const v = await e.run({
      kind: 'define',
      vars: [{
        name: 'boom',
        value: {
          kind: 'lambda',
          type: {
            name: 'function',
            call: {
              args: { name: 'obj' },
              returns: { name: 'text' },
              throws: { name: 'text' },
            },
          },
          body: {
            kind: 'flow',
            action: 'throw',
            error: { kind: 'new', type: { name: 'text' }, value: 'kaboom' },
          },
        },
      }],
      body: {
        kind: 'get',
        path: [
          { prop: 'boom' },
          {
            args: {},
            catch: { kind: 'get', path: [{ prop: 'error' }] },
          },
        ],
      },
    });
    expect(v.raw).toBe('kaboom');
  });

  test('`error` is bound inside a method-call catch Expr', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'throwingNum',
      props: {
        failIfZero: {
          type: r.fn(r.obj({}), r.num(), r.text()),
          get: {
            kind: 'if',
            ifs: [{
              condition: {
                kind: 'get',
                path: [
                  { prop: 'this' }, { prop: 'eq' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                ],
              },
              body: {
                kind: 'flow',
                action: 'throw',
                error: { kind: 'new', type: { name: 'text' }, value: 'zero!' },
              },
            }],
            else: { kind: 'get', path: [{ prop: 'this' }] },
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'throwingNum' }, value: 0 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'failIfZero' },
          {
            args: {},
            catch: {
              kind: 'get',
              path: [
                { prop: 'error' }, { prop: 'concat' },
                { args: { other: { kind: 'new', type: { name: 'text' }, value: ' caught' } } },
              ],
            },
          },
        ],
      },
    });
    expect(v.raw).toBe('zero! caught');
  });
});

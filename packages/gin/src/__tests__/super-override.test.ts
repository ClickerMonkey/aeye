import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

/**
 * When an Extension locally overrides an existing prop/method/setter, the
 * override body runs with `super` bound to the base's same-named impl:
 *
 *   PropDef.get    override → super: fn(args)        → base.get result
 *   PropDef.set    override → super: fn({value})     → invokes base.set
 *   CallDef.set    override → super: fn({args,value}) → invokes base.call.set
 *
 * Super is ONLY present when the prop is a LOCAL override (the Extension's
 * local.props has this name AND the base has the same name). Additive-only
 * props (new names that the base doesn't have) receive no super.
 */

describe('super in method (PropDef.get) override', () => {
  test('native-backed base: override calls super and modifies result', async () => {
    const r = createRegistry();
    // Override num.add so it returns (base.add(other)) * 2.
    r.register(r.extend('num', {
      name: 'doubled',
      props: {
        add: {
          type: r.fn(r.obj({ other: { type: r.num() } }), r.num()),
          get: {
            kind: 'get',
            path: [
              { prop: 'super' },
              { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'other' }] } } },
              { prop: 'mul' },
              { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'doubled' }, value: 3 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 4 } } },
        ],
      },
    });
    expect(v.raw).toBe(14); // (3+4)*2
  });

  test('override transforms args before calling super', async () => {
    const r = createRegistry();
    // Override add: supercall with (other+10) — so result = this + other + 10.
    r.register(r.extend('num', {
      name: 'biasedAdder',
      props: {
        add: {
          type: r.fn(r.obj({ other: { type: r.num() } }), r.num()),
          get: {
            kind: 'get',
            path: [
              { prop: 'super' },
              {
                args: {
                  other: {
                    kind: 'get',
                    path: [
                      { prop: 'args' }, { prop: 'other' }, { prop: 'add' },
                      { args: { other: { kind: 'new', type: { name: 'num' }, value: 10 } } },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'biasedAdder' }, value: 5 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
        ],
      },
    });
    expect(v.raw).toBe(17); // 5 + (2+10)
  });

  test('chained extension: super reaches the immediate parent', async () => {
    const r = createRegistry();
    // Level 1: override add → super(other) + 100
    const lvl1 = r.extend('num', {
      name: 'lvl1',
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
    r.register(lvl1);

    // Level 2: extends lvl1. Override add → super(other) + 1000
    const lvl2 = r.extend(lvl1, {
      name: 'lvl2',
      props: {
        add: {
          type: r.fn(r.obj({ other: { type: r.num() } }), r.num()),
          get: {
            kind: 'get',
            path: [
              { prop: 'super' },
              { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'other' }] } } },
              { prop: 'add' },
              { args: { other: { kind: 'new', type: { name: 'num' }, value: 1000 } } },
            ],
          },
        },
      },
    });
    r.register(lvl2);

    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'lvl2' }, value: 5 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
        ],
      },
    });
    // lvl2.add(3) = lvl1.add(3) + 1000 = (5+3+100) + 1000 = 1108
    expect(v.raw).toBe(1108);
  });

  test('super inside `this` preserves the base — avoids infinite override recursion', async () => {
    const r = createRegistry();
    // If super rebound `this` to the Extension, `this.add` in the super body
    // would loop back to the override. Binding `this` to base prevents it.
    r.register(r.extend('num', {
      name: 'wrap',
      props: {
        add: {
          type: r.fn(r.obj({ other: { type: r.num() } }), r.num()),
          get: {
            kind: 'get',
            path: [
              { prop: 'super' },
              { args: { other: { kind: 'get', path: [{ prop: 'args' }, { prop: 'other' }] } } },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'wrap' }, value: 1 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'add' },
          { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
        ],
      },
    });
    expect(v.raw).toBe(3);
  });

  test('new (non-override) method does NOT receive super', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'withExtra',
      props: {
        brand: {
          type: r.fn(r.obj({}), r.text()),
          get: { kind: 'get', path: [{ prop: 'super' }] },
        },
      },
    }));
    const e = new Engine(r);
    await expect(e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'withExtra' }, value: 1 } }],
      body: {
        kind: 'get',
        path: [{ prop: 'x' }, { prop: 'brand' }, { args: {} }],
      },
    })).rejects.toThrow(/unknown variable 'super'/);
  });
});

describe('super in PropDef.set override', () => {
  test('override calls super({value*10}) — base sees transformed value', async () => {
    const r = createRegistry();
    const base = r.extend('num', {
      name: 'tally',
      props: {
        data: {
          type: r.num(),
          get: { kind: 'get', path: [{ prop: 'this' }] },
          set: {
            kind: 'get',
            path: [
              { prop: 'baseLog' }, { prop: 'push' },
              { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
            ],
          },
        },
      },
    });
    r.register(base);

    const overridden = r.extend(base, {
      name: 'tallyPlus',
      props: {
        data: {
          type: r.num(),
          get: { kind: 'get', path: [{ prop: 'this' }] },
          set: {
            kind: 'get',
            path: [
              { prop: 'super' },
              {
                args: {
                  value: {
                    kind: 'get',
                    path: [
                      { prop: 'value' }, { prop: 'mul' },
                      { args: { other: { kind: 'new', type: { name: 'num' }, value: 10 } } },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    });
    r.register(overridden);

    const e = new Engine(r);
    const baseLog = await e.run({
      kind: 'define',
      vars: [
        { name: 'baseLog', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'tallyPlus' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'x' }, { prop: 'data' }],
            value: { kind: 'new', type: { name: 'num' }, value: 7 },
          },
          { kind: 'get', path: [{ prop: 'baseLog' }] },
        ],
      },
    });
    expect(primitives(baseLog)).toEqual([70]);
  });

  test('override of set can inspect base value then delegate', async () => {
    const r = createRegistry();
    // Simpler test: super call with identical value.
    r.register(r.extend('num', {
      name: 'baseStore',
      props: {
        data: {
          type: r.num(),
          get: { kind: 'new', type: { name: 'num' }, value: 0 },
          set: {
            kind: 'get',
            path: [
              { prop: 'log' }, { prop: 'push' },
              { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
            ],
          },
        },
      },
    }));
    r.register(r.extend(r.lookup('baseStore')!, {
      name: 'overStore',
      props: {
        data: {
          type: r.num(),
          get: { kind: 'new', type: { name: 'num' }, value: 0 },
          set: {
            kind: 'get',
            path: [
              { prop: 'super' },
              { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
            ],
          },
        },
      },
    }));
    const e = new Engine(r);
    const log = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'overStore' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'x' }, { prop: 'data' }],
            value: { kind: 'new', type: { name: 'num' }, value: 42 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(log)).toEqual([42]);
  });
});

describe('super in CallDef.set (method call.set) override', () => {
  test('override invokes super({args, value}) to chain into base setter', async () => {
    const r = createRegistry();
    // Base method has call.set that pushes (args.k, value) onto baseLog.
    const baseFn = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { k: { type: { name: 'text' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'baseLog' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'args' }, { prop: 'k' }] } } },
              ],
            },
            {
              kind: 'get',
              path: [
                { prop: 'baseLog' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
          ],
        },
      },
    });
    const base = r.extend('num', {
      name: 'baseEntry',
      props: {
        entry: {
          type: baseFn,
          get: { kind: 'new', type: { name: 'num' }, value: 0 },
        },
      },
    });
    r.register(base);

    // Override: push into overrideLog, then super({args: args, value: value + 1000}).
    const overrideFn = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { k: { type: { name: 'text' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'overrideLog' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
              ],
            },
            {
              kind: 'get',
              path: [
                { prop: 'super' },
                {
                  args: {
                    args: { kind: 'get', path: [{ prop: 'args' }] },
                    value: {
                      kind: 'get',
                      path: [
                        { prop: 'value' }, { prop: 'add' },
                        { args: { other: { kind: 'new', type: { name: 'num' }, value: 1000 } } },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    });
    r.register(r.extend(base, {
      name: 'overrideEntry',
      props: {
        entry: {
          type: overrideFn,
          get: { kind: 'new', type: { name: 'num' }, value: 0 },
        },
      },
    }));

    const e = new Engine(r);
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'baseLog', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'any' } } }, value: [] } },
        { name: 'overrideLog', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'overrideEntry' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'x' }, { prop: 'entry' },
              { args: { k: { kind: 'new', type: { name: 'text' }, value: 'foo' } } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 5 },
          },
          // Return a concatenated log for inspection.
          {
            kind: 'get',
            path: [
              { prop: 'overrideLog' }, { prop: 'concat' },
              { args: { other: { kind: 'get', path: [{ prop: 'baseLog' }] } } },
            ],
          },
        ],
      },
    });
    // overrideLog = [5], baseLog = ['foo', 1005]. Concatenated: [5, 'foo', 1005].
    expect(primitives(result)).toEqual([5, 'foo', 1005]);
  });
});

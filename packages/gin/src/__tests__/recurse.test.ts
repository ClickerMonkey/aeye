import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';

/**
 * `recurse` is a Fn Value in scope inside every callable body — lambda,
 * PropDef.get (method), PropDef.set (method set), CallDef.get, CallDef.set.
 * Calling it re-invokes the same callable (same `this` for methods) with
 * fresh args, enabling anonymous recursion.
 */

describe('recurse in lambda body', () => {
  test('factorial via anonymous recursion', async () => {
    const e = new Engine(createRegistry());
    const v = await e.run({
      kind: 'define',
      vars: [{
        name: 'fact',
        value: {
          kind: 'lambda',
          type: {
            name: 'function',
            call: {
              args: { name: 'obj', props: { n: { type: { name: 'num' } } } },
              returns: { name: 'num' },
            },
          },
          body: {
            kind: 'if',
            ifs: [{
              condition: {
                kind: 'get',
                path: [
                  { prop: 'args' }, { prop: 'n' }, { prop: 'lte' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                ],
              },
              body: { kind: 'new', type: { name: 'num' }, value: 1 },
            }],
            else: {
              kind: 'get',
              path: [
                { prop: 'args' }, { prop: 'n' }, { prop: 'mul' },
                {
                  args: {
                    other: {
                      kind: 'get',
                      path: [
                        { prop: 'recurse' },
                        {
                          args: {
                            n: {
                              kind: 'get',
                              path: [
                                { prop: 'args' }, { prop: 'n' }, { prop: 'sub' },
                                { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      }],
      body: {
        kind: 'get',
        path: [
          { prop: 'fact' },
          { args: { n: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    });
    expect(v.raw).toBe(120);
  });
});

describe('recurse in PropDef.get (method)', () => {
  test('method self-recursion via `recurse`', async () => {
    const r = createRegistry();
    // Extend num with `sumTo(k)` that returns 0+1+…+k.
    r.register(r.extend('num', {
      name: 'summer',
      props: {
        sumTo: {
          type: r.fn(r.obj({ k: { type: r.num() } }), r.num()),
          get: {
            kind: 'if',
            ifs: [{
              condition: {
                kind: 'get',
                path: [
                  { prop: 'args' }, { prop: 'k' }, { prop: 'lte' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                ],
              },
              body: { kind: 'new', type: { name: 'num' }, value: 0 },
            }],
            else: {
              kind: 'get',
              path: [
                { prop: 'args' }, { prop: 'k' }, { prop: 'add' },
                {
                  args: {
                    other: {
                      kind: 'get',
                      path: [
                        { prop: 'recurse' },
                        {
                          args: {
                            k: {
                              kind: 'get',
                              path: [
                                { prop: 'args' }, { prop: 'k' }, { prop: 'sub' },
                                { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'summer' }, value: 0 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'sumTo' },
          { args: { k: { kind: 'new', type: { name: 'num' }, value: 5 } } },
        ],
      },
    });
    expect(v.raw).toBe(15); // 5+4+3+2+1+0
  });

  test('method recurse preserves `this`', async () => {
    const r = createRegistry();
    // times(k) = this * k, but computed as k additions of `this` via recursion.
    r.register(r.extend('num', {
      name: 'multiplier',
      props: {
        times: {
          type: r.fn(r.obj({ k: { type: r.num() } }), r.num()),
          get: {
            kind: 'if',
            ifs: [{
              condition: {
                kind: 'get',
                path: [
                  { prop: 'args' }, { prop: 'k' }, { prop: 'lte' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                ],
              },
              body: { kind: 'new', type: { name: 'num' }, value: 0 },
            }],
            else: {
              kind: 'get',
              path: [
                { prop: 'this' }, { prop: 'add' },
                {
                  args: {
                    other: {
                      kind: 'get',
                      path: [
                        { prop: 'recurse' },
                        {
                          args: {
                            k: {
                              kind: 'get',
                              path: [
                                { prop: 'args' }, { prop: 'k' }, { prop: 'sub' },
                                { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'multiplier' }, value: 7 } }],
      body: {
        kind: 'get',
        path: [
          { prop: 'x' }, { prop: 'times' },
          { args: { k: { kind: 'new', type: { name: 'num' }, value: 4 } } },
        ],
      },
    });
    expect(v.raw).toBe(28); // 7 + 7 + 7 + 7
  });
});

describe('recurse in CallDef.get', () => {
  test('JSON-declared callable recurses via `recurse`', async () => {
    const r = createRegistry();
    const countdownFn = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { n: { type: { name: 'num' } } } },
        returns: { name: 'num' },
        get: {
          kind: 'if',
          ifs: [{
            condition: {
              kind: 'get',
              path: [
                { prop: 'args' }, { prop: 'n' }, { prop: 'lte' },
                { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
              ],
            },
            body: { kind: 'new', type: { name: 'num' }, value: 0 },
          }],
          else: {
            kind: 'get',
            path: [
              { prop: 'args' }, { prop: 'n' }, { prop: 'add' },
              {
                args: {
                  other: {
                    kind: 'get',
                    path: [
                      { prop: 'recurse' },
                      {
                        args: {
                          n: {
                            kind: 'get',
                            path: [
                              { prop: 'args' }, { prop: 'n' }, { prop: 'sub' },
                              { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    });
    const e = new Engine(r);
    e.registerGlobal('countdown', { type: countdownFn, value: null });
    const v = await e.run({
      kind: 'get',
      path: [
        { prop: 'countdown' },
        { args: { n: { kind: 'new', type: { name: 'num' }, value: 5 } } },
      ],
    });
    expect(v.raw).toBe(15); // 5+4+3+2+1+0
  });
});

describe('recurse in CallDef.set (method)', () => {
  test('setter recurses to drain a counter into a log', async () => {
    const r = createRegistry();
    // x.drain({k}) = _ — walks k..0, pushing each to log via recurse.
    const drainFn = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { k: { type: { name: 'num' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'args' }, { prop: 'k' }] } } },
              ],
            },
            {
              kind: 'if',
              ifs: [{
                condition: {
                  kind: 'get',
                  path: [
                    { prop: 'args' }, { prop: 'k' }, { prop: 'gt' },
                    { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                  ],
                },
                body: {
                  kind: 'get',
                  path: [
                    { prop: 'recurse' },
                    {
                      args: {
                        k: {
                          kind: 'get',
                          path: [
                            { prop: 'args' }, { prop: 'k' }, { prop: 'sub' },
                            { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                          ],
                        },
                      },
                    },
                  ],
                },
              }],
            },
          ],
        },
      },
    });
    r.register(r.extend('num', {
      name: 'drainer',
      props: {
        drain: {
          type: drainFn,
          get: { kind: 'new', type: { name: 'num' }, value: 0 },
        },
      },
    }));
    const e = new Engine(r);
    const log = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'drainer' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'x' }, { prop: 'drain' },
              { args: { k: { kind: 'new', type: { name: 'num' }, value: 3 } } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 0 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(log)).toEqual([3, 2, 1, 0]);
  });
});

describe('recurse in CallDef.set (direct call)', () => {
  test('direct-call setter recurses', async () => {
    const r = createRegistry();
    const fnType = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { k: { type: { name: 'num' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'args' }, { prop: 'k' }] } } },
              ],
            },
            {
              kind: 'if',
              ifs: [{
                condition: {
                  kind: 'get',
                  path: [
                    { prop: 'args' }, { prop: 'k' }, { prop: 'gt' },
                    { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                  ],
                },
                body: {
                  kind: 'get',
                  path: [
                    { prop: 'recurse' },
                    {
                      args: {
                        k: {
                          kind: 'get',
                          path: [
                            { prop: 'args' }, { prop: 'k' }, { prop: 'sub' },
                            { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                          ],
                        },
                      },
                    },
                  ],
                },
              }],
            },
          ],
        },
      },
    });
    const e = new Engine(r);
    e.registerGlobal('sink', { type: fnType, value: null });
    const log = await e.run({
      kind: 'define',
      vars: [{ name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'sink' },
              { args: { k: { kind: 'new', type: { name: 'num' }, value: 2 } } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 0 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(log)).toEqual([2, 1, 0]);
  });
});

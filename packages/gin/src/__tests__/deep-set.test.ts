import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry, Engine } from '../index';
import { val, Value } from '../value';

/**
 * Deep-set paths — the last step picks the write target while earlier steps
 * navigate. Covers:
 *   - method call → index set   (obj.method(args)[key] = value)
 *   - method call → prop   set   (obj.method(args).prop = value)
 *   - field      → index set   (obj.field[key] = value)
 *   - method call with call.set  (obj.method(args) = value)
 *   - direct call with call.set  (fn(args)        = value)
 */

describe('set return value + safe-navigation', () => {
  test('successful set returns bool(true)', async () => {
    const e = new Engine(createRegistry());
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'arr', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] } }],
      body: {
        kind: 'set',
        path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
        value: { kind: 'new', type: { name: 'num' }, value: 99 },
      },
    });
    expect(v.raw).toBe(true);
    expect(v.type.name).toBe('bool');
  });

  test('bare variable assignment returns bool(true)', async () => {
    const e = new Engine(createRegistry());
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      body: {
        kind: 'set',
        path: [{ prop: 'x' }],
        value: { kind: 'new', type: { name: 'num' }, value: 2 },
      },
    });
    expect(v.raw).toBe(true);
  });

  test('prop deref on null raw short-circuits to bool(false)', async () => {
    const e = new Engine(createRegistry());
    const objType = e.registry.obj({
      inner: { type: e.registry.map(e.registry.text(), e.registry.num()) },
    });
    // Plant a box whose raw is null — navigating .inner must abort the set.
    e.registerGlobal('box', { type: objType, value: null });
    const v = await e.run({
      kind: 'set',
      path: [
        { prop: 'box' }, { prop: 'inner' },
        { key: { kind: 'new', type: { name: 'text' }, value: 'k' } },
      ],
      value: { kind: 'new', type: { name: 'num' }, value: 42 },
    });
    expect(v.raw).toBe(false);
  });

  test('index deref on null raw short-circuits to bool(false)', async () => {
    const e = new Engine(createRegistry());
    const nestedListType = e.registry.list(e.registry.list(e.registry.num()));
    e.registerGlobal('holder', { type: nestedListType, value: null });
    const v = await e.run({
      kind: 'set',
      path: [
        { prop: 'holder' },
        { key: { kind: 'new', type: { name: 'num' }, value: 0 } },
        { key: { kind: 'new', type: { name: 'num' }, value: 0 } },
      ],
      value: { kind: 'new', type: { name: 'num' }, value: 99 },
    });
    expect(v.raw).toBe(false);
  });

  test('null produced mid-path (method returning null) short-circuits to false', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'nullProducer',
      props: {
        maybeMap: {
          type: r.fn(r.obj({}), r.map(r.text(), r.num())),
          get: { kind: 'native', id: 'test.null-map' },
        },
      },
    }));
    r.setNative('test.null-map', (_scope, reg) => val(reg.map(reg.text(), reg.num()), null as any));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'nullProducer' }, value: 0 } }],
      body: {
        kind: 'set',
        path: [
          { prop: 'x' }, { prop: 'maybeMap' }, { args: {} },
          { key: { kind: 'new', type: { name: 'text' }, value: 'foo' } },
        ],
        value: { kind: 'new', type: { name: 'num' }, value: 42 },
      },
    });
    expect(v.raw).toBe(false);
  });

  test('safe-nav does NOT short-circuit a call step (Fn raw may be null)', async () => {
    const r = createRegistry();
    const fnType = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { k: { type: { name: 'text' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'get',
          path: [
            { prop: 'log' }, { prop: 'push' },
            { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
          ],
        },
      },
    });
    const e = new Engine(r);
    e.registerGlobal('sink', { type: fnType, value: null });
    const ok = await e.run({
      kind: 'define',
      vars: [{ name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } }],
      body: {
        kind: 'set',
        path: [
          { prop: 'sink' },
          { args: { k: { kind: 'new', type: { name: 'text' }, value: 'hi' } } },
        ],
        value: { kind: 'new', type: { name: 'num' }, value: 1 },
      },
    });
    expect(ok.raw).toBe(true);
  });
});

describe('deep set: method call → index set', () => {
  test('`this.blah({a: 33})[x] = meow` writes through the method-returned map', async () => {
    const r = createRegistry();
    // map<text, num> + a method `scope({a}) -> this` so the returned map is the same reference.
    r.register(r.extend(r.map(r.text(), r.num()), {
      name: 'taggedMap',
      props: {
        scope: {
          type: r.fn(r.obj({ a: { type: r.num() } }), r.map(r.text(), r.num())),
          get: { kind: 'get', path: [{ prop: 'this' }] },
        },
      },
    }));
    const e = new Engine(r);
    const v = await e.run({
      kind: 'define',
      vars: [{ name: 'm', value: { kind: 'new', type: { name: 'taggedMap' } } }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'm' }, { prop: 'scope' },
              { args: { a: { kind: 'new', type: { name: 'num' }, value: 33 } } },
              { key: { kind: 'new', type: { name: 'text' }, value: 'meow' } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 99 },
          },
          { kind: 'get', path: [{ prop: 'm' }] },
        ],
      },
    });
    expect(v.raw).toBeInstanceOf(Map);
    const entry = (v.raw as Map<string, [Value, Value]>).get('meow')!;
    expect(entry[1].raw).toBe(99);
  });
});

describe('deep set: method call → prop set', () => {
  test('runs the returned value\'s PropDef.set', async () => {
    const r = createRegistry();
    r.register(r.extend('num', {
      name: 'tattler',
      props: {
        shadow: {
          type: r.num(),
          get: { kind: 'get', path: [{ prop: 'this' }] },
          set: {
            kind: 'get',
            path: [
              { prop: 'log' }, { prop: 'push' },
              { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
            ],
          },
        },
        self: {
          type: r.fn(r.obj({}), r.alias('tattler')),
          get: { kind: 'get', path: [{ prop: 'this' }] },
        },
      },
    }));
    const e = new Engine(r);
    const log = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'tattler' }, value: 42 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'x' }, { prop: 'self' }, { args: {} },
              { prop: 'shadow' },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 7 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(log)).toEqual([7]);
  });
});

describe('deep set: field → index set', () => {
  test('`obj.inner[key] = value` mutates the inner map', async () => {
    const e = new Engine(createRegistry());
    const v = await e.run({
      kind: 'define',
      vars: [{
        name: 'box',
        value: {
          kind: 'new',
          type: {
            name: 'obj',
            props: { inner: { type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } } },
          },
          value: { inner: [['a', 1]] },
        },
      }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'box' }, { prop: 'inner' },
              { key: { kind: 'new', type: { name: 'text' }, value: 'b' } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 99 },
          },
          { kind: 'get', path: [{ prop: 'box' }, { prop: 'inner' }] },
        ],
      },
    });
    expect(v.raw).toBeInstanceOf(Map);
    const m = v.raw as Map<string, [Value, Value]>;
    expect(m.get('a')![1].raw).toBe(1);
    expect(m.get('b')![1].raw).toBe(99);
  });
});

describe('deep set: method call with CallDef.set', () => {
  test('`obj.method(args) = value` invokes the method\'s call.set', async () => {
    const r = createRegistry();
    // Method whose Fn type has call.set — set body pushes {args.key, value} to log.
    const setterFn = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { key: { type: { name: 'text' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'block',
          lines: [
            {
              kind: 'get',
              path: [
                { prop: 'log' }, { prop: 'push' },
                { args: { value: { kind: 'get', path: [{ prop: 'args' }, { prop: 'key' }] } } },
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
    });
    r.register(r.extend('num', {
      name: 'record',
      props: {
        entry: {
          type: setterFn,
          // get returns args.key concatenated — not exercised here, but required for the prop.
          get: {
            kind: 'new', type: { name: 'num' }, value: 0,
          },
        },
      },
    }));
    const e = new Engine(r);
    const result = await e.run({
      kind: 'define',
      vars: [
        { name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'any' } } }, value: [] } },
        { name: 'x', value: { kind: 'new', type: { name: 'record' }, value: 0 } },
      ],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'x' }, { prop: 'entry' },
              { args: { key: { kind: 'new', type: { name: 'text' }, value: 'foo' } } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 42 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(result)).toEqual(['foo', 42]);
  });
});

describe('deep set: direct call with CallDef.set', () => {
  test('`fn(args) = value` invokes the Fn\'s call.set', async () => {
    const r = createRegistry();
    const fnType = r.parse({
      name: 'function',
      call: {
        args: { name: 'obj', props: { k: { type: { name: 'text' } } } },
        returns: { name: 'num' },
        set: {
          kind: 'get',
          path: [
            { prop: 'log' }, { prop: 'push' },
            { args: { value: { kind: 'get', path: [{ prop: 'value' }] } } },
          ],
        },
      },
    });
    const e = new Engine(r);
    e.registerGlobal('sink', { type: fnType, value: null });
    const result = await e.run({
      kind: 'define',
      vars: [{ name: 'log', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] } }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [
              { prop: 'sink' },
              { args: { k: { kind: 'new', type: { name: 'text' }, value: 'hi' } } },
            ],
            value: { kind: 'new', type: { name: 'num' }, value: 77 },
          },
          { kind: 'get', path: [{ prop: 'log' }] },
        ],
      },
    });
    expect(primitives(result)).toEqual([77]);
  });

  test('`fn(args) = value` throws when Fn has no call.set', async () => {
    const e = new Engine(createRegistry());
    await expect(e.run({
      kind: 'define',
      vars: [{
        name: 'fn',
        value: {
          kind: 'lambda',
          type: { name: 'function', call: { args: { name: 'obj' }, returns: { name: 'num' } } },
          body: { kind: 'new', type: { name: 'num' }, value: 0 },
        },
      }],
      body: {
        kind: 'set',
        path: [{ prop: 'fn' }, { args: {} }],
        value: { kind: 'new', type: { name: 'num' }, value: 1 },
      },
    })).rejects.toThrow(/no call\.set/);
  });
});

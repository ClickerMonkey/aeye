import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * Engine.validate reports problems for unsettable final steps on set paths:
 *   - {prop} last step without PropDef.set
 *   - {key}  last step without GetSetDef.set
 *   - {args} last step (method or direct call) without CallDef.set
 * Intermediate steps still only need navigation (get-mode); they are NOT
 * required to be settable.
 */

function codes(e: Engine, expr: unknown): string[] {
  return e.validate(expr as any).list.map((p) => p.code);
}

describe('validate set — positive cases (no settability errors)', () => {
  test('bare variable assignment', () => {
    const e = new Engine(createRegistry());
    expect(codes(e, {
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 1 } }],
      body: { kind: 'set', path: [{ prop: 'x' }], value: { kind: 'new', type: { name: 'num' }, value: 2 } },
    })).toEqual([]);
  });

  test('list index set (gs.set present)', () => {
    const e = new Engine(createRegistry());
    expect(codes(e, {
      kind: 'define',
      vars: [{ name: 'a', value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1] } }],
      body: {
        kind: 'set',
        path: [{ prop: 'a' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
        value: { kind: 'new', type: { name: 'num' }, value: 9 },
      },
    })).toEqual([]);
  });

  test('method(args)[key] (mid-path call, index-set at end) is fine', () => {
    const r = createRegistry();
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
    expect(codes(e, {
      kind: 'define',
      vars: [{ name: 'm', value: { kind: 'new', type: { name: 'taggedMap' } } }],
      body: {
        kind: 'set',
        path: [
          { prop: 'm' }, { prop: 'scope' },
          { args: { a: { kind: 'new', type: { name: 'num' }, value: 1 } } },
          { key: { kind: 'new', type: { name: 'text' }, value: 'k' } },
        ],
        value: { kind: 'new', type: { name: 'num' }, value: 1 },
      },
    })).toEqual([]);
  });
});

describe('validate set — negative cases (errors flagged)', () => {
  test('index-set on a type with no gs.set (num: loop only)', () => {
    const e = new Engine(createRegistry());
    const c = codes(e, {
      kind: 'define',
      vars: [{ name: 'n', value: { kind: 'new', type: { name: 'num' }, value: 5 } }],
      body: {
        kind: 'set',
        path: [{ prop: 'n' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }],
        value: { kind: 'new', type: { name: 'num' }, value: 1 },
      },
    });
    expect(c).toContain('set.index.no-set');
  });

  test('prop-set on a field with no PropDef.set', () => {
    const r = createRegistry();
    // An Extension that adds a prop with get only — no set.
    r.register(r.extend('num', {
      name: 'readonly',
      props: {
        doubled: {
          type: r.num(),
          get: { kind: 'get', path: [{ prop: 'this' }] },
        },
      },
    }));
    const e = new Engine(r);
    const c = codes(e, {
      kind: 'define',
      vars: [{ name: 'x', value: { kind: 'new', type: { name: 'readonly' }, value: 1 } }],
      body: {
        kind: 'set',
        path: [{ prop: 'x' }, { prop: 'doubled' }],
        value: { kind: 'new', type: { name: 'num' }, value: 2 },
      },
    });
    expect(c).toContain('set.prop.no-set');
  });

  test('method-call-set without call.set', () => {
    const e = new Engine(createRegistry());
    const c = codes(e, {
      kind: 'define',
      vars: [{
        name: 'x',
        value: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [] },
      }],
      body: {
        kind: 'set',
        path: [
          { prop: 'x' }, { prop: 'push' },
          { args: { value: { kind: 'new', type: { name: 'num' }, value: 1 } } },
        ],
        value: { kind: 'new', type: { name: 'num' }, value: 2 },
      },
    });
    expect(c).toContain('set.call.no-set');
  });

  test('direct-call set without call.set', () => {
    const e = new Engine(createRegistry());
    const c = codes(e, {
      kind: 'define',
      vars: [{
        name: 'fn',
        value: {
          kind: 'lambda',
          type: { name: 'function', call: { args: { name: 'object' }, returns: { name: 'num' } } },
          body: { kind: 'new', type: { name: 'num' }, value: 0 },
        },
      }],
      body: {
        kind: 'set',
        path: [{ prop: 'fn' }, { args: {} }],
        value: { kind: 'new', type: { name: 'num' }, value: 1 },
      },
    });
    expect(c).toContain('set.call.no-set');
  });
});

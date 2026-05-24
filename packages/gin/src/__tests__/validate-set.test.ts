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
          type: r.fn({ args: r.obj({ a: { type: r.num() } }), returns: r.map(r.text(), r.num()) }),
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

  test('prop-set on a computed prop (has get, no set) → set.prop.computed', () => {
    const r = createRegistry();
    // An Extension that adds a prop with `get` only — no `set`. Writing
    // to it is a runtime impossibility because the read is computed;
    // there's no underlying slot to hold a written value.
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
    expect(c).toContain('set.prop.computed');
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
          type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'num' } } },
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

  test('prop-set on a vanilla data field (no get, no set) — validates AND runs', async () => {
    // The canonical "vars.foo = 'x'" case. A plain obj field with no
    // get / set Expr is a data slot; writing to it should be allowed
    // by the validator AND should actually update the raw value at
    // runtime. Without the fall-through, ginny's `vars` global was
    // unwritable from inside a gin program.
    const { createRegistry, Engine } = await import('../index');
    const r = createRegistry();
    const e = new Engine(r);

    // Simulate ginny's `vars` global — an obj with one text-typed slot.
    const varsType = r.obj({ apiKey: { type: r.text() } });
    e.registerGlobal('vars', { type: varsType, value: { apiKey: '' } });

    // Validate: no `set.prop.computed` / `set.prop.method` flagged
    // for a vanilla data field.
    const probs = e.validate({
      kind: 'set',
      path: [{ prop: 'vars' }, { prop: 'apiKey' }],
      value: { kind: 'new', type: { name: 'text' }, value: 'sk-test' },
    });
    expect(probs.list.some((p) => p.code === 'set.prop.computed')).toBe(false);
    expect(probs.list.some((p) => p.code === 'set.prop.method')).toBe(false);

    // Runtime: assignment should land on the underlying raw object.
    await e.run({
      kind: 'set',
      path: [{ prop: 'vars' }, { prop: 'apiKey' }],
      value: { kind: 'new', type: { name: 'text' }, value: 'sk-test' },
    });
    const back = await e.run({
      kind: 'get',
      path: [{ prop: 'vars' }, { prop: 'apiKey' }],
    });
    expect(back.raw).toBe('sk-test');
  });

  test('prop-set on a method-typed prop is NOT flagged (the call may have its own .set)', () => {
    // A prop whose type is callable could still be writable via the
    // call's own `set` mechanism, or via a custom prop-level `set`
    // added by an extension. The validator doesn't have enough info
    // at this step to decide, so it stays silent and lets the
    // runtime surface a clear error if the assignment turns out to
    // be impossible.
    const e = new Engine(createRegistry());
    const c = codes(e, {
      kind: 'define',
      vars: [{ name: 'n', value: { kind: 'new', type: { name: 'num' }, value: 5 } }],
      body: {
        kind: 'set',
        path: [{ prop: 'n' }, { prop: 'add' }],
        value: { kind: 'new', type: { name: 'num' }, value: 0 },
      },
    });
    expect(c).not.toContain('set.prop.method');
    expect(c).not.toContain('set.prop.computed');
  });
});

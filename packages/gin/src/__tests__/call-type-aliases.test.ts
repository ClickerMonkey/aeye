import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, FnType, ListType, type TypeDef } from '../index';
import { AliasType } from '../types/alias';
import { LocalScope } from '../type-scope';

/**
 * Call-level type aliases (`CallDef.types`) — declared aliases are
 * bound into a `LocalScope` while the call's slots parse, so bare
 * `{name: '<alias>'}` references inside `args` / `returns` / `throws`
 * resolve to AliasType wrappers around the alias's parsed Type.
 *
 * Round-trip is symmetric: `toJSON` re-emits the alias map and the
 * bare-name references; `parse` rebuilds the same structure.
 */

const r = createRegistry();
const e = new Engine(r);

describe('CallDef.types — basic resolution', () => {
  test('alias referenced twice in args resolves to the alias target', () => {
    const fn = r.parse({
      name: 'function',
      call: {
        types: { counter: { name: 'num', options: { whole: true, min: 1 } } },
        args: { name: 'object', props: { a: { type: { name: 'counter' } }, b: { type: { name: 'counter' } } } },
        returns: { name: 'counter' },
      },
    });
    // toCode resolves through AliasType.simplify-style behavior — both
    // `a` and `b` show as the alias's resolved underlying type.
    expect(fn.toCode()).toContain('a: counter');
    expect(fn.toCode()).toContain('b: counter');
    // The parsed args' value Type for `a` and `b` is an AliasType
    // pointing to `counter`; resolved properties reflect the underlying
    // num{whole, min:1}.
    const fields = ((fn as FnType)._call.args as unknown as { fields: Record<string, { type: { name: string; valid(x: unknown): boolean } }> }).fields;
    expect(fields.a!.type.valid(5)).toBe(true);
    expect(fields.a!.type.valid(0)).toBe(false);
  });

  test('sequential aliases — later refs earlier', () => {
    const fn = r.parse({
      name: 'function',
      call: {
        types: {
          A: { name: 'num', options: { whole: true, min: 1 } },
          B: { name: 'list', generic: { V: { name: 'A' } } },
        },
        args: { name: 'object', props: { items: { type: { name: 'B' } } } },
        returns: { name: 'A' },
      },
    });
    const items = ((fn as FnType)._call.args as unknown as { fields: Record<string, { type: unknown }> })
      .fields['items']!.type as { simplify(): ListType };
    // items is an AliasType('B'); its resolved target is list<A>.
    const list = items.simplify() as ListType;
    expect(list.name).toBe('list');
    // The list's V is itself an alias for A; A → num{min:1, whole:true}.
    const v = (list.item as { simplify(): { name: string; options: { min?: number } } }).simplify();
    expect(v.name).toBe('num');
    expect(v.options.min).toBe(1);
  });

  test('alias references generic — extra-scope T=text resolves through the alias', () => {
    const fn = r.parse({
      name: 'function',
      generic: { T: { name: 'T' } },
      call: {
        types: {
          valueList: { name: 'list', generic: { V: { name: 'T' } } },
        },
        args: { name: 'object', props: { items: { type: { name: 'valueList' } } } },
        returns: { name: 'T' },
      },
    });
    const local = new LocalScope(r, { T: r.text() });
    // items.type is AliasType('valueList'); its captured scope binds
    // valueList → list<AliasType('T')>. With the extra scope binding
    // T → text, the resolved chain is list<text>.
    const items = ((fn as FnType)._call.args.props() as Record<string, { type: unknown }>)['items']!
      .type as AliasType;
    const list = items.simplify(local) as ListType;
    expect(list.name).toBe('list');
    expect((list.item as AliasType).simplify(local).name).toBe('text');
  });
});

describe('CallDef.types — round-trip', () => {
  test('toJSON preserves the source `types` map and alias references', () => {
    const def: TypeDef = {
      name: 'function',
      call: {
        types: { counter: { name: 'num', options: { whole: true, min: 1 } } },
        args: { name: 'object', props: { a: { type: { name: 'counter' } } } },
        returns: { name: 'counter' },
      },
    };
    const fn = r.parse(def);
    const json = fn.toJSON();
    expect(json.call?.types).toBeDefined();
    expect(json.call?.types?.['counter']).toEqual({ name: 'num', options: { whole: true, min: 1 } });
    // The args slot still references the alias by NAME (bare form).
    expect(json.call?.args).toEqual({ name: 'object', props: { a: { type: { name: 'counter' } } } });
    expect(json.call?.returns).toEqual({ name: 'counter' });
  });

  test('parse → toJSON → parse produces structurally identical args', () => {
    const def: TypeDef = {
      name: 'function',
      call: {
        types: {
          A: { name: 'num', options: { min: 0 } },
          B: { name: 'list', generic: { V: { name: 'A' } } },
        },
        args: { name: 'object', props: { xs: { type: { name: 'B' } } } },
        returns: { name: 'A' },
      },
    };
    const a = r.parse(def);
    const b = r.parse(a.toJSON());
    expect((a as FnType)._call.args.toJSON()).toEqual((b as FnType)._call.args.toJSON());
    expect((a as FnType)._call.returns?.toJSON()).toEqual((b as FnType)._call.returns?.toJSON());
  });

  test('toJSON output is stable — call-site bindings do not mutate the source', () => {
    // Without an eager bind step, the FnType instance is unchanged
    // regardless of which scopes consult it. toJSON always emits the
    // declared shape — `T` survives bare, `box` survives.
    const fn = r.parse({
      name: 'function',
      generic: { T: { name: 'T' } },
      call: {
        types: { box: { name: 'list', generic: { V: { name: 'T' } } } },
        args: { name: 'object', props: { v: { type: { name: 'box' } } } },
        returns: { name: 'T' },
      },
    });
    // Use the type with an extra scope (R=text) — this does NOT mutate
    // anything; no rebuild happens.
    const local = new LocalScope(r, { T: r.text() });
    fn.call(local);                // exercise the call-site path
    const j = fn.toJSON();
    expect(j.call?.types?.['box']).toEqual({ name: 'list', generic: { V: { name: 'T' } } });
    expect(j.call?.returns).toEqual({ name: 'T' });
  });
});

describe('CallDef.types — ExprDef bodies', () => {
  test('alias referenced inside `call.get` body resolves correctly', async () => {
    // counterFn() => 7 (where `counter` aliases num{min:1, whole:true})
    const fnType = r.parse({
      name: 'function',
      call: {
        types: { counter: { name: 'num', options: { whole: true, min: 1 } } },
        args: { name: 'object' },
        returns: { name: 'counter' },
        get: { kind: 'new', type: { name: 'counter' }, value: 7 },
      },
    });
    e.registerGlobal('counterFn', { type: fnType, value: null });
    const v = await e.run({
      kind: 'get',
      path: [{ prop: 'counterFn' }, { args: {} }],
    });
    expect(v.raw).toBe(7);
  });
});

describe('CallDef.types — toCodeDefinition rendering', () => {
  test('aliases render as `type X = …;` lines before the call signature', () => {
    const fn = r.parse({
      name: 'function',
      call: {
        types: { counter: { name: 'num', options: { whole: true, min: 1 } } },
        args: { name: 'object', props: { n: { type: { name: 'counter' } } } },
        returns: { name: 'counter' },
      },
    });
    const def = fn.toCodeDefinition();
    const aliasIdx = def.indexOf('type counter');
    const callIdx  = def.indexOf('(n:');
    expect(aliasIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(aliasIdx).toBeLessThan(callIdx);
  });
});

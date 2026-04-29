import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, FnType, ListType, type TypeDef } from '../index';

/**
 * Call-level type aliases (`CallDef.types`) — verify the inliner
 * resolves bare `{name: '<alias>'}` references in args/returns/throws
 * /get/set, that round-trip preserves the source form, that
 * substitution drops aliases, and that the various validation cases
 * throw with the expected error codes.
 */

const r = createRegistry();
const e = new Engine(r);

const numLit = (n: number) => ({ kind: 'new', type: { name: 'num' }, value: n }) as const;

describe('CallDef.types — basic resolution', () => {
  test('alias referenced twice in args resolves identically to inlined form', () => {
    const aliased = r.parse({
      name: 'function',
      call: {
        types: { counter: { name: 'num', options: { whole: true, min: 1 } } },
        args: { name: 'object', props: { a: { type: { name: 'counter' } }, b: { type: { name: 'counter' } } } },
        returns: { name: 'counter' },
      },
    });
    const inlined = r.parse({
      name: 'function',
      call: {
        args: { name: 'object', props: {
          a: { type: { name: 'num', options: { whole: true, min: 1 } } },
          b: { type: { name: 'num', options: { whole: true, min: 1 } } },
        } },
        returns: { name: 'num', options: { whole: true, min: 1 } },
      },
    });
    expect(aliased.toCode()).toContain('a: num');
    expect(aliased.toCode()).toContain('b: num');
    // Structural equality on the inlined parsed forms.
    expect((aliased as FnType)._call.args.toJSON()).toEqual((inlined as FnType)._call.args.toJSON());
    expect((aliased as FnType)._call.returns?.toJSON()).toEqual((inlined as FnType)._call.returns?.toJSON());
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
      .fields['items']!.type as ListType;
    expect(items.name).toBe('list');
    expect(items.item.name).toBe('num');
    // The element type's options carry through.
    expect((items.item.options as { min?: number }).min).toBe(1);
  });

  test('alias references generic — bind substitutes inside the inlined tree', () => {
    const fn = r.parse({
      name: 'function',
      generic: { T: { name: 'generic', options: { name: 'T' } } },
      call: {
        types: {
          valueList: { name: 'list', generic: { V: { name: 'generic', options: { name: 'T' } } } },
        },
        args: { name: 'object', props: { items: { type: { name: 'valueList' } } } },
        returns: { name: 'generic', options: { name: 'T' } },
      },
    });
    const bound = fn.bind({ T: r.text() });
    const items = ((bound as FnType)._call.args as unknown as { fields: Record<string, { type: unknown }> })
      .fields['items']!.type as ListType;
    expect(items.item.name).toBe('text');
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
    // The args slot still references the alias by name (NOT inlined).
    expect(json.call?.args).toEqual({ name: 'object', props: { a: { type: { name: 'counter' } } } });
    expect(json.call?.returns).toEqual({ name: 'counter' });
  });

  test('parse → toJSON → parse produces structurally identical inlined args', () => {
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

  test('post-bind toJSON drops `types` and emits inlined args', () => {
    const fn = r.parse({
      name: 'function',
      generic: { T: { name: 'generic', options: { name: 'T' } } },
      call: {
        types: { box: { name: 'list', generic: { V: { name: 'generic', options: { name: 'T' } } } } },
        args: { name: 'object', props: { v: { type: { name: 'box' } } } },
        returns: { name: 'generic', options: { name: 'T' } },
      },
    });
    const bound = fn.bind({ T: r.text() });
    const j = bound.toJSON();
    expect(j.call?.types).toBeUndefined();
    // args is now the fully-inlined-and-bound form (list<text>).
    const v = (j.call?.args as { props?: Record<string, { type: TypeDef }> }).props!['v']!.type;
    expect(v.name).toBe('list');
  });
});

describe('CallDef.types — validation errors', () => {
  test('alias name conflicts with built-in class → throws', () => {
    expect(() => r.parse({
      name: 'function',
      call: {
        types: { list: { name: 'num' } },
        args: { name: 'object' },
      },
    })).toThrow(/call\.types\.name-conflict/);
  });

  test('empty alias name → throws', () => {
    expect(() => r.parse({
      name: 'function',
      call: {
        types: { '': { name: 'num' } },
        args: { name: 'object' },
      },
    })).toThrow(/call\.types\.empty-name/);
  });

  test('forward reference → throws', () => {
    expect(() => r.parse({
      name: 'function',
      call: {
        types: {
          A: { name: 'B' },                       // refs B before B is declared
          B: { name: 'num' },
        },
        args: { name: 'object' },
      },
    })).toThrow(/call\.types\.forward-ref/);
  });

  test('self reference → throws', () => {
    expect(() => r.parse({
      name: 'function',
      call: {
        types: { recur: { name: 'list', generic: { V: { name: 'recur' } } } },
        args: { name: 'object' },
      },
    })).toThrow(/call\.types\.forward-ref/);
  });

  test('alias name in `extends` → throws extends-alias', () => {
    expect(() => r.parse({
      name: 'function',
      call: {
        types: { Foo: { name: 'num' } },
        args: { name: 'object', props: { x: { type: { name: 'obj', extends: 'Foo' } } } },
      },
    })).toThrow(/call\.types\.extends-alias/);
  });

  test('alias name in `satisfies` → throws extends-alias', () => {
    expect(() => r.parse({
      name: 'function',
      call: {
        types: { Bar: { name: 'num' } },
        args: { name: 'object', props: { x: { type: { name: 'obj', satisfies: ['Bar'] } } } },
      },
    })).toThrow(/call\.types\.extends-alias/);
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

describe('CallDef.types — lambdas inherit aliases from their fnType', () => {
  test('lambda body referencing a call.types alias parses (was failing before)', () => {
    const lam = r.parseExpr({
      kind: 'lambda',
      type: {
        name: 'function',
        call: {
          types: { positiveInt: { name: 'num', options: { whole: true, min: 1 } } },
          args: { name: 'object' },
          returns: { name: 'positiveInt' },
        },
      },
      body: { kind: 'new', type: { name: 'positiveInt' }, value: 5 },
    });
    expect(lam.kind).toBe('lambda');
    // The body's parsed form has the alias inlined (so the engine sees
    // a real num type, not an unresolvable name).
    const bodyJson = lam.body.toJSON() as { type: { name: string; options?: { min?: number } } };
    expect(bodyJson.type.name).toBe('num');
    expect(bodyJson.type.options?.min).toBe(1);
  });

  test('lambda constraint can also reference call.types aliases', () => {
    const lam = r.parseExpr({
      kind: 'lambda',
      type: {
        name: 'function',
        call: {
          types: { positiveInt: { name: 'num', options: { whole: true, min: 1 } } },
          args: { name: 'object', props: { n: { type: { name: 'positiveInt' } } } },
          returns: { name: 'bool' },
        },
      },
      // Constraint compares args.n against a positiveInt literal.
      constraint: {
        kind: 'get',
        path: [
          { prop: 'args' }, { prop: 'n' }, { prop: 'gte' },
          { args: { other: { kind: 'new', type: { name: 'positiveInt' }, value: 1 } } },
        ],
      },
      body: { kind: 'new', type: { name: 'bool' }, value: true },
    });
    expect(lam.constraint).toBeDefined();
  });

  test('lambda toJSON round-trips with alias refs intact in body', () => {
    const def = {
      kind: 'lambda' as const,
      type: {
        name: 'function',
        call: {
          types: { positiveInt: { name: 'num', options: { whole: true, min: 1 } } },
          args: { name: 'object' },
          returns: { name: 'positiveInt' },
        },
      },
      body: { kind: 'new' as const, type: { name: 'positiveInt' }, value: 5 },
    };
    const lam = r.parseExpr(def);
    const json = lam.toJSON() as { body: { type: { name: string } } };
    // Source body preserved — emits `{name: 'positiveInt'}`, NOT the
    // inlined `{name: 'num', options: {...}}`.
    expect(json.body.type.name).toBe('positiveInt');
    // Re-parse should still work and produce the same result.
    const lam2 = r.parseExpr(json as never);
    const body2 = lam2.body.toJSON() as { type: { name: string } };
    expect(body2.type.name).toBe('num'); // re-inlined on parse
  });

  test('lambda WITHOUT call.types behaves exactly as before', () => {
    const lam = r.parseExpr({
      kind: 'lambda',
      type: {
        name: 'function',
        call: {
          args: { name: 'object', props: { n: { type: { name: 'num' } } } },
          returns: { name: 'num' },
        },
      },
      body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] },
    });
    const json = lam.toJSON() as { body: { kind: string } };
    expect(json.body.kind).toBe('get');
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
    // The alias line precedes the call-signature line.
    const aliasIdx = def.indexOf('type counter');
    const callIdx  = def.indexOf('(n:');
    expect(aliasIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(aliasIdx).toBeLessThan(callIdx);
    // The call sig itself uses the alias-resolved name (num), since
    // formatParams renders parsed Types — whether it shows `counter`
    // or `num` depends on the inlined tree. We just confirm the
    // signature is present and the alias header is too.
    expect(def).toContain('type counter');
  });
});

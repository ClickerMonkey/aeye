import { describe, test, expect } from 'vitest';
import { createRegistry, typeReferences, typeClosure, type TypeDef, type TypeResolver } from '../index';

/**
 * A def from elsewhere parses to the intended type only where the names it
 * refers to resolve. These tests pin which names `typeReferences` reports, and
 * that `typeClosure` / `Type.closure` follow them through a resolver in an
 * order a scope can be built from.
 */
const r = createRegistry();
const refs = (def: TypeDef) => typeReferences(def, r).refs;

describe('typeReferences — direct', () => {
  test('enum members and literal values are constants, never references', () => {
    const order: TypeDef = { name: 'enum', options: { values: { name: 'name', score: 'score' } } };
    const literal: TypeDef = { name: 'literal', generic: { T: { name: 'Customer' } }, options: { value: { name: 'Order' } } };
    expect(refs({ name: 'obj', props: { order: { type: order }, pick: { type: literal } } })).toEqual(['Customer']);
  });

  test('built-in classes are not references', () => {
    expect(refs({ name: 'obj', props: { a: { type: { name: 'text' } }, b: { type: { name: 'list', generic: { V: { name: 'num' } } } } } })).toEqual([]);
  });

  test('a bare unknown name is a reference, reported once in first-seen order', () => {
    const def: TypeDef = {
      name: 'obj',
      props: {
        a: { type: { name: 'Customer' } },
        b: { type: { name: 'list', generic: { V: { name: 'Order' } } } },
        c: { type: { name: 'optional', generic: { T: { name: 'Customer' } } } },
      },
    };
    expect(refs(def)).toEqual(['Customer', 'Order']);
  });

  test('extends and satisfies name references; the extension itself is defined, not referenced', () => {
    const def: TypeDef = {
      name: 'VipCustomer',
      extends: 'Customer',
      satisfies: ['Comparable'],
      props: { next: { type: { name: 'optional', generic: { T: { name: 'VipCustomer' } } } } },
    };
    const out = typeReferences(def, r);
    expect(out.refs).toEqual(['Customer', 'Comparable']);
    expect(out.defines).toEqual(['VipCustomer']);
  });

  test('an extension over a built-in references nothing', () => {
    expect(refs({ name: 'Email', extends: 'text', options: { pattern: '@' } })).toEqual([]);
  });

  test('a fn\'s declared generics are local, including in their own constraints', () => {
    const def: TypeDef = {
      name: 'fn',
      generic: { T: { name: 'T' }, R: { name: 'Shape' } },
      call: { args: { name: 'obj', props: { x: { type: { name: 'T' } } } }, returns: { name: 'R' } },
    };
    expect(refs(def)).toEqual(['Shape']);
  });

  test('a use-site generic argument is walked; the generic name is the referenced type\'s parameter', () => {
    expect(refs({ name: 'Page', generic: { T: { name: 'Customer' } } })).toEqual(['Page', 'Customer']);
  });

  test('call.types aliases are local to the call and visible to later aliases', () => {
    const def: TypeDef = {
      name: 'fn',
      call: {
        types: { Row: { name: 'Customer' }, Rows: { name: 'list', generic: { V: { name: 'Row' } } } },
        args: { name: 'obj', props: { rows: { type: { name: 'Rows' } } } },
        returns: { name: 'Row' },
      },
    };
    expect(refs(def)).toEqual(['Customer']);
  });

  test('child defs in options: tuple elements, or/and types, not', () => {
    expect(refs({ name: 'tuple', options: { elements: [{ name: 'A' }, { name: 'text' }] } })).toEqual(['A']);
    expect(refs({ name: 'or', options: { types: [{ name: 'B' }, { name: 'C' }] } })).toEqual(['B', 'C']);
    expect(refs({ name: 'not', options: { excluded: { name: 'D' } } })).toEqual(['D']);
  });

  test('enum and literal constants are not mistaken for defs', () => {
    expect(refs({ name: 'enum', generic: { V: { name: 'text' } }, options: { values: { a: 'Customer' } } })).toEqual([]);
    expect(refs({ name: 'literal', generic: { T: { name: 'text' } }, options: { value: 'Customer' } })).toEqual([]);
  });

  test('expressions carry types: new, lambda, define, native, call generics', () => {
    const def: TypeDef = {
      name: 'obj',
      props: {
        a: {
          type: { name: 'num' },
          default: {
            kind: 'define',
            vars: [{ name: 'x', type: { name: 'Seed' }, value: { kind: 'new', type: { name: 'Seed' } } }],
            body: {
              kind: 'get',
              path: [{ prop: 'x' }, { prop: 'map' }, { args: {}, generic: { R: { name: 'Out' } } }],
            },
          },
        },
        b: { type: { name: 'num' }, get: { kind: 'native', id: 'n', type: { name: 'Native' } } },
        c: { type: { name: 'fn' }, get: { kind: 'lambda', type: { name: 'fn', call: { args: { name: 'Arg' } } }, body: { kind: 'new', type: { name: 'num' }, value: 1 } } },
      },
    };
    expect(refs(def)).toEqual(['Seed', 'Out', 'Native', 'Arg']);
  });

  test('a new payload is data: its field names are not type slots, but embedded exprs are walked', () => {
    const def: TypeDef = {
      name: 'obj',
      props: {
        a: {
          type: { name: 'obj' },
          default: {
            kind: 'new',
            type: { name: 'obj' },
            value: { type: { name: 'NotAType' }, inner: { kind: 'new', type: { name: 'Inner' } } },
          },
        },
      },
    };
    expect(refs(def)).toEqual(['Inner']);
  });

  test('a typ value IS a def', () => {
    const def: TypeDef = {
      name: 'obj',
      props: { t: { type: { name: 'typ' }, default: { kind: 'new', type: { name: 'typ' }, value: { name: 'Picked' } } } },
    };
    expect(refs(def)).toEqual(['Picked']);
  });
});

describe('Type.references — from live types', () => {
  test('a scope-bound name stays a reference', () => {
    const scope = r.scope({ Customer: r.obj({ id: r.text() }) });
    const t = scope.parse({ name: 'obj', props: { c: { type: { name: 'Customer' } } } });
    expect(t.references().refs).toEqual(['Customer']);
  });

  test('a registered named type reached by a type is a reference, not inlined', () => {
    const local = createRegistry();
    const Customer = local.extend(local.obj({ id: local.text() }), { name: 'Customer' });
    local.register(Customer);
    const t = local.obj({ c: Customer, list: local.list(Customer) });
    expect(t.references()).toEqual({ refs: ['Customer'], defines: [] });
    expect(Customer.references()).toEqual({ refs: [], defines: ['Customer'] });
  });

  test('a type built from builtins references nothing', () => {
    expect(r.obj({ a: r.list(r.map(r.text(), r.num())) }).references().refs).toEqual([]);
  });
});

describe('typeClosure — transitive', () => {
  const defs: Record<string, TypeDef> = {
    Order: { name: 'Order', extends: 'obj', props: { customer: { type: { name: 'Customer' } }, lines: { type: { name: 'list', generic: { V: { name: 'Line' } } } } } },
    Customer: { name: 'Customer', extends: 'obj', props: { id: { type: { name: 'text' } } } },
    Line: { name: 'Line', extends: 'obj', props: { sku: { type: { name: 'Sku' } }, order: { type: { name: 'optional', generic: { T: { name: 'Order' } } } } } },
  };
  const resolve: TypeResolver = (name) => defs[name];

  test('follows references, reports what it could not find, orders dependencies first', () => {
    const root: TypeDef = { name: 'fn', call: { args: { name: 'obj', props: { order: { type: { name: 'Order' } } } } } };
    const out = typeClosure([root], r, resolve);
    expect(out.missing).toEqual(['Sku']);
    expect(out.order).toEqual(['Customer', 'Line', 'Order']);
    expect([...out.defs.keys()].sort()).toEqual(['Customer', 'Line', 'Order']);
    expect(out.order.indexOf('Customer')).toBeLessThan(out.order.indexOf('Order'));
  });

  test('names the roots define inline are not fetched', () => {
    const out = typeClosure([defs.Customer!], r, resolve);
    expect(out.order).toEqual([]);
    expect(out.missing).toEqual([]);
  });

  test('the order builds a scope in which every root parses and resolves', () => {
    const root: TypeDef = { name: 'obj', props: { order: { type: { name: 'Order' } } } };
    const out = typeClosure([root], r, (n) => (n === 'Sku' ? { name: 'text' } : defs[n]));
    const scope = r.scope();
    for (const name of out.order) scope.bind(name, scope.parse(out.defs.get(name)!));
    const t = scope.parse(root);
    const v = t.parse({ order: { customer: { id: 'c1' }, lines: [{ sku: 'x' }] } });
    expect(v.toLogical()).toEqual({ order: { customer: { id: 'c1' }, lines: [{ sku: 'x', order: undefined }] } });
  });

  test('Type.closure resolves through the type\'s own scope', () => {
    const scope = r.scope({ Sku: r.text() });
    scope.bind('Line', scope.parse({ name: 'obj', props: { sku: { type: { name: 'Sku' } } } }));
    const t = scope.parse({ name: 'list', generic: { V: { name: 'Line' } } });
    const out = t.closure();
    expect(out.order).toEqual(['Sku', 'Line']);
    expect(out.missing).toEqual([]);
    expect(out.defs.get('Line')).toEqual({ name: 'obj', props: { sku: { type: { name: 'Sku' } } } });
  });
});

describe('and on the right of compatible', () => {
  test('an intersection is assignable wherever one part, or its single equivalent, is', () => {
    const a = r.obj({ a: r.text() });
    const both = r.and([a, r.obj({ b: r.num() })]);
    expect(a.compatible(both)).toBe(true);
    expect(r.obj({ a: r.text(), b: r.num() }).compatible(both)).toBe(true);
    expect(both.compatible(r.parse(both.toJSON()))).toBe(true);
    expect(r.obj({ c: r.text() }).compatible(both)).toBe(false);
  });
});

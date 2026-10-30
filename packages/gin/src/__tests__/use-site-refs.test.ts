import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import type { Registry } from '../index';

// A reference that carries generic ARGUMENTS or narrowing OPTIONS
// (`Node<T>`, `PlayerText{maxLength=40}`) used to consult registered names
// only: a self or forward reference threw "unknown type", a name bound in a
// scope overlay threw too, and options on a registered name were dropped.
// Found loading the dg-engine model (3,534 types) into a registry.

const nodeDef = {
  name: 'Node', extends: 'obj', generic: { T: { name: 'any' } },
  props: {
    v: { type: { name: 'T' } },
    next: { type: { name: 'optional', generic: { T: { name: 'Node', generic: { T: { name: 'T' } } } } } },
  },
};

const condDef = {
  name: 'Cond', extends: 'obj', generic: { A: { name: 'any' } },
  props: { x: { type: { name: 'A' } } },
};

describe('use-site references — generic arguments', () => {
  test('a self reference with type arguments parses and registers', () => {
    const r = createRegistry();
    r.register(r.parse(nodeDef));
    const n = r.parse({ name: 'Node', generic: { T: { name: 'num' } } });
    expect(n.toCode()).toBe('Node<num>');
    expect(r.parseValue({ v: 1, next: { v: 2 } }, n).raw).toBeDefined();
  });

  test('a forward reference resolves once its name is registered, with its arguments applied', () => {
    const r = createRegistry();
    r.register(r.parse({
      name: 'When', extends: 'obj',
      props: { c: { type: { name: 'Cond', generic: { A: { name: 'num' } } } } },
    }));
    r.register(r.parse(condDef));
    const when = r.lookup('When')!;
    const c = when.props().c!.type;
    expect(c.toCode()).toBe('Cond<num>');
    expect(c.toJSON()).toEqual({ name: 'Cond', generic: { A: { name: 'num' } } });
    expect(() => r.parseValue({ c: { x: 'nope' } }, when)).toThrow();
    expect(r.parseValue({ c: { x: 3 } }, when).raw).toBeDefined();
  });

  test('a name bound in a scope overlay resolves through the scope', () => {
    const r = createRegistry();
    const s = r.scope({});
    s.bind('Cond', r.parse(condDef, s));
    const when = r.parse({
      name: 'When', extends: 'obj',
      props: { c: { type: { name: 'Cond', generic: { A: { name: 'text' } } } } },
    }, s);
    expect(when.props().c!.type.toCode()).toBe('Cond<text>');
  });

  test('a lazy reference is compatible with an identical one', () => {
    const r = createRegistry();
    const mk = () => r.parse({ name: 'list', generic: { V: { name: 'Cond', generic: { A: { name: 'num' } } } } });
    const a = mk();
    const b = mk();
    r.register(r.parse(condDef));
    expect(a.compatible(b)).toBe(true);
  });

  test('a misspelled built-in still throws with a suggestion', () => {
    const r = createRegistry();
    expect(() => r.parse({ name: 'lst', generic: { V: { name: 'num' } } })).toThrow(/did you mean `list`/);
  });
});

describe('use-site references — options', () => {
  const withPlayerText = (r: Registry) =>
    r.register(r.parse({ name: 'PlayerText', extends: 'text', options: { maxLength: 100 } }));
  const labelOf = (r: Registry, scope?: ReturnType<Registry['scope']>) => r.parse({
    name: 'X', extends: 'obj',
    props: { label: { type: { name: 'PlayerText', options: { maxLength: 4 } } } },
  }, scope).props().label!.type;

  test('options on a registered name are enforced, printed and round-tripped', () => {
    const r = createRegistry();
    withPlayerText(r);
    const t = labelOf(r);
    expect(t.valid('abc')).toBe(true);
    expect(t.valid('abcdefgh')).toBe(false);
    expect(t.toCode()).toBe('PlayerText{maxLength=4}');
    expect(t.toJSON()).toEqual({ name: 'PlayerText', options: { maxLength: 4 } });
    const back = r.parse(t.toJSON());
    expect(back.toCode()).toBe('PlayerText{maxLength=4}');
    expect(back.valid('abcdefgh')).toBe(false);
  });

  test('options on a name bound in a scope overlay', () => {
    const r = createRegistry();
    const s = r.scope({});
    s.bind('PlayerText', r.parse({ name: 'PlayerText', extends: 'text', options: { maxLength: 100 } }, s));
    const t = labelOf(r, s);
    expect(t.toCode()).toBe('PlayerText{maxLength=4}');
    expect(t.valid('abc')).toBe(true);
    expect(t.valid('abcdefgh')).toBe(false);
  });

  test('widening at the use site still throws', () => {
    const r = createRegistry();
    withPlayerText(r);
    expect(() => r.parse({ name: 'PlayerText', options: { maxLength: 400 } })).toThrow();
  });

  test('options that narrow nothing keep the registered identity', () => {
    const r = createRegistry();
    withPlayerText(r);
    expect(r.parse({ name: 'PlayerText', options: { maxLength: 100 } })).toBe(r.lookup('PlayerText'));
  });
});

describe('types that share references stay linear', () => {
  // L(i) has two props of type L(i-1): written out in full, L(n) is 2^n copies.
  const chain = (r: Registry, n: number) => {
    r.register(r.parse({ name: 'L0', extends: 'obj', props: { x: { type: { name: 'num' } } } }));
    for (let i = 1; i <= n; i++) {
      r.register(r.parse({
        name: `L${i}`, extends: 'obj',
        props: { a: { type: { name: `L${i - 1}` } }, b: { type: { name: `L${i - 1}` } } },
      }));
    }
  };

  test('a tuple of a deeply shared type parses without serializing it', () => {
    const r = createRegistry();
    chain(r, 40);
    const start = Date.now();
    const t = r.parse({ name: 'tuple', options: { elements: [{ name: 'L40' }, { name: 'num' }] } });
    expect(Date.now() - start).toBeLessThan(500);
    expect(t.toCode()).toBe('tuple<L40, num>');
  });

  test('toDefinitionJSON writes nested registered types by name', () => {
    const r = createRegistry();
    chain(r, 40);
    const def = r.lookup('L40')!.toDefinitionJSON();
    expect(def.props!.a!.type).toEqual({ name: 'L39' });
    expect(r.parse(def).toCode()).toBe('L40');
  });

  test('registry.validate finishes over the chain and over recursive types', () => {
    const r = createRegistry();
    chain(r, 40);
    r.register(r.parse(nodeDef));
    const start = Date.now();
    const problems = r.validate(new Engine(r));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(problems.list.filter((p) => p.severity === 'error')).toEqual([]);
  });

  test('compatible terminates on a recursive type compared with a copy of itself', () => {
    const r = createRegistry();
    r.register(r.parse(nodeDef));
    const a = r.parse({ name: 'Node', generic: { T: { name: 'num' } } });
    const b = r.parse({ name: 'Node', generic: { T: { name: 'num' } } });
    expect(a.compatible(b)).toBe(true);
  });
});

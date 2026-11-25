/**
 * `Type.toA()` — every TypeDef kind's value schema as `a`, checked against
 * the zod `toValueSchema` value-for-value (the same verdict on every probe)
 * and against `fromGin` of the same def (the same JSON Schema on every
 * model profile), plus named types as refs, `toNewA`, docs, `unknownKeys`
 * and `ginValue`'s cache.
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_STRICT, fromGin, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, OPENAI_STRICT, XAI_STRICT, type GinTypeDef,
} from '@aeye/schema';
import { createRegistry, ginValue, ginValueBundle, Prop, type Type } from '../index';
import { accepts, asParser } from './_a';

interface Case { readonly label: string; readonly def: GinTypeDef; readonly ok: readonly unknown[]; readonly bad: readonly unknown[] }

/** One case per TypeDef kind (ported from packages/schema corpus/gin-values.test.ts). */
const CASES: readonly Case[] = [
  { label: 'text{min,max,pattern}', def: { name: 'text', options: { minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]*$' } }, ok: ['a', 'abc-1'], bad: ['', 'Abc', 1, null] },
  { label: 'text pattern flags', def: { name: 'text', options: { pattern: '^user-', flags: 'i' } }, ok: ['user-1', 'USER-1'], bad: ['admin'] },
  { label: 'num{whole,min,max}', def: { name: 'num', options: { whole: true, min: 0, max: 100 } }, ok: [0, 100, 42], bad: [-1, 101, 1.5, '1'] },
  { label: 'num', def: { name: 'num' }, ok: [1.5, -3], bad: ['x', null] },
  { label: 'bool', def: { name: 'bool' }, ok: [true, false], bad: ['true', 0] },
  { label: 'null', def: { name: 'null' }, ok: [null], bad: [0, ''] },
  { label: 'void', def: { name: 'void' }, ok: [null], bad: [0, {}] },
  { label: 'any', def: { name: 'any' }, ok: [1, 'x', null, { a: [1] }], bad: [] },
  { label: 'date (a prefix)', def: { name: 'date' }, ok: ['2024-01-15', '2024-01-15T10:00:00Z'], bad: ['Jan 15', 20240115] },
  { label: 'timestamp', def: { name: 'timestamp' }, ok: ['2024-01-15T10:30:00Z', '2024-01-15 10:30', '2024-01-15T10:30:00.123+02:00'], bad: ['2024-01-15', 'now'] },
  { label: 'duration (ms)', def: { name: 'duration' }, ok: [1500, 0], bad: ['PT1S'] },
  { label: 'color (int)', def: { name: 'color' }, ok: [0xff0000ff, 0], bad: ['#ff0000', -1, 0x100000000] },
  { label: 'enum (strings)', def: { name: 'enum', options: { values: { LOW: 'low', HIGH: 'high' } } }, ok: ['low', 'high'], bad: ['LOW', 'mid'] },
  { label: 'enum (numbers)', def: { name: 'enum', generic: { V: { name: 'num' } }, options: { values: { ONE: 1, TWO: 2 } } }, ok: [1, 2], bad: [3, '1'] },
  { label: 'literal', def: { name: 'literal', options: { value: 'task' } }, ok: ['task'], bad: ['Task', null] },
  { label: 'list<text>{min,max}', def: { name: 'list', generic: { V: { name: 'text' } }, options: { minLength: 1, maxLength: 2 } }, ok: [['a'], ['a', 'b']], bad: [[], ['a', 'b', 'c'], [1], 'a'] },
  { label: 'map<num, text> (pairs)', def: { name: 'map', generic: { K: { name: 'num' }, V: { name: 'text' } } }, ok: [[{ key: 1, value: 'a' }], []], bad: [{ 1: 'a' }, [{ key: 'x', value: 'a' }]] },
  { label: 'tuple', def: { name: 'tuple', options: { elements: [{ name: 'text' }, { name: 'num' }] } }, ok: [['a', 1]], bad: [['a'], [1, 'a']] },
  {
    label: 'obj (optional prop; unknown keys pass)',
    def: { name: 'obj', props: { a: { type: { name: 'num' } }, b: { type: { name: 'optional', generic: { T: { name: 'text' } } } } } },
    ok: [{ a: 1 }, { a: 1, b: 'x' }, { a: 1, extra: true }], bad: [{ b: 'x' }, { a: 1, b: 2 }, []],
  },
  { label: 'optional<num>', def: { name: 'optional', generic: { T: { name: 'num' } } }, ok: [1], bad: ['1', null] },
  { label: 'nullable<text>', def: { name: 'nullable', generic: { T: { name: 'text' } } }, ok: ['a', null], bad: [1] },
  { label: 'not<null>', def: { name: 'not', options: { excluded: { name: 'null' } } }, ok: [1, 'x', {}], bad: [null] },
  { label: 'or<text, num, null>', def: { name: 'or', options: { types: [{ name: 'text' }, { name: 'num' }, { name: 'null' }] } }, ok: ['a', 1, null], bad: [true, {}] },
  {
    label: 'and<obj{id}, obj{label}>',
    def: { name: 'and', options: { types: [{ name: 'obj', props: { id: { type: { name: 'num' } } } }, { name: 'obj', props: { label: { type: { name: 'text' } } } }] } },
    ok: [{ id: 1, label: 'x' }], bad: [{ id: 1 }, { label: 'x' }, { id: 'x', label: 'x' }],
  },
  { label: 'interface (extra keys pass)', def: { name: 'interface', props: { id: { type: { name: 'num' } } } }, ok: [{ id: 1 }, { id: 1, more: 'x' }], bad: [{}, { id: 'x' }] },
  { label: 'fn (a name or a program)', def: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'bool' } } }, ok: ['native/id', { kind: 'new', type: { name: 'bool' }, value: true }], bad: [{ kind: 'nope' }, { op: 'x' }, 1] },
  { label: 'typ (any TypeDef that parses)', def: { name: 'typ' }, ok: [{ name: 'num' }, { name: 'list', generic: { V: { name: 'text' } } }], bad: [{ name: 'not a name' }, { name: 'Ghost' }, 'num'] },
  { label: 'typ<num> (narrowed)', def: { name: 'typ', generic: { T: { name: 'num' } } }, ok: [{ name: 'num' }, { name: 'MyNum', extends: 'num' }], bad: [{ name: 'text' }, { name: 'WeirdText', extends: 'text' }] },
];

const PROFILES = [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, GOOGLE_OPENAPI, XAI_STRICT, MINIMAL, LENIENT];

describe('Type.toA: every kind accepts exactly what toValueSchema accepts', () => {
  const r = createRegistry();
  for (const c of CASES) {
    it(c.label, () => {
      const type = r.parse(c.def as never);
      const zod = type.toValueSchema();
      const ours = ginValue(type).render(LENIENT);
      for (const v of c.ok) expect([zod.safeParse(v).success, ours.parse(structuredClone(v)).ok], `accepts ${JSON.stringify(v)}`).toEqual([true, true]);
      for (const v of c.bad) expect([zod.safeParse(v).success, ours.parse(structuredClone(v)).ok], `rejects ${JSON.stringify(v)}`).toEqual([false, false]);
    });
  }

  it('map<text, V> is a record in the code shape (gin\'s zod value is pairs; the profile writes pairs where it must)', () => {
    const type = r.map(r.text(), r.num());
    expect(type.toValueSchema().safeParse([{ key: 'a', value: 1 }]).success).toBe(true);
    const bound = ginValue(type);
    expect(bound.render(LENIENT).parse({ a: 1 }).ok).toBe(true);
    expect(bound.render(OPENAI_STRICT).encode({ a: 1 })).toEqual({ input: [{ key: 'a', value: 1 }] });
    expect(bound.render(GOOGLE_STRICT).encode({ a: 1 })).toEqual({ a: 1 });
  });

  it('DELIBERATE: a typ value with an unknown TypeDef key is refused (zod stripped the key before gin parsed it)', () => {
    const typ = r.typ(r.any());
    expect(typ.toValueSchema().safeParse({ name: 'num', options: { bogus: 1 } }).success).toBe(true);
    const res = ginValue(typ).render(LENIENT).parse({ name: 'num', options: { bogus: 1 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('bogus');
  });
});

describe('Type.toA is fromGin of the same def (same JSON Schema on every profile)', () => {
  const r = createRegistry();
  // typ/fn hold refs into the grammar (fromGin's are the same refs, but its module lacks gin's registry part).
  for (const c of CASES.filter((x) => x.def.name !== 'typ' && x.def.name !== 'fn')) {
    it(c.label, () => {
      const ours = r.parse(c.def as never).toA() as unknown as { render(p: typeof LENIENT): { jsonSchema: unknown } };
      const theirs = fromGin(c.def) as unknown as { render(p: typeof LENIENT): { jsonSchema: unknown } };
      for (const p of PROFILES) expect(ours.render(p).jsonSchema, p.id).toEqual(theirs.render(p).jsonSchema);
    });
  }
});

describe('named types are refs, defined once by the grammar', () => {
  const r = createRegistry();
  const Task = r.extend('obj', { name: 'Task', docs: 'a work item', props: { title: { type: r.text({ minLength: 1 }), docs: 'short summary' }, done: { type: r.bool() } } });
  r.register(Task);
  const Node = r.extend('obj', { name: 'Node', props: { value: { type: r.num() } } });
  r.register(Node);

  it('a registered type is a.ref(name); its definition is its own shape', () => {
    expect(Task.toA()).toMatchObject({ kind: 'ref', name: 'Task' });
    expect(Task.defineA().kind).toBe('object');
    const list = ginValue(r.list(Task));
    const js = list.render(OPENAI_STRICT).jsonSchema as { $defs: Record<string, { description?: string; properties: Record<string, { description?: string }> }> };
    expect(js.$defs.Task!.description).toBe('a work item');
    expect(js.$defs.Task!.properties.title!.description).toBe('short summary');
    expect(list.render(LENIENT).parse([{ title: 'x', done: false }]).ok).toBe(true);
    expect(list.render(LENIENT).parse([{ title: '', done: false }]).ok).toBe(false);
  });

  it('a recursive named type (Tree → list<Tree>) is a recursive ref', () => {
    const r2 = createRegistry();
    const Tree = r2.extend('obj', { name: 'Tree', props: { label: { type: r2.text() } } });
    r2.register(Tree);
    const TreeFull = r2.parse({ name: 'Tree2', extends: 'obj', props: { label: { type: { name: 'text' } }, kids: { type: { name: 'list', generic: { V: { name: 'Tree2' } } } } } } as never);
    r2.register(TreeFull);
    const bound = ginValue(TreeFull);
    const v = { label: 'a', kids: [{ label: 'b', kids: [] }] };
    expect(bound.render(LENIENT).parse(structuredClone(v)).ok).toBe(true);
    expect(bound.render(LENIENT).parse({ label: 'a', kids: [{ label: 1, kids: [] }] }).ok).toBe(false);
    expect(TreeFull.toValueSchema().safeParse(v).success).toBe(true);
  });

  it('a value with typ / fn slots binds the grammar (namedRefs: a stored type by name)', () => {
    const args = r.obj({ type: r.typ(r.any()), run: r.fn({ args: r.obj({}), returns: r.num() }) });
    const p = asParser(ginValue(args));
    expect(p.safeParse({ type: { name: 'Task' }, run: { kind: 'get', path: [{ prop: 'x' }] } }).success).toBe(true);
    // A name-only type fits the schema (namedRefs) and is then checked by gin, which doesn't know it.
    const stored = p.safeParse({ type: { name: 'ns/Stored' }, run: 'num.add' });
    expect(stored.success).toBe(false);
    expect(stored.message).toContain('ns/Stored');
    expect(args.toValueSchema().safeParse({ type: { name: 'ns/Stored' }, run: 'num.add' }).success).toBe(false);
    expect(p.safeParse({ type: { name: 'bogus thing' }, run: 'num.add' }).success).toBe(false);
  });
});

describe('toNewA (a `new` value slot)', () => {
  const r = createRegistry();
  const nw = (t: Type) => asParser(t.toNewA(), r);
  it('primitives take their value; composites take Exprs; plain obj fields take either', () => {
    expect(nw(r.num()).safeParse(1).success).toBe(true);
    expect(nw(r.list(r.num())).safeParse([1]).success).toBe(false);
    expect(nw(r.list(r.num())).safeParse([{ kind: 'new', type: { name: 'num' }, value: 1 }]).success).toBe(true);
    const o = r.obj({ x: { type: r.num() }, tags: { type: r.list(r.text()) }, n: { type: r.optional(r.num()) } });
    expect(nw(o).safeParse({ x: 5, tags: { kind: 'get', path: [{ prop: 't' }] } }).success).toBe(true);
    expect(nw(o).safeParse({ x: 'five', tags: { kind: 'get', path: [{ prop: 't' }] } }).success).toBe(false);
    expect(nw(o).safeParse({ x: 5, tags: ['a'] }).success).toBe(false);
  });
  it('a type with init takes its args (duration, color, augmented)', () => {
    expect(nw(r.duration()).safeParse({ days: 1 }).success).toBe(true);
    expect(nw(r.duration()).safeParse(1234).success).toBe(false);
    expect(nw(r.color()).safeParse({ r: 255, g: 0, b: 0 }).success).toBe(true);
    expect(nw(r.color()).safeParse({ r: 256, g: 0, b: 0 }).success).toBe(false);
  });
});

describe('options', () => {
  const r = createRegistry();
  it("includeDocs: 'type' / 'all' describe the type and its fields; constraints always", () => {
    const person = r.obj({ name: new Prop({ type: r.text(), docs: 'given name' }) });
    const all = person.toA({ includeDocs: 'all' }).render(LENIENT).jsonSchema as { properties: { name: { description?: string } } };
    expect(all.properties.name.description).toBe('given name');
    const none = person.toA().render(LENIENT).jsonSchema as { properties: { name: { description?: string } } };
    expect(none.properties.name.description).toBeUndefined();
    const ranged = r.extend('num', { name: 'ranged', docs: 'bounded', options: { min: 0 } });
    expect((ranged.defineA({ includeDocs: 'type' }).render(LENIENT).jsonSchema as { description?: string }).description).toBe('bounded');
  });
  it("unknownKeys: 'refuse' closes object shapes", () => {
    const o = r.obj({ a: { type: r.num() } });
    expect(accepts(o.toA(), { a: 1, b: 2 })).toBe(true);
    expect(accepts(o.toA({ unknownKeys: 'refuse' }), { a: 1, b: 2 })).toBe(false);
  });
});

describe('ginValue', () => {
  it('is memoized per type until the registry changes', () => {
    const r = createRegistry();
    const t = r.list(r.num());
    expect(ginValueBundle(t)).toBe(ginValueBundle(t));
    expect(ginValue(t)).toBe(ginValue(t));
    const before = ginValueBundle(t);
    r.register(r.extend('obj', { name: 'Later', props: {} }));
    expect(ginValueBundle(t)).not.toBe(before);
  });
  it('a ref-free value still renders everywhere', () => {
    const r = createRegistry();
    const t = r.obj({ when: { type: r.timestamp() }, tags: { type: r.map(r.text(), r.num()) } });
    for (const p of PROFILES) expect(() => ginValue(t).render(p)).not.toThrow();
  });
});

import { describe, test, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  createRegistry, Value, ObjType, ListType, MapType, TupleType, OrType, AndType, EnumType, LiteralType,
  FnType, IfaceType, AliasType, Extension, OptionalType, NullableType, TypType,
  type Infer, type FnArgs, type FnReturns, type FnThrows, type ObjValue, type FieldsInput, type Type,
} from '../index';

/**
 * The type builder infers the TypeScript value of every type it builds, so a
 * gin type is the single source of truth for both the runtime contract and
 * the static one. These tests pin both halves: `expectTypeOf` (checked by
 * `npm run test:types`) for the static value, and runtime assertions that the
 * same types parse, round-trip and schema the way the static value says.
 */
const r = createRegistry();

describe('primitives', () => {
  test('each primitive infers its JS value', () => {
    expectTypeOf<Infer<ReturnType<typeof r.text>>>().toEqualTypeOf<string>();
    expectTypeOf<Infer<ReturnType<typeof r.num>>>().toEqualTypeOf<number>();
    expectTypeOf<Infer<ReturnType<typeof r.bool>>>().toEqualTypeOf<boolean>();
    expectTypeOf<Infer<ReturnType<typeof r.null>>>().toEqualTypeOf<null>();
    expectTypeOf<Infer<ReturnType<typeof r.void>>>().toEqualTypeOf<void>();
    expectTypeOf<Infer<ReturnType<typeof r.date>>>().toEqualTypeOf<Date>();
    expectTypeOf<Infer<ReturnType<typeof r.timestamp>>>().toEqualTypeOf<Date>();
    expectTypeOf<Infer<ReturnType<typeof r.duration>>>().toEqualTypeOf<number>();
    expectTypeOf<Infer<ReturnType<typeof r.color>>>().toEqualTypeOf<number>();
  });

  test('constraints ride the options and are enforced', () => {
    const t = r.num({ min: 0, max: 10, whole: true });
    expect(t.parse(4).toLogical()).toBe(4);
    expect(() => t.parse(11)).toThrow();
    expect(() => t.parse(1.5)).toThrow();
    const name = r.text({ minLength: 2, pattern: '^[a-z]+$' });
    expect(name.parse('ok').toLogical()).toBe('ok');
    expect(() => name.parse('A1')).toThrow();
  });
});

describe('obj', () => {
  const Read = r.obj({
    path: r.text(),
    offset: r.optional(r.num()),
    tags: r.list(r.text()),
  });

  test('infers fields, with optional<T> fields as optional keys', () => {
    expectTypeOf<Infer<typeof Read>>().toEqualTypeOf<{
      path: string;
      tags: string[];
      offset?: number | undefined;
    }>();
    expect(Read).toBeInstanceOf(ObjType);
  });

  test('accepts bare types, PropSpecs, Props and field() in one record', () => {
    const t = r.obj({
      a: r.text(),
      b: { type: r.num(), docs: 'b docs' },
      c: r.field(r.bool(), { docs: 'c docs' }),
      d: r.field(r.optional(r.text())),
    });
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<{ a: string; b: number; c: boolean; d?: string | undefined }>();
    expect(t.fields.b!.docs).toBe('b docs');
    expect(t.fields.c!.docs).toBe('c docs');
    expect(t.toJSON().props?.c?.docs).toBe('c docs');
  });

  test('field defaults are parsed to Exprs and survive toJSON', () => {
    const t = r.obj({
      mode: r.field(r.text(), { default: { kind: 'new', type: { name: 'text' }, value: 'fast' } }),
    });
    expect(t.fields.mode!.default?.toJSON()).toEqual({ kind: 'new', type: { name: 'text' }, value: 'fast' });
  });

  test('a parsed value reads back as the inferred plain value', () => {
    const v = Read.parse({ path: 'a.txt', tags: ['x', 'y'] });
    const plain: Infer<typeof Read> = v.toLogical();
    expect(plain).toEqual({ path: 'a.txt', offset: undefined, tags: ['x', 'y'] });
  });

  test('the value schema accepts what the inferred type describes', () => {
    const schema = Read.toValueSchema();
    const ok: Infer<typeof Read> = { path: 'p', tags: [] };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ path: 1, tags: [] }).success).toBe(false);
    const json = z.toJSONSchema(schema);
    expect(json).toMatchObject({ type: 'object', required: expect.arrayContaining(['path', 'tags']) });
  });

  test('wrong field values do not type-check', () => {
    // @ts-expect-error — path is a string
    const bad: Infer<typeof Read> = { path: 1, tags: [] };
    // @ts-expect-error — tags is required
    const missing: Infer<typeof Read> = { path: 'p' };
    expect([bad, missing]).toHaveLength(2);
  });

  test('ObjValue reads a fields record directly', () => {
    const fields = { id: r.text(), n: r.optional(r.num()) } satisfies FieldsInput;
    expectTypeOf<ObjValue<typeof fields>>().toEqualTypeOf<{ id: string; n?: number | undefined }>();
  });
});

describe('containers and modifiers', () => {
  test('list, map, tuple, nullable, optional', () => {
    const l = r.list(r.num());
    const m = r.map(r.text(), r.bool());
    const t = r.tuple([r.text(), r.num(), r.optional(r.bool())]);
    const n = r.nullable(r.text());
    const o = r.optional(r.date());
    expectTypeOf<Infer<typeof l>>().toEqualTypeOf<number[]>();
    expectTypeOf<Infer<typeof m>>().toEqualTypeOf<Map<string, boolean>>();
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<[string, number, boolean | undefined]>();
    expectTypeOf<Infer<typeof n>>().toEqualTypeOf<string | null>();
    expectTypeOf<Infer<typeof o>>().toEqualTypeOf<Date | undefined>();
    expect([l, m, t, n, o].map((x) => x.constructor)).toEqual([ListType, MapType, TupleType, NullableType, OptionalType]);
  });

  test('toLogical unwraps every container', () => {
    const t = r.obj({
      when: r.timestamp(),
      pair: r.tuple([r.text(), r.num()]),
      counts: r.map(r.text(), r.num()),
      maybe: r.nullable(r.list(r.num())),
    });
    const v = t.parse({
      when: '2026-01-02T03:04:05.000Z',
      pair: ['a', 1],
      counts: [{ key: 'x', value: 2 }],
      maybe: null,
    });
    const plain: Infer<typeof t> = v.toLogical();
    expect(plain.when).toBeInstanceOf(Date);
    expect(plain.when.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(plain.pair).toEqual(['a', 1]);
    expect(plain.counts).toEqual(new Map([['x', 2]]));
    expect(plain.maybe).toBeNull();
  });

  test('nested objects infer and unwrap recursively', () => {
    const t = r.obj({ roots: r.list(r.obj({ path: r.text(), writable: r.bool() })) });
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<{ roots: { path: string; writable: boolean }[] }>();
    expect(t.parse({ roots: [{ path: '/a', writable: true }] }).toLogical())
      .toEqual({ roots: [{ path: '/a', writable: true }] });
  });
});

describe('unions, intersections and constants', () => {
  test('or infers the union of its variants', () => {
    const t = r.or([r.text(), r.num(), r.null()]);
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<string | number | null>();
    expect(t).toBeInstanceOf(OrType);
    expect(t.parse(3).toLogical()).toBe(3);
    expect(t.parse('x').toLogical()).toBe('x');
  });

  test('and infers the intersection of its parts', () => {
    const t = r.and([r.obj({ a: r.text() }), r.obj({ b: r.num() })]);
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<{ a: string } & { b: number }>();
    expect(t).toBeInstanceOf(AndType);
    expect(t.parse({ a: 'x', b: 1 }).toLogical()).toEqual({ a: 'x', b: 1 });
  });

  test('and of an unknown-length list stays as wide as gin\'s untyped Type', () => {
    const parts: Type[] = [r.num()];
    expectTypeOf<Infer<ReturnType<typeof r.and<typeof parts>>>>().toEqualTypeOf<any>();
  });

  test('enum from labels infers the label union', () => {
    const t = r.enum(['free', 'pro']);
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<'free' | 'pro'>();
    expect(t).toBeInstanceOf(EnumType);
    expect(t.toJSON().options).toEqual({ values: { free: 'free', pro: 'pro' } });
    expect(t.parse('pro').toLogical()).toBe('pro');
    expect(() => t.parse('gold')).toThrow();
  });

  test('enum from a record infers the value union and keeps the member type', () => {
    const t = r.enum({ low: 1, high: 9 }, r.num());
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<1 | 9>();
    expectTypeOf(t.value).toEqualTypeOf<Type<number>>();
    expect(t.parse(9).toLogical()).toBe(9);
  });

  test('literal infers the exact constant, with or without an inner type', () => {
    const a = r.literal('ok');
    const b = r.literal(3);
    const c = r.literal(true);
    const d = r.literal(r.text(), 'x');
    expectTypeOf<Infer<typeof a>>().toEqualTypeOf<'ok'>();
    expectTypeOf<Infer<typeof b>>().toEqualTypeOf<3>();
    expectTypeOf<Infer<typeof c>>().toEqualTypeOf<true>();
    expectTypeOf<Infer<typeof d>>().toEqualTypeOf<'x'>();
    expect(a).toBeInstanceOf(LiteralType);
    expect(a.inner.name).toBe('text');
    expect(b.inner.name).toBe('num');
    expect(c.inner.name).toBe('bool');
    expect(() => a.parse('no')).toThrow();
  });

  test('a discriminated union of objects infers as one', () => {
    const t = r.or([
      r.obj({ kind: r.literal('file'), size: r.num() }),
      r.obj({ kind: r.literal('dir'), entries: r.num() }),
    ]);
    type T = Infer<typeof t>;
    expectTypeOf<T>().toEqualTypeOf<{ kind: 'file'; size: number } | { kind: 'dir'; entries: number }>();
    const v: T = t.parse({ kind: 'dir', entries: 2 }).toLogical();
    expect(v.kind === 'dir' ? v.entries : v.size).toBe(2);
  });
});

describe('fn, iface, alias, typ', () => {
  test('fn keeps its args, returns and throws', () => {
    const f = r.fn({ args: r.obj({ path: r.text() }), returns: r.list(r.text()), throws: r.text() });
    expectTypeOf<FnArgs<typeof f>>().toEqualTypeOf<{ path: string }>();
    expectTypeOf<FnReturns<typeof f>>().toEqualTypeOf<string[]>();
    expectTypeOf<FnThrows<typeof f>>().toEqualTypeOf<string>();
    expect(f).toBeInstanceOf(FnType);
    expect(f.call().args.toJSON()).toEqual({ name: 'obj', props: { path: { type: { name: 'text' } } } });
  });

  test('a fn with no returns returns void', () => {
    const f = r.fn({ args: r.obj({}) });
    expectTypeOf<FnReturns<typeof f>>().toEqualTypeOf<void>();
  });

  test('fn generics are declared on the type and survive the wire', () => {
    const f = r.fn({ generic: { T: r.any() }, args: r.obj({ x: r.alias('T') }), returns: r.alias('T') });
    const back = r.parse(f.toJSON());
    expect(back.toJSON()).toEqual(f.toJSON());
    expect(Object.keys(back.generic)).toEqual(['T']);
  });

  test('iface infers its data props, not its methods', () => {
    const t = r.iface({
      props: {
        id: r.text(),
        rename: r.fn({ args: r.obj({ to: r.text() }), returns: r.bool() }),
        size: r.prop(r.num(), 'x.size'),
      },
    });
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<{ id: string }>();
    expect(t).toBeInstanceOf(IfaceType);
  });

  test('alias defaults to unknown and takes its value explicitly', () => {
    const a = r.alias('Customer');
    const b = r.alias<{ id: string }>('Customer');
    expectTypeOf<Infer<typeof a>>().toEqualTypeOf<unknown>();
    expectTypeOf<Infer<typeof b>>().toEqualTypeOf<{ id: string }>();
    expect(a).toBeInstanceOf(AliasType);
    expect(a.toJSON()).toEqual({ name: 'Customer' });
  });

  test('typ values are types', () => {
    const t = r.typ(r.num());
    expect(t).toBeInstanceOf(TypType);
    expect(t.parse({ name: 'num' }).raw.name).toBe('num');
  });
});

describe('extend and methods', () => {
  test('stored-data props extend the base value; methods and computed props do not', () => {
    const Base = r.obj({ id: r.text() });
    const Customer = r.extend(Base, {
      name: 'Customer',
      docs: 'A paying customer.',
      props: {
        email: r.text(),
        note: r.optional(r.text()),
        upgrade: r.method({ plan: r.text() }, r.bool(), 'Customer.upgrade'),
        label: r.prop(r.text(), 'Customer.label'),
      },
    });
    expectTypeOf<Infer<typeof Customer>>().toEqualTypeOf<{ id: string; email: string; note?: string | undefined }>();
    expect(Customer).toBeInstanceOf(Extension);
    expect(Customer.parse({ id: '1', email: 'a@b' }).toLogical()).toEqual({ id: '1', email: 'a@b', note: undefined });
  });

  test('extend with no data props keeps the base value', () => {
    const Email = r.extend(r.text({ pattern: '@' }), { name: 'Email' });
    expectTypeOf<Infer<typeof Email>>().toEqualTypeOf<string>();
    expect(() => Email.parse('nope')).toThrow();
  });

  test('extend by a built-in name infers that class\'s value', () => {
    const Slug = r.extend('text', { name: 'Slug', options: { pattern: '^[a-z-]+$' } });
    expectTypeOf<Infer<typeof Slug>>().toEqualTypeOf<string>();
    expect(Slug.parse('a-b').toLogical()).toBe('a-b');
  });

  test('extend by an unknown name is unknown', () => {
    r.register(r.extend('num', { name: 'Score' }));
    const t = r.extend('Score', { name: 'HighScore' });
    expectTypeOf<Infer<typeof t>>().toEqualTypeOf<unknown>();
    expect(t.parse(3).toLogical()).toBe(3);
  });

  test('method keeps its args and returns on the fn it builds', () => {
    const m = r.method({ by: r.num() }, r.num(), 'num.add');
    expect(m.get.toJSON()).toEqual({ kind: 'native', id: 'num.add' });
    expect(m.type).toBeInstanceOf(FnType);
  });

  test('augment adds methods to a built-in, visible to path walks', () => {
    const local = createRegistry();
    local.augment('text', { props: { shout: local.method({}, local.text(), 'text.upper') } });
    expect(Object.keys(local.text().props())).toContain('shout');
  });
});

describe('every builder round-trips through gin JSON and is compatible with itself', () => {
  const cases: [string, Type][] = [
    ['obj', r.obj({ a: r.text(), b: r.optional(r.num({ min: 1 })) })],
    ['list', r.list(r.text({ maxLength: 3 }), { minLength: 1 })],
    ['map', r.map(r.text(), r.num())],
    ['tuple', r.tuple([r.text(), r.bool()])],
    ['or', r.or([r.text(), r.num()])],
    ['and', r.and([r.obj({ a: r.text() }), r.obj({ b: r.num() })])],
    ['enum', r.enum(['x', 'y'])],
    ['literal', r.literal('x')],
    ['nullable', r.nullable(r.date())],
    ['fn', r.fn({ args: r.obj({ a: r.text() }), returns: r.num() })],
    ['iface', r.iface({ props: { id: r.text() } })],
  ];
  test.each(cases)('%s', (_name, t) => {
    const back = r.parse(JSON.parse(JSON.stringify(t.toJSON())));
    expect(back.toJSON()).toEqual(t.toJSON());
    expect(back.compatible(t)).toBe(true);
    expect(t.compatible(back)).toBe(true);
  });

  test('compatibility refuses an incompatible redeclaration', () => {
    const v1 = r.obj({ a: r.text() });
    const v2 = r.obj({ a: r.num() });
    expect(v1.compatible(v2)).toBe(false);
    const widened = r.obj({ a: r.text(), b: r.optional(r.num()) });
    expect(widened.compatible(v1)).toBe(true);
  });
});

describe('Value.toLogical', () => {
  test('passes leaves through untouched', () => {
    const d = new Date(0);
    expect(new Value(r.date(), d).toLogical()).toBe(d);
    const t = r.num();
    expect(new Value(r.typ(r.any()), t).toLogical()).toBe(t);
  });
});

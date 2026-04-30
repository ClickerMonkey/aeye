import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';
import { Extension } from '../extension';
import { AliasType } from '../types/alias';
import { LocalScope } from '../type-scope';

/**
 * Extensions can declare their own generic parameters. The parameters
 * live on `local.generic` (decl + current binding map) and are
 * referenced as `r.alias('T')` inside `props`/`get`/`call`. There is
 * no eager `bind` machinery — call sites pass an extra `TypeScope`
 * binding T to a concrete type, and AliasType resolution sees it.
 */
describe('Extension generics', () => {
  const r = createRegistry();

  test('declare: Box<T> placeholders survive as AliasType', () => {
    const T = r.alias('T');
    const Box = r.extend('object', {
      name: 'Box',
      generic: { T },
      props: {
        value: { type: T },
      },
    });
    r.register(Box);

    expect(Box.generic.T).toBeInstanceOf(AliasType);
    expect((Box as Extension).local.props!.value!.type).toBeInstanceOf(AliasType);
  });

  test('Box<T> resolution: extra-scope T=num makes value.type behave as num', () => {
    const reg = createRegistry();
    const T = reg.alias('T');
    const Box = reg.extend('object', {
      name: 'Box',
      generic: { T },
      props: { value: { type: T } },
    });
    reg.register(Box);

    const local = new LocalScope(reg, { T: reg.num() });
    const valueProp = (Box as Extension).local.props!.value!;
    expect((valueProp.type as AliasType).simplify(local).name).toBe('num');
    expect(valueProp.type.valid(5, local)).toBe(true);
    expect(valueProp.type.valid('x', local)).toBe(false);
  });

  test('multi-param: Pair<A, B> via extra-scope', () => {
    const reg = createRegistry();
    const A = reg.alias('A');
    const B = reg.alias('B');
    const Pair = reg.extend('object', {
      name: 'Pair',
      generic: { A, B },
      props: {
        first:  { type: A },
        second: { type: B },
      },
    });
    reg.register(Pair);

    const local = new LocalScope(reg, { A: reg.num(), B: reg.text() });
    expect((Pair as Extension).local.props!.first!.type.valid(5, local)).toBe(true);
    expect((Pair as Extension).local.props!.first!.type.valid('x', local)).toBe(false);
    expect((Pair as Extension).local.props!.second!.type.valid('x', local)).toBe(true);
    expect((Pair as Extension).local.props!.second!.type.valid(5, local)).toBe(false);
  });

  test('generic on call: identity<T>(x: T): T resolves via extra-scope', () => {
    const reg = createRegistry();
    const T = reg.alias('T');
    const Fn = reg.extend('function', {
      name: 'identity',
      generic: { T },
      call: { args: reg.obj({ x: { type: T } }), returns: T },
    });
    reg.register(Fn);

    const local = new LocalScope(reg, { T: reg.num() });
    const call = Fn.call(local)!;
    // `returns` is AliasType('T'); .simplify(local) → num.
    expect(call.returns?.simplify(local).name).toBe('num');
    // args is an obj; its `x` field, accessed with local scope,
    // resolves through to num.
    expect(call.args.prop('x', local)!.type.valid(5, local)).toBe(true);
  });

  test('generic on get: Bag<K, V>[K]: V resolves via extra-scope', () => {
    const reg = createRegistry();
    const K = reg.alias('K');
    const V = reg.alias('V');
    const Bag = reg.extend('object', {
      name: 'Bag',
      generic: { K, V },
      get: {
        key: K,
        value: V,
      },
    });
    reg.register(Bag);

    const local = new LocalScope(reg, { K: reg.text(), V: reg.num() });
    const gs = Bag.get(local)!;
    // gs.key / gs.value are AliasTypes; resolved via local.
    expect((gs.key as AliasType).simplify(local).name).toBe('text');
    expect((gs.value as AliasType).simplify(local).name).toBe('num');
  });

  test('JSON round-trip preserves generic placeholder', () => {
    const reg = createRegistry();
    const T = reg.alias('T');
    const Holder = reg.extend('object', {
      name: 'Holder',
      generic: { T },
      props: { item: { type: T } },
    });
    reg.register(Holder);

    const json = Holder.toJSON();
    // `T` survives in the JSON as a bare-name AliasType ref.
    expect(json.generic?.T).toEqual({ name: 'T' });
    expect(json.props?.item?.type).toEqual({ name: 'T' });

    const reparsed = reg.parse(json) as Extension;
    expect(reparsed.local.props!.item!.type).toBeInstanceOf(AliasType);
    const local = new LocalScope(reg, { T: reg.num() });
    expect((reparsed.local.props!.item!.type as AliasType).simplify(local).name).toBe('num');
  });

  test('extra-scope inside props is visible via props()', () => {
    const reg = createRegistry();
    const T = reg.alias('T');
    const Wrapper = reg.extend('object', {
      name: 'Wrapper',
      generic: { T },
      props: { inside: { type: T } },
    });
    reg.register(Wrapper);

    const local = new LocalScope(reg, { T: reg.text({ minLength: 1 }) });
    const inside = Wrapper.prop('inside', local);
    expect(inside).toBeDefined();
    // The captured Prop's type is AliasType('T'); resolution via local
    // returns the bound text type with options preserved.
    const resolved = (inside!.type as AliasType).simplify(local);
    expect(resolved.name).toBe('text');
    expect((resolved.options as { minLength?: number }).minLength).toBe(1);
  });
});

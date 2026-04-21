import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';
import { Extension } from '../extension';
import { GenericType } from '../types/generic';

/**
 * Extensions can declare their own generic parameters. The parameters
 * live on `local.generic` (decl + current binding map), are substituted
 * via `.bind({T: ...})`, and propagate through local.props / get / call.
 *
 * Convention: use `registry.generic('T')` as both the declaration value
 * AND the placeholder inside props/etc. That way `.bind(...)` updates
 * the declared binding AND the usage sites in one substitute walk.
 */
describe('Extension generics', () => {
  const r = createRegistry();

  test('declare + bind: Box<T>', () => {
    const T = r.generic('T');
    const Box = r.extend('object', {
      name: 'Box',
      generic: { T },
      props: {
        value: { type: T },
      },
    });
    r.register(Box);

    // Template: T unbound
    expect(Box.generic.T).toBeInstanceOf(GenericType);
    expect((Box as Extension).local.props!.value!.type).toBeInstanceOf(GenericType);

    // Bind T = num
    const NumBox = Box.bind({ T: r.num() });
    expect(NumBox).toBeInstanceOf(Extension);
    expect(NumBox.generic.T!.name).toBe('num');
    // The prop's type is now num, not a placeholder.
    expect((NumBox as Extension).local.props!.value!.type.name).toBe('num');
  });

  test('multi-param: Pair<A, B>', () => {
    const A = r.generic('A');
    const B = r.generic('B');
    const Pair = r.extend('object', {
      name: 'Pair',
      generic: { A, B },
      props: {
        first:  { type: A },
        second: { type: B },
      },
    });
    r.register(Pair);

    const NumText = Pair.bind({ A: r.num(), B: r.text() });
    expect((NumText as Extension).local.props!.first!.type.name).toBe('num');
    expect((NumText as Extension).local.props!.second!.type.name).toBe('text');
  });

  test('generic on call: identity<T>(x: T): T', () => {
    const T = r.generic('T');
    const Fn = r.extend('function', {
      name: 'identity',
      generic: { T },
      call: { args: r.obj({ x: { type: T } }), returns: T },
    });
    r.register(Fn);

    const bound = Fn.bind({ T: r.num() });
    const call = bound.call()!;
    expect(call.returns!.name).toBe('num');
    // args is an obj; its `x` field is num.
    const argsObj = call.args;
    expect(argsObj.prop('x')!.type.name).toBe('num');
  });

  test('generic on get: Bag<K, V>[K]: V', () => {
    const K = r.generic('K');
    const V = r.generic('V');
    const Bag = r.extend('object', {
      name: 'Bag',
      generic: { K, V },
      get: {
        key: K,
        value: V,
      },
    });
    r.register(Bag);

    const bound = Bag.bind({ K: r.text(), V: r.num() });
    const gs = bound.get()!;
    expect(gs.key.name).toBe('text');
    expect(gs.value.name).toBe('num');
  });

  test('JSON round-trip preserves generic', () => {
    const T = r.generic('T');
    const Holder = r.extend('object', {
      name: 'Holder',
      generic: { T },
      props: { item: { type: T } },
    });
    r.register(Holder);

    const NumHolder = Holder.bind({ T: r.num() });
    const json = NumHolder.toJSON();
    expect(json.generic?.T).toEqual({ name: 'num', options: undefined });
    expect(json.props?.item?.type).toEqual({ name: 'num', options: undefined });

    const reparsed = r.parse(json) as Extension;
    expect(reparsed.local.props!.item!.type.name).toBe('num');
  });

  test('bind substitutes inside props, accessible via props()', () => {
    const T = r.generic('T');
    const Wrapper = r.extend('object', {
      name: 'Wrapper',
      generic: { T },
      props: { inside: { type: T } },
    });
    r.register(Wrapper);

    const StrWrap = Wrapper.bind({ T: r.text({ minLength: 1 }) });
    // Access via the merged props() surface — T is replaced by the text type
    // with its options preserved.
    const inside = StrWrap.prop('inside');
    expect(inside).toBeDefined();
    expect(inside!.type.name).toBe('text');
    const textOpts = (inside!.type.options as { minLength?: number });
    expect(textOpts.minLength).toBe(1);
  });
});

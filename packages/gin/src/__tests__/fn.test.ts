import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { FnType } from '../types/fn';

describe('FnType', () => {
  const r = createRegistry();

  test('builder with args/returns', () => {
    const t = r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() }) as FnType;
    expect(t).toBeInstanceOf(FnType);
    expect(t.call()?.args.name).toBe('obj');
    expect(t.call()?.returns?.name).toBe('num');
  });

  test('valid accepts functions, expressions, strings', () => {
    const t = r.fn({ args: r.obj({}), returns: r.num() });
    expect(t.valid(() => 1)).toBe(true);
    expect(t.valid('native-id')).toBe(true);
    expect(t.valid({ kind: 'lambda' })).toBe(true);
    expect(t.valid(42)).toBe(false);
  });

  test('compatible with matching signatures', () => {
    const a = r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() });
    const b = r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() });
    expect(a.compatible(b)).toBe(true);
  });

  test('compatible rejects different signatures', () => {
    const a = r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() });
    const b = r.fn({ args: r.obj({ x: { type: r.text() } }), returns: r.num() });
    expect(a.compatible(b)).toBe(false);
  });

  test('call() exposes signature', () => {
    const t = r.fn({ args: r.obj({}), returns: r.bool() });
    const c = t.call();
    expect(c).toBeDefined();
    expect(c!.returns?.name).toBe('bool');
  });

  test('call is natively consumed → no auto-Extension', () => {
    const json = {
      name: 'fn',
      call: { args: { name: 'obj' }, returns: { name: 'num' } },
    };
    const back = r.parse(json);
    expect(back).toBeInstanceOf(FnType);
  });

  test('encode + parse roundtrip', () => {
    const t = r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.text() });
    const back = r.parse(t.toJSON()) as FnType;
    expect(back).toBeInstanceOf(FnType);
    expect(back.call().returns?.name).toBe('text');
  });
});

/**
 * `fn.create()` used to be `null`, and `fn.valid(null)` is false — so `fn` was
 * the one type whose own constructor produced a value its own predicate
 * rejected. The witness IS derivable: the declaration names the return type.
 */
describe('create() produces a value the type accepts (0.4.2)', () => {
  const r = createRegistry();

  test('the zero fn is a body constructing the declared return type', () => {
    const t = r.fn({ args: r.obj({ x: { type: r.num() } }), returns: r.num() });
    expect(t.create()).toEqual({ kind: 'new', type: { name: 'num' } });
    expect(t.valid(t.create())).toBe(true);
  });

  test('...and it is a runnable program of that return type', async () => {
    const { Engine } = await import('../engine');
    const e = new Engine(r);
    const t = r.fn({ args: r.obj({}), returns: r.num() });
    const out = await e.run(t.create());
    expect(out.raw).toBe(0);
    expect(out.type.name).toBe('num');
  });

  test('no declared return → a void body', () => {
    expect(r.fn({ args: r.obj({}) }).create()).toEqual({ kind: 'new', type: { name: 'void' } });
  });

  test('it does not recurse into another create() — a fn returning a fn is finite', () => {
    const inner = r.fn({ args: r.obj({}), returns: r.num() });
    const outer = r.fn({ args: r.obj({}), returns: inner });
    expect(() => outer.create()).not.toThrow();
    expect(outer.valid(outer.create())).toBe(true);
  });

  test('the failure it propagated into: an obj holding a fn field', () => {
    // MEASURED BEFORE: false — an obj could not validate its own `create()`.
    const holder = r.obj({ m: { type: r.fn({ args: r.obj({}), returns: r.text() }) } });
    expect(holder.valid(holder.create())).toBe(true);
  });

  test('...and a list of fns, which reported it as a LENGTH constraint', () => {
    // MEASURED BEFORE: threw `list.parse: length constraints violated` for a
    // one-element list with no min/max declared anywhere — the element-vs-
    // length diagnostic confusion, fired by a value `create()` had just made.
    const t = r.fn({ args: r.obj({}), returns: r.num() });
    expect(() => r.list(t).parse([t.create()])).not.toThrow();
  });

  test('random() agrees with create() — both must satisfy the type', () => {
    const t = r.fn({ args: r.obj({}), returns: r.text() });
    expect(t.valid(t.random(() => 0))).toBe(true);
  });

  test('parse still accepts all three value forms', () => {
    const t = r.fn({ args: r.obj({}), returns: r.num() });
    expect(t.parse('native.id').raw).toBe('native.id');
    expect(t.parse({ kind: 'lambda' }).raw).toEqual({ kind: 'lambda' });
    expect(typeof t.parse(() => 1).raw).toBe('function');
  });
});

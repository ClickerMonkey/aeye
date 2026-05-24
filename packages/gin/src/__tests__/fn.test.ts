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

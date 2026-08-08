import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { Extension } from '../extension';
import { NumType } from '../types/num';

describe('Extension', () => {
  test('extend narrows options and adds props', () => {
    const r = createRegistry();
    const temp = r.extend('num', {
      name: 'temperature',
      options: { min: -273.15, suffix: '°C' },
      props: {
        toFahrenheit: { type: r.fn({ args: r.obj({}), returns: r.num() }) },
      },
    });
    expect(temp).toBeInstanceOf(Extension);
    expect(temp.name).toBe('temperature');
    // base delegation: enforces narrowed bounds
    expect(temp.valid(0)).toBe(true);
    expect(temp.valid(-300)).toBe(false);
    // overlay: local prop is present alongside base props
    expect(temp.props().toFahrenheit).toBeDefined();
    expect(temp.props().add).toBeDefined();  // inherited from num
  });

  test('extend rejects options widening', () => {
    const r = createRegistry();
    const bounded = r.extend('num', { name: 'positive', options: { min: 0 } });
    expect(() => r.extend(bounded, { name: 'negative', options: { min: -100 } })).toThrow();
  });

  test('compatible with base in non-exact mode', () => {
    const r = createRegistry();
    const t = r.extend('num', { name: 'pct', options: { min: 0, max: 100 } });
    expect(t.compatible(r.num())).toBe(true);
    expect(t.compatible(r.num(), { exact: true })).toBe(false);
  });

  test('auto-Extension: bare num with extra props wraps automatically', () => {
    const r = createRegistry();
    const json = {
      name: 'num',
      options: { min: 0 },
      props: { extraMethod: { type: { name: 'any' } } },
    };
    const back = r.parse(json);
    expect(back).toBeInstanceOf(Extension);
    expect(back.name).toBe('num');
    expect(back.props().extraMethod).toBeDefined();
    // base num props still available
    expect(back.props().add).toBeDefined();
  });

  test('auto-Extension: object.props is native (no wrap)', () => {
    const r = createRegistry();
    const json = {
      name: 'obj',
      props: { x: { type: { name: 'num' } } },
    };
    const back = r.parse(json);
    expect(back).not.toBeInstanceOf(Extension);
  });

  test('extends: "obj" folds structural props into the base (fields survive parse)', () => {
    // Regression: an `extends: 'obj'` type-ref used to strand its props in the
    // Extension local, which `parse` never consults — so every value parsed to
    // `{}`. The props are now folded into the obj base and parse round-trips.
    const r = createRegistry();
    const Widget = r.parse({
      name: 'Widget',
      extends: 'obj',
      props: { x: { type: { name: 'num' } }, y: { type: { name: 'num' } } },
    });
    expect(Widget).toBeInstanceOf(Extension);
    expect(Widget.name).toBe('Widget');
    // props() still advertises the fields …
    expect(Widget.props().x).toBeDefined();
    expect(Widget.props().y).toBeDefined();
    // … and, crucially, a parsed VALUE keeps them (was `{}` before the fix).
    const raw = Widget.parse({ x: 1, y: 2 }).raw as Record<string, { raw: unknown }>;
    expect(raw['x']?.raw).toBe(1);
    expect(raw['y']?.raw).toBe(2);
  });

  test('auto-Extension: fn.call is native (no wrap)', () => {
    const r = createRegistry();
    const json = {
      name: 'fn',
      call: { args: { name: 'obj' }, returns: { name: 'num' } },
    };
    const back = r.parse(json);
    expect(back).not.toBeInstanceOf(Extension);
  });

  test('auto-Extension: object + init wraps in Extension', () => {
    // obj consumes props but not init; adding init should trigger wrap.
    const r = createRegistry();
    const json = {
      name: 'obj',
      props: { x: { type: { name: 'num' } } },
      init: { args: { name: 'obj' }, run: { kind: 'native', id: 'foo' } },
    };
    const back = r.parse(json);
    expect(back).toBeInstanceOf(Extension);
  });

  test('extends: cross-extend to a different name', () => {
    const r = createRegistry();
    const pct = r.extend('num', { name: 'percent', options: { min: 0, max: 100 } });
    r.register(pct);
    const json = { name: 'gradePct', extends: 'percent', options: { min: 50 } };
    const ext = r.parse(json) as Extension;
    expect(ext).toBeInstanceOf(Extension);
    expect(ext.name).toBe('gradePct');
    expect(ext.options.min).toBe(50);
    expect(ext.options.max).toBe(100);
  });

  test('encode: cross-extend emits extends field', () => {
    const r = createRegistry();
    const temp = r.extend('num', { name: 'temperature', options: { min: -273.15 } });
    const j = temp.toJSON();
    expect(j.extends).toBe('num');
    expect(j.name).toBe('temperature');
  });

  test('encode: self-extend (same name) flattens', () => {
    const r = createRegistry();
    const json = { name: 'num', options: { min: 0 }, props: { x: { type: { name: 'any' } } } };
    const ext = r.parse(json) as Extension;
    const out = ext.toJSON();
    expect(out.extends).toBeUndefined();
    expect(out.name).toBe('num');
    expect(out.props?.x).toBeDefined();
  });

  test('base stays a Num after narrowing', () => {
    const r = createRegistry();
    const t = r.extend('num', { name: 'n', options: { min: 0 } });
    expect(t.base).toBeInstanceOf(NumType);
    expect((t.base as NumType).options.min).toBe(0);
  });

  describe('extending a type whose narrow() has nothing to narrow', () => {
    // The base is rebuilt by splicing the NARROWED options into the original's
    // wire def, which is only sound where the runtime and wire forms coincide.
    // `or`/`and` hold `variants`/`parts` in memory and emit `types` on the
    // wire, and their `narrow` has no per-part semantics — it hands the base's
    // own options straight back. Splicing those in produced a base with ZERO
    // parts: `or<>` refused every value, `and<>` accepted every value, both
    // silently. The rebuild is now skipped when narrowing changed nothing.

    test('or keeps its variants', () => {
      const r = createRegistry();
      const either = r.extend(r.or([r.text(), r.num()]), { name: 'Either', options: {} });
      expect(either.base.toCode()).toBe('or<text, num>');
      expect(either.parse('x').raw).toBe('x');
      expect(either.parse(1).raw).toBe(1);
      expect(() => either.parse(true)).toThrow();
    });

    test('and keeps its parts', () => {
      const r = createRegistry();
      const both = r.extend(r.and([r.obj({ a: { type: r.text() } })]), { name: 'Both', options: {} });
      expect(both.base.toCode()).toBe('and<obj{a: text}>');
      // `and<>` would have accepted this — an intersection over no parts is universal.
      expect(() => both.parse({ b: 1 })).toThrow();
    });

    test('a REAL narrowing still rebuilds the base and enforces the tighter bound', () => {
      const r = createRegistry();
      const pos = r.extend(r.num(), { name: 'Pos', options: { min: 1 } });
      expect((pos.base as NumType).options.min).toBe(1);
      expect(pos.parse(5).raw).toBe(5);
      expect(() => pos.parse(0)).toThrow();
    });

    test('a narrowing that merges with the base keeps both bounds', () => {
      const r = createRegistry();
      const slug = r.extend(r.text({ maxLength: 9 }), { name: 'Slug', options: { minLength: 2 } });
      expect(slug.valid('abc')).toBe(true);
      expect(slug.valid('a')).toBe(false);
      expect(slug.valid('0123456789')).toBe(false);
    });
  });
});

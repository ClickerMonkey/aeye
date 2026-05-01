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
        toFahrenheit: { type: r.fn(r.obj({}), r.num()) },
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
});

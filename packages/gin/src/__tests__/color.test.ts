import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { ColorType } from '../types/color';

describe('ColorType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.color()).toBeInstanceOf(ColorType);
    expect(r.color().name).toBe('color');
  });

  test('valid requires 32-bit int', () => {
    expect(r.color().valid(0x000000ff)).toBe(true);
    expect(r.color().valid(0xffffffff)).toBe(true);
    expect(r.color().valid(-1)).toBe(false);
    expect(r.color().valid(0x1ffffffff)).toBe(false);
    expect(r.color().valid(1.5)).toBe(false);
    expect(r.color().valid('red')).toBe(false);
  });

  test('parse + dump roundtrip', () => {
    const t = r.color();
    const v = t.parse(0x00ff00ff);
    expect(v.raw).toBe(0x00ff00ff);
    expect(t.encode(0x00ff00ff)).toBe(0x00ff00ff);
  });

  test('create returns opaque black', () => {
    expect(r.color().create()).toBe(0x000000ff);
  });

  test('init spec exposes r/g/b/a args', () => {
    const i = r.color().init();
    expect(i).toBeDefined();
    expect(i!.args.name).toBe('object');
  });

  test('props include components + manipulation + conversion', () => {
    const p = r.color().props();
    for (const n of ['r', 'g', 'b', 'a', 'hue', 'saturation', 'lightness', 'lighten', 'darken', 'mix', 'toHex', 'toRgb', 'toHsl']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.color({ hasAlpha: true });
    const back = r.parse(t.toJSON()) as ColorType;
    expect(back).toBeInstanceOf(ColorType);
    expect(back.options.hasAlpha).toBe(true);
  });
});

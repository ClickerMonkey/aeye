import type { NativeImpl } from '../registry';
import { val } from '../value';
import { arg, self } from './helpers';

const rOf = (c: number) => (c >>> 24) & 0xff;
const gOf = (c: number) => (c >>> 16) & 0xff;
const bOf = (c: number) => (c >>> 8)  & 0xff;
const aOf = (c: number) => (c        & 0xff) / 255;
const pack = (r: number, g: number, b: number, a: number) =>
  ((Math.round(r) & 0xff) << 24) | ((Math.round(g) & 0xff) << 16) | ((Math.round(b) & 0xff) << 8) | (Math.round(a * 255) & 0xff);

export const colorNatives: Record<string, NativeImpl> = {
  'color.init': (scope, reg) => {
    const r = arg<number>(scope, 'r');
    const g = arg<number>(scope, 'g');
    const b = arg<number>(scope, 'b');
    const a = arg<number | undefined>(scope, 'a') ?? 1;
    return val(reg.color(), pack(r, g, b, a) >>> 0);
  },

  'color.r': (scope, reg) => val(reg.num(), rOf(self<number>(scope))),
  'color.g': (scope, reg) => val(reg.num(), gOf(self<number>(scope))),
  'color.b': (scope, reg) => val(reg.num(), bOf(self<number>(scope))),
  'color.a': (scope, reg) => val(reg.num(), aOf(self<number>(scope))),

  'color.hue': (scope, reg) => val(reg.num(), hsl(self<number>(scope)).h),
  'color.saturation': (scope, reg) => val(reg.num(), hsl(self<number>(scope)).s),
  'color.lightness':  (scope, reg) => val(reg.num(), hsl(self<number>(scope)).l),

  'color.eq':  (scope, reg) => val(reg.bool(), self<number>(scope) === arg<number>(scope, 'other')),
  'color.neq': (scope, reg) => val(reg.bool(), self<number>(scope) !== arg<number>(scope, 'other')),

  'color.lighten':    (scope, reg) => val(reg.color(), adjustL(self<number>(scope),  arg<number>(scope, 'amount'))),
  'color.darken':     (scope, reg) => val(reg.color(), adjustL(self<number>(scope), -arg<number>(scope, 'amount'))),
  'color.saturate':   (scope, reg) => val(reg.color(), adjustS(self<number>(scope),  arg<number>(scope, 'amount'))),
  'color.desaturate': (scope, reg) => val(reg.color(), adjustS(self<number>(scope), -arg<number>(scope, 'amount'))),
  'color.opacity':    (scope, reg) => val(reg.color(), (self<number>(scope) & 0xffffff00) | (Math.round(arg<number>(scope, 'alpha') * 255) & 0xff)),
  'color.invert':     (scope, reg) => {
    const c = self<number>(scope);
    return val(reg.color(), pack(255 - rOf(c), 255 - gOf(c), 255 - bOf(c), aOf(c)) >>> 0);
  },
  'color.mix': (scope, reg) => {
    const a = self<number>(scope), b = arg<number>(scope, 'other');
    const w = arg<number | undefined>(scope, 'weight') ?? 0.5;
    return val(reg.color(), pack(
      rOf(a) * (1 - w) + rOf(b) * w,
      gOf(a) * (1 - w) + gOf(b) * w,
      bOf(a) * (1 - w) + bOf(b) * w,
      aOf(a) * (1 - w) + aOf(b) * w,
    ) >>> 0);
  },
  'color.complement': (scope, reg) => val(reg.color(), adjustH(self<number>(scope), 180)),

  'color.toHex': (scope, reg) => val(reg.text(), '#' + self<number>(scope).toString(16).padStart(8, '0')),
  'color.toRgb': (scope, reg) => {
    const c = self<number>(scope);
    return val(reg.text(), `rgb(${rOf(c)},${gOf(c)},${bOf(c)})`);
  },
  'color.toHsl': (scope, reg) => {
    const { h, s, l } = hsl(self<number>(scope));
    return val(reg.text(), `hsl(${Math.round(h)},${Math.round(s * 100)}%,${Math.round(l * 100)}%)`);
  },
  'color.toText': (scope, reg) => val(reg.text(), '#' + self<number>(scope).toString(16).padStart(8, '0')),
};

function hsl(c: number): { h: number; s: number; l: number } {
  const r = rOf(c) / 255, g = gOf(c) / 255, b = bOf(c) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number, a: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60)       [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else              [r1, g1, b1] = [c, 0, x];
  return pack((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255, a);
}

function adjustL(c: number, delta: number): number {
  const { h, s, l } = hsl(c);
  return fromHsl(h, s, Math.max(0, Math.min(1, l + delta)), aOf(c)) >>> 0;
}
function adjustS(c: number, delta: number): number {
  const { h, s, l } = hsl(c);
  return fromHsl(h, Math.max(0, Math.min(1, s + delta)), l, aOf(c)) >>> 0;
}
function adjustH(c: number, delta: number): number {
  const { h, s, l } = hsl(c);
  return fromHsl((h + delta + 360) % 360, s, l, aOf(c)) >>> 0;
}

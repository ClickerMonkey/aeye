import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { arg, epsilon, self, setupYield } from './helpers';

export const numNatives: Record<string, NativeImpl> = {
  // comparison (value-approx via epsilon)
  'num.eq':  (scope, reg) => val(reg.bool(), Math.abs(self<number>(scope) - arg<number>(scope, 'other')) <= epsilon(scope)),
  'num.neq': (scope, reg) => val(reg.bool(), Math.abs(self<number>(scope) - arg<number>(scope, 'other')) > epsilon(scope)),
  'num.lt':  (scope, reg) => val(reg.bool(), self<number>(scope) <  arg<number>(scope, 'other')),
  'num.lte': (scope, reg) => val(reg.bool(), self<number>(scope) <= arg<number>(scope, 'other')),
  'num.gt':  (scope, reg) => val(reg.bool(), self<number>(scope) >  arg<number>(scope, 'other')),
  'num.gte': (scope, reg) => val(reg.bool(), self<number>(scope) >= arg<number>(scope, 'other')),

  // arithmetic
  'num.add': (scope, reg) => val(reg.num(), self<number>(scope) + arg<number>(scope, 'other')),
  'num.sub': (scope, reg) => val(reg.num(), self<number>(scope) - arg<number>(scope, 'other')),
  'num.mul': (scope, reg) => val(reg.num(), self<number>(scope) * arg<number>(scope, 'other')),
  'num.div': (scope, reg) => val(reg.num(), self<number>(scope) / arg<number>(scope, 'other')),
  'num.mod': (scope, reg) => val(reg.num(), self<number>(scope) % arg<number>(scope, 'other')),
  'num.pow': (scope, reg) => val(reg.num(), self<number>(scope) ** arg<number>(scope, 'other')),

  // unary
  'num.abs':  (scope, reg) => val(reg.num(), Math.abs(self<number>(scope))),
  'num.neg':  (scope, reg) => val(reg.num(), -self<number>(scope)),
  'num.sign': (scope, reg) => val(reg.num(), Math.sign(self<number>(scope))),
  'num.sqrt': (scope, reg) => val(reg.num(), Math.sqrt(self<number>(scope))),

  // bounds
  'num.min':   (scope, reg) => val(reg.num(), Math.min(self<number>(scope), arg<number>(scope, 'other'))),
  'num.max':   (scope, reg) => val(reg.num(), Math.max(self<number>(scope), arg<number>(scope, 'other'))),
  'num.clamp': (scope, reg) => val(reg.num(), Math.min(Math.max(self<number>(scope), arg<number>(scope, 'min')), arg<number>(scope, 'max'))),

  // rounding
  'num.floor': (scope, reg) => val(reg.num(), Math.floor(self<number>(scope))),
  'num.ceil':  (scope, reg) => val(reg.num(), Math.ceil(self<number>(scope))),
  'num.round': (scope, reg) => val(reg.num(), Math.round(self<number>(scope))),

  // predicates
  'num.isZero':     (scope, reg) => val(reg.bool(), Math.abs(self<number>(scope)) <= epsilon(scope)),
  'num.isPositive': (scope, reg) => val(reg.bool(), self<number>(scope) > epsilon(scope)),
  'num.isNegative': (scope, reg) => val(reg.bool(), self<number>(scope) < -epsilon(scope)),
  'num.isInteger':  (scope, reg) => val(reg.bool(), Number.isInteger(self<number>(scope))),
  'num.isEven':     (scope, reg) => val(reg.bool(), self<number>(scope) % 2 === 0),
  'num.isOdd':      (scope, reg) => val(reg.bool(), Math.abs(self<number>(scope)) % 2 === 1),

  // conversion
  'num.toText': (scope, reg) => {
    const precision = arg<number | undefined>(scope, 'precision');
    const s = precision != null ? self<number>(scope).toFixed(precision) : String(self<number>(scope));
    return val(reg.text(), s);
  },
  'num.toBool': (scope, reg) => val(reg.bool(), self<number>(scope) !== 0),

  // loop: yields (key=0..|n|-1, value=0-toward-n)
  'num.loop': async (scope, reg) => {
    const n = self<number>(scope);
    const numType = reg.num();
    const doYield = setupYield(scope, reg, numType, numType);
    const count = Math.abs(Math.trunc(n));
    const step = n < 0 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const v = i * step;
      // Normalize negative zero to positive zero for consistent equality.
      const safe = Object.is(v, -0) ? 0 : v;
      await doYield(val(numType, i), val(numType, safe));
    }
    return val(reg.void(), undefined);
  },
};

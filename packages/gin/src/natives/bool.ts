import type { NativeImpl } from '../registry';
import { val } from '../value';
import { arg, self } from './helpers';

export const boolNatives: Record<string, NativeImpl> = {
  'bool.eq':  (scope, reg) => val(reg.bool(), self<boolean>(scope) === arg<boolean>(scope, 'other')),
  'bool.neq': (scope, reg) => val(reg.bool(), self<boolean>(scope) !== arg<boolean>(scope, 'other')),
  'bool.and': (scope, reg) => val(reg.bool(), self<boolean>(scope) && arg<boolean>(scope, 'other')),
  'bool.or':  (scope, reg) => val(reg.bool(), self<boolean>(scope) || arg<boolean>(scope, 'other')),
  'bool.xor': (scope, reg) => val(reg.bool(), self<boolean>(scope) !== arg<boolean>(scope, 'other')),
  'bool.not': (scope, reg) => val(reg.bool(), !self<boolean>(scope)),

  'bool.toText': (scope, reg) => {
    const s = self<boolean>(scope);
    const t = arg<string | undefined>(scope, 'trueText');
    const f = arg<string | undefined>(scope, 'falseText');
    return val(reg.text(), s ? (t ?? 'true') : (f ?? 'false'));
  },
  'bool.toNum': (scope, reg) => {
    const s = self<boolean>(scope);
    const t = arg<number | undefined>(scope, 'trueValue');
    const f = arg<number | undefined>(scope, 'falseValue');
    return val(reg.num(), s ? (t ?? 1) : (f ?? 0));
  },
};

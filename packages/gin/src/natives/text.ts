import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { arg, self } from './helpers';

export const textNatives: Record<string, NativeImpl> = {
  // field
  'text.length': (scope, reg) => val(reg.num({ whole: true, min: 0 }), self<string>(scope).length),

  // comparison
  'text.eq':         (scope, reg) => val(reg.bool(), self<string>(scope) === arg<string>(scope, 'other')),
  'text.neq':        (scope, reg) => val(reg.bool(), self<string>(scope) !== arg<string>(scope, 'other')),
  'text.contains':   (scope, reg) => val(reg.bool(), self<string>(scope).includes(arg<string>(scope, 'search'))),
  'text.startsWith': (scope, reg) => val(reg.bool(), self<string>(scope).startsWith(arg<string>(scope, 'prefix'))),
  'text.endsWith':   (scope, reg) => val(reg.bool(), self<string>(scope).endsWith(arg<string>(scope, 'suffix'))),

  // transformation
  'text.trim':      (scope, reg) => val(reg.text(), self<string>(scope).trim()),
  'text.trimStart': (scope, reg) => val(reg.text(), self<string>(scope).trimStart()),
  'text.trimEnd':   (scope, reg) => val(reg.text(), self<string>(scope).trimEnd()),
  'text.upper':     (scope, reg) => val(reg.text(), self<string>(scope).toUpperCase()),
  'text.lower':     (scope, reg) => val(reg.text(), self<string>(scope).toLowerCase()),

  'text.slice': (scope, reg) => {
    const start = arg<number>(scope, 'start');
    const end = arg<number | undefined>(scope, 'end');
    return val(reg.text(), self<string>(scope).slice(start, end));
  },
  'text.replace': (scope, reg) => {
    const search = arg<string>(scope, 'search');
    const replacement = arg<string>(scope, 'replacement');
    return val(reg.text(), self<string>(scope).split(search).join(replacement));
  },
  'text.split': (scope, reg) => {
    const parts = self<string>(scope).split(arg<string>(scope, 'separator'));
    return val(reg.list(reg.text()), parts.map((p) => val(reg.text(), p)));
  },
  'text.concat': (scope, reg) => val(reg.text(), self<string>(scope) + arg<string>(scope, 'other')),
  'text.repeat': (scope, reg) => val(reg.text(), self<string>(scope).repeat(arg<number>(scope, 'count'))),

  'text.indexOf': (scope, reg) => {
    const from = arg<number | undefined>(scope, 'from');
    return val(reg.num(), self<string>(scope).indexOf(arg<string>(scope, 'search'), from));
  },
  'text.lastIndexOf': (scope, reg) => {
    const from = arg<number | undefined>(scope, 'from');
    return val(reg.num(), self<string>(scope).lastIndexOf(arg<string>(scope, 'search'), from));
  },

  'text.match': (scope, reg) => {
    const pattern = arg<string>(scope, 'pattern');
    const m = self<string>(scope).match(new RegExp(pattern, 'g'));
    const parts = m ?? [];
    return val(reg.list(reg.text()), parts.map((p) => val(reg.text(), p)));
  },
  'text.test': (scope, reg) => {
    const pattern = arg<string>(scope, 'pattern');
    return val(reg.bool(), new RegExp(pattern).test(self<string>(scope)));
  },

  'text.isEmpty':    (scope, reg) => val(reg.bool(), self<string>(scope).length === 0),
  'text.isNotEmpty': (scope, reg) => val(reg.bool(), self<string>(scope).length > 0),

  'text.toNum':  (scope, reg) => val(reg.num(), Number(self<string>(scope))),
  'text.toBool': (scope, reg) => val(reg.bool(), self<string>(scope).length > 0),

  // indexed access + loop
  'text.charAt': (scope, reg) => {
    const key = scope.get('key')!.raw as number;
    const s = self<string>(scope);
    const ch = s[key];
    if (ch === undefined) throw new Error(`text[${key}]: index out of range`);
    return val(reg.text({ minLength: 1, maxLength: 1 }), ch);
  },
  'text.chars': async (scope, reg) => {
    const s = self<string>(scope);
    const yieldFn = scope.get('yield')!.raw as (k: Value, v: Value) => Promise<Value>;
    for (let i = 0; i < s.length; i++) {
      await yieldFn(val(reg.num({ whole: true, min: 0 }), i), val(reg.text({ minLength: 1, maxLength: 1 }), s[i]!));
    }
    return val(reg.void(), undefined);
  },
};

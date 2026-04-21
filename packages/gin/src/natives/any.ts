import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { arg, self, selfValue } from './helpers';

export const anyNatives: Record<string, NativeImpl> = {
  'any.typeOf':    (scope, reg) => val(reg.text(), selfValue(scope).type.name),
  'any.is':        (scope, reg) => val(reg.bool(), selfValue(scope).type.name === arg<string>(scope, 'type')),
  'any.as':        (scope, reg) => {
    const sv = selfValue(scope);
    const target = arg<string>(scope, 'type');
    return sv.type.name === target ? sv : val(reg.any(), null);
  },
  'any.toText':    (scope, reg) => val(reg.text(), String(self(scope))),
  'any.toBoolean': (scope, reg) => val(reg.bool(), Boolean(self(scope))),
  'any.eq':        (scope, reg) => val(reg.bool(), self(scope) === arg(scope, 'other')),
  'any.neq':       (scope, reg) => val(reg.bool(), self(scope) !== arg(scope, 'other')),
};

export const voidNatives: Record<string, NativeImpl> = {
  'void.toText':    (_scope, reg) => val(reg.text(), 'void'),
  'void.toBoolean': (_scope, reg) => val(reg.bool(), false),
};

export const nullNatives: Record<string, NativeImpl> = {
  'null.toText':    (_scope, reg) => val(reg.text(), 'null'),
  'null.toBoolean': (_scope, reg) => val(reg.bool(), false),
};

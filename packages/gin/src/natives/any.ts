import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { arg, self, selfValue } from './helpers';

export const anyNatives: Record<string, NativeImpl> = {
  // Universal — every Type inherits `toAny` via base Type.props().
  'type.toAny':    (scope, reg) => val(reg.any(), self(scope)),
  'any.typeOf':    (scope, reg) => val(reg.text(), selfValue(scope).type.name),
  // `is<T>()` / `as<T>()` — the caller picks T via the CallStep's `generic`
  // binding. Runtime plumbing to surface that binding to the native still
  // needs scope-level type bindings; for now the definition is correct but
  // these natives are placeholders that fall through to permissive defaults.
  'any.is':        (_scope, reg) => val(reg.bool(), true),
  'any.as':        (scope, reg) => {
    const sv = selfValue(scope);
    return val(reg.optional(sv.type), sv.raw);
  },
  'any.toText':    (scope, reg) => val(reg.text(), String(self(scope))),
  'any.toBool': (scope, reg) => val(reg.bool(), Boolean(self(scope))),
  'any.eq':        (scope, reg) => val(reg.bool(), self(scope) === arg(scope, 'other')),
  'any.neq':       (scope, reg) => val(reg.bool(), self(scope) !== arg(scope, 'other')),
};

export const voidNatives: Record<string, NativeImpl> = {
  'void.toText':    (_scope, reg) => val(reg.text(), 'void'),
  'void.toBool': (_scope, reg) => val(reg.bool(), false),
};

export const nullNatives: Record<string, NativeImpl> = {
  'null.toText':    (_scope, reg) => val(reg.text(), 'null'),
  'null.toBool': (_scope, reg) => val(reg.bool(), false),
};

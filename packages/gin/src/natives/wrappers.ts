import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { OptionalType } from '../types/optional';
import { NullableType } from '../types/nullable';
import { NotType } from '../types/not';
import { EnumType } from '../types/enum';
import { arg, self, selfValue, argValue } from './helpers';

// ─── optional ────────────────────────────────────────────────────────────

export const optionalNatives: Record<string, NativeImpl> = {
  'optional.value': (scope) => {
    const raw = self(scope);
    if (raw === undefined) throw new Error('optional.value: value is undefined');
    return val((selfValue(scope).type as OptionalType).inner, raw);
  },
  'optional.has': (scope, reg) => val(reg.bool(), self(scope) !== undefined),
  'optional.or': (scope) => {
    const raw = self(scope);
    const inner = (selfValue(scope).type as OptionalType).inner;
    if (raw !== undefined) return val(inner, raw);
    return argValue(scope, 'fallback') ?? val(inner, arg(scope, 'fallback'));
  },
  'optional.map': async (scope, reg) => {
    const raw = self(scope);
    const inner = (selfValue(scope).type as OptionalType).inner;
    if (raw === undefined) return val(reg.optional(reg.any()), undefined);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const argsType = reg.obj({ value: { type: inner } });
    const result = await call(new Value(argsType, { value: val(inner, raw) } as any));
    return val(reg.optional(reg.any()), result.raw);
  },
};

// ─── nullable ────────────────────────────────────────────────────────────

export const nullableNatives: Record<string, NativeImpl> = {
  'nullable.value': (scope) => {
    const raw = self(scope);
    if (raw === null) throw new Error('nullable.value: value is null');
    return val((selfValue(scope).type as NullableType).inner, raw);
  },
  'nullable.isNull': (scope, reg) => val(reg.bool(), self(scope) === null),
  'nullable.or': (scope) => {
    const raw = self(scope);
    const inner = (selfValue(scope).type as NullableType).inner;
    if (raw !== null) return val(inner, raw);
    return argValue(scope, 'fallback') ?? val(inner, arg(scope, 'fallback'));
  },
  'nullable.map': async (scope, reg) => {
    const raw = self(scope);
    const inner = (selfValue(scope).type as NullableType).inner;
    if (raw === null) return val(reg.nullable(reg.any()), null);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const argsType = reg.obj({ value: { type: inner } });
    const result = await call(new Value(argsType, { value: val(inner, raw) } as any));
    return val(reg.nullable(reg.any()), result.raw);
  },
};

// ─── not ─────────────────────────────────────────────────────────────────

export const notNatives: Record<string, NativeImpl> = {
  'not.typeOf': (scope, reg) => val(reg.text(), selfValue(scope).type.name),
  'not.toText': (scope, reg) => val(reg.text(), String(self(scope))),
};

// ─── enum ────────────────────────────────────────────────────────────────

export const enumNatives: Record<string, NativeImpl> = {
  'enum.name': (scope, reg) => {
    const raw = self(scope);
    const et = selfValue(scope).type as EnumType;
    const entry = Object.entries(et.options.values).find(([, v]) => v === raw);
    return val(reg.text(), entry ? entry[0] : '');
  },
  'enum.value': (scope) => {
    const et = selfValue(scope).type as EnumType;
    return val(et.value, self(scope));
  },
  'enum.eq':     (scope, reg) => val(reg.bool(), self(scope) === arg(scope, 'other')),
  'enum.neq':    (scope, reg) => val(reg.bool(), self(scope) !== arg(scope, 'other')),
  'enum.toText': (scope, reg) => val(reg.text(), String(self(scope))),
};

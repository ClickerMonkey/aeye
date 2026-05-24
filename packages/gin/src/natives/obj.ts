import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { ObjType } from '../types/obj';
import { arg, self, selfValue, setupYield } from './helpers';
import { Effects } from '../effects';

const fields = (scope: any) => (selfValue(scope).type as ObjType).fields;

/**
 * Object natives. Raw storage is `Record<string, Value>` — each field
 * carries its own actual type. Natives preserve these Values on reads
 * and stores.
 */
export const objNatives: Record<string, NativeImpl> = {
  'object.indexGet': (scope) => {
    const k = scope.get('key')!.raw as string;
    const f = fields(scope)[k];
    if (!f) throw new Error(`object[${k}]: no such field`);
    const stored = (self<Record<string, Value>>(scope))[k];
    if (stored instanceof Value) return stored;
    // Fallback when constructed outside parse (rare).
    return val(f.type, stored);
  },
  'object.indexSet': (scope, reg) => {
    const k = scope.get('key')!.raw as string;
    const v = scope.get('value')!;
    (self<Record<string, Value>>(scope))[k] = v;
    return val(reg.void(), undefined);
  },
  'object.iterate': async (scope, reg) => {
    const obj = self<Record<string, Value>>(scope);
    const fs = fields(scope);
    // Build the per-iteration yielder once with stable types: keys
    // are always text (field names), values are the union of the
    // obj's field types (or just any when there are no fields).
    const keyType = reg.text();
    const fieldTypes = Object.values(fs).map((p: any) => p.type);
    const valueType = fieldTypes.length === 0
      ? reg.any()
      : fieldTypes.length === 1 ? fieldTypes[0]! : reg.or(fieldTypes);
    const doYield = setupYield(scope, reg, keyType, valueType);
    for (const [name] of Object.entries(fs)) {
      const stored = obj[name];
      if (stored instanceof Value) {
        await doYield(val(keyType, name), stored);
      }
    }
    return val(reg.void(), undefined);
  },

  'object.keys':    (scope, reg) => {
    const names = Object.keys(fields(scope));
    return val(reg.list(reg.text()), names.map((n) => val(reg.text(), n)));
  },
  'object.values':  (scope, reg) => {
    const obj = self<Record<string, Value>>(scope);
    const out = Object.keys(fields(scope)).map((k) => obj[k] ?? val(reg.any(), undefined));
    return val(reg.list(reg.any()), out);
  },
  'object.entries': (scope, reg) => {
    const obj = self<Record<string, Value>>(scope);
    const out = Object.keys(fields(scope)).map((k) => val(reg.any(), [k, obj[k]?.raw]));
    return val(reg.list(reg.any()), out);
  },
  'object.has':     (scope, reg) => val(reg.bool(), Object.hasOwn(fields(scope), arg<string>(scope, 'key'))),

  'object.eq':  (scope, reg) => val(reg.bool(), deepEq(selfValue(scope), scope.get('args')!.raw as any)),
  'object.neq': (scope, reg) => val(reg.bool(), !deepEq(selfValue(scope), scope.get('args')!.raw as any)),

  'object.toText': (scope, reg) => {
    const obj = self<Record<string, Value>>(scope);
    const fs = fields(scope);
    const out: Record<string, unknown> = {};
    for (const [name] of Object.entries(fs)) {
      const v = obj[name];
      out[name] = v ? v.type.encode(v.raw) : undefined;
    }
    return val(reg.text(), JSON.stringify(out));
  },
};

/**
 * Effects overrides for object natives that aren't pure. Every native
 * not listed here defaults to `Effects.NONE` at registration time.
 */
export const objNativesEffects: Record<string, Effects> = {
  'object.indexSet': Effects.STATE,
};

/** Deep equality comparing Value.raw all the way down. */
function deepEq(aVal: Value, args: { other: Value } | Record<string, unknown>): boolean {
  const other = (args as { other: unknown }).other;
  const bRaw = other instanceof Value ? other.raw : other;
  return deepEqRaw(aVal.raw, bRaw);
}

function deepEqRaw(a: unknown, b: unknown): boolean {
  if (a instanceof Value) a = a.raw;
  if (b instanceof Value) b = b.raw;
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqRaw(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqRaw((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}

import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { TupleType } from '../types/tuple';
import { self, selfValue } from './helpers';

const elems = (scope: any) => (selfValue(scope).type as TupleType).elements;

/**
 * Tuple natives. Raw storage is `Value[]` — each slot carries its own
 * positional type. Natives pass Values through directly.
 */
export const tupleNatives: Record<string, NativeImpl> = {
  'tuple.at': (scope) => {
    const k = scope.get('key')!.raw as number;
    const arr = self<Value[]>(scope);
    const v = arr[k];
    if (v instanceof Value) return v;
    const es = elems(scope);
    return val(es[k] ?? val.prototype, v);
  },
  'tuple.setAt': (scope, reg) => {
    const k = scope.get('key')!.raw as number;
    const v = scope.get('value')!;
    self<Value[]>(scope)[k] = v;
    return val(reg.void(), undefined);
  },
  'tuple.iterate': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const yieldFn = scope.get('yield')!.raw as (k: Value, v: Value) => Promise<Value>;
    for (let i = 0; i < arr.length; i++) {
      await yieldFn(val(reg.num({ whole: true, min: 0 }), i), arr[i]!);
    }
    return val(reg.void(), undefined);
  },

  'tuple.length': (scope, reg) => val(reg.num({ whole: true }), self<Value[]>(scope).length),
  'tuple.first':  (scope) => {
    const arr = self<Value[]>(scope);
    const es = elems(scope);
    const v = arr[0];
    if (v instanceof Value) return v;
    return val(es[0]!, v);
  },
  'tuple.last':   (scope) => {
    const arr = self<Value[]>(scope);
    const es = elems(scope);
    const v = arr[arr.length - 1];
    if (v instanceof Value) return v;
    return val(es[es.length - 1]!, v);
  },
  'tuple.toList': (scope, reg) => val(reg.list(reg.any()), [...self<Value[]>(scope)]),
};

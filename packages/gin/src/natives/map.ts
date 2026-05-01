import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { MapType } from '../types/map';
import { arg, self, selfValue, argValue, setupYield } from './helpers';

type Entry = [Value, Value];
type MapRaw = Map<any, Entry>;

const valueType = (scope: any) => (selfValue(scope).type as MapType).value;

/**
 * Map natives. Raw storage is `Map<rawKey, [Value<K>, Value<V>]>` —
 * the ES Map keys on raw primitives (for correct `Map.has/get/delete`
 * semantics) but each entry preserves both the key and value Values so
 * their actual types survive.
 */
export const mapNatives: Record<string, NativeImpl> = {
  'map.size': (scope, reg) => val(reg.num({ whole: true, min: 0 }), self<MapRaw>(scope).size),

  'map.indexGet': (scope) => {
    const k = scope.get('key')!.raw;
    const m = self<MapRaw>(scope);
    const entry = m.get(k);
    if (!entry) throw new Error(`map[${String(k)}]: key not found`);
    return entry[1];
  },
  'map.indexSet': (scope, reg) => {
    const kV = scope.get('key')!;
    const vV = scope.get('value')!;
    self<MapRaw>(scope).set(kV.raw, [kV, vV]);
    return val(reg.void(), undefined);
  },
  'map.iterate': async (scope, reg) => {
    const m = self<MapRaw>(scope);
    // The map's K / V types are stored on `selfValue.type.generic`;
    // peek at the first stored entry as a quick proxy. If the map
    // is empty the loop body never runs so the args type doesn't
    // matter — fall back to `any` only in that edge case.
    const first = m.values().next().value as [Value, Value] | undefined;
    const keyType = first ? first[0].type : reg.any();
    const valueType = first ? first[1].type : reg.any();
    const doYield = setupYield(scope, reg, keyType, valueType);
    for (const [, [kV, vV]] of m) {
      await doYield(kV, vV);
    }
    return val(reg.void(), undefined);
  },

  'map.at': (scope, reg) => {
    const k = arg(scope, 'key');
    const m = self<MapRaw>(scope);
    const entry = m.get(k);
    return val(reg.optional(valueType(scope)), entry ? entry[1].raw : undefined);
  },
  'map.has':    (scope, reg) => val(reg.bool(), self<MapRaw>(scope).has(arg(scope, 'key'))),
  'map.delete': (scope, reg) => val(reg.bool(), self<MapRaw>(scope).delete(arg(scope, 'key'))),
  'map.clear':  (scope, reg) => { self<MapRaw>(scope).clear(); return val(reg.void(), undefined); },

  'map.keys':   (scope, reg) => {
    const m = self<MapRaw>(scope);
    const t = (selfValue(scope).type as MapType).key;
    const out: Value[] = [];
    for (const [, [kV]] of m) out.push(kV);
    return val(reg.list(t), out);
  },
  'map.values': (scope, reg) => {
    const m = self<MapRaw>(scope);
    const t = (selfValue(scope).type as MapType).value;
    const out: Value[] = [];
    for (const [, [, vV]] of m) out.push(vV);
    return val(reg.list(t), out);
  },

  'map.isEmpty':    (scope, reg) => val(reg.bool(), self<MapRaw>(scope).size === 0),
  'map.isNotEmpty': (scope, reg) => val(reg.bool(), self<MapRaw>(scope).size > 0),
};

// Re-export argValue for any future map ops.
void argValue;

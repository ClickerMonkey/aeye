import type { NativeImpl } from '../registry';
import { Value, val } from '../value';
import { ListType } from '../types/list';
import { arg, self, selfValue, argValue, setupYield } from './helpers';
import { Effects } from '../effects';

const itemType = (scope: any) => (selfValue(scope).type as ListType).item;

/**
 * List natives. Internal representation of a list's raw is `Value<V>[]`
 * — each element carries its own type. Natives preserve these Values on
 * read-through operations (indexGet, slice, reverse, …) and unwrap via
 * `.raw` only for equality/comparison.
 */
export const listNatives: Record<string, NativeImpl> = {
  'list.length': (scope, reg) => val(reg.num({ whole: true, min: 0 }), self<Value[]>(scope).length),

  // indexed access — elements are already Values, return them directly.
  'list.indexGet': (scope) => {
    const k = scope.get('key')!.raw as number;
    const arr = self<Value[]>(scope);
    if (k < 0 || k >= arr.length) throw new Error(`list[${k}]: index out of range`);
    return arr[k]!;
  },
  'list.indexSet': (scope, reg) => {
    const k = scope.get('key')!.raw as number;
    const v = scope.get('value')!;
    const arr = self<Value[]>(scope);
    if (k < 0 || k >= arr.length) throw new Error(`list[${k}] =: index out of range`);
    arr[k] = v;
    return val(reg.void(), undefined);
  },
  'list.iterate': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const indexType = reg.num({ whole: true, min: 0 });
    const doYield = setupYield(scope, reg, indexType, itemType(scope));
    const voidValue = val(reg.void(), undefined);
    for (let i = 0; i < arr.length; i++) {
      await doYield(val(indexType, i), arr[i]!);
    }
    return voidValue;
  },

  'list.at': (scope, reg) => {
    const k = arg<number>(scope, 'index');
    const arr = self<Value[]>(scope);
    if (k < 0 || k >= arr.length) return val(reg.optional(itemType(scope)), undefined);
    return val(reg.optional(itemType(scope)), arr[k]!.raw);
  },

  // mutation — store the Value as-is.
  'list.push':    (scope, reg) => { self<Value[]>(scope).push(argValue(scope, 'value')!); return val(reg.void(), undefined); },
  'list.pop':     (scope, reg) => {
    const v = self<Value[]>(scope).pop();
    return val(reg.optional(itemType(scope)), v ? v.raw : undefined);
  },
  'list.shift':   (scope, reg) => {
    const v = self<Value[]>(scope).shift();
    return val(reg.optional(itemType(scope)), v ? v.raw : undefined);
  },
  'list.unshift': (scope, reg) => { self<Value[]>(scope).unshift(argValue(scope, 'value')!); return val(reg.void(), undefined); },
  'list.insert':  (scope, reg) => {
    self<Value[]>(scope).splice(arg<number>(scope, 'index'), 0, argValue(scope, 'value')!);
    return val(reg.void(), undefined);
  },
  'list.remove': (scope) => {
    const removed = self<Value[]>(scope).splice(arg<number>(scope, 'index'), 1)[0]!;
    return removed;
  },
  'list.clear': (scope, reg) => { self<Value[]>(scope).length = 0; return val(reg.void(), undefined); },

  // read-only transforms
  'list.slice': (scope) => {
    const t = selfValue(scope).type as ListType;
    const start = arg<number | undefined>(scope, 'start');
    const end = arg<number | undefined>(scope, 'end');
    return val(t, self<Value[]>(scope).slice(start, end));
  },
  'list.concat': (scope) => {
    const t = selfValue(scope).type as ListType;
    const other = arg<Value[]>(scope, 'other');
    return val(t, self<Value[]>(scope).concat(other));
  },
  'list.reverse': (scope) => {
    const t = selfValue(scope).type as ListType;
    return val(t, [...self<Value[]>(scope)].reverse());
  },
  'list.join': (scope, reg) => {
    const sep = arg<string | undefined>(scope, 'separator') ?? ',';
    return val(reg.text(), self<Value[]>(scope).map((v) => String(v.raw)).join(sep));
  },

  // equality-based ops compare by the stored Value's raw.
  'list.indexOf': (scope, reg) => {
    const needle = argValue(scope, 'value')!.raw;
    const arr = self<Value[]>(scope);
    const idx = arr.findIndex((v) => v.raw === needle);
    return val(reg.num(), idx);
  },
  'list.contains': (scope, reg) => {
    const needle = argValue(scope, 'value')!.raw;
    const arr = self<Value[]>(scope);
    return val(reg.bool(), arr.some((v) => v.raw === needle));
  },
  'list.unique': (scope) => {
    const t = selfValue(scope).type as ListType;
    const seen = new Set<unknown>();
    const out: Value[] = [];
    for (const v of self<Value[]>(scope)) {
      if (!seen.has(v.raw)) { seen.add(v.raw); out.push(v); }
    }
    return val(t, out);
  },
  'list.duplicates': (scope) => {
    const t = selfValue(scope).type as ListType;
    const seen = new Set<unknown>();
    const dupeRaws = new Set<unknown>();
    const out: Value[] = [];
    for (const v of self<Value[]>(scope)) {
      if (seen.has(v.raw)) {
        if (!dupeRaws.has(v.raw)) { dupeRaws.add(v.raw); out.push(v); }
      } else {
        seen.add(v.raw);
      }
    }
    return val(t, out);
  },

  // higher-order — fn is invoked with { value: <stored Value>, index: Value<num> }.
  'list.map': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const it = itemType(scope);
    const out: Value[] = [];
    const argsType = reg.obj({ value: { type: it }, index: { type: reg.num() } });
    for (let i = 0; i < arr.length; i++) {
      const argObj = new Value(argsType, { value: arr[i]!, index: val(reg.num(), i) } as any);
      out.push(await call(argObj));
    }
    return val(reg.list(reg.any()), out);
  },
  'list.filter': async (scope) => {
    const t = selfValue(scope).type as ListType;
    const arr = self<Value[]>(scope);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const out: Value[] = [];
    const argsType = t.registry.obj({ value: { type: t.item }, index: { type: t.registry.num() } });
    for (let i = 0; i < arr.length; i++) {
      const argObj = new Value(argsType, { value: arr[i]!, index: val(t.registry.num(), i) } as any);
      const r = await call(argObj);
      if (r.raw) out.push(arr[i]!);
    }
    return val(t, out);
  },
  'list.find': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const it = itemType(scope);
    const argsType = reg.obj({ value: { type: it }, index: { type: reg.num() } });
    for (let i = 0; i < arr.length; i++) {
      const argObj = new Value(argsType, { value: arr[i]!, index: val(reg.num(), i) } as any);
      const r = await call(argObj);
      if (r.raw) return val(reg.optional(it), arr[i]!.raw);
    }
    return val(reg.optional(it), undefined);
  },
  'list.reduce': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const fn = argValue(scope, 'fn')!;
    const initial = argValue(scope, 'initial')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const it = itemType(scope);
    let acc: Value = initial;
    const argsType = reg.obj({ acc: { type: reg.any() }, value: { type: it }, index: { type: reg.num() } });
    for (let i = 0; i < arr.length; i++) {
      const argObj = new Value(argsType, { acc, value: arr[i]!, index: val(reg.num(), i) } as any);
      acc = await call(argObj);
    }
    return acc;
  },
  'list.some': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const it = itemType(scope);
    const argsType = reg.obj({ value: { type: it }, index: { type: reg.num() } });
    for (let i = 0; i < arr.length; i++) {
      const r = await call(new Value(argsType, { value: arr[i]!, index: val(reg.num(), i) } as any));
      if (r.raw) return val(reg.bool(), true);
    }
    return val(reg.bool(), false);
  },
  'list.every': async (scope, reg) => {
    const arr = self<Value[]>(scope);
    const fn = argValue(scope, 'fn')!;
    const call = fn.raw as (a: Value) => Promise<Value>;
    const it = itemType(scope);
    const argsType = reg.obj({ value: { type: it }, index: { type: reg.num() } });
    for (let i = 0; i < arr.length; i++) {
      const r = await call(new Value(argsType, { value: arr[i]!, index: val(reg.num(), i) } as any));
      if (!r.raw) return val(reg.bool(), false);
    }
    return val(reg.bool(), true);
  },
  'list.sort': async (scope) => {
    const t = selfValue(scope).type as ListType;
    const arr = [...self<Value[]>(scope)];
    const fn = argValue(scope, 'fn');
    if (fn && typeof fn.raw === 'function') {
      const call = fn.raw as (a: Value) => Promise<Value>;
      const argsType = t.registry.obj({ a: { type: t.item }, b: { type: t.item } });
      // Async-safe sort via keying.
      const pairs: Array<{ index: number; key: number }> = [];
      for (let i = 0; i < arr.length; i++) {
        let key = 0;
        for (let j = 0; j < arr.length; j++) {
          if (i === j) continue;
          const r = await call(new Value(argsType, { a: arr[i]!, b: arr[j]! } as any));
          if ((r.raw as number) > 0) key++;
        }
        pairs.push({ index: i, key });
      }
      pairs.sort((x, y) => x.key - y.key);
      return val(t, pairs.map((p) => arr[p.index]!));
    }
    return val(t, arr.sort((a, b) => {
      const ar = a.raw as any, br = b.raw as any;
      return ar < br ? -1 : ar > br ? 1 : 0;
    }));
  },

  'list.isEmpty':    (scope, reg) => val(reg.bool(), self<Value[]>(scope).length === 0),
  'list.isNotEmpty': (scope, reg) => val(reg.bool(), self<Value[]>(scope).length > 0),

  'list.first': (scope, reg) => {
    const a = self<Value[]>(scope);
    return val(reg.optional(itemType(scope)), a.length > 0 ? a[0]!.raw : undefined);
  },
  'list.last':  (scope, reg) => {
    const a = self<Value[]>(scope);
    return val(reg.optional(itemType(scope)), a.length > 0 ? a[a.length - 1]!.raw : undefined);
  },
};

/**
 * Effects overrides for list natives that aren't pure. Every native
 * not listed here defaults to `Effects.NONE` at registration time.
 *
 * STATE entries mutate the underlying `Value<V>[]` in place — the
 * iteration / accessor / transform variants (slice, concat, reverse,
 * map, filter, sort, …) all return NEW arrays and stay NONE.
 */
export const listNativesEffects: Record<string, Effects> = {
  'list.indexSet': Effects.STATE,
  'list.push':     Effects.STATE,
  'list.pop':      Effects.STATE,
  'list.shift':    Effects.STATE,
  'list.unshift':  Effects.STATE,
  'list.insert':   Effects.STATE,
  'list.remove':   Effects.STATE,
  'list.clear':    Effects.STATE,
};

import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import {
  type CompatOptions, GetSet, type NewSlotVisitor, type Prop, type Rnd, Type,
  ENVELOPE_ENCODE, encodeSlot, slotAccepts,
} from '../type';
import type { Engine } from '../engine';
import type { Scope } from '../scope';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { EncodeOptions, JSONOf, JSONValue } from '../json-type';


/** Whether a `Map` value slot already holds a RUNTIME `[Value<K>, Value<V>]` entry. */
function isRuntimeEntry(v: unknown): v is [Value, Value] {
  return Array.isArray(v) && v.length === 2 && v[0] instanceof Value && v[1] instanceof Value;
}

/** The key / value halves of one authored map entry, in either accepted
 *  spelling (`{key, value}` or the positional `[key, value]`). */
function entrySlots(entry: unknown): [unknown, unknown] {
  if (Array.isArray(entry)) return [entry[0], entry[1]];
  const e = entry as { key?: unknown; value?: unknown } | null | undefined;
  return [e?.key, e?.value];
}

/**
 * MapType<K, V> — keyed collection with generic key/value types.
 *
 * Logical T = `Map<K, V>`. Runtime `.raw` = `Map<K_raw, [Value<K>, Value<V>]>`
 * — keys are primitives (so ES Map equality works), but each entry carries
 * both the Value<K> and Value<V> so ACTUAL key/value types are preserved
 * even when the declared generics are interfaces/unions. JSON dump =
 * `[JSONValue<K>, JSONValue<V>][]` so both key and value subtypes
 * round-trip through JSON.
 */
export class MapType<K = any, V = any> extends Type<Map<K, V>, Record<string, never>> {
  static readonly NAME = 'map';
  readonly name = MapType.NAME;

  /** `map` is structure-only: both slots are type parameters. */
  static readonly optionKeys = [] as const;
  static readonly genericKeys = ['K', 'V'] as const;

  static from(json: TypeDef, scope: TypeScope): MapType {
    const registry = scope.registry;
    const K = json.generic?.K ? scope.parse(json.generic.K) : registry.text();
    const V = json.generic?.V ? scope.parse(json.generic.V) : registry.any();
    return new MapType(scope, K, V);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('map'),
      generic: z.object({ K: opts.Type, V: opts.Type }).optional(),
    }).meta({ aid: 'Type_map' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: each entry is `{key: Expr, value: Expr}` — LLM-friendly
    // shape that mirrors the instance method.
    return z.array(z.object({ key: opts.Expr, value: opts.Expr }));
  }

  constructor(scope: TypeScope, key: Type<K>, value: Type<V>) {
    super(scope, {}, { K: key, V: value });
  }

  get key(): Type<K> {
    return this.generic.K as Type<K>;
  }

  get value(): Type<V> {
    return this.generic.V as Type<V>;
  }

  valid(raw: unknown, scope?: TypeScope): raw is Map<unknown, [Value<K>, Value<V>]> {
    if (!(raw instanceof Map)) return false;
    for (const [, entry] of raw as Map<unknown, unknown>) {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [kv, vv] = entry;
      if (!(kv instanceof Value) || !(vv instanceof Value)) return false;
      if (!kv.type.valid(kv.raw, scope) || !vv.type.valid(vv.raw, scope)) return false;
      // ...and each half must be one the DECLARED K / V accepts. See
      // `slotAccepts` for why asking only "valid by its own type" was the defect.
      if (!slotAccepts(this.key, kv.type, scope) || !slotAccepts(this.value, vv.type, scope)) return false;
    }
    return true;
  }

  parse(json: unknown, scope?: TypeScope): Value<Map<K, V>> {
    // Accept the AUTHORED forms (`[{key, value}]` / `[[key, value]]`) AND the
    // RUNTIME form — a live `Map`, which is what `create()` / `random()` produce
    // and what `valid()` requires. Without this a map was the one builtin whose
    // own constructor produced a value its own parser refused
    // (`map.parse(map.create())` threw). A runtime entry is already
    // `[Value<K>, Value<V>]`; anything else is read as a plain `key → value`
    // pair, so a hand-built `Map` works too.
    const entries: unknown = json instanceof Map
      ? Array.from(json as Map<unknown, unknown>, ([k, v]) => (isRuntimeEntry(v) ? v : [k, v]))
      : json;
    if (!Array.isArray(entries)) {
      throw new TypeError({
        path: [], code: 'map.invalid',
        message: `map.parse: expected array of [key, value] pairs`, severity: 'error',
      });
    }
    const m = new Map<unknown, [Value<K>, Value<V>]>();
    for (const entry of entries) {
      const [rawK, rawV] = Array.isArray(entry)
        ? entry
        : [(entry as { key?: unknown; value?: unknown }).key,
           (entry as { key?: unknown; value?: unknown }).value];
      const keyV: Value<K> = this.registry.parseValue(rawK, this.key, scope);
      const valV: Value<V> = this.registry.parseValue(rawV, this.value, scope);
      m.set(keyV.raw, [keyV, valV]);
    }
    return new Value(this, m);
  }

  /** Emit as an array of `{ key, value }` pairs (LLM-friendly — avoids
   *  positional tuples). Each half is a `JSONValue` envelope so nested
   *  subtypes round-trip, or its bare logical form under `form:'logical'`
   *  — the `[{key, value}]` shape IS the map's logical JSON form, so it
   *  stays either way. One walk, via `encodeAs`. */
  encode(raw: Map<unknown, [Value<K>, Value<V>]>, scope?: TypeScope): Array<{ key: JSONValue<K>; value: JSONValue<V> }> {
    return this.encodeAs(raw, ENVELOPE_ENCODE, scope) as Array<{ key: JSONValue<K>; value: JSONValue<V> }>;
  }

  encodeAs(raw: Map<unknown, [Value<K>, Value<V>]>, opts: EncodeOptions, scope?: TypeScope): unknown {
    return Array.from(raw, ([, [kv, vv]]) => ({
      key: encodeSlot(kv, opts, scope),
      value: encodeSlot(vv, opts, scope),
    }));
  }

  create(): Map<unknown, [Value<K>, Value<V>]> {
    return new Map();
  }

  /** A `new map<K,V>` payload is an ENTRY array — `{key, value}` or
   *  `[key, value]` per entry — so each entry contributes two slots,
   *  declared `K` and `V`. The runtime `Map` form (what `create()` returns)
   *  is not an authored payload and stays opaque. */
  forEachNewSlot(value: unknown, visit: NewSlotVisitor): boolean {
    if (!Array.isArray(value)) return false;
    for (let i = 0; i < value.length; i++) {
      const [rawK, rawV] = entrySlots(value[i]);
      visit.slot(this.key, rawK, `${i}.key`);
      visit.slot(this.value, rawV, `${i}.value`);
    }
    return true;
  }

  async newFill(value: unknown, engine: Engine, scope: Scope): Promise<unknown> {
    if (!Array.isArray(value)) return super.newFill(value, engine, scope);
    const out: Array<{ key: unknown; value: unknown }> = [];
    // Sequential, in authored order — see `Type.newFill`. Entries normalize
    // to the `{key, value}` form, which `parse` accepts alongside the
    // positional one.
    for (const entry of value) {
      const [rawK, rawV] = entrySlots(entry);
      out.push({
        key: await this.key.newFill(rawK, engine, scope),
        value: await this.value.newFill(rawV, engine, scope),
      });
    }
    return out;
  }

  random(rnd: Rnd): Map<unknown, [Value<K>, Value<V>]> {
    const n = rnd(0, 5, true);
    const m = new Map<unknown, [Value<K>, Value<V>]>();
    for (let i = 0; i < n; i++) {
      const kr = this.key.random(rnd);
      const vr = this.value.random(rnd);
      m.set(kr, [new Value(this.key, kr), new Value(this.value, vr)]);
    }
    return m;
  }

  like(other: Type): Type {
    if (!(other instanceof MapType)) return this;
    const key = this.registry.like(other.key);
    const value = this.registry.like(other.value);
    if (key.name === 'null' || value.name === 'null') return this.registry.null();
    return this.registry.map(key, value);
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof MapType)) return false;
    return this.key.compatible(other.key, opts, scope) && this.value.compatible(other.value, opts, scope);
  }

  or(other: Type<Map<K, V>>): Type<Map<K, V>> {
    if (!(other instanceof MapType)) return this;
    return new MapType<K, V>(
      this.registry,
      this.key.or(other.key as Type<K>),
      this.value.or(other.value as Type<V>),
    );
  }

  narrow(_local: Partial<Record<string, never>>): Record<string, never> {
    return {};
  }

  get(): GetSet {
    const r = this.registry;
    return new GetSet({
      key: this.key,
      value: this.value,
      get: r.nativeExpr('map.indexGet'),
      set: r.nativeExpr('map.indexSet'),
      loop: r.nativeExpr('map.iterate'),
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const K = this.key, V = this.value;
    const num = r.num(), bool = r.bool(), voidT = r.void();
    const optV = r.optional(V);
    return {
      ...super.props(),
      size:   r.prop(num, 'map.size'),

      at:     r.method({ key: K },           optV,            'map.at'),

      has:    r.method({ key: K },           bool,            'map.has'),
      delete: r.method({ key: K },           bool,            'map.delete'),
      clear:  r.method({},                   voidT,           'map.clear'),

      keys:   r.method({},                   r.list(K),       'map.keys'),
      values: r.method({},                   r.list(V),       'map.values'),

      isEmpty:    r.method({}, bool, 'map.isEmpty'),
      isNotEmpty: r.method({}, bool, 'map.isNotEmpty'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: MapType.NAME,
      generic: { K: this.key.toJSON(), V: this.value.toJSON() },
    };
  }

  clone(): MapType<K, V> {
    return new MapType(
      this.registry,
      this.key.clone() as Type<K>,
      this.value.clone() as Type<V>,
    );
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + `map<${this.key.toCode(undefined, options)}, ${this.value.toCode(undefined, options)}>`;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // LLM-friendly shape: an array of { key, value } objects. Not a
    // positional tuple — LLMs handle object keys more reliably.
    return this.describeType(z.array(this.valueObject({
      key: this.key.toValueSchema(opts),
      value: this.value.toValueSchema(opts),
    }, opts)), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Each entry's key and value accept any Expr; per-slot type-compat is
    // enforced at evaluate/validate time.
    return this.describeType(z.array(z.object({
      key: opts.Expr,
      value: opts.Expr,
    })), opts, 'NewValue_');
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('map'),
      generic: z.object({
        K: this.key.toInstanceSchema(),
        V: this.value.toInstanceSchema(),
      }).optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    return data instanceof Map
      ? new MapType(this.registry, this.registry.any(), this.registry.any())
      : undefined;
  }
}

import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { JSONOf, JSONValue } from '../json-type';


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
    }
    return true;
  }

  parse(json: unknown, scope?: TypeScope): Value<Map<K, V>> {
    if (!Array.isArray(json)) {
      throw new TypeError({
        path: [], code: 'map.invalid',
        message: `map.parse: expected array of [key, value] pairs`, severity: 'error',
      });
    }
    const m = new Map<unknown, [Value<K>, Value<V>]>();
    for (const entry of json) {
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

  /** Emit as an array of `{ key, value }` envelopes (LLM-friendly — avoids
   *  positional tuples). Each key/value is itself a `JSONValue` envelope
   *  so nested subtypes round-trip. */
  encode(raw: Map<unknown, [Value<K>, Value<V>]>, _scope?: TypeScope): Array<{ key: JSONValue<K>; value: JSONValue<V> }> {
    return Array.from(raw, ([, [kv, vv]]) => ({ key: kv.toJSON(), value: vv.toJSON() }));
  }

  create(): Map<unknown, [Value<K>, Value<V>]> {
    return new Map();
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

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
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
    return new GetSet({
      key: this.key,
      value: this.value,
      get: { kind: 'native', id: 'map.indexGet' },
      set: { kind: 'native', id: 'map.indexSet' },
      loop: { kind: 'native', id: 'map.iterate' },
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
    return this.describeType(z.array(z.object({
      key: this.key.toValueSchema(opts),
      value: this.value.toValueSchema(opts),
    })), opts);
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

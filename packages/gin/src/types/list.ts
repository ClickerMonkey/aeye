import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type, optionsCode } from '../type';
import type { ListOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import type { JSONOf, JSONValue } from '../json-type';


/**
 * ListType<V> — ordered collection with generic element type V and
 * optional length bounds. narrow() enforces minLength ≥ base, maxLength ≤ base.
 *
 * Logical T = `V[]`. Runtime `.raw` = `Value<V>[]` (each element stored as
 * a Value so its ACTUAL type is preserved — important when the declared
 * element type is an interface/union but a stored value has a more specific
 * concrete type). JSON dump = `JSONValue<V>[]` (each element wrapped as
 * `{type, value}` so element subtypes round-trip through JSON).
 */
export class ListType<V = any> extends Type<V[], ListOptions> {
  static readonly NAME = 'list';
  readonly name = ListType.NAME;

  static from(json: TypeDef, registry: Registry): ListType {
    const item = json.generic?.V ? registry.parse(json.generic.V) : registry.any();
    return new ListType(registry, item, (json.options ?? {}) as ListOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('list'),
      generic: z.object({ V: opts.Type }).optional(),
      options: z.object({
        minLength: z.number().optional(),
        maxLength: z.number().optional(),
      }).optional(),
    }).meta({ aid: 'Type_list' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: `value: Expr[]`. Element type narrows per-instance.
    return z.array(opts.Expr);
  }

  constructor(registry: Registry, item: Type<V>, options: ListOptions = {}) {
    super(registry, options, { V: item });
  }

  get item(): Type<V> {
    return this.generic.V as Type<V>;
  }

  valid(raw: unknown): raw is Value<V>[] {
    if (!Array.isArray(raw)) return false;
    const { minLength, maxLength } = this.options;
    if (minLength !== undefined && raw.length < minLength) return false;
    if (maxLength !== undefined && raw.length > maxLength) return false;
    return raw.every((x) => x instanceof Value && x.type.valid(x.raw));
  }

  parse(json: unknown): Value<V[]> {
    if (!Array.isArray(json)) {
      throw new TypeError({
        path: [], code: 'list.invalid',
        message: `list.parse: expected array, got ${typeof json}`, severity: 'error',
      });
    }
    const raw: Value<V>[] = json.map((x) => this.registry.parseValue<V>(x, this.item));
    if (!this.valid(raw)) {
      throw new TypeError({
        path: [], code: 'list.constraint',
        message: 'list.parse: length constraints violated', severity: 'error',
      });
    }
    return new Value(this, raw);
  }

  /** Each element becomes a `JSONValue` envelope so nested subtypes
   *  round-trip through JSON. */
  encode(raw: Value<V>[]): JSONValue<V>[] {
    return raw.map((v) => v.toJSON());
  }

  create(): Value<V>[] {
    const n = this.options.minLength ?? 0;
    return Array.from({ length: n }, () => new Value(this.item, this.item.create()));
  }

  random(rnd: Rnd): Value<V>[] {
    const min = this.options.minLength ?? 0;
    const max = this.options.maxLength ?? Math.max(min, 5);
    const n = rnd(min, max, true);
    return Array.from({ length: n }, () => new Value(this.item, this.item.random(rnd)));
  }

  like(other: Type): Type {
    if (!(other instanceof ListType)) return this;
    const item = this.registry.like(other.item);
    if (item.name === 'null') return item;
    return this.registry.list(item);
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof ListType)) return false;
    if (!this.item.compatible(other.item, opts)) return false;
    if (!opts?.value) return true;
    const a = this.options, b = other.options;
    if (a.minLength !== undefined && (b.minLength === undefined || b.minLength < a.minLength)) return false;
    if (a.maxLength !== undefined && (b.maxLength === undefined || b.maxLength > a.maxLength)) return false;
    return true;
  }

  or(other: Type<V[]>): Type<V[]> {
    if (!(other instanceof ListType)) return this;
    const a = this.options, b = other.options;
    return new ListType<V>(
      this.registry,
      this.item.or(other.item as Type<V>),
      {
        minLength: a.minLength !== undefined && b.minLength !== undefined
          ? Math.min(a.minLength, b.minLength) : undefined,
        maxLength: a.maxLength !== undefined && b.maxLength !== undefined
          ? Math.max(a.maxLength, b.maxLength) : undefined,
      },
    );
  }

  narrow(local: Partial<ListOptions>): ListOptions {
    const base = this.options;
    const fail = (code: string, msg: string): never => {
      throw new TypeError({ path: [], code, message: msg, severity: 'error' });
    };
    const merged: ListOptions = { ...base };
    if (local.minLength !== undefined) {
      if (base.minLength !== undefined && local.minLength < base.minLength) {
        fail('list.widen.minLength', `local ${local.minLength} < base ${base.minLength}`);
      }
      merged.minLength = local.minLength;
    }
    if (local.maxLength !== undefined) {
      if (base.maxLength !== undefined && local.maxLength > base.maxLength) {
        fail('list.widen.maxLength', `local ${local.maxLength} > base ${base.maxLength}`);
      }
      merged.maxLength = local.maxLength;
    }
    return merged;
  }

  get(): GetSet {
    return new GetSet({
      key: this.registry.num({ whole: true, min: 0 }),
      value: this.item,
      get: { kind: 'native', id: 'list.indexGet' },
      set: { kind: 'native', id: 'list.indexSet' },
      loop: { kind: 'native', id: 'list.iterate' },
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const V = this.item;
    const num = r.num();
    const bool = r.bool();
    const text = r.text();
    const voidT = r.void();
    const optV = r.optional(V);
    const lstV = r.list(V);
    const fnValueIndex = (ret: Type) =>
      r.fn(r.obj({ value: { type: V }, index: { type: num } }), ret);

    return {
      ...super.props(),
      length: r.prop(num, 'list.length'),

      at:      r.method({ index: num },              optV,  'list.at'),

      push:    r.method({ value: V },                voidT, 'list.push'),
      pop:     r.method({},                          optV,  'list.pop'),
      shift:   r.method({},                          optV,  'list.shift'),
      unshift: r.method({ value: V },                voidT, 'list.unshift'),
      insert:  r.method({ index: num, value: V },    voidT, 'list.insert'),
      remove:  r.method({ index: num },              V,     'list.remove'),
      clear:   r.method({},                          voidT, 'list.clear'),

      slice:   r.method({ start: r.optional(num), end: r.optional(num) }, lstV, 'list.slice'),
      concat:  r.method({ other: lstV },             lstV,  'list.concat'),
      reverse: r.method({},                          lstV,  'list.reverse'),
      join:    r.method({ separator: r.optional(text) }, text, 'list.join'),

      indexOf:  r.method({ value: V },               num,   'list.indexOf'),
      contains: r.method({ value: V },               bool,  'list.contains'),
      unique:     r.method({},                       lstV,  'list.unique'),
      duplicates: r.method({},                       lstV,  'list.duplicates'),

      map:    r.method({ fn: fnValueIndex(r.generic('R')) }, r.list(r.generic('R')), 'list.map', { generic: { R: r.any() } }),
      filter: r.method({ fn: fnValueIndex(bool) },    lstV,            'list.filter'),
      find:   r.method({ fn: fnValueIndex(bool) },    optV,            'list.find'),
      reduce: r.method({ fn: r.fn(r.obj({ acc: { type: r.generic('R') }, value: { type: V }, index: { type: num } }), r.generic('R')), initial: r.generic('R') }, r.generic('R'), 'list.reduce', { generic: { R: r.any() } }),
      some:   r.method({ fn: fnValueIndex(bool) },    bool,            'list.some'),
      every:  r.method({ fn: fnValueIndex(bool) },    bool,            'list.every'),
      sort:   r.method({ fn: r.optional(r.fn(r.obj({ a: { type: V }, b: { type: V } }), num)) }, lstV, 'list.sort'),

      isEmpty:    r.method({}, bool, 'list.isEmpty'),
      isNotEmpty: r.method({}, bool, 'list.isNotEmpty'),

      first: r.prop(optV, 'list.first'),
      last:  r.prop(optV, 'list.last'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: ListType.NAME,
      generic: { V: this.item.toJSON() },
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): ListType<V> {
    return new ListType(this.registry, this.item.clone() as Type<V>, { ...this.options });
  }

  toCode(): string {
    return this.docsPrefix() + `list<${this.item.toCode()}>` + optionsCode(this.options);
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    let s = z.array(this.item.toValueSchema(opts));
    if (this.options.minLength !== undefined) s = s.min(this.options.minLength);
    if (this.options.maxLength !== undefined) s = s.max(this.options.maxLength);
    return this.describeType(s, opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Each element accepts any Expr; per-element type is enforced at
    // evaluate/validate time.
    let s = z.array(opts.Expr);
    if (this.options.minLength !== undefined) s = s.min(this.options.minLength);
    if (this.options.maxLength !== undefined) s = s.max(this.options.maxLength);
    return this.describeType(s, opts, 'NewValue_');
  }

  /** Structural TypeDef match delegating the item's instance schema. */
  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('list'),
      generic: z.object({ V: this.item.toInstanceSchema() }).optional(),
      options: z.object({
        minLength: z.number().optional(),
        maxLength: z.number().optional(),
      }).optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    if (!Array.isArray(data)) return undefined;
    // Best-effort: use any for the element type; callers can refine via narrow.
    return new ListType(this.registry, this.registry.any(), {});
  }
}

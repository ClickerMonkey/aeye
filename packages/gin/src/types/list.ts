import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import {
  type CompatOptions, GetSet, type NewSlotVisitor, type Prop, type Rnd, Type,
  ENVELOPE_ENCODE, encodeSlot, optionsCode, slotAccepts,
} from '../type';
import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { ListOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { EncodeOptions, JSONOf, JSONValue } from '../json-type';


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

  static readonly optionKeys = ['minLength', 'maxLength'] as const satisfies readonly (keyof ListOptions)[];
  /** The ELEMENT type — `{options:{item}}` used to parse silently to `list<any>`. */
  static readonly genericKeys = ['V'] as const;

  static from(json: TypeDef, scope: TypeScope): ListType {
    const registry = scope.registry;
    const item = json.generic?.V ? scope.parse(json.generic.V) : registry.any();
    return new ListType(scope, item, (json.options ?? {}) as ListOptions);
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

  constructor(scope: TypeScope, item: Type<V>, options: ListOptions = {}) {
    super(scope, options, { V: item });
  }

  get item(): Type<V> {
    return this.generic.V as Type<V>;
  }

  valid(raw: unknown, scope?: TypeScope): raw is Value<V>[] {
    if (!Array.isArray(raw)) return false;
    const { minLength, maxLength } = this.options;
    if (minLength !== undefined && raw.length < minLength) return false;
    if (maxLength !== undefined && raw.length > maxLength) return false;
    // Each cell must be valid BY ITS OWN TYPE **and** be a value the
    // DECLARED element type accepts. Asking only the first question is how a
    // `num` sat inside a `list<text>` and `valid()` said yes. `slotAccepts`
    // keeps a genuine subtype (a `Dog` in a `list<Animal>`).
    return raw.every((x) => x instanceof Value
      && x.type.valid(x.raw, scope)
      && slotAccepts(this.item, x.type, scope));
  }

  parse(json: unknown, scope?: TypeScope): Value<V[]> {
    if (!Array.isArray(json)) {
      throw new TypeError({
        path: [], code: 'list.invalid',
        message: `list.parse: expected array, got ${typeof json}`, severity: 'error',
      });
    }
    const raw: Value<V>[] = json.map((x) => this.registry.parseValue<V>(x, this.item, scope));
    if (!this.valid(raw, scope)) {
      throw new TypeError({
        path: [], code: 'list.constraint',
        message: 'list.parse: length constraints violated', severity: 'error',
      });
    }
    return new Value(this, raw);
  }

  /** Each element becomes a `JSONValue` envelope so nested subtypes
   *  round-trip through JSON — or its bare logical form under
   *  `form:'logical'`. One walk, via `encodeAs`. */
  encode(raw: Value<V>[], scope?: TypeScope): JSONValue<V>[] {
    return this.encodeAs(raw, ENVELOPE_ENCODE, scope) as JSONValue<V>[];
  }

  encodeAs(raw: Value<V>[], opts: EncodeOptions, scope?: TypeScope): unknown {
    return raw.map((v) => encodeSlot(v, opts, scope));
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

  /** A `new list<V>` payload is an element ARRAY; each position is a slot
   *  declared `V`. A payload that is not an array is opaque (an Expr
   *  yielding the whole list, say) and the base judges it. */
  forEachNewSlot(value: unknown, visit: NewSlotVisitor): boolean {
    if (!Array.isArray(value)) return false;
    for (let i = 0; i < value.length; i++) visit.slot(this.item, value[i], i);
    return true;
  }

  async newFill(value: unknown, engine: Engine, scope: Scope): Promise<unknown> {
    if (!Array.isArray(value)) return super.newFill(value, engine, scope);
    const out: unknown[] = [];
    // Sequential, in authored order — see `Type.newFill`.
    for (const item of value) out.push(await this.item.newFill(item, engine, scope));
    return out;
  }

  like(other: Type): Type {
    if (!(other instanceof ListType)) return this;
    const item = this.registry.like(other.item);
    if (item.name === 'null') return item;
    return this.registry.list(item);
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof ListType)) return false;
    if (!this.item.compatible(other.item, opts, scope)) return false;
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
    const r = this.registry;
    return new GetSet({
      key: r.num({ whole: true, min: 0 }),
      value: this.item,
      get: r.nativeExpr('list.indexGet'),
      set: r.nativeExpr('list.indexSet'),
      loop: r.nativeExpr('list.iterate'),
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
      r.fn({ args: r.obj({ value: { type: V }, index: { type: num } }), returns: ret });

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

      map:    r.method({ fn: fnValueIndex(r.alias('R')) }, r.list(r.alias('R')), 'list.map', { generic: { R: r.any() } }),
      filter: r.method({ fn: fnValueIndex(bool) },    lstV,            'list.filter'),
      find:   r.method({ fn: fnValueIndex(bool) },    optV,            'list.find'),
      reduce: r.method({ fn: r.fn({ args: r.obj({ acc: { type: r.alias('R') }, value: { type: V }, index: { type: num } }), returns: r.alias('R') }), initial: r.alias('R') }, r.alias('R'), 'list.reduce', { generic: { R: r.any() } }),
      some:   r.method({ fn: fnValueIndex(bool) },    bool,            'list.some'),
      every:  r.method({ fn: fnValueIndex(bool) },    bool,            'list.every'),
      sort:   r.method({ fn: r.optional(r.fn({ args: r.obj({ a: { type: V }, b: { type: V } }), returns: num })) }, lstV, 'list.sort'),

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

  toCode(_registry?: Registry, options?: CodeOptions): string {
    // `minLength=0` is a no-op; skip. `maxLength` only renders when
    // explicitly set.
    return this.docsPrefix(options) + `list<${this.item.toCode(undefined, options)}>` + optionsCode(this.options, {
      minLength: 0,
    });
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
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

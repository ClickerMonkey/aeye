import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import type { JSONOf, RuntimeOf } from '../json-type';
import { baseTypeFields } from '../schemas';

export interface EnumOptions<V = unknown> {
  values: Record<string, V>;
}

/**
 * EnumType<V> — a named set of constants of some value type V.
 * The inner type V lives in generic.V (e.g. text, num).
 * Options carry the {key → value} constants the enum allows.
 */
export class EnumType<V = unknown> extends Type<V, EnumOptions<V>> {
  static readonly NAME = 'enum';
  readonly name = EnumType.NAME;

  static from(json: TypeDef, registry: Registry): EnumType {
    const V = json.generic?.V ? registry.parse(json.generic.V) : registry.text();
    const values = (json.options?.values ?? {}) as Record<string, unknown>;
    return new EnumType(registry, V, { values });
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('enum'),
      ...baseTypeFields(opts),
      generic: z.object({ V: opts.Type }).optional(),
      options: z.object({ values: z.record(z.string(), z.any()) }),
    });
  }

  constructor(registry: Registry, value: Type<V>, options: EnumOptions<V>) {
    super(registry, options, { V: value });
  }

  get value(): Type<V> {
    return this.generic.V as Type<V>;
  }

  valid(raw: unknown): raw is RuntimeOf<V> {
    if (!this.value.valid(raw)) return false;
    return Object.values(this.options.values).some((v) => v === raw);
  }

  parse(json: unknown): Value<V> {
    const inner = this.value.parse(json);
    if (!this.valid(inner.raw)) {
      throw new TypeError({
        path: [], code: 'enum.not-a-member',
        message: `enum.parse: ${String(inner.raw)} is not one of ${Object.values(this.options.values).join(', ')}`,
        severity: 'error',
      });
    }
    return new Value(this, inner.raw);
  }

  encode(raw: RuntimeOf<V>): JSONOf<V> {
    return this.value.encode(raw);
  }

  create(): RuntimeOf<V> {
    const first = Object.values(this.options.values)[0];
    return first !== undefined ? (first as RuntimeOf<V>) : this.value.create();
  }

  random(rnd: Rnd): RuntimeOf<V> {
    const vals = Object.values(this.options.values);
    if (vals.length === 0) return this.value.random(rnd);
    return vals[rnd(0, vals.length - 1, true)] as RuntimeOf<V>;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof EnumType)) return false;
    if (!this.value.compatible(other.value, opts)) return false;
    if (!opts?.value) return true;
    // value-mode: other's values must be a subset of ours
    return Object.values(other.options.values).every((v) =>
      Object.values(this.options.values).some((m) => m === v),
    );
  }

  or(other: Type<V>): Type<V> {
    if (!(other instanceof EnumType)) return this;
    return new EnumType(
      this.registry,
      this.value.or(other.value as Type<V>),
      { values: { ...other.options.values, ...this.options.values } },
    );
  }

  narrow(local: Partial<EnumOptions<V>>): EnumOptions<V> {
    const base = this.options.values;
    if (local.values === undefined) return this.options;
    // Local values must be a subset of base.
    for (const [k, v] of Object.entries(local.values)) {
      const present = Object.values(base).some((bv) => bv === v);
      if (!present) {
        throw new TypeError({
          path: [], code: 'enum.widen',
          message: `enum.narrow: ${k}=${String(v)} not in base values`, severity: 'error',
        });
      }
    }
    return { values: local.values };
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const V = this.value;
    return {
      name:   r.prop(r.text(), 'enum.name'),
      value:  r.prop(V,        'enum.value'),
      eq:     r.method({ other: V },     r.bool(), 'enum.eq'),
      neq:    r.method({ other: V },     r.bool(), 'enum.neq'),
      toText: r.method({},               r.text(), 'enum.toText'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: EnumType.NAME,
      generic: { V: this.value.toJSON() },
      options: { values: this.options.values },
    };
  }

  clone(): EnumType<V> {
    return new EnumType(
      this.registry,
      this.value.clone() as Type<V>,
      { values: { ...this.options.values } },
    );
  }

  toCode(): string {
    const vals = Object.values(this.options.values);
    if (vals.length === 0) return 'never';
    return vals.map((v) => typeof v === 'string' ? JSON.stringify(v) : String(v)).join(' | ');
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Zod v4's z.enum accepts a Record — same shape as EnumOptions.values.
    return this.describeType(
      z.enum(this.options.values as Record<string, string | number>),
      opts,
    );
  }
}

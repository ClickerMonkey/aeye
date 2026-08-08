import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type, optionsCode } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { JSONOf, RuntimeOf } from '../json-type';


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

  static readonly optionKeys = ['values'] as const satisfies readonly (keyof EnumOptions)[];
  static readonly genericKeys = ['V'] as const;

  static from(json: TypeDef, scope: TypeScope): EnumType {
    const registry = scope.registry;
    const V = json.generic?.V ? scope.parse(json.generic.V) : registry.text();
    const values = (json.options?.values ?? {}) as Record<string, unknown>;
    return new EnumType(scope, V, { values });
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('enum'),
      generic: z.object({ V: opts.Type }).optional(),
      options: z.object({ values: z.record(z.string(), z.any()) }),
    }).meta({ aid: 'Type_enum' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: member value of any supported enum primitive.
    return z.union([z.string(), z.number()]);
  }

  constructor(scope: TypeScope, value: Type<V>, options: EnumOptions<V>) {
    super(scope, options, { V: value });
  }

  get value(): Type<V> {
    return this.generic.V as Type<V>;
  }

  valid(raw: unknown, scope?: TypeScope): raw is RuntimeOf<V> {
    if (!this.value.valid(raw, scope)) return false;
    return Object.values(this.options.values).some((v) => v === raw);
  }

  parse(json: unknown, scope?: TypeScope): Value<V> {
    const inner = this.value.parse(json, scope);
    if (!this.valid(inner.raw, scope)) {
      throw new TypeError({
        path: [], code: 'enum.not-a-member',
        message: `enum.parse: ${String(inner.raw)} is not one of ${Object.values(this.options.values).join(', ')}`,
        severity: 'error',
      });
    }
    return new Value(this, inner.raw);
  }

  encode(raw: RuntimeOf<V>, scope?: TypeScope): JSONOf<V> {
    return this.value.encode(raw, scope);
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

  like(other: Type): Type {
    if (!(other instanceof EnumType)) return this;
    const inner = this.registry.like(other.value);
    if (inner.name === 'null') return this.registry.null();
    return this.registry.enum(
      other.options.values as Record<string, V>,
      inner as Type<V>,
    );
  }

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof EnumType)) return false;
    if (!this.value.compatible(other.value, opts, scope)) return false;
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
      ...super.props(),
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

  toCode(_registry?: Registry, options?: CodeOptions): string {
    const body = `enum<${this.value.toCode(undefined, options)}>` + optionsCode(this.options.values as Record<string, unknown>);
    return this.docsPrefix(options) + body;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Zod v4's z.enum accepts a Record — same shape as EnumOptions.values.
    return this.describeType(
      z.enum(this.options.values as Record<string, string | number>),
      opts,
    );
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('enum'),
      generic: z.object({ V: this.value.toInstanceSchema() }).optional(),
      options: z.object({ values: z.record(z.string(), z.any()) }),
    }).passthrough();
  }
}

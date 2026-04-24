import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import type { JSONOf, RuntimeOf } from '../json-type';


/**
 * NullableType<T> — allows `null` in addition to the inner type T.
 * Distinct from OptionalType (which is for `undefined`). Useful for
 * database values and explicit absence.
 */
export class NullableType<T = any> extends Type<T | null, Record<string, never>> {
  static readonly NAME = 'nullable';
  readonly name = NullableType.NAME;

  static from(json: TypeDef, registry: Registry): NullableType {
    const inner = json.generic?.T
      ? registry.parse(json.generic.T)
      : registry.any();
    return new NullableType(registry, inner);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('nullable'),
      generic: z.object({ T: opts.Type }).optional(),
    }).meta({ aid: 'Type_nullable' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return opts.Expr.nullable();
  }

  constructor(registry: Registry, readonly inner: Type<T>) {
    super(registry, {}, { T: inner });
  }

  valid(raw: unknown): raw is RuntimeOf<T | null> {
    return raw === null || this.inner.valid(raw);
  }

  parse(json: unknown): Value<T | null> {
    if (json === null) return new Value(this, null as RuntimeOf<T | null>);
    const v = this.inner.parse(json);
    return new Value(this, v.raw as RuntimeOf<T | null>);
  }

  encode(raw: RuntimeOf<T | null>): JSONOf<T | null> {
    if (raw === null) return null as JSONOf<T | null>;
    return this.inner.encode(raw as RuntimeOf<T>) as JSONOf<T | null>;
  }

  create(): RuntimeOf<T | null> {
    return null as RuntimeOf<T | null>;
  }

  random(rnd: Rnd): RuntimeOf<T | null> {
    if (rnd(0, 9, true) < 3) return null as RuntimeOf<T | null>;
    return this.inner.random(rnd) as RuntimeOf<T | null>;
  }

  like(other: Type): Type {
    if (!(other instanceof NullableType)) return this;
    const inner = this.registry.like(other.inner);
    if (inner.name === 'null') return inner;
    return this.registry.nullable(inner);
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (other instanceof NullableType) {
      return this.inner.compatible(other.inner, opts);
    }
    if (opts?.exact) return false;
    return this.inner.compatible(other, opts);
  }

  or(other: Type<T | null>): Type<T | null> {
    if (other instanceof NullableType) {
      return new NullableType(this.registry, this.inner.or(other.inner as Type<T>));
    }
    return this;
  }

  required(): Type {
    return this.inner;
  }

  isUniversal(): boolean {
    return this.inner.isUniversal();
  }

  narrow(local: Partial<Record<string, never>>): Record<string, never> {
    if (local && Object.keys(local).length > 0) {
      throw new TypeError({
        path: [], code: 'nullable.no-options',
        message: 'nullable has no narrowable options', severity: 'error',
      });
    }
    return {};
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const T = this.inner;
    return {
      ...super.props(),
      value:  r.prop(T,                                  'nullable.value'),
      isNull: r.method({},                  r.bool(),    'nullable.isNull'),
      or:     r.method({ fallback: T },     T,           'nullable.or'),
      map:    r.method({ fn: r.fn(r.obj({ value: { type: T } }), r.generic('R')) }, r.nullable(r.generic('R')), 'nullable.map', { generic: { R: r.any() } }),
    };
  }

  toJSON(): TypeDef {
    return {
      name: NullableType.NAME,
      generic: { T: this.inner.toJSON() },
    };
  }

  clone(): NullableType<T> {
    return new NullableType(this.registry, this.inner.clone() as Type<T>);
  }

  toCode(): string {
    return this.docsPrefix() + `nullable<${this.inner.toCode()}>`;
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    return this.describeType(this.inner.toValueSchema(opts).nullable(), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(this.inner.toNewSchema(opts).nullable(), opts, 'NewValue_');
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('nullable'),
      generic: z.object({ T: this.inner.toInstanceSchema() }).optional(),
    }).passthrough();
  }
}

import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


/**
 * AnyType — the top type. Accepts any value and is compatible with every
 * other type. Has no options to narrow.
 */
export class AnyType extends Type<any, Record<string, never>> {
  static readonly NAME = 'any';
  readonly name = AnyType.NAME;

  static from(_json: TypeDef, registry: Registry): AnyType {
    return new AnyType(registry, {});
  }

  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.object({ name: z.literal('any') })
      .meta({ aid: 'Type_any' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.any(); }

  valid(_raw: unknown): _raw is any {
    return true;
  }

  parse(json: unknown): Value<any> {
    return new Value(this, json);
  }

  encode(raw: any): any {
    return raw;
  }

  create(): any {
    return null;
  }

  random(_rnd: Rnd): any {
    return null;
  }

  compatible(_other: Type, _opts?: CompatOptions): boolean {
    return true;
  }

  flexible(): boolean {
    return true;
  }

  or(_other: Type<any>): Type<any> {
    return this;
  }

  narrow(local: Partial<Record<string, never>>): Record<string, never> {
    if (local && Object.keys(local).length > 0) {
      throw new TypeError({
        path: [], code: 'any.no-options',
        message: 'any has no narrowable options', severity: 'error',
      });
    }
    return {};
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    return {
      ...super.props(),
      typeOf:    r.method({}, r.text(), 'any.typeOf'),
      // Runtime-check against a target type T. Caller picks T via generic
      // binding: `x.is<num>()` or `x.is<Task>()`.
      is:        r.method({}, r.bool(), 'any.is', { generic: { T: r.any() } }),
      // Cast to target type T. Returns optional<T> — null when the value
      // doesn't satisfy T.
      as:        r.method({}, r.optional(r.generic('T')), 'any.as', { generic: { T: r.any() } }),
      toText:    r.method({},                 r.text(), 'any.toText'),
      toBool:    r.method({},                 r.bool(), 'any.toBool'),
      eq:        r.method({ other: r.any() }, r.bool(), 'any.eq'),
      neq:       r.method({ other: r.any() }, r.bool(), 'any.neq'),
    };
  }

  toJSON(): TypeDef {
    return { name: AnyType.NAME };
  }

  clone(): AnyType {
    return new AnyType(this.registry, {});
  }

  toCode(): string { return this.docsPrefix() + 'any'; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny { return this.describeType(z.any(), opts); }
}

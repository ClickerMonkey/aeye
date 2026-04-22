import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import { baseTypeFields } from '../schemas';

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

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({ name: z.literal('any'), ...baseTypeFields(opts) })
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
      typeOf:    r.method({},              r.text(), 'any.typeOf'),
      is:        r.method({ type: r.text() }, r.bool(), 'any.is'),
      as:        r.method({ type: r.text() }, r.any(),  'any.as'),
      toText:    r.method({},              r.text(), 'any.toText'),
      toBoolean: r.method({},              r.bool(), 'any.toBoolean'),
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

  toCode(): string { return 'any'; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny { return this.describeType(z.any(), opts); }
}

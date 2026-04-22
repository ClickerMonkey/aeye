import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import { baseTypeFields } from '../schemas';

/**
 * NullType — the unit type whose only value is `null`.
 * Distinct from optional/undefined; use Nullable<T> when null is a
 * meaningful alternative alongside T.
 */
export class NullType extends Type<null, Record<string, never>> {
  static readonly NAME = 'null';
  readonly name = NullType.NAME;

  static from(_json: TypeDef, registry: Registry): NullType {
    return new NullType(registry, {});
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({ name: z.literal('null'), ...baseTypeFields(opts) })
      .meta({ aid: 'Type_null' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.null(); }

  valid(raw: unknown): raw is null {
    return raw === null;
  }

  parse(json: unknown): Value<null> {
    if (json !== null) {
      throw new TypeError({
        path: [], code: 'null.invalid',
        message: `null expects null, got ${typeof json}`, severity: 'error',
      });
    }
    return new Value(this, null);
  }

  encode(_raw: null): null {
    return null;
  }

  create(): null {
    return null;
  }

  random(_rnd: Rnd): null {
    return null;
  }

  compatible(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof NullType;
  }

  or(_other: Type<null>): Type<null> {
    return this;
  }

  narrow(local: Partial<Record<string, never>>): Record<string, never> {
    if (local && Object.keys(local).length > 0) {
      throw new TypeError({
        path: [], code: 'null.no-options',
        message: 'null has no narrowable options', severity: 'error',
      });
    }
    return {};
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    return {
      toText:    r.method({}, r.text(), 'null.toText'),
      toBoolean: r.method({}, r.bool(), 'null.toBoolean'),
    };
  }

  toJSON(): TypeDef {
    return { name: NullType.NAME };
  }

  clone(): NullType {
    return new NullType(this.registry, {});
  }

  toCode(): string { return 'null'; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny { return this.describeType(z.null(), opts); }
}

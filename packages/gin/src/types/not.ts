import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import { baseTypeFields } from '../schemas';

export interface NotOptions {
  excluded: TypeDef;
}

/**
 * NotType — value may be anything EXCEPT the excluded type.
 * Primarily a constraint for validation and narrowing.
 */
export class NotType extends Type<any, NotOptions> {
  static readonly NAME = 'not';
  readonly name = NotType.NAME;

  static from(json: TypeDef, registry: Registry): NotType {
    const excluded = json.options?.excluded
      ? registry.parse(json.options.excluded)
      : registry.any();
    return new NotType(registry, excluded);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('not'),
      ...baseTypeFields(opts),
      options: z.object({ excluded: opts.Type }),
    }).meta({ aid: 'Type_not' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.any(); }

  constructor(registry: Registry, readonly excluded: Type) {
    super(registry, { excluded: excluded.toJSON() });
  }

  valid(raw: unknown): raw is any {
    return !this.excluded.valid(raw);
  }

  parse(json: unknown): Value<any> {
    if (this.excluded.valid(json)) {
      throw new TypeError({
        path: [], code: 'not.excluded',
        message: `not: value matches excluded type ${this.excluded.name}`, severity: 'error',
      });
    }
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

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (opts?.exact) return other instanceof NotType && this.excluded.exact(other.excluded);
    // other must NOT be structurally compatible with excluded.
    return !this.excluded.compatible(other, opts);
  }

  flexible(): boolean {
    return true;
  }

  or(other: Type<any>): Type<any> {
    if (!(other instanceof NotType)) return this;
    // Intersection of exclusions — union the excluded sets.
    return new NotType(this.registry, this.registry.or([this.excluded, other.excluded]));
  }

  narrow(local: Partial<NotOptions>): NotOptions {
    // Can only narrow by EXPANDING the excluded set (the value space shrinks).
    // Here we simply accept replacement — upstream callers may enforce stricter
    // policy via their own checks.
    return { excluded: local.excluded ?? this.options.excluded };
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    return {
      typeOf: r.method({}, r.text(), 'not.typeOf'),
      toText: r.method({}, r.text(), 'not.toText'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: NotType.NAME,
      options: { excluded: this.excluded.toJSON() },
    };
  }

  clone(): NotType {
    return new NotType(this.registry, this.excluded.clone());
  }

  toCode(): string { return `Exclude<any, ${this.excluded.toCode()}>`; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    const excluded = this.excluded.toValueSchema(opts);
    return this.describeType(z.any().refine(
      (v) => !excluded.safeParse(v).success,
      { message: `must not match excluded type '${this.excluded.name}'` },
    ), opts);
  }
}

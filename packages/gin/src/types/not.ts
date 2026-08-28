import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';


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

  /** The excluded type is an OPTION (`options.excluded`), not a generic. */
  static readonly optionKeys = ['excluded'] as const satisfies readonly (keyof NotOptions)[];
  static readonly genericKeys = [] as const;

  static from(json: TypeDef, scope: TypeScope): NotType {
    const registry = scope.registry;
    const excluded = json.options?.excluded
      ? scope.parse(json.options.excluded)
      : registry.any();
    return new NotType(scope, excluded);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('not'),
      options: z.object({ excluded: opts.Type }),
    }).meta({ aid: 'Type_not' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.any(); }

  constructor(scope: TypeScope, readonly excluded: Type) {
    super(scope, { excluded: excluded.toJSON() });
  }

  valid(raw: unknown, scope?: TypeScope): raw is any {
    return !this.excluded.valid(raw, scope);
  }

  parse(json: unknown, scope?: TypeScope): Value<any> {
    if (this.excluded.valid(json, scope)) {
      throw new TypeError({
        path: [], code: 'not.excluded',
        message: `not: value matches excluded type ${this.excluded.name}`, severity: 'error',
      });
    }
    return new Value(this, json);
  }

  encode(raw: any, _scope?: TypeScope): any {
    return raw;
  }

  create(): any {
    return null;
  }

  random(_rnd: Rnd): any {
    return null;
  }

  like(other: Type): Type {
    if (!(other instanceof NotType)) return this;
    const excluded = this.registry.like(other.excluded);
    if (excluded.name === 'null') return excluded;
    return this.registry.not(excluded);
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (opts?.exact) return other instanceof NotType && this.excluded.exact(other.excluded, scope);
    // other must NOT be structurally compatible with excluded.
    return !this.excluded.compatible(other, opts, scope);
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
      ...super.props(),
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

  toCode(_registry?: Registry, options?: CodeOptions): string { return this.docsPrefix(options) + `not<${this.excluded.toCode(undefined, options)}>`; }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    const excluded = this.excluded.toValueSchema(opts);
    return this.describeType(z.any().refine(
      (v) => !excluded.safeParse(v).success,
      { message: `must not match excluded type '${this.excluded.name}'` },
    ), opts);
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('not'),
      options: z.object({ excluded: this.excluded.toInstanceSchema() }),
    }).passthrough();
  }
}

import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


export interface GenericOptions {
  name: string;
}

/**
 * GenericType — a type-parameter placeholder (e.g. `V`, `R`). It
 * carries no structure itself; its meaning is determined by the
 * bindings in scope. `bind(bindings)` on an enclosing type substitutes
 * this placeholder with the bound Type.
 *
 * Before binding, Generic is maximally permissive — validation passes
 * any value, compatibility is true, props is empty. This mirrors how
 * TypeScript treats unconstrained type parameters inside a generic body.
 */
export class GenericType extends Type<any, GenericOptions> {
  static readonly NAME = 'generic';
  readonly name = GenericType.NAME;

  static from(json: TypeDef, registry: Registry): GenericType {
    const name = (json.options?.name ?? 'T') as string;
    return new GenericType(registry, { name });
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('generic'),
      options: z.object({ name: z.string() }),
    }).meta({ aid: 'Type_generic' });
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

  isUniversal(): boolean {
    return true;
  }

  or(_other: Type<any>): Type<any> {
    return this;
  }

  narrow(local: Partial<GenericOptions>): GenericOptions {
    // Renaming a generic placeholder is a structural rename, not a narrow.
    return { name: local.name ?? this.options.name };
  }

  /** Resolve self against the given bindings — the terminal case of the
   *  polymorphic Type.substitute walk. */
  substitute(bindings: Record<string, Type>): Type {
    return bindings[this.options.name] ?? this;
  }

  props(): Record<string, Prop> {
    return {};
  }

  toJSON(): TypeDef {
    return {
      name: GenericType.NAME,
      options: { name: this.options.name },
    };
  }

  clone(): GenericType {
    return new GenericType(this.registry, { ...this.options });
  }

  toCode(): string { return this.docsPrefix() + this.options.name; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Unbound placeholder — no concrete shape constraint. Callers that
    // need tight schemas should `.bind()` the generic first.
    return this.describeType(z.any(), opts);
  }

  /** Unbound generic — its instance schema mirrors `any`: accepts any TypeDef. */
  toInstanceSchema(): z.ZodTypeAny {
    return z.object({ name: z.string() }).passthrough();
  }
}

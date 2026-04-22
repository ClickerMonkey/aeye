import type { Registry } from '../registry';
import type { PathStepDef, TypeDef } from '../schema';
import { Value } from '../value';
import {
  type Call,
  type CompatOptions,
  type GetSet,
  type Init,
  type Prop,
  type PropSpec,
  type Rnd,
  Type,
} from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import { baseTypeFields } from '../schemas';

export interface RefOptions {
  name: string;
}

/**
 * RefType — a lazy reference to a named type registered in the Registry.
 * All methods delegate to the resolved target. Used for forward references
 * and for breaking potentially-cyclic type definitions.
 */
export class RefType extends Type<any, RefOptions> {
  static readonly NAME = 'ref';
  readonly name = RefType.NAME;

  static from(json: TypeDef, registry: Registry): RefType {
    const name = (json.options?.name ?? '') as string;
    return new RefType(registry, { name });
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('ref'),
      ...baseTypeFields(opts),
      options: z.object({ name: z.string() }),
    }).meta({ aid: 'Type_ref' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.any(); }

  private resolve(): Type {
    const target = this.registry.lookup(this.options.name);
    if (!target) {
      throw new TypeError({
        path: [], code: 'ref.unresolved',
        message: `ref.${this.options.name}: not registered`, severity: 'error',
      });
    }
    return target;
  }

  valid(raw: unknown): raw is any {
    return this.resolve().valid(raw);
  }

  parse(json: unknown): Value<any> {
    const v = this.resolve().parse(json);
    return new Value(this, v.raw);
  }

  encode(raw: any): any {
    return this.resolve().encode(raw);
  }

  create(): any {
    return this.resolve().create();
  }

  random(rnd: Rnd): any {
    return this.resolve().random(rnd);
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    return this.resolve().compatible(other, opts);
  }

  flexible(): boolean {
    return true;
  }

  or(other: Type<any>): Type<any> {
    return this.resolve().or(other);
  }

  simplify(): Type {
    return this.resolve();
  }

  narrow(local: Partial<RefOptions>): RefOptions {
    if (local.name && local.name !== this.options.name) {
      throw new TypeError({
        path: [], code: 'ref.rename',
        message: 'ref name cannot change via narrow', severity: 'error',
      });
    }
    return this.options;
  }

  props(): Record<string, Prop | PropSpec> {
    return this.resolve().props();
  }

  get(): GetSet | undefined {
    return this.resolve().get();
  }

  call(): Call | undefined {
    return this.resolve().call();
  }

  init(): Init | undefined {
    return this.resolve().init();
  }

  follow(step: PathStepDef): Type | undefined {
    return this.resolve().follow(step);
  }

  toJSON(): TypeDef {
    return {
      name: RefType.NAME,
      options: { name: this.options.name },
    };
  }

  clone(): RefType {
    return new RefType(this.registry, { name: this.options.name });
  }

  toCode(): string { return this.options.name; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Lazy so recursive named types (A → list<A>) don't blow the stack.
    return this.describeType(z.lazy(() => this.resolve().toValueSchema(opts)), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(z.lazy(() => this.resolve().toNewSchema(opts)), opts, 'NewValue_');
  }
}

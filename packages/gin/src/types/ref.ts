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
    // When the ref resolves, the target's props already include the
    // universal `toAny` via base.Type.props. If it can't resolve yet
    // (unregistered target), fall back to the universal-only set.
    try {
      return this.resolve().props();
    } catch {
      return super.props();
    }
  }

  get(): GetSet | undefined {
    try { return this.resolve().get(); } catch { return undefined; }
  }

  call(): Call | undefined {
    try { return this.resolve().call(); } catch { return undefined; }
  }

  init(): Init | undefined {
    try { return this.resolve().init(); } catch { return undefined; }
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

  toCode(): string { return this.docsPrefix() + this.options.name; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Lazy so recursive named types (A → list<A>) don't blow the stack.
    return this.describeType(z.lazy(() => this.resolve().toValueSchema(opts)), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(z.lazy(() => this.resolve().toNewSchema(opts)), opts, 'NewValue_');
  }

  /** A ref IS a name — the instance schema is just `{name: <target>}`. Lazy
   *  so self-referential named types (A → list<A>) don't infinite-recurse. */
  toInstanceSchema(): z.ZodTypeAny {
    return z.lazy(() => this.resolve().toInstanceSchema());
  }
}

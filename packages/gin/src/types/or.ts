import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { Call, type CompatOptions, GetSet, type Prop, type PropSpec, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


export interface OrOptions {
  variants: Type[];
}

/**
 * OrType — discriminated union. A value satisfies Or<[A, B, …]> iff it
 * satisfies AT LEAST ONE variant. Behaves like TypeScript `A | B`:
 *
 *   props()  = names in ALL variants; per-name type = union of variant types
 *   get()    = present iff all variants have get; key = intersection, value = union
 *   call()   = present iff all callable; args = intersection, returns = union
 *   init()   = present iff all have init; args = intersection
 *
 * The engine dispatches to the ACTIVE variant at runtime (via valid() on each).
 */
export class OrType extends Type<any, OrOptions> {
  static readonly NAME = 'or';
  readonly name = OrType.NAME;

  static from(json: TypeDef, registry: Registry): OrType {
    const variants = ((json.options?.types ?? []) as TypeDef[]).map((t) => registry.parse(t));
    return new OrType(registry, variants);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('or'),
      options: z.object({ types: z.array(opts.Type) }),
    }).meta({ aid: 'Type_or' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return opts.Expr;
  }

  constructor(registry: Registry, variants: Type[]) {
    super(registry, { variants });
  }

  get variants(): Type[] {
    return this.options.variants;
  }

  valid(raw: unknown): raw is any {
    return this.variants.some((v) => v.valid(raw));
  }

  parse(json: unknown): Value<any> {
    for (const v of this.variants) {
      try {
        const parsed = v.parse(json);
        return new Value(this, parsed.raw);
      } catch {
        continue;
      }
    }
    throw new TypeError({
      path: [], code: 'or.no-match',
      message: `or: no variant matched (${this.variants.map((v) => v.name).join(' | ')})`,
      severity: 'error',
    });
  }

  encode(raw: any): any {
    const match = this.variants.find((v) => v.valid(raw));
    if (!match) {
      throw new TypeError({
        path: [], code: 'or.dump.no-match',
        message: 'or.dump: value does not satisfy any variant', severity: 'error',
      });
    }
    return match.encode(raw);
  }

  create(): any {
    return this.variants[0]?.create() ?? null;
  }

  random(rnd: Rnd): any {
    const i = rnd(0, this.variants.length - 1, true);
    return this.variants[i]?.random(rnd) ?? null;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    // other is assignable to Or iff it's assignable to at least one variant.
    if (other instanceof OrType) {
      return other.variants.every((v) => this.compatible(v, opts));
    }
    return this.variants.some((v) => v.compatible(other, opts));
  }

  or(other: Type<any>): Type<any> {
    if (other instanceof OrType) {
      return new OrType(this.registry, [...this.variants, ...other.variants]);
    }
    return new OrType(this.registry, [...this.variants, other]);
  }

  simplify(): Type {
    if (this.variants.length === 1) return this.variants[0]!;
    return this;
  }

  narrow(_local: Partial<OrOptions>): OrOptions {
    // Or has no per-variant narrowing semantics — callers build narrower
    // Or by explicitly re-constructing with narrower variants.
    return this.options;
  }

  props(): Record<string, Prop | PropSpec> {
    const base = super.props();
    if (this.variants.length === 0) return base;
    const perVariant = this.variants.map((v) => v.props());
    const commonNames = Object.keys(perVariant[0]!).filter((n) =>
      perVariant.every((p) => n in p),
    );
    const out: Record<string, Prop | PropSpec> = { ...base };
    for (const name of commonNames) {
      const types = perVariant.map((p) => p[name]!.type);
      out[name] = { type: this.registry.or(types) };
    }
    return out;
  }

  get(): GetSet | undefined {
    const all = this.variants.map((v) => v.get());
    if (all.some((g) => !g)) return undefined;
    const gs = all as GetSet[];
    return new GetSet({
      key: this.registry.and(gs.map((g) => g.key)),
      value: this.registry.or(gs.map((g) => g.value)),
    });
  }

  call(): Call | undefined {
    const all = this.variants.map((v) => v.call());
    if (all.some((c) => !c)) return undefined;
    const cs = all as Call[];
    const returns = cs.map((c) => c.returns).filter((t): t is Type => !!t);
    const throws = cs.map((c) => c.throws).filter((t): t is Type => !!t);
    return new Call({
      args: this.registry.and(cs.map((c) => c.args)) as Type<any>,
      returns: returns.length === cs.length ? this.registry.or(returns) : undefined,
      throws: throws.length > 0 ? this.registry.or(throws) : undefined,
    });
  }

  toJSON(): TypeDef {
    return {
      name: OrType.NAME,
      options: { types: this.variants.map((v) => v.toJSON()) },
    };
  }

  clone(): OrType {
    return new OrType(this.registry, this.variants.map((v) => v.clone()));
  }

  toCode(): string {
    return this.docsPrefix() + `or<${this.variants.map((v) => v.toCode()).join(', ')}>`;
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    if (this.variants.length === 0) return this.describeType(z.never(), opts);
    if (this.variants.length === 1) return this.describeType(this.variants[0]!.toValueSchema(opts), opts);
    const schemas = this.variants.map((v) => v.toValueSchema(opts)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    return this.describeType(z.union(schemas), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    if (this.variants.length === 0) return this.describeType(z.never(), opts, 'NewValue_');
    if (this.variants.length === 1) return this.describeType(this.variants[0]!.toNewSchema(opts), opts, 'NewValue_');
    const schemas = this.variants.map((v) => v.toNewSchema(opts)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    return this.describeType(z.union(schemas), opts, 'NewValue_');
  }
}

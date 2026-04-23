import type { Registry } from '../registry';
import type { PropDef, TypeDef } from '../schema';
import { Value } from '../value';
import { Call, type CompatOptions, GetSet, type Prop, PropSpec, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


export interface AndOptions {
  parts: Type[];
}

/**
 * AndType — intersection type. A value satisfies And<[A, B, …]> iff it
 * satisfies ALL parts. Behaves like TypeScript `A & B`:
 *
 *   props()  = names in ANY part; per-name type = intersection of parts' types
 *              (same name + different type = conflict unless intersectable)
 *   get()    = each get's args-side is taken (take-first for simplicity);
 *              if multiple parts declare incompatible gets, registration errors
 *   call()   = union of args, intersection of returns (take-first)
 *   init()   = first part's init
 */
export class AndType extends Type<any, AndOptions> {
  static readonly NAME = 'and';
  readonly name = AndType.NAME;

  static from(json: TypeDef, registry: Registry): AndType {
    const parts = ((json.options?.types ?? []) as TypeDef[]).map((t) => registry.parse(t));
    return new AndType(registry, parts);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('and'),
      options: z.object({ types: z.array(opts.Type) }),
    }).meta({ aid: 'Type_and' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return opts.Expr;
  }

  constructor(registry: Registry, parts: Type[]) {
    super(registry, { parts });
  }

  get parts(): Type[] {
    return this.options.parts;
  }

  valid(raw: unknown): raw is any {
    return this.parts.every((p) => p.valid(raw));
  }

  parse(json: unknown): Value<any> {
    // Every part must accept the raw value.
    for (const p of this.parts) {
      if (!p.valid(json)) {
        throw new TypeError({
          path: [], code: 'and.constraint',
          message: `and: value fails part ${p.name}`, severity: 'error',
        });
      }
    }
    return new Value(this, json);
  }

  encode(raw: any): any {
    // Take any part's dump (they should all agree on valid values).
    return this.parts[0]?.encode(raw) ?? raw;
  }

  create(): any {
    return this.parts[0]?.create() ?? null;
  }

  random(rnd: Rnd): any {
    // Random from first part; callers of And over primitive types are
    // typically building structural intersections where this is enough.
    return this.parts[0]?.random(rnd) ?? null;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    // other assignable to And iff assignable to every part.
    return this.parts.every((p) => p.compatible(other, opts));
  }

  or(other: Type<any>): Type<any> {
    if (other instanceof AndType) {
      return new AndType(this.registry, [...this.parts, ...other.parts]);
    }
    return this;
  }

  simplify(): Type {
    if (this.parts.length === 1) return this.parts[0]!;
    return this;
  }

  narrow(_local: Partial<AndOptions>): AndOptions {
    return this.options;
  }

  props(): Record<string, Prop | PropSpec> {
    const out: Record<string, Prop | PropSpec> = {};
    for (const part of this.parts) {
      for (const [name, prop] of Object.entries(part.props())) {
        if (name in out) {
          // Same-name conflict → intersect types via And.
          out[name] = { type: this.registry.and([out[name]!.type, prop.type]) };
        } else {
          out[name] = prop;
        }
      }
    }
    return out;
  }

  get(): GetSet | undefined {
    const withGet = this.parts.map((p) => p.get()).filter((g): g is GetSet => !!g);
    if (withGet.length === 0) return undefined;
    return new GetSet({
      key: this.registry.or(withGet.map((g) => g.key)),
      value: this.registry.and(withGet.map((g) => g.value)),
    });
  }

  call(): Call | undefined {
    const withCall = this.parts.map((p) => p.call()).filter((c): c is Call => !!c);
    if (withCall.length === 0) return undefined;
    const returns = withCall.map((c) => c.returns).filter((t): t is Type => !!t);
    return new Call({
      args: this.registry.or(withCall.map((c) => c.args)) as Type<any>,
      returns: returns.length > 0 ? this.registry.and(returns) : undefined,
    });
  }

  toJSON(): TypeDef {
    return {
      name: AndType.NAME,
      options: { types: this.parts.map((p) => p.toJSON()) },
    };
  }

  clone(): AndType {
    return new AndType(this.registry, this.parts.map((p) => p.clone()));
  }

  toCode(): string {
    if (this.parts.length === 0) return 'unknown';
    return this.parts.map((p) => {
      const code = p.toCode();
      return / \| /.test(code) ? `(${code})` : code;
    }).join(' & ');
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    if (this.parts.length === 0) return this.describeType(z.unknown(), opts);
    if (this.parts.length === 1) return this.describeType(this.parts[0]!.toValueSchema(opts), opts);
    const s = this.parts
      .map((p) => p.toValueSchema(opts))
      .reduce((a, b) => z.intersection(a, b));
    return this.describeType(s, opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    if (this.parts.length === 0) return this.describeType(z.unknown(), opts, 'NewValue_');
    if (this.parts.length === 1) return this.describeType(this.parts[0]!.toNewSchema(opts), opts, 'NewValue_');
    const s = this.parts
      .map((p) => p.toNewSchema(opts))
      .reduce((a, b) => z.intersection(a, b));
    return this.describeType(s, opts, 'NewValue_');
  }
}

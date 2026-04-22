import type { Registry } from '../registry';
import type { PathStepDef, TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import type { JSONValue } from '../json-type';
import { baseTypeFields } from '../schemas';

export interface TupleOptions {
  elements: TypeDef[];
}

/**
 * TupleType — fixed-length, heterogeneous sequence. Each position has
 * its own Type. follow() is overridden so that a literal numeric key
 * returns the exact positional type (rather than a union over positions).
 */
export class TupleType extends Type<[any, ...any[]], TupleOptions> {
  static readonly NAME = 'tuple';
  readonly name = TupleType.NAME;

  readonly elements: Type[];

  static from(json: TypeDef, registry: Registry): TupleType {
    const defs = ((json.options?.elements ?? []) as TypeDef[]);
    const elems = defs.map((d) => registry.parse(d));
    return new TupleType(registry, elems);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('tuple'),
      ...baseTypeFields(opts),
      options: z.object({ elements: z.array(opts.Type) }),
    });
  }

  constructor(registry: Registry, elements: Type[]) {
    super(registry, { elements: elements.map((e) => e.toJSON()) });
    this.elements = elements;
  }

  valid(raw: unknown): raw is [Value, ...Value[]] {
    if (!Array.isArray(raw)) return false;
    if (raw.length !== this.elements.length) return false;
    return raw.every((v) => v instanceof Value && v.type.valid(v.raw));
  }

  parse(json: unknown): Value<[any, ...any[]]> {
    if (!Array.isArray(json) || json.length !== this.elements.length) {
      throw new TypeError({
        path: [], code: 'tuple.invalid',
        message: `tuple.parse: expected array of length ${this.elements.length}`,
        severity: 'error',
      });
    }
    const raw = this.elements.map((e, i) => this.registry.parseValue(json[i], e)) as [Value, ...Value[]];
    return new Value(this, raw);
  }

  /** Each positional value becomes a `JSONValue` envelope. */
  encode(raw: [Value, ...Value[]]): [JSONValue, ...JSONValue[]] {
    return raw.map((v) => v.toJSON()) as [JSONValue, ...JSONValue[]];
  }

  create(): [Value, ...Value[]] {
    return this.elements.map((e) => new Value(e, e.create())) as [Value, ...Value[]];
  }

  random(rnd: Rnd): [Value, ...Value[]] {
    return this.elements.map((e) => new Value(e, e.random(rnd))) as [Value, ...Value[]];
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof TupleType)) return false;
    if (other.elements.length !== this.elements.length) return false;
    return this.elements.every((e, i) => e.compatible(other.elements[i]!, opts));
  }

  or(other: Type<[any, ...any[]]>): Type<[any, ...any[]]> {
    if (!(other instanceof TupleType) || other.elements.length !== this.elements.length) {
      return this;
    }
    return new TupleType(
      this.registry,
      this.elements.map((e, i) => e.or(other.elements[i]! as Type<any>)),
    );
  }

  narrow(_local: Partial<TupleOptions>): TupleOptions {
    return this.options;
  }

  get(): GetSet {
    // Dynamic indexed access: value type is the union of positional types.
    const valueUnion = this.elements.length === 1
      ? this.elements[0]!
      : this.registry.or(this.elements);
    return new GetSet({
      key: this.registry.num({ whole: true, min: 0, max: this.elements.length - 1 }),
      value: valueUnion,
      get: { kind: 'native', id: 'tuple.at' },
      set: { kind: 'native', id: 'tuple.setAt' },
      loop: { kind: 'native', id: 'tuple.iterate' },
    });
  }

  follow(step: PathStepDef): Type | undefined {
    // Literal positional index → exact element type.
    if ('key' in step && !('args' in step)) {
      const key = step.key as any;
      const rawKey = key?.kind === 'new' ? key.value : undefined;
      if (typeof rawKey === 'number' && Number.isInteger(rawKey)) {
        return this.elements[rawKey];
      }
    }
    return super.follow(step);
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num();
    const firstT = this.elements[0] ?? r.any();
    const lastT = this.elements[this.elements.length - 1] ?? r.any();
    return {
      length: r.prop(r.num({ whole: true, min: this.elements.length, max: this.elements.length }),
                     'tuple.length'),
      first:  r.prop(firstT, 'tuple.first'),
      last:   r.prop(lastT,  'tuple.last'),
      toList: r.method({}, r.list(this.elements.length === 0 ? r.any() : r.or(this.elements)),
                       'tuple.toList'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: TupleType.NAME,
      options: { elements: this.elements.map((e) => e.toJSON()) },
    };
  }

  clone(): TupleType {
    return new TupleType(this.registry, this.elements.map((e) => e.clone()));
  }

  toCode(): string {
    return `[${this.elements.map((e) => e.toCode()).join(', ')}]`;
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Tuples ARE positional by nature — emit z.tuple for fidelity. LLM
    // consumers that struggle with positional arrays should use a different
    // shape (obj with named fields); tuple type preserves the position
    // contract.
    const elems = this.elements.map((e) => e.toValueSchema(opts));
    return this.describeType(z.tuple(elems as [z.ZodTypeAny, ...z.ZodTypeAny[]]), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Each position requires a New of the declared positional type.
    const slots = this.elements.map((e) => e.toNewExprSchema(opts));
    return this.describeType(z.tuple(slots as [z.ZodTypeAny, ...z.ZodTypeAny[]]), opts);
  }
}

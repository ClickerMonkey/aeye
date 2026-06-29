import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { PathStepDef, TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type } from '../type';
import { Effects } from '../effects';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { JSONValue } from '../json-type';


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

  static from(json: TypeDef, scope: TypeScope): TupleType {
    const registry = scope.registry;
    const defs = ((json.options?.elements ?? []) as TypeDef[]);
    const elems = defs.map((d) => scope.parse(d));
    return new TupleType(scope, elems);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('tuple'),
      options: z.object({ elements: z.array(opts.Type) }),
    }).meta({ aid: 'Type_tuple' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: generic positional array of Exprs. LLM producing a
    // tuple via the class branch specifies its positions in `options.elements`;
    // per-position type checking lives on the registered named-instance branch.
    return z.array(opts.Expr);
  }

  constructor(scope: TypeScope, elements: Type[]) {
    super(scope, { elements: elements.map((e) => e.toJSON()) });
    this.elements = elements;
  }

  valid(raw: unknown, scope?: TypeScope): raw is [Value, ...Value[]] {
    if (!Array.isArray(raw)) return false;
    if (raw.length !== this.elements.length) return false;
    return raw.every((v) => v instanceof Value && v.type.valid(v.raw, scope));
  }

  parse(json: unknown, scope?: TypeScope): Value<[any, ...any[]]> {
    if (!Array.isArray(json) || json.length !== this.elements.length) {
      throw new TypeError({
        path: [], code: 'tuple.invalid',
        message: `tuple.parse: expected array of length ${this.elements.length}`,
        severity: 'error',
      });
    }
    const raw = this.elements.map((e, i) => this.registry.parseValue(json[i], e, scope)) as [Value, ...Value[]];
    return new Value(this, raw);
  }

  /** Each positional value becomes a `JSONValue` envelope. */
  encode(raw: [Value, ...Value[]], _scope?: TypeScope): [JSONValue, ...JSONValue[]] {
    return raw.map((v) => v.toJSON()) as [JSONValue, ...JSONValue[]];
  }

  create(): [Value, ...Value[]] {
    return this.elements.map((e) => new Value(e, e.create())) as [Value, ...Value[]];
  }

  newEffects(value: unknown): Effects {
    const init = this.initEffects();
    if (Array.isArray(value)) {
      let acc = init;
      for (let i = 0; i < this.elements.length; i++) {
        if (i < value.length) acc |= this.elements[i]!.newEffects(value[i]);
      }
      return acc;
    }
    return init | this.exprValueEffects(value);
  }

  /** Each positional slot contributes its `elementComplexity` — the
   *  embedded Expr's cost or 1 for a raw literal. */
  newComplexity(value: unknown): number {
    const init = this.initComplexity();
    if (Array.isArray(value)) {
      let acc = 1 + init;
      for (let i = 0; i < this.elements.length; i++) {
        if (i < value.length) acc += this.elements[i]!.elementComplexity(value[i]);
      }
      return acc;
    }
    return 1 + init + this.exprValueComplexity(value);
  }

  random(rnd: Rnd): [Value, ...Value[]] {
    return this.elements.map((e) => new Value(e, e.random(rnd))) as [Value, ...Value[]];
  }

  like(other: Type): Type {
    if (!(other instanceof TupleType) || other.elements.length !== this.elements.length) {
      return this;
    }
    const narrowed = other.elements.map((e) => this.registry.like(e));
    if (narrowed.some((t) => t.name === 'null')) return this.registry.null();
    return this.registry.tuple(narrowed);
  }

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof TupleType)) return false;
    if (other.elements.length !== this.elements.length) return false;
    return this.elements.every((e, i) => e.compatible(other.elements[i]!, opts, scope));
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

  narrow(local: Partial<TupleOptions>): TupleOptions {
    // A tuple's identity lives in `elements`. If the local ExtensionLocal
    // specifies elements, use them verbatim (needed for named-tuple
    // round-trip: a `Pair = [text, num]` cross-extending the bare `tuple`
    // class re-specifies its elements on reparse). Otherwise keep base.
    if (local.elements === undefined) return this.options;
    return { elements: local.elements };
  }

  get(): GetSet {
    // Dynamic indexed access: value type is the union of positional types.
    const valueUnion = this.elements.length === 1
      ? this.elements[0]!
      : this.registry.or(this.elements);
    const r = this.registry;
    return new GetSet({
      key: r.num({ whole: true, min: 0, max: this.elements.length - 1 }),
      value: valueUnion,
      get: r.nativeExpr('tuple.at'),
      set: r.nativeExpr('tuple.setAt'),
      loop: r.nativeExpr('tuple.iterate'),
    });
  }

  follow(step: PathStepDef, scope?: TypeScope): Type | undefined {
    // Literal positional index → exact element type.
    if ('key' in step && !('args' in step)) {
      const key = step.key as any;
      const rawKey = key?.kind === 'new' ? key.value : undefined;
      if (typeof rawKey === 'number' && Number.isInteger(rawKey)) {
        return this.elements[rawKey];
      }
    }
    return super.follow(step, scope);
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num();
    const firstT = this.elements[0] ?? r.any();
    const lastT = this.elements[this.elements.length - 1] ?? r.any();
    return {
      ...super.props(),
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

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + `tuple<${this.elements.map((e) => e.toCode(undefined, options)).join(', ')}>`;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Tuples ARE positional by nature — emit z.tuple for fidelity. LLM
    // consumers that struggle with positional arrays should use a different
    // shape (obj with named fields); tuple type preserves the position
    // contract.
    const elems = this.elements.map((e) => e.toValueSchema(opts));
    return this.describeType(z.tuple(elems as [z.ZodTypeAny, ...z.ZodTypeAny[]]), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Each position accepts any Expr. Per-position type-compat is enforced
    // at evaluate/validate time.
    const slots = this.elements.map(() => opts.Expr as z.ZodTypeAny);
    return this.describeType(z.tuple(slots as [z.ZodTypeAny, ...z.ZodTypeAny[]]), opts, 'NewValue_');
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('tuple'),
      options: z.object({
        elements: z.tuple(this.elements.map((e) => e.toInstanceSchema()) as [z.ZodTypeAny, ...z.ZodTypeAny[]]),
      }),
    }).passthrough();
  }
}

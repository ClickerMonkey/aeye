import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { PropDef, TypeDef } from '../schema';
import { Value } from '../value';
import { Call, type CompatOptions, GetSet, type Prop, PropSpec, type Rnd, Type } from '../type';
import { ObjType } from './obj';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';


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

  static from(json: TypeDef, scope: TypeScope): AndType {
    const registry = scope.registry;
    const parts = ((json.options?.types ?? []) as TypeDef[]).map((t) => scope.parse(t));
    return new AndType(scope, parts);
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

  constructor(scope: TypeScope, parts: Type[]) {
    super(scope, { parts });
  }

  get parts(): Type[] {
    return this.options.parts;
  }

  valid(raw: unknown, scope?: TypeScope): raw is any {
    return this.parts.every((p) => p.valid(raw, scope));
  }

  /**
   * The single Type this intersection PARSES / CONSTRUCTS through.
   *
   * `parse` takes the AUTHORED (JSON) form; `valid` is a predicate over the
   * RUNTIME form (an obj's props are `Value`s, a list's items are `Value`s).
   * Checking `valid(json)` therefore rejects everything an object or container
   * part would happily parse — no value satisfied `and<obj{a}, obj{b}>` at all.
   * So an And parses through one type and only THEN checks each part:
   *
   *  - no parts   → `undefined` (an empty And is universal; nothing to parse
   *                 through, and `valid` accepts anything);
   *  - one part   → that part;
   *  - ALL parts objects → the MERGED obj (see {@link mergedObjFields}) —
   *                 exactly what `and<obj{a: text}, obj{b: num}>` MEANS
   *                 (`{a: text, b: num}`). Parsing through one part alone would
   *                 drop the other's fields and then fail its own `valid` check;
   *  - otherwise  → the FIRST part. The remaining parts are then pure
   *                 constraints checked by `valid` on the runtime value, which
   *                 is how `and<num, num{min=3}>` and
   *                 `and<list<text>, list<text>{maxLength=2}>` work.
   */
  private effective(): Type | undefined {
    const parts = this.parts;
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0]!;
    const merged = this.mergedObjFields();
    return merged ? this.registry.obj(merged) : parts[0]!;
  }

  /**
   * The DECLARED fields of an all-object intersection, unioned by name with
   * same-name fields intersected via `and` — or `undefined` when the parts are
   * not all objects. Reads each part's `fields` rather than its `props()`,
   * because `props()` also exposes an obj's NATIVE members (`keys`, `values`,
   * `has`, …) and rebuilding an obj from those would declare each native as a
   * structural `fn` field the parser then demands a value for.
   */
  private mergedObjFields(): Record<string, Prop | PropSpec> | undefined {
    const objs: ObjType[] = [];
    for (const p of this.parts) {
      if (!(p instanceof ObjType)) return undefined;
      objs.push(p);
    }
    const out: Record<string, Prop | PropSpec> = {};
    for (const o of objs) {
      for (const [name, prop] of Object.entries(o.fields)) {
        const existing = out[name];
        out[name] = existing ? { type: this.registry.and([existing.type, prop.type]) } : prop;
      }
    }
    return out;
  }

  parse(json: unknown, scope?: TypeScope): Value<any> {
    // Parse the AUTHORED form through the effective type to obtain the RUNTIME
    // representation, then check every part against THAT — `valid` is a
    // predicate over runtime values, not over JSON (see `effective`).
    const base = this.effective();
    if (!base) return new Value(this, json);
    const raw = base.parse(json, scope).raw;
    for (const p of this.parts) {
      if (!p.valid(raw, scope)) {
        throw new TypeError({
          path: [], code: 'and.constraint',
          message: `and: value fails part ${p.name}`, severity: 'error',
        });
      }
    }
    return new Value(this, raw);
  }

  encode(raw: any, scope?: TypeScope): any {
    // Encode through the SAME type `parse` built the runtime value with, so the
    // round-trip is lossless. Taking `parts[0]` would drop every field the other
    // object parts contribute (`and<obj{a}, obj{b}>` would encode away `b`).
    return this.effective()?.encode(raw, scope) ?? raw;
  }

  create(): any {
    return this.parts[0]?.create() ?? null;
  }

  random(rnd: Rnd): any {
    // Random from first part; callers of And over primitive types are
    // typically building structural intersections where this is enough.
    return this.parts[0]?.random(rnd) ?? null;
  }

  like(other: Type): Type {
    if (!(other instanceof AndType)) return this;
    const narrowed = other.parts
      .map((p) => this.registry.like(p))
      .filter((t) => t.name !== 'null');
    if (narrowed.length === 0) return this.registry.null();
    if (narrowed.length === 1) return narrowed[0]!;
    return this.registry.and(narrowed);
  }

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    // other assignable to And iff assignable to every part.
    return this.parts.every((p) => p.compatible(other, opts, scope));
  }

  /** Empty And vacuously matches anything — too broad for Registry.compatible. */
  isUniversal(): boolean {
    return this.parts.length === 0 || this.parts.every((p) => p.isUniversal());
  }

  or(other: Type<any>): Type<any> {
    if (other instanceof AndType) {
      return new AndType(this.registry, [...this.parts, ...other.parts]);
    }
    return this;
  }

  /**
   * Collapse to the equivalent single type where one exists: a one-part And is
   * its part, and an And of OBJECTS is the merged obj — `and<obj{a: text},
   * obj{b: num}>` simply IS `obj{a: text, b: num}` (see {@link effective}).
   * Anything else (a constraint intersection like `and<num, num{min=3}>`, or a
   * mix of kinds) has no single-type equivalent and stays an And.
   */
  simplify(): Type {
    if (this.parts.length === 1) return this.parts[0]!;
    if (this.parts.length === 0) return this;
    const merged = this.mergedObjFields();
    return merged ? this.registry.obj(merged) : this;
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

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + `and<${this.parts.map((p) => p.toCode(undefined, options)).join(', ')}>`;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    if (this.parts.length === 0) return this.describeType(z.unknown(), opts);
    if (this.parts.length === 1) return this.describeType(this.parts[0]!.toValueSchema(opts), opts);
    const s = this.parts
      .map((p) => p.toValueSchema(opts))
      .reduce((a, b) => z.intersection(a, b));
    return this.describeType(s, opts);
  }

  /** And's instance schema = intersection of each part's instance schema. */
  toInstanceSchema(): z.ZodTypeAny {
    if (this.parts.length === 0) return z.unknown();
    if (this.parts.length === 1) return this.parts[0]!.toInstanceSchema();
    return this.parts
      .map((p) => p.toInstanceSchema())
      .reduce((a, b) => z.intersection(a, b));
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

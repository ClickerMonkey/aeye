import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import { a, type AnySchema } from '@aeye/schema';
import type { TypeDef } from '../schema';
import type { CodeOptions, ValueSchemaOptions } from '../node';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { Value } from '../value';
import { extensionA, namedRefA, typeBranchA } from '../grammar-parts';


/**
 * TypType<T> — values of this type ARE gin Type instances. The generic T
 * constrains which Types are acceptable: only Types compatible with T pass
 * `valid()`. The JSON wire form (via `encode`/`toJSON`) is the Type's
 * TypeDef descriptor so serialization looks like `{name:'num'}`, but the
 * runtime `.raw` is the full Type instance — matching how gin stores rich
 * runtime values for other composites (obj's raw is a record of Values,
 * list's raw is an array of Values).
 *
 * Consumers of a `typ` Value (e.g. the fetch/llm natives) can use `.raw`
 * directly as a Type — no `registry.parse` needed at each invocation.
 *
 * `toA()` (a ref to the grammar's `TypeDef`) still validates the INCOMING JSON TypeDef form (what the
 * LLM emits in ExprDef slots); `parse` does the one-time JSON→Type conversion.
 */
export class TypType<T = any> extends Type<Type, Record<string, never>> {
  static readonly NAME = 'typ';
  readonly name = TypType.NAME;

  static readonly optionKeys = [] as const;
  static readonly genericKeys = ['T'] as const;
  static readonly valuesAreTypes = true;

  static from(json: TypeDef, scope: TypeScope): TypType {
    const registry = scope.registry;
    const constraint = json.generic?.T ? scope.parse(json.generic.T) : registry.any();
    return new TypType(scope, constraint);
  }

  constructor(scope: TypeScope, readonly constraint: Type<T>) {
    super(scope, {}, { T: constraint });
  }

  /** Accepts a Type instance whose values fit (in either direction — see
   *  note on compat asymmetry). The raw IS a Type, not JSON. */
  valid(raw: unknown, scope?: TypeScope): boolean {
    if (!(raw instanceof Type)) return false;
    // Accept in either direction: `raw.compatible(constraint)` handles
    // Extension subtypes (Positive.compatible(num) = true via base); the
    // opposite direction `constraint.compatible(raw)` handles top-type
    // cases (any.compatible(num) = true) so `typ<any>` accepts everything.
    return raw.compatible(this.constraint, undefined, scope)
        || this.constraint.compatible(raw, undefined, scope);
  }

  /** Parse a JSON TypeDef into a Type instance, then validate against the
   *  constraint. One-shot conversion — subsequent `.raw` access is free. */
  parse(json: unknown, scope?: TypeScope): Value<Type> {
    // Passthrough: already a Value of the right shape.
    if (json instanceof Value && json.type instanceof TypType) return json;
    // Already a Type — wrap directly.
    if (json instanceof Type) {
      if (!this.valid(json, scope)) {
        throw new Error(`typ.parse: Type '${json.name}' is not compatible with ${this.constraint.toCode()}`);
      }
      return new Value(this, json);
    }
    // JSON TypeDef — parse via registry, then validate.
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error(`typ.parse: expected TypeDef or Type, got ${typeof json}`);
    }
    if (!('name' in json) || typeof (json as { name: unknown }).name !== 'string') {
      throw new Error(`typ.parse: TypeDef missing 'name' field`);
    }
    let parsed: Type;
    try {
      parsed = this.registry.parse(json as TypeDef, scope);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`typ.parse: ${msg}`);
    }
    if (!this.valid(parsed, scope)) {
      throw new Error(`typ.parse: Type '${parsed.name}' is not compatible with ${this.constraint.toCode()}`);
    }
    // a name nothing resolves parses as an unbound alias, whose values are anything: refuse it here
    const lookup = scope ?? this.registry;
    const unknown = parsed.references().refs.filter((name) => lookup.lookup(name) === undefined);
    if (unknown.length > 0) {
      throw new Error(`typ.parse: no type named ${unknown.join(', ')}`);
    }
    return new Value(this, parsed);
  }

  /** Serialize to TypeDef JSON — the wire form. */
  encode(raw: Type, _scope?: TypeScope): TypeDef {
    return raw.toJSON();
  }

  create(): Type {
    return this.constraint;
  }

  random(_rnd: Rnd): Type {
    return this.constraint;
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof TypType)) return false;
    return this.constraint.compatible(other.constraint, opts, scope);
  }

  or(other: Type<Type>): Type<Type> {
    if (other instanceof TypType) {
      return new TypType(this.registry, this.registry.or([this.constraint, other.constraint]) as Type<T>);
    }
    return this;
  }

  narrow(_local: Partial<Record<string, never>>): Record<string, never> {
    return {};
  }

  props(): Record<string, Prop> {
    return { ...super.props() } as Record<string, Prop>;
  }

  toJSON(): TypeDef {
    return {
      name: TypType.NAME,
      generic: { T: this.constraint.toJSON() },
    };
  }

  clone(): TypType<T> {
    return new TypType(this.registry, this.constraint.clone() as Type<T>);
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + `typ<${this.constraint.toCode(undefined, options)}>`;
  }

  /**
   * A typ value IS a TypeDef: `a.ref('TypeDef')` from the grammar module
   * when unconstrained; else the TypeDef branches whose type fits the
   * constraint (classes, named types, a named type by name, an inline
   * Extension of a fitting base). Either way the def must then parse.
   */
  valueA(opts?: ValueSchemaOptions): AnySchema {
    const compatible = this.registry.compatible(this.constraint);
    if (compatible.length === 0 && this.constraint.name !== 'any') return a.never();
    let shape: AnySchema;
    if (this.constraint.name === 'any') {
      shape = a.ref('TypeDef');
    } else {
      const branches: AnySchema[] = compatible.map((t) => typeBranchA(this.registry, t.name));
      branches.push(namedRefA());
      branches.push(extensionA(compatible.map((t) => t.name)));
      shape = a.union(branches)
        .describe(`A gin type definition ({ "name": ..., ... }) whose type fits ${this.constraint.toCode()}.`);
    }
    return shape.refine((value: unknown) => {
      try {
        this.parse(value, opts?.scope);
        return true;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
  }

  toNewA(opts?: ValueSchemaOptions): AnySchema { return this.describeA(this.toA(opts), opts); }
}

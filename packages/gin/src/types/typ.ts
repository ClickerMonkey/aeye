import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import { z } from 'zod';
import type { TypeDef } from '../schema';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { Value } from '../value';
import { extensionSchemaNarrowed } from '../schemas';

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
 * `toValueSchema()` still validates the INCOMING JSON TypeDef form (what the
 * LLM emits in ExprDef slots); `parse` does the one-time JSON→Type conversion.
 */
export class TypType<T = any> extends Type<Type, Record<string, never>> {
  static readonly NAME = 'typ';
  readonly name = TypType.NAME;

  static from(json: TypeDef, scope: TypeScope): TypType {
    const registry = scope.registry;
    const constraint = json.generic?.T ? scope.parse(json.generic.T) : registry.any();
    return new TypType(scope, constraint);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('typ'),
      generic: z.object({ T: opts.Type }).optional(),
    }).meta({ aid: 'Type_typ' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: any TypeDef JSON (the LLM writes JSON, not Type instances).
    return opts.Type;
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

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
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

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    const narrowed = this.registry.like(this.constraint);
    // If no registry type is compatible with the constraint, nothing can
    // pass — emit never so callers can't supply an arbitrary TypeDef.
    if (narrowed.name === 'null') {
      return this.describeType(z.never(), opts);
    }

    const baseSchema = narrowed.toInstanceSchema();

    const compatibleNames = this.registry
      .compatible(this.constraint)
      .map((t) => t.name);
    // `extensionSchemaNarrowed` needs the full meta-language schema bag
    // (`Type` + `Expr`). When toValueSchema is called with only the
    // narrow ValueSchemaOptions, gracefully drop the inline-extension
    // branch — the base instance schema is still correct.
    const inlineExt = opts?.Type && opts?.Expr && compatibleNames.length > 0
      ? extensionSchemaNarrowed(this.registry, opts as SchemaOptions, compatibleNames)
      : null;

    const schema = inlineExt
      ? z.union([baseSchema as z.ZodTypeAny, inlineExt])
      : baseSchema;

    return this.describeType(schema, opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(this.toValueSchema(opts), opts, 'NewValue_');
  }
}

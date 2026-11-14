import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import { z } from 'zod';
import type { TypeDef } from '../schema';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { Value } from '../value';
import { buildSchemas, extensionSchemaNarrowed } from '../schemas';
import { TYPE_NAME } from '../type-name';

/** The schema bag a typ builds its value schema from, per registry, when the caller passes none. */
const bags = new WeakMap<Registry, SchemaOptions>();

/** `opts` when it carries the meta-language schemas, else the registry's own (built once). */
function schemaBag(registry: Registry, opts?: ValueSchemaOptions): SchemaOptions {
  if (opts?.Type !== undefined && opts.Expr !== undefined && opts.registry !== undefined) return opts as SchemaOptions;
  let bag = bags.get(registry);
  if (bag === undefined) {
    bag = buildSchemas(registry, { namedRefs: true });
    bags.set(registry, bag);
  }
  return bag;
}

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

  static readonly optionKeys = [] as const;
  static readonly genericKeys = ['T'] as const;
  static readonly valuesAreTypes = true;

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
   * The JSON TypeDefs this typ accepts, as gin's strict TypeDef schemas (`buildSchemas`): for `typ<any>` every
   * TypeDef, otherwise the class schema of each built-in class compatible with the constraint (`obj` with its
   * props, `num` with its options), a reference to each compatible named type, and an inline Extension of one of
   * them. So a tool parameter of this type tells the model the TypeDef shape, rather than an empty schema. The
   * schema bag comes from `opts` when it carries one, else it is built for this registry (and kept). A refinement
   * then parses the TypeDef, so a definition that fits the shape but not the constraint is refused too.
   */
  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    const bag = schemaBag(this.registry, opts);
    const compatible = this.registry.compatible(this.constraint);
    // If no registry type is compatible with the constraint, nothing can
    // pass — emit never so callers can't supply an arbitrary TypeDef.
    if (compatible.length === 0 && this.constraint.name !== 'any') {
      return this.describeType(z.never(), opts);
    }
    let shape: z.ZodTypeAny;
    if (this.constraint.name === 'any') {
      shape = bag.Type;
    } else {
      const branches = compatible.map((t) => {
        const cls = this.registry.typeClass(t.name);
        return cls !== undefined ? cls.toSchema(bag) : z.object({ name: z.literal(t.name) }).passthrough().meta({ aid: t.name });
      });
      // a named type the scope resolves but the registry doesn't hold; the refinement checks it fits
      branches.push(z.object({ name: z.string().regex(TYPE_NAME) }).strict().describe('A named type, by its name.'));
      branches.push(extensionSchemaNarrowed(this.registry, bag, compatible.map((t) => t.name)));
      const error = `must be a gin type definition ({ "name": ..., ... }) whose type fits ${this.constraint.toCode()}${this.constraint.name === 'obj' ? ', such as { "name": "obj", "props": { "id": { "type": { "name": "num" } } } }' : ''}`;
      shape = branches.length > 1 ? z.union(branches as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]], { error }) : branches[0]!;
    }
    const schema = shape.superRefine((value, ctx) => {
      try {
        const parsed = this.parse(value, opts?.scope).raw;
        const lookup = opts?.scope ?? this.registry;
        const unknown = parsed.references().refs.filter((name) => lookup.lookup(name) === undefined);
        if (unknown.length > 0) ctx.addIssue({ code: 'custom', message: `no type named ${unknown.join(', ')}` });
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
      }
    });
    return this.describeType(schema, opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(this.toValueSchema(opts), opts, 'NewValue_');
  }
}

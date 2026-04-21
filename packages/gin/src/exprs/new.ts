import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { NewExprDef, ExprDef } from '../schema';
import { Value, val } from '../value';
import { ObjType } from '../types/obj';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

/**
 * NewExpr — construct a Value of a type.
 *
 *   { kind: 'new', type: TypeDef, value?: any }
 *
 * Semantics:
 *   - If `value` is provided and the type has `init`: run init.run with
 *     { this, args } in scope. `this` is a pre-constructed default Value.
 *     The run returns either a fresh raw/Value (replaces this) or
 *     void/undefined (meaning `this` was mutated in place — return it).
 *   - Else if `value` is provided: parse it as the given type. For Obj
 *     types, missing fields with a `default` Expr are filled first.
 *   - Else: Value(type, type.create()).
 */
export class NewExpr extends Expr {
  static readonly KIND = 'new';
  readonly kind = NewExpr.KIND;

  constructor(
    readonly type: Type,
    readonly value: unknown | undefined,
  ) {
    super();
  }

  static from(json: NewExprDef, registry: Registry): NewExpr {
    return new NewExpr(registry.parse(json.type), json.value).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Strict mode: enumerate the available types so the LLM can ONLY
    // produce a New expr targeting one of them. Composite slots inside
    // recursively constrain to the FIELD types via toNewExprSchema.
    if (opts.newStrict && opts.types.length > 0) {
      const variants = opts.types.map((t) => t.toNewExprSchema(opts));
      return variants.length === 1
        ? variants[0]!
        : z.union(variants as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }
    // Default: any TypeDef + any value.
    return z.object({
      kind: z.literal('new'),
      ...baseExprFields,
      type: opts.Type,
      value: z.any().optional(),
    });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const type = this.type;
    const init = type.init();

    if (this.value !== undefined) {
      if (init) {
        const argsValue = init.args.parse(this.value);
        const thisValue = val(type, type.create());
        const child = scope.child({ this: thisValue, args: argsValue });
        const result = await engine.evaluate(init.run, child);
        if (result === undefined || result.raw === undefined) return thisValue;
        return new Value(type, (result as Value).raw);
      }

      const value = await fillObjDefaults(type, this.value, engine, scope);
      const v = type.parse(value);
      return v.type === type ? v : new Value(type, v.raw);
    }

    return val(type, type.create());
  }

  typeOf(_engine: Engine, _scope: TypeScope): Type {
    return this.type;
  }

  validateWalk(_engine: Engine, _scope: TypeScope, _p: Problems, _ctx: ValidateContext): Type {
    return this.type;
  }

  toCode(_registry?: Registry, options: CodeOptions = {}): string {
    const typeName = this.type.toCode();
    let code: string;
    if (this.value === undefined) {
      // An omitted value on an optional type IS `undefined`; otherwise
      // fall back to the default constructor form.
      code = this.type.isOptional() ? 'undefined' : `new ${typeName}()`;
    }
    else if (typeof this.value === 'number' || typeof this.value === 'boolean') code = String(this.value);
    else if (typeof this.value === 'string') code = JSON.stringify(this.value);
    else if (this.value === null) code = 'null';
    else code = `${JSON.stringify(this.value)} as ${typeName}`;
    return this.commentPrefix(options) + code;
  }

  toJSON(): NewExprDef {
    return this.withCommentOn({ kind: 'new', type: this.type.toJSON(), value: this.value });
  }

  clone(): NewExpr {
    return new NewExpr(this.type.clone(), this.value).withComment(this.comment);
  }
}

/**
 * For an Obj type (including Extensions over Obj via `.base` delegation),
 * evaluate each field's `default` Expr for any missing input key. Leaves
 * other types untouched.
 */
/**
 * Two passes against the raw value of `new obj {...}`:
 *   1. For any field whose input is an ExprDef (has a registered `kind`),
 *      evaluate it at runtime and inject the resulting Value.
 *   2. For any field that's still missing, invoke the prop's `default` Expr.
 *
 * This lets `new` mix static literals with dynamic sub-expressions:
 *   { kind: 'new', type: obj, value: { name: 'Alice', count: { kind: 'get', … } } }
 */
async function fillObjDefaults(
  type: Type,
  raw: unknown,
  engine: Engine,
  scope: Scope,
): Promise<unknown> {
  const obj = asObjType(type);
  if (!obj) return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  let filled: Record<string, unknown> | undefined;

  for (const [name, prop] of Object.entries(obj.fields)) {
    const inputValue = input[name];

    // Dynamic field: value is an Expr JSON that should be evaluated now.
    if (looksLikeExpr(inputValue, engine)) {
      const dv = await engine.evaluate(inputValue as ExprDef, scope);
      filled ??= { ...input };
      filled[name] = dv;
      continue;
    }

    // Missing field with a declared default.
    if (inputValue === undefined && prop.default !== undefined) {
      const dv = await engine.evaluate(prop.default as ExprDef, scope);
      filled ??= { ...input };
      filled[name] = dv;
    }
  }

  return filled ?? input;
}

function looksLikeExpr(v: unknown, engine: Engine): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const kind = (v as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return false;
  return !!engine.registry.exprClass(kind);
}

function asObjType(type: Type): ObjType | undefined {
  if (type instanceof ObjType) return type;
  const base = (type as unknown as { base?: Type }).base;
  return base ? asObjType(base) : undefined;
}

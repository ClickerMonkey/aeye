import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { NewExprDef, ExprDef } from '../schema';
import { Value, val } from '../value';
import { ObjType } from '../types/obj';
import type { Registry } from '../registry';
import { joinAuto, type Type } from '../type';
import type { Locals } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';

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

  static from(json: NewExprDef, scope: TypeScope): NewExpr {
    return new NewExpr(scope.registry.parse(json.type, scope), json.value).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Strict mode: emit a discriminated union over every Type the LLM
    // could legitimately `new`:
    //   - One branch per built-in Type class: `type` is that class's full
    //     TypeDef Zod (with options), `value` is any.
    //   - One branch per registered named Type instance (or opts.types):
    //     `type` is a name-only reference, `value` is that instance's
    //     specific `toNewSchema(opts)`.
    //
    // Example for `{name:'Pair'}` (registered) vs `{name:'num', options}`:
    //   ({ kind:'new', type:{name:'Pair'},                value:[…pair value…] }
    //  | { kind:'new', type:{name:'num',  options:{min?, max?, …}}, value:number }
    //  | …)
    if (opts.newStrict) {
      // Per-named-instance branches — specific value schemas.
      const byName = new Map<string, Type>();
      for (const t of opts.types) byName.set(t.name, t);
      for (const t of opts.registry.namedTypeList()) {
        if (!byName.has(t.name)) byName.set(t.name, t);
      }
      const instanceBranches = Array.from(byName.values()).map((t) =>
        z.object({
          kind: z.literal('new'),
          ...baseExprFields,
          type: z.object({ name: z.literal(t.name) }).passthrough().describe(
            `Reference to the registered named type \`${t.name}\` — name-only, the registry resolves it to its full definition.`,
          ),
          value: t.toNewSchema(opts).optional().describe(
            `Initial value for the new \`${t.name}\` instance. Each composite slot accepts an Expr (Get, NewExpr, etc.); per-slot type correctness is enforced at runtime.`,
          ),
        }).meta({ aid: `New_${t.name}` }),
      );
      // Per-built-in-class branches — full TypeDef shape + the class's
      // static `toNewSchema(opts)` for the value slot. Each class declares
      // its own class-level value shape (num → number, list → Expr[],
      // map → {key:Expr,value:Expr}[], etc.). Instance-specific narrowing
      // (num with min, obj with declared fields) belongs on a named
      // registered type branch.
      const classBranches = opts.registry.typeClasses().map((cls) =>
        z.object({
          kind: z.literal('new'),
          ...baseExprFields,
          type: cls.toSchema(opts).describe(
            `Full TypeDef for a \`${cls.NAME}\` instance (name + options + per-class fields).`,
          ),
          value: cls.toNewSchema(opts).optional().describe(
            `Initial value matching this \`${cls.NAME}\` instance. Composites accept Expr slots; primitives accept their raw form.`,
          ),
        }).meta({ aid: `New_${cls.NAME}` }),
      );
      const all = [...instanceBranches, ...classBranches];
      if (all.length === 1) return all[0]!;
      return z.union(all as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        .meta({ aid: 'Expr_new' });
    }
    // Default (non-strict): any TypeDef + any value.
    return z.object({
      kind: z.literal('new'),
      ...baseExprFields,
      type: opts.Type.describe(
        'TypeDef of the value being constructed. The `value` field is interpreted relative to this type — primitives take their raw form (`new num` → number), composites take Expr slots (`new list` → Expr[]).',
      ),
      value: z.any().optional().describe(
        'Initial value matching `type`. Optional when the type has a defined `init` constructor or a sensible default (empty list, zero num with no constraints, etc.).',
      ),
    }).meta({ aid: 'Expr_new' });
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

  typeOf(_engine: Engine, _scope: Locals): Type {
    return this.type;
  }

  validateWalk(_engine: Engine, _scope: Locals, _p: Problems, _ctx: ValidateContext): Type {
    return this.type;
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const typeName = this.type.toCode(undefined, options);
    let code: string;
    if (this.value === undefined) {
      // An omitted value on an optional type IS `undefined`; otherwise
      // fall back to the default constructor form.
      code = this.type.isOptional() ? 'undefined' : `new ${typeName}()`;
    }
    else if (typeof this.value === 'number' || typeof this.value === 'boolean') code = String(this.value);
    else if (typeof this.value === 'string') code = JSON.stringify(this.value);
    else if (this.value === null) code = 'null';
    else code = renderNewValue(this.value, registry, typeName, options);
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
 * Render the `value` slot of a `{kind:'new'}` expression as readable
 * source instead of a raw `JSON.stringify(...) as TypeName` dump.
 *
 * The value can hold:
 *   - primitive (already handled by the caller)
 *   - ExprDef (object with `kind`) — recurse via the registry's
 *     `parseExpr` and call its `toCode`. Mirrors how a hand-written
 *     `new list { value: [<Expr>, <Expr>] }` would read.
 *   - array — list-shaped `new`; render `[item, item]` with each slot
 *     recursed.
 *   - plain object — obj-shaped `new`; render `{ key: value, ... }`
 *     with each value recursed.
 *
 * Without a registry we can't parse ExprDefs back into Exprs; in that
 * case we still recurse over the array / object structure but render
 * primitive leaves directly and bail to JSON.stringify for any
 * ExprDef-shaped node we can't decode.
 */
function renderNewValue(value: unknown, registry: Registry | undefined, typeName: string, options: CodeOptions = {}): string {
  // ExprDef-shaped → render via the parsed Expr's toCode.
  if (registry && value && typeof value === 'object' && !Array.isArray(value)
      && 'kind' in (value as Record<string, unknown>)
      && typeof (value as { kind: unknown }).kind === 'string') {
    const kind = (value as { kind: string }).kind;
    if (registry.exprClass(kind)) {
      try {
        return registry.parseExpr(value as ExprDef).toCode(registry, { ...options, expectsValue: true });
      } catch { /* fall through to literal rendering */ }
    }
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => renderNewValueLeaf(v, registry, options));
    const joined = joinAuto(parts);
    return joined.startsWith('\n') ? `[${joined}]` : `[${joined}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `new ${typeName}()`;
    const parts = entries.map(([k, v]) => `${k}: ${renderNewValueLeaf(v, registry, options)}`);
    const joined = joinAuto(parts);
    return joined.startsWith('\n')
      ? `new ${typeName} {${joined}}`
      : `new ${typeName} { ${joined} }`;
  }

  // Last resort — primitive / null already handled in caller; this
  // is for unexpected shapes.
  return JSON.stringify(value);
}

function renderNewValueLeaf(v: unknown, registry: Registry | undefined, options: CodeOptions = {}): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Recurse — typeName is unknown at leaf depth, so use a generic
  // marker; composite leaves render as `[...]` or `{ k: v }` without
  // the `new <type>` prefix.
  return renderNewValue(v, registry, '<inferred>', options);
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

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
import { Code, span } from '../code';
import { z } from 'zod';
import type { TypeScope } from '../type-scope';
import type { Effects } from '../effects';

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
// no `comment` field — comment-spam on `new`/`get`/`flow` Exprs is
      // pure noise (the literal/path/keyword already conveys intent), so
      // strict-mode schema rejects them outright. Comments belong on
      // statement-shaped Exprs (if/switch/define/block/lambda) only.
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
        const result = await init.run.evaluate(engine, child);
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

  validateWalk(_engine: Engine, _scope: Locals, p: Problems, _ctx: ValidateContext): Type {
    // Warn when the value is missing on a structural type with required
    // fields — the runtime fills with `type.create()` defaults (zero
    // for num, "" for text, null for optional, etc.), which is almost
    // never what the author meant. The model frequently writes
    // `{kind: 'new', type: obj{a, b}}` (no value) when it intends to
    // declare placeholder slots; the resulting obj has zero/empty
    // values that silently substitute into templates and arithmetic.
    // Catching this at validate time saves a debug round-trip.
    if (this.value === undefined && hasRequiredFields(this.type)) {
      p.warn('new.value.missing',
        `\`new ${this.type.name}\` has no \`value\` — every field will fall to its type default (0 / "" / null). Provide a \`value\` matching the type's shape.`);
    }
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
    else code = renderNewValue(this.value, registry, this.type, options);
    return this.commentPrefix(options) + code;
  }

  toJSON(): NewExprDef {
    return this.withCommentOn({ kind: 'new', type: this.type.toJSON(), value: this.value });
  }

  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const typeCode = this.type.toJSONCode([...path, 'type'], indent, level + 1);
    // The `value` field on the new-Expr is inlined literally (no
    // child-Expr toJSONCode to delegate to). Continuation lines need
    // to be re-anchored to (level + 1) — the depth of the `value`
    // field inside the parent Code — so nested array / obj items
    // sit one indent level deeper than `value` itself.
    const valueText = this.value === undefined
      ? undefined
      : (() => {
          const text = JSON.stringify(this.value, null, indent);
          const reindentLevel = level + 1;
          return reindentLevel > 0
            ? text.replace(/\n/g, '\n' + ' '.repeat(reindentLevel * indent))
            : text;
        })();
    const valueSpan = valueText !== undefined
      ? span(valueText, { path: [...path, 'value'] })
      : undefined;
    return Code.jsonObject(
      [
        { key: 'kind', value: Code.jsonString('new') },
        { key: 'type', value: typeCode },
        { key: 'value', value: valueSpan },
        ...(this.comment ? [{ key: 'comment', value: Code.jsonString(this.comment) }] : []),
      ],
      { path, expr: this },
      level,
      indent,
    );
  }

  clone(): NewExpr {
    return new NewExpr(this.type.clone(), this.value).withComment(this.comment);
  }

  /** Construction effects come from the type itself: init.run plus any
   *  composite-slot Exprs the type knows how to walk. Each concrete
   *  Type implements `newEffects(value)` for its own shape. */
  effects(): Effects {
    return this.type.newEffects(this.value);
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
function renderNewValue(value: unknown, registry: Registry | undefined, type: Type | undefined, options: CodeOptions = {}): string {
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

  const typeName = type ? type.toCode(undefined, options) : '<inferred>';

  if (Array.isArray(value)) {
    // For list-shaped types we know each item's type from `list.item`,
    // so propagate it down — items render as `new Point {...}` instead
    // of `new <inferred> {...}` when the parent declared `list<Point>`.
    const itemType = (type as unknown as { item?: Type } | undefined)?.item;
    const parts = value.map((v) => renderNewValueLeaf(v, registry, itemType, options));
    const joined = joinAuto(parts);
    return joined.startsWith('\n') ? `[${joined}]` : `[${joined}]`;
  }

  if (value && typeof value === 'object') {
    // For obj-shaped types we know each field's type from `obj.fields`,
    // so a nested obj literal can render with its declared field type
    // (`{ pos: new Point {x:1,y:2} }` instead of `<inferred>`).
    const fields = (type as unknown as { fields?: Record<string, { type: Type }> } | undefined)?.fields;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `new ${typeName}()`;
    const parts = entries.map(([k, v]) => `${k}: ${renderNewValueLeaf(v, registry, fields?.[k]?.type, options)}`);
    const joined = joinAuto(parts);
    return joined.startsWith('\n')
      ? `new ${typeName} {${joined}}`
      : `new ${typeName} { ${joined} }`;
  }

  // Last resort — primitive / null already handled in caller; this
  // is for unexpected shapes.
  return JSON.stringify(value);
}

function renderNewValueLeaf(v: unknown, registry: Registry | undefined, type: Type | undefined, options: CodeOptions = {}): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Recurse with whatever element / field type the parent supplied;
  // composite leaves at the deepest level fall back to `<inferred>`.
  return renderNewValue(v, registry, type, options);
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

/**
 * True when the type is an obj (or extension thereof) with at least
 * one required field. Other shapes — list/map/tuple/scalar — either
 * default to empty (not interesting) or have no structural fields
 * to populate, so a missing `value` isn't suspicious for them.
 *
 * We deliberately skip the generic `type.props()` path because
 * `props()` includes inherited methods on every type (map.set,
 * num.add, etc.); treating those as "required fields" would force
 * the warning on every typed value with methods.
 */
function hasRequiredFields(type: Type): boolean {
  const obj = asObjType(type);
  if (!obj) return false;
  for (const prop of Object.values(obj.fields)) {
    if (!prop.type.isOptional()) return true;
  }
  return false;
}

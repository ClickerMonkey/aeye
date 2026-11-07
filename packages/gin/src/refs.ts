/**
 * Type references — which NAMED types a definition depends on.
 *
 * A def that names a type it does not define (`{name: 'Customer'}`,
 * `extends: 'Customer'`, `satisfies: ['Comparable']`) only parses to the
 * intended type where that name resolves. A process that receives a def
 * from elsewhere — a system loading a fn signature from a hub — asks this
 * module which names to fetch, fetches them, and binds them in a scope
 * (`registry.scope(...)`) before parsing.
 *
 * The walk is over the WIRE form (`TypeDef`), not live `Type`s, for two
 * reasons: a def whose names are not bound yet cannot always be parsed
 * (an unknown `extends` base is an error), and the wire form is what
 * crosses the process boundary. `Type.references()` / `Type.closure()`
 * serialize with `toDefinitionJSON()` first, so a registered named type a
 * type reaches is reported as a reference rather than inlined.
 */
import type { Registry } from './registry';
import type { CallDef, ExprDef, GetSetDef, PropDef, TypeDef } from './schema';

/** The named types one definition depends on. */
export interface TypeReferences {
  /**
   * Names the definition refers to and does not itself define, in first-seen
   * order. Built-in class names (`text`, `list`, …) and type parameters in
   * scope (a fn's or extension's `generic`, a call's `types`) are never
   * references.
   */
  readonly refs: readonly string[];
  /**
   * Named types the definition carries inline — `{name, extends, …}` defs.
   * A consumer has these already; they are not in `refs`.
   */
  readonly defines: readonly string[];
}

/** Looks a referenced name up, returning its definition, or `undefined` when unknown. */
export type TypeResolver = (name: string) => TypeDef | undefined;

/** Everything a set of definitions needs, followed through the definitions it refers to. */
export interface TypeClosure {
  /**
   * Every referenced name the resolver found, in dependency order: a name
   * comes after the names its definition refers to, so binding them in this
   * order into a scope lets each definition resolve the ones before it.
   * Names in a cycle keep their first-seen order (gin resolves the forward
   * reference lazily).
   */
  readonly order: readonly string[];
  /** The resolved definition of each name in {@link TypeClosure.order}. */
  readonly defs: ReadonlyMap<string, TypeDef>;
  /** Referenced names the resolver did not know, in first-seen order. */
  readonly missing: readonly string[];
}

/**
 * The named types `def` refers to directly. `registry` says which names are
 * built-in classes and which `kind`s are expressions (an expression may carry
 * types: a `new` value, a lambda signature, a call's generic bindings).
 */
export function typeReferences(def: TypeDef, registry: Registry): TypeReferences {
  const walker = new RefWalker(registry);
  walker.type(def, EMPTY);
  const defines = new Set(walker.defines);
  return {
    refs: walker.refs.filter((name) => !defines.has(name)),
    defines: walker.defines,
  };
}

/**
 * The named types `roots` depend on, followed transitively through `resolve`.
 * Names the roots define inline are not resolved — they are already there.
 */
export function typeClosure(
  roots: readonly TypeDef[],
  registry: Registry,
  resolve: TypeResolver,
): TypeClosure {
  const defs = new Map<string, TypeDef>();
  const missing: string[] = [];
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const inline = new Set<string>();
  for (const root of roots) for (const name of typeReferences(root, registry).defines) inline.add(name);

  const visit = (name: string): void => {
    if (state.has(name) || inline.has(name)) return;
    const def = resolve(name);
    if (!def) {
      state.set(name, 'done');
      missing.push(name);
      return;
    }
    state.set(name, 'visiting');
    defs.set(name, def);
    for (const ref of typeReferences(def, registry).refs) visit(ref);
    state.set(name, 'done');
    order.push(name);
  };
  for (const root of roots) for (const ref of typeReferences(root, registry).refs) visit(ref);
  return { order, defs, missing };
}

/** Names bound as type parameters / call aliases where the walk currently is. */
type Locals = ReadonlySet<string>;
const EMPTY: Locals = new Set();

/** One walk over a def tree, collecting reference and definition names in first-seen order. */
class RefWalker {
  readonly refs: string[] = [];
  readonly defines: string[] = [];
  private readonly seenRefs = new Set<string>();
  private readonly seenDefines = new Set<string>();

  constructor(private readonly registry: Registry) {}

  /** A `TypeDef` position. */
  type(def: TypeDef, locals: Locals): void {
    const cls = this.registry.typeClass(def.name);
    const declares = def.extends !== undefined || cls?.declaresGenerics === true;

    if (def.extends !== undefined) {
      this.define(def.name);
      this.name(def.extends, locals);
    } else if (!cls) {
      this.name(def.name, locals);
    }
    for (const iface of def.satisfies ?? []) this.name(iface, locals);

    // Type parameters an extension or a fn DECLARES are local below it — and
    // inside their own constraints, where `R: R` is gin's "unconstrained".
    // Anywhere else `generic` holds type ARGUMENTS, walked in place.
    const inner = declares && def.generic ? withNames(locals, Object.keys(def.generic)) : locals;
    for (const arg of Object.values(def.generic ?? {})) this.type(arg, inner);

    this.options(def.options, inner);
    for (const prop of Object.values(def.props ?? {})) this.prop(prop, inner);
    if (def.get) this.getSet(def.get, inner);
    if (def.call) this.call(def.call, inner);
    if (def.init) {
      this.type(def.init.args, inner);
      this.expr(def.init.run, inner);
    }
    if (def.constraint) this.expr(def.constraint, inner);
  }

  /** A bare name in a type position: a reference unless built in or bound locally. */
  private name(name: string, locals: Locals): void {
    if (locals.has(name) || this.registry.typeClass(name) || this.seenRefs.has(name)) return;
    this.seenRefs.add(name);
    this.refs.push(name);
  }

  private define(name: string): void {
    if (this.seenDefines.has(name)) return;
    this.seenDefines.add(name);
    this.defines.push(name);
  }

  /**
   * `options` carry child TypeDefs for some classes (`tuple.elements`,
   * `or` / `and` `types`, `not.excluded`) and plain constants for others
   * (`enum.values`, `literal.value`). A child def is anything shaped like
   * one, which a constant of those classes never is: enum values and
   * literal values are scalars.
   */
  private options(options: unknown, locals: Locals): void {
    if (!isRecord(options)) return;
    for (const value of Object.values(options)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isTypeDef(item)) this.type(item, locals);
      } else if (isTypeDef(value)) {
        this.type(value, locals);
      }
    }
  }

  private prop(prop: PropDef, locals: Locals): void {
    this.type(prop.type, locals);
    this.expr(prop.get, locals);
    this.expr(prop.set, locals);
    this.expr(prop.default, locals);
  }

  private getSet(gs: GetSetDef, locals: Locals): void {
    this.type(gs.key, locals);
    this.type(gs.value, locals);
    this.expr(gs.get, locals);
    this.expr(gs.set, locals);
    this.expr(gs.loop, locals);
  }

  /** A call's `types` aliases are local to the call, and visible to later aliases. */
  private call(call: CallDef, locals: Locals): void {
    let inner = locals;
    for (const [alias, def] of Object.entries(call.types ?? {})) {
      this.type(def, inner);
      inner = withNames(inner, [alias]);
    }
    this.type(call.args, inner);
    if (call.returns) this.type(call.returns, inner);
    if (call.throws) this.type(call.throws, inner);
    this.expr(call.get, inner);
    this.expr(call.set, inner);
  }

  /**
   * An expression position. Expressions carry types in two keys: `type`
   * (a `new` value's type, a lambda's signature, a `define` var, a native's
   * declared type) and `generic` (a call step's bindings). `value` holds
   * DATA — a `new` payload, which may embed expressions at any depth but
   * whose own keys are field names, never type slots — except where the
   * value's type is one whose values ARE types (`typ`), when it is a def.
   * Everything else is expression structure: sub-expressions, path steps,
   * branch lists.
   */
  expr(node: unknown, locals: Locals): void {
    if (Array.isArray(node)) {
      for (const item of node) this.expr(item, locals);
      return;
    }
    if (!isRecord(node)) return;
    const valueIsType = isTypeDef(node.type) && this.registry.typeClass(node.type.name)?.valuesAreTypes === true;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'type' && isTypeDef(child)) this.type(child, locals);
      else if (key === 'generic' && isRecord(child)) {
        for (const arg of Object.values(child)) if (isTypeDef(arg)) this.type(arg, locals);
      } else if (key === 'value') {
        if (valueIsType && isTypeDef(child)) this.type(child, locals);
        else this.data(child, locals);
      } else this.expr(child, locals);
    }
  }

  /** A data position: only expressions embedded in it can carry types. */
  private data(node: unknown, locals: Locals): void {
    if (Array.isArray(node)) {
      for (const item of node) this.data(item, locals);
      return;
    }
    if (!isRecord(node)) return;
    if (this.isExpr(node)) {
      this.expr(node, locals);
      return;
    }
    for (const child of Object.values(node)) this.data(child, locals);
  }

  /** Gin's own probe for an embedded expression: `kind` names a registered Expr class. */
  private isExpr(node: Record<string, unknown>): node is ExprDef {
    return typeof node.kind === 'string' && this.registry.exprClass(node.kind) !== undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shaped like a `TypeDef`: an object with a string `name`. */
function isTypeDef(value: unknown): value is TypeDef {
  return isRecord(value) && typeof value.name === 'string';
}

function withNames(locals: Locals, names: readonly string[]): Locals {
  return names.length === 0 ? locals : new Set([...locals, ...names]);
}

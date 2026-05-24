import type { Registry } from './registry';
import type { Type } from './type';
import type { Expr } from './expr';
import type { TypeDef, ExprDef } from './schema';

/**
 * Type-name resolution scope. A tree of name → Type bindings rooted at
 * the Registry. Used by `AliasType` to resolve `{name: 'X'}` lazily,
 * and by `Registry.parse` to dispatch bare-name TypeDefs to AliasType
 * when X is bound in a local scope.
 *
 * - The Registry is the root scope; it implements `TypeScope` directly.
 *   Its `lookup` walks `namedTypes` and built-in `classes`.
 * - `LocalScope` wraps a parent scope with an overlay map. Used by
 *   `Call.from` to scope `CallDef.types` aliases, by FnType to scope
 *   declared generics, etc.
 *
 * Distinct from:
 *  - `Scope` in `scope.ts` (runtime variable bindings — Value scope).
 *  - `Locals` in `analysis.ts` (`Map<string, Type>` for static
 *    variable-type analysis during validate / typeOf).
 */
export interface TypeScope {
  /** Look up a type by name. Returns the bound Type if present in this
   *  scope or any parent scope; undefined if not found anywhere. */
  lookup(name: string): Type | undefined;

  /** Look up a type bound DIRECTLY in this scope's local layer.
   *  Does NOT walk parent. Used by `Registry.parseInner` to detect
   *  bare-name refs that must wrap as AliasType (so generic / alias
   *  substitution still works) rather than resolving eagerly through
   *  the registry. The Registry implementation returns undefined —
   *  registry hits aren't "local-above-root" bindings. */
  localLookup(name: string): Type | undefined;

  /** Parse a TypeDef in this scope. Convenience over
   *  `scope.registry.parse(def, scope)` — most type implementations'
   *  `from(def, scope)` recurse via `scope.parse(child)` without
   *  needing to thread the registry separately. */
  parse(def: unknown): Type;

  /**
   * Parse anything Expr-shaped in this scope. Overloads:
   *   - `Expr` → returned as-is
   *   - `ExprDef` → parsed
   *   - `null` / `undefined` → returned as `undefined`
   *
   * Mirrors `parse()` for the expression side. Forwards to
   * `this.registry.parseExpr(def, this)`. See `Registry.parseExpr`
   * for the full contract.
   */
  parseExpr(def: Expr): Expr;
  parseExpr(def: ExprDef): Expr;
  parseExpr(def: null | undefined): undefined;
  parseExpr(def: Expr | ExprDef | null | undefined): Expr | undefined;

  /** The root Registry — every TypeScope can resolve to it via the
   *  parent chain. Use this to access builder methods (`registry.num()`)
   *  for fresh built-in instances. */
  readonly registry: Registry;

  /** Parent scope, or undefined for the root (Registry). */
  readonly parent?: TypeScope;
}

/**
 * A scope layer holding local name → Type bindings. Falls through to
 * `parent.lookup` on miss. Construction order matters for sequential
 * builds (later aliases referencing earlier ones); the caller is
 * responsible for adding bindings in order if dependencies exist.
 */
export class LocalScope implements TypeScope {
  readonly parent: TypeScope;
  readonly registry: Registry;
  private readonly local: Record<string, Type>;

  constructor(parent: TypeScope, local: Record<string, Type> = {}) {
    this.parent = parent;
    this.registry = parent.registry;
    this.local = local;
  }

  lookup(name: string): Type | undefined {
    return this.local[name] ?? this.parent.lookup(name);
  }

  localLookup(name: string): Type | undefined {
    return this.local[name];
  }

  parse(def: unknown): Type {
    return this.registry.parse(def as TypeDef, this);
  }

  parseExpr(def: Expr): Expr;
  parseExpr(def: ExprDef): Expr;
  parseExpr(def: null | undefined): undefined;
  parseExpr(def: Expr | ExprDef | null | undefined): Expr | undefined;
  parseExpr(def: Expr | ExprDef | null | undefined): Expr | undefined {
    return this.registry.parseExpr(def, this);
  }

  /** Add a binding to this scope's local map. Used by sequential
   *  alias / generic build steps where each entry may reference
   *  earlier ones. */
  bind(name: string, type: Type): void {
    this.local[name] = type;
  }

  /** Return the names bound DIRECTLY in this scope (excluding parent).
   *  Used for diagnostics / rendering. */
  ownNames(): string[] {
    return Object.keys(this.local);
  }
}
